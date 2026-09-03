// C-006: idempotency fingerprint retention. Fingerprints ride ON canonical
// event documents (no separate collection), so retention is a field-level
// prune, not a TTL index. Coverage:
//   - seam pruneIdempotencyFingerprints against the stateful fake (prunes
//     old fingerprinted events, keeps recent ones, leaves keyless events
//     and other agents untouched)
//   - resolveIdempotencyRetentionDays env contract (default / valid / zero /
//     invalid fallback)
//   - manager facade: real write-ops path against the fake, hourly gate,
//     force bypass, failure swallow
//   - worker drain wiring: drainMemoryJobQueue awaits the prune after
//     outbox repair
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { MongoDBMemoryManager } from "./mongodb-manager.js"
import {
	pruneIdempotencyFingerprints,
	resolveIdempotencyRetentionDays,
} from "./mongodb-events.js"
import {
	buildMockManager,
	captureManagerPrototype,
} from "./test-helpers/manager-test-kit.js"
import { createStatefulMongoFake } from "./test-helpers/stateful-mongo-fake.js"

captureManagerPrototype(MongoDBMemoryManager)

const PREFIX = "test_"
const AGENT = "agent-1"
const NOW = new Date("2026-08-14T12:00:00.000Z")

function daysBefore(days: number): Date {
	return new Date(NOW.getTime() - days * 86_400_000)
}

function seedEvent(params: {
	eventId: string
	agentId?: string
	timestamp: Date
	idempotencyKey?: string
	idempotencyFingerprint?: string
}) {
	return {
		eventId: params.eventId,
		agentId: params.agentId ?? AGENT,
		role: "user" as const,
		body: `body for ${params.eventId}`,
		scope: "session" as const,
		scopeRef: "session:s-1",
		timestamp: params.timestamp,
		validAt: params.timestamp,
		recordedAt: params.timestamp,
		...(params.idempotencyKey !== undefined
			? { idempotencyKey: params.idempotencyKey }
			: {}),
		...(params.idempotencyFingerprint !== undefined
			? { idempotencyFingerprint: params.idempotencyFingerprint }
			: {}),
	}
}

describe("pruneIdempotencyFingerprints — seam", () => {
	let fake: ReturnType<typeof createStatefulMongoFake>

	beforeEach(() => {
		fake = createStatefulMongoFake({ prefix: PREFIX })
	})

	it("unsets fingerprint fields on old completed writes and leaves everything else alone", async () => {
		await fake.collection("events").insertMany([
			seedEvent({
				eventId: "evt-old-keyed",
				timestamp: daysBefore(100),
				idempotencyKey: "key-old",
				idempotencyFingerprint: "fp-old",
			}),
			seedEvent({
				eventId: "evt-recent-keyed",
				timestamp: daysBefore(10),
				idempotencyKey: "key-recent",
				idempotencyFingerprint: "fp-recent",
			}),
			seedEvent({
				eventId: "evt-old-keyless",
				timestamp: daysBefore(100),
			}),
			seedEvent({
				eventId: "evt-other-agent",
				agentId: "agent-2",
				timestamp: daysBefore(100),
				idempotencyKey: "key-other",
				idempotencyFingerprint: "fp-other",
			}),
		])

		const result = await pruneIdempotencyFingerprints({
			db: fake.db,
			prefix: PREFIX,
			agentId: AGENT,
			olderThanDays: 90,
			now: NOW,
		})

		expect(result.pruned).toBe(1)

		const oldKeyed = fake.findDoc("events", { eventId: "evt-old-keyed" })
		expect(oldKeyed?.idempotencyKey).toBeUndefined()
		expect(oldKeyed?.idempotencyFingerprint).toBeUndefined()
		// The event body itself is untouched — only deduplication state expires.
		expect(oldKeyed?.body).toBe("body for evt-old-keyed")

		const recentKeyed = fake.findDoc("events", {
			eventId: "evt-recent-keyed",
		})
		expect(recentKeyed?.idempotencyKey).toBe("key-recent")
		expect(recentKeyed?.idempotencyFingerprint).toBe("fp-recent")

		const oldKeyless = fake.findDoc("events", { eventId: "evt-old-keyless" })
		expect(oldKeyless).toBeTruthy()
		expect(oldKeyless?.idempotencyKey).toBeUndefined()

		const otherAgent = fake.findDoc("events", { eventId: "evt-other-agent" })
		expect(otherAgent?.idempotencyKey).toBe("key-other")
		expect(otherAgent?.idempotencyFingerprint).toBe("fp-other")
	})

	it("olderThanDays 0 prunes every fingerprinted event (cutoff = now)", async () => {
		await fake.collection("events").insertMany([
			seedEvent({
				eventId: "evt-now",
				timestamp: NOW,
				idempotencyKey: "key-now",
				idempotencyFingerprint: "fp-now",
			}),
			seedEvent({
				eventId: "evt-1s-ago",
				timestamp: new Date(NOW.getTime() - 1_000),
				idempotencyKey: "key-1s",
				idempotencyFingerprint: "fp-1s",
			}),
		])

		const result = await pruneIdempotencyFingerprints({
			db: fake.db,
			prefix: PREFIX,
			agentId: AGENT,
			olderThanDays: 0,
			now: NOW,
		})

		expect(result.pruned).toBe(1)
		expect(
			fake.findDoc("events", { eventId: "evt-1s-ago" })?.idempotencyKey,
		).toBeUndefined()
		// Exactly at the cutoff is NOT older-than: timestamp < cutoff is strict.
		expect(fake.findDoc("events", { eventId: "evt-now" })?.idempotencyKey).toBe(
			"key-now",
		)
	})
})

describe("resolveIdempotencyRetentionDays", () => {
	afterEach(() => {
		vi.unstubAllEnvs()
	})

	it("defaults to the 90-day window", () => {
		expect(resolveIdempotencyRetentionDays()).toBe(90)
	})

	it("honors a valid MEMONGO_IDEMPOTENCY_RETENTION_DAYS override", () => {
		vi.stubEnv("MEMONGO_IDEMPOTENCY_RETENTION_DAYS", "30")
		expect(resolveIdempotencyRetentionDays()).toBe(30)
	})

	it("treats 0 as prune-every-sweep, not as invalid", () => {
		vi.stubEnv("MEMONGO_IDEMPOTENCY_RETENTION_DAYS", "0")
		expect(resolveIdempotencyRetentionDays()).toBe(0)
	})

	it("falls back to the default on non-numeric or negative input", () => {
		vi.stubEnv("MEMONGO_IDEMPOTENCY_RETENTION_DAYS", "not-a-number")
		expect(resolveIdempotencyRetentionDays()).toBe(90)
		vi.stubEnv("MEMONGO_IDEMPOTENCY_RETENTION_DAYS", "-5")
		expect(resolveIdempotencyRetentionDays()).toBe(90)
		vi.stubEnv("MEMONGO_IDEMPOTENCY_RETENTION_DAYS", "")
		expect(resolveIdempotencyRetentionDays()).toBe(90)
	})
})

describe("pruneIdempotencyFingerprints — manager facade", () => {
	let fake: ReturnType<typeof createStatefulMongoFake>
	let manager: MongoDBMemoryManager

	beforeEach(() => {
		fake = createStatefulMongoFake({ prefix: PREFIX })
		manager = buildMockManager({
			db: fake.db,
			prefix: PREFIX,
			agentId: AGENT,
		})
	})

	it("prunes through the write-ops path and the hourly gate skips the next sweep", async () => {
		await fake.collection("events").insertOne(
			seedEvent({
				eventId: "evt-old",
				timestamp: daysBefore(120),
				idempotencyKey: "key-old",
				idempotencyFingerprint: "fp-old",
			}),
		)

		const first = await manager.pruneIdempotencyFingerprints({
			olderThanDays: 90,
			force: true,
		})
		expect(first.pruned).toBe(1)
		expect(
			fake.findDoc("events", { eventId: "evt-old" })?.idempotencyKey,
		).toBeUndefined()

		// A new prunable event arrives; the un-forced sweep is gated off and
		// must not touch the database.
		await fake.collection("events").insertOne(
			seedEvent({
				eventId: "evt-old-2",
				timestamp: daysBefore(120),
				idempotencyKey: "key-old-2",
				idempotencyFingerprint: "fp-old-2",
			}),
		)
		const gated = await manager.pruneIdempotencyFingerprints({
			olderThanDays: 90,
		})
		expect(gated.pruned).toBe(0)
		expect(
			fake.findDoc("events", { eventId: "evt-old-2" })?.idempotencyKey,
		).toBe("key-old-2")

		// force bypasses the gate.
		const forced = await manager.pruneIdempotencyFingerprints({
			olderThanDays: 90,
			force: true,
		})
		expect(forced.pruned).toBe(1)
		expect(
			fake.findDoc("events", { eventId: "evt-old-2" })?.idempotencyKey,
		).toBeUndefined()
	})

	it("swallows prune failures so the worker drain never blocks", async () => {
		await fake.collection("events").insertOne(
			seedEvent({
				eventId: "evt-old",
				timestamp: daysBefore(120),
				idempotencyKey: "key-old",
				idempotencyFingerprint: "fp-old",
			}),
		)
		fake.injectFailure({
			collection: "events",
			method: "updateMany",
			error: new Error("simulated prune failure"),
		})

		const result = await manager.pruneIdempotencyFingerprints({
			olderThanDays: 90,
			force: true,
		})
		expect(result).toEqual({ pruned: 0 })
	})
})

describe("pruneIdempotencyFingerprints — worker drain wiring", () => {
	it("drainMemoryJobQueue awaits the prune after outbox repair", async () => {
		const repairExtractionOutbox = vi.fn(async () => ({
			eventsProcessed: 0,
			jobsCreated: 0,
			jobsReleased: 0,
			eventsFailed: 0,
		}))
		const pruneSpy = vi.fn(async () => ({ pruned: 0 }))
		const manager = Object.assign(
			Object.create(MongoDBMemoryManager.prototype),
			{
				db: {} as import("mongodb").Db,
				prefix: PREFIX,
				agentId: AGENT,
				client: undefined,
				memoryJobWorkerStopped: true,
				memoryJobOperationContexts: new Map(),
				repairExtractionOutbox,
				pruneIdempotencyFingerprints: pruneSpy,
			},
		) as MongoDBMemoryManager

		const drain = (
			MongoDBMemoryManager.prototype as unknown as {
				drainMemoryJobQueue: (this: MongoDBMemoryManager) => Promise<void>
			}
		).drainMemoryJobQueue
		await drain.call(manager)

		expect(repairExtractionOutbox).toHaveBeenCalledTimes(1)
		expect(pruneSpy).toHaveBeenCalledTimes(1)
	})
})
