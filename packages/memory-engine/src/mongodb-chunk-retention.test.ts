// C-005: chunk retention lifecycle. Chunks inherit the expiry of the event
// they were projected from (absent = never expires), a partial TTL index
// deletes expired chunks server-side, and every conversation-chunk read
// surface composes an unexpired guard so expired chunks stop surfacing
// immediately instead of waiting for the ~60s TTL sweep lag. Coverage:
//   - projectEventChunk / projectEventChunksBatch propagate expiresAt onto
//     the chunk (stateful fake IS the database) and HEAL chunks that an
//     older path wrote without one (re-projection re-asserts via $set)
//   - projectConversationWindows excludes expired events from window text
//     and stamps each window with the LATEST expiry among its events (a
//     window embedding any never-expiring event is permanent)
//   - buildConversationChunkFilter / buildBridgeChunkFilter compose the
//     unexpired clause and functionally hide expired chunks on a real
//     find() against the fake
//   - readConversationChunk / readBridgeChunk / repairExtractionOutbox —
//     the direct-read and outbox-repair surfaces carry the same guard /
//     propagation (round-1 refutation defects 1-5)
//   - session-evidence docs (benchmark lanes) inherit the latest
//     source-event expiry via resolveSessionEvidenceExpiresAt (defect 6)
//   - CHUNKS_SCHEMA accepts the optional expiresAt on the traditional variant
import { describe, expect, it, vi } from "vitest"
import {
	projectEventChunk,
	projectEventChunksBatch,
	type CanonicalEvent,
} from "./mongodb-events.js"
import { projectConversationWindows } from "./mongodb-conversation-windows.js"
import { MongoDBManagerSearchOps } from "./mongodb-manager-search.js"
import { MongoDBManagerReadOps } from "./mongodb-manager-read.js"
import { MongoDBManagerSyncOps } from "./mongodb-manager-sync.js"
import {
	buildSessionEvidenceDocuments,
	resolveSessionEvidenceExpiresAt,
} from "./mongodb-session-evidence.js"
import type { MongoDBManagerHost } from "./mongodb-manager-host.js"
import { CHUNKS_SCHEMA } from "./mongodb-schema-validator-knowledge.js"
import { createStatefulMongoFake } from "./test-helpers/stateful-mongo-fake.js"

// The outbox-repair path runs entity extraction; covered by its own suites.
vi.mock("./mongodb-graph.js", async (importOriginal) => {
	const actual = await importOriginal()
	return {
		...actual,
		extractAndUpsertEntities: vi.fn(async () => ({ entities: [] })),
	}
})

const PREFIX = "test_"
const AGENT = "agent-1"

function makeEvent(params: {
	eventId: string
	expiresAt?: Date
	timestamp?: Date
}): CanonicalEvent {
	return {
		eventId: params.eventId,
		agentId: AGENT,
		role: "user",
		body: `body for ${params.eventId}`,
		scope: "session",
		scopeRef: "session:s-1",
		sessionId: "s-1",
		timestamp: params.timestamp ?? new Date("2026-08-03T10:00:00.000Z"),
		...(params.expiresAt ? { expiresAt: params.expiresAt } : {}),
	}
}

describe("projectEventChunk — expiresAt propagation (C-005)", () => {
	it("carries the event expiry onto the projected chunk", async () => {
		const fake = createStatefulMongoFake({ prefix: PREFIX })
		const expiresAt = new Date("2026-09-01T00:00:00.000Z")

		await projectEventChunk({
			db: fake.db,
			prefix: PREFIX,
			event: makeEvent({ eventId: "evt-expiring", expiresAt }),
		})

		const chunk = fake.findDoc("chunks", { path: "events/evt-expiring" })
		expect(chunk).toBeTruthy()
		expect(chunk?.expiresAt).toEqual(expiresAt)
	})

	it("omits expiresAt entirely when the event never expires", async () => {
		const fake = createStatefulMongoFake({ prefix: PREFIX })

		await projectEventChunk({
			db: fake.db,
			prefix: PREFIX,
			event: makeEvent({ eventId: "evt-permanent" }),
		})

		const chunk = fake.findDoc("chunks", { path: "events/evt-permanent" })
		expect(chunk).toBeTruthy()
		expect("expiresAt" in (chunk ?? {})).toBe(false)
	})
})

describe("projectEventChunksBatch — expiresAt propagation (C-005)", () => {
	it("propagates expiry per chunk in a mixed batch", async () => {
		const fake = createStatefulMongoFake({ prefix: PREFIX })
		const expiresAt = new Date("2026-09-01T00:00:00.000Z")

		const results = await projectEventChunksBatch({
			db: fake.db,
			prefix: PREFIX,
			events: [
				makeEvent({ eventId: "evt-batch-expiring", expiresAt }),
				makeEvent({ eventId: "evt-batch-permanent" }),
			],
			recordRun: false,
		})

		expect(results.map((r) => r.chunkCreated)).toEqual([true, true])
		const expiring = fake.findDoc("chunks", {
			path: "events/evt-batch-expiring",
		})
		expect(expiring?.expiresAt).toEqual(expiresAt)
		const permanent = fake.findDoc("chunks", {
			path: "events/evt-batch-permanent",
		})
		expect("expiresAt" in (permanent ?? {})).toBe(false)
	})
})

describe("buildConversationChunkFilter — unexpired guard (C-005)", () => {
	const searchOps = new MongoDBManagerSearchOps({
		agentId: AGENT,
	} as unknown as MongoDBManagerHost)

	it("composes the unexpired clause with the tenant filter", () => {
		const filter = searchOps.buildConversationChunkFilter({
			scope: "session",
			scopeRef: "session:s-1",
		})
		expect(filter).toMatchObject({
			$and: [
				{
					source: { $in: expect.arrayContaining(["conversation"]) },
					agentId: AGENT,
					scope: "session",
					scopeRef: "session:s-1",
					status: { $ne: "deleted" },
				},
				{
					$or: [
						{ expiresAt: { $exists: false } },
						{ expiresAt: { $gt: expect.any(Date) } },
					],
				},
			],
		})
	})

	it("hides expired chunks on a real find while keeping live and no-expiry chunks", async () => {
		const fake = createStatefulMongoFake({ prefix: PREFIX })
		const now = new Date()
		await fake.collection("chunks").insertMany([
			{
				path: "events/evt-live",
				text: "live chunk",
				hash: "h-live",
				source: "conversation",
				agentId: AGENT,
				scope: "session",
				scopeRef: "session:s-1",
				status: "active",
				updatedAt: now,
				expiresAt: new Date(now.getTime() + 86_400_000),
			},
			{
				path: "events/evt-expired",
				text: "expired chunk",
				hash: "h-expired",
				source: "conversation",
				agentId: AGENT,
				scope: "session",
				scopeRef: "session:s-1",
				status: "active",
				updatedAt: now,
				// Already past: the TTL sweep (lagging ~60s) has not deleted it
				// yet — the read guard must hide it anyway.
				expiresAt: new Date(now.getTime() - 1_000),
			},
			{
				path: "events/evt-no-expiry",
				text: "no-expiry chunk",
				hash: "h-no-expiry",
				source: "conversation",
				agentId: AGENT,
				scope: "session",
				scopeRef: "session:s-1",
				status: "active",
				updatedAt: now,
			},
			{
				path: "events/evt-other-tenant",
				text: "other tenant chunk",
				hash: "h-other",
				source: "conversation",
				agentId: "agent-2",
				scope: "session",
				scopeRef: "session:s-2",
				status: "active",
				updatedAt: now,
			},
		])

		const filter = searchOps.buildConversationChunkFilter({
			scope: "session",
			scopeRef: "session:s-1",
		})
		const visible = await fake.collection("chunks").find(filter).toArray()
		const paths = visible.map((doc) => doc.path).sort()

		expect(paths).toEqual(["events/evt-live", "events/evt-no-expiry"])
	})
})

describe("CHUNKS_SCHEMA — optional expiresAt (C-005)", () => {
	it("accepts expiresAt as an optional date on the traditional chunk variant", () => {
		const schema = CHUNKS_SCHEMA.$jsonSchema as {
			oneOf: Array<{ properties: Record<string, { bsonType?: string }> }>
		}
		const traditional = schema.oneOf.find((variant) => variant.properties.path)
		expect(traditional).toBeTruthy()
		expect(traditional?.properties.expiresAt?.bsonType).toBe("date")
		// Optional: not in the required list.
		const traditionalRequired = (
			CHUNKS_SCHEMA.$jsonSchema as {
				oneOf: Array<{ required?: string[] }>
			}
		).oneOf.find((variant) => variant.properties?.path)?.required
		expect(traditionalRequired).not.toContain("expiresAt")
	})
})

describe("projectEventChunk — self-heal of expiry-less chunks (C-005 r1 defect 7)", () => {
	it("backfills expiresAt onto an existing chunk written without one", async () => {
		const fake = createStatefulMongoFake({ prefix: PREFIX })
		const expiresAt = new Date("2026-09-01T00:00:00.000Z")

		// An older projection path (pre-C-005 manager handoff) created the
		// chunk WITHOUT the expiry even though the event carries one.
		await fake.collection("chunks").insertOne({
			path: "events/evt-heal",
			text: "stale immortal chunk",
			hash: "h-stale",
			source: "conversation",
			agentId: AGENT,
			scope: "session",
			scopeRef: "session:s-1",
			sessionId: "s-1",
			timestamp: new Date("2026-08-03T10:00:00.000Z"),
			updatedAt: new Date("2026-08-03T10:00:00.000Z"),
			status: "active",
		})

		await projectEventChunk({
			db: fake.db,
			prefix: PREFIX,
			event: makeEvent({ eventId: "evt-heal", expiresAt }),
		})

		const chunk = fake.findDoc("chunks", { path: "events/evt-heal" })
		expect(chunk?.expiresAt).toEqual(expiresAt)
		// Re-projection does not duplicate the chunk.
		const all = await fake.collection("chunks").find({}).toArray()
		expect(all).toHaveLength(1)
	})

	it("batch re-projection backfills expiresAt the same way", async () => {
		const fake = createStatefulMongoFake({ prefix: PREFIX })
		const expiresAt = new Date("2026-09-01T00:00:00.000Z")

		await fake.collection("chunks").insertOne({
			path: "events/evt-batch-heal",
			text: "stale immortal chunk",
			hash: "h-stale",
			source: "conversation",
			agentId: AGENT,
			scope: "session",
			scopeRef: "session:s-1",
			sessionId: "s-1",
			timestamp: new Date("2026-08-03T10:00:00.000Z"),
			updatedAt: new Date("2026-08-03T10:00:00.000Z"),
			status: "active",
		})

		const results = await projectEventChunksBatch({
			db: fake.db,
			prefix: PREFIX,
			events: [makeEvent({ eventId: "evt-batch-heal", expiresAt })],
			recordRun: false,
		})

		expect(results.map((r) => r.chunkCreated)).toEqual([false])
		const chunk = fake.findDoc("chunks", {
			path: "events/evt-batch-heal",
		})
		expect(chunk?.expiresAt).toEqual(expiresAt)
	})
})

describe("projectConversationWindows — expiry propagation (C-005 r1 defect 4)", () => {
	function seedEvents(
		fake: ReturnType<typeof createStatefulMongoFake>,
		events: Array<{ eventId: string; body: string; expiresAt?: Date }>,
	) {
		const base = new Date("2026-08-03T10:00:00.000Z")
		return fake.collection("events").insertMany(
			events.map((e, i) => ({
				eventId: e.eventId,
				agentId: AGENT,
				sessionId: "s-win",
				role: "user",
				body: e.body,
				scope: "session",
				scopeRef: "session:s-win",
				timestamp: new Date(base.getTime() + i * 60_000),
				updatedAt: new Date(base.getTime() + i * 60_000),
				...(e.expiresAt ? { expiresAt: e.expiresAt } : {}),
			})),
		)
	}

	it("stamps a window with the LATEST expiry among its events", async () => {
		const fake = createStatefulMongoFake({ prefix: PREFIX })
		// Dynamic future dates: the fetch composes the unexpired guard against
		// the real clock, so static fixture dates would read as already expired.
		const early = new Date(Date.now() + 86_400_000)
		const late = new Date(Date.now() + 15 * 86_400_000)
		await seedEvents(
			fake,
			[1, 2, 3, 4, 5, 6, 7].map((n) => ({
				eventId: `evt-w${n}`,
				body: `window body ${n}`,
				expiresAt: n === 5 ? late : early,
			})),
		)

		const { windowsCreated } = await projectConversationWindows({
			db: fake.db,
			prefix: PREFIX,
			agentId: AGENT,
			sessionId: "s-win",
			scope: "session",
			scopeRef: "session:s-win",
		})

		expect(windowsCreated).toBeGreaterThan(0)
		const window = fake.findDoc("chunks", {
			path: "windows/s-win/0",
		})
		expect(window?.expiresAt).toEqual(late)
	})

	it("keeps a window permanent when any of its events never expires", async () => {
		const fake = createStatefulMongoFake({ prefix: PREFIX })
		await seedEvents(
			fake,
			[1, 2, 3, 4, 5, 6, 7].map((n) => ({
				eventId: `evt-m${n}`,
				body: `mixed body ${n}`,
				// Event 3 is permanent → the whole window is permanent.
				expiresAt: n === 3 ? undefined : new Date(Date.now() + 86_400_000),
			})),
		)

		await projectConversationWindows({
			db: fake.db,
			prefix: PREFIX,
			agentId: AGENT,
			sessionId: "s-win",
			scope: "session",
			scopeRef: "session:s-win",
		})

		const window = fake.findDoc("chunks", {
			path: "windows/s-win/0",
		})
		expect("expiresAt" in (window ?? {})).toBe(false)
	})

	it("excludes already-expired events from window text", async () => {
		const fake = createStatefulMongoFake({ prefix: PREFIX })
		const now = new Date()
		await seedEvents(fake, [
			...[1, 2, 3, 4, 5, 6].map((n) => ({
				eventId: `evt-x${n}`,
				body: `live body ${n}`,
				expiresAt: new Date(now.getTime() + 86_400_000),
			})),
			{
				// Already expired: the events TTL sweep lags, so the doc is
				// still there — the window fetch must exclude it anyway.
				eventId: "evt-x-dead",
				body: "dead body",
				expiresAt: new Date(now.getTime() - 1_000),
			},
		])

		const { windowsCreated } = await projectConversationWindows({
			db: fake.db,
			prefix: PREFIX,
			agentId: AGENT,
			sessionId: "s-win",
			scope: "session",
			scopeRef: "session:s-win",
		})

		expect(windowsCreated).toBeGreaterThan(0)
		const window = fake.findDoc("chunks", {
			path: "windows/s-win/0",
		})
		const text = typeof window?.text === "string" ? window.text : ""
		expect(text).toContain("live body 1")
		expect(text).not.toContain("dead body")
	})
})

describe("buildBridgeChunkFilter — unexpired guard (C-005 r1 defect 5)", () => {
	const WORKSPACE = "workspace:ws-1"
	const searchOps = new MongoDBManagerSearchOps({
		agentId: AGENT,
		workspaceScopeRef: WORKSPACE,
	} as unknown as MongoDBManagerHost)

	it("composes the unexpired clause with the bridge filter", () => {
		const filter = searchOps.buildBridgeChunkFilter()
		expect(filter).toMatchObject({
			$and: [
				{
					source: { $in: ["conversation", "memory"] },
					agentId: AGENT,
					scope: "workspace",
					scopeRef: WORKSPACE,
					status: { $ne: "deleted" },
				},
				{
					$or: [
						{ expiresAt: { $exists: false } },
						{ expiresAt: { $gt: expect.any(Date) } },
					],
				},
			],
		})
	})

	it("hides expired bridge chunks on a real find", async () => {
		const fake = createStatefulMongoFake({ prefix: PREFIX })
		const now = new Date()
		await fake.collection("chunks").insertMany([
			{
				path: "windows/s-win/0",
				text: "live window",
				hash: "h-live-w",
				source: "conversation",
				agentId: AGENT,
				scope: "workspace",
				scopeRef: WORKSPACE,
				status: "active",
				updatedAt: now,
				expiresAt: new Date(now.getTime() + 86_400_000),
			},
			{
				path: "windows/s-old/0",
				text: "expired window",
				hash: "h-dead-w",
				source: "conversation",
				agentId: AGENT,
				scope: "workspace",
				scopeRef: WORKSPACE,
				status: "active",
				updatedAt: now,
				expiresAt: new Date(now.getTime() - 1_000),
			},
		])

		const filter = searchOps.buildBridgeChunkFilter()
		const visible = await fake.collection("chunks").find(filter).toArray()
		expect(visible.map((doc) => doc.path)).toEqual(["windows/s-win/0"])
	})
})

describe("direct chunk readers — unexpired guard (C-005 r1 defect 5)", () => {
	const WORKSPACE = "workspace:ws-1"
	function buildReadOps(fake: ReturnType<typeof createStatefulMongoFake>) {
		const host = {
			db: fake.db,
			prefix: PREFIX,
			agentId: AGENT,
			workspaceScopeRef: WORKSPACE,
		} as unknown as MongoDBManagerHost
		const ops = new MongoDBManagerReadOps(host)
		// readConversationChunk delegates the events/ miss to the host method.
		host.readCanonicalEvent = (eventId: string, rawPath: string) =>
			ops.readCanonicalEvent(eventId, rawPath)
		return ops
	}

	it("readConversationChunk hides an expired conversation chunk", async () => {
		const fake = createStatefulMongoFake({ prefix: PREFIX })
		const now = new Date()
		await fake.collection("chunks").insertMany([
			{
				path: "events/evt-r-live",
				text: "live chunk text",
				hash: "h-r-live",
				source: "conversation",
				agentId: AGENT,
				scope: "session",
				scopeRef: "session:s-1",
				sessionId: "s-1",
				status: "active",
				updatedAt: now,
				expiresAt: new Date(now.getTime() + 86_400_000),
			},
			{
				path: "events/evt-r-dead",
				text: "expired chunk text",
				hash: "h-r-dead",
				source: "conversation",
				agentId: AGENT,
				scope: "session",
				scopeRef: "session:s-1",
				sessionId: "s-1",
				status: "active",
				updatedAt: now,
				expiresAt: new Date(now.getTime() - 1_000),
			},
		])

		const ops = buildReadOps(fake)
		const live = await ops.readConversationChunk("events/evt-r-live")
		const dead = await ops.readConversationChunk("events/evt-r-dead")

		expect(live.text).toContain("live chunk text")
		// Expired chunk hidden AND its event (never written) hidden — empty.
		expect(dead.text).toBe("")
	})

	it("readConversationChunk still applies the line-range clause with the guard", async () => {
		const fake = createStatefulMongoFake({ prefix: PREFIX })
		const now = new Date()
		await fake.collection("chunks").insertOne({
			path: "sessions/s-1/turn-1",
			text: "range chunk text",
			hash: "h-range",
			source: "sessions",
			agentId: AGENT,
			scope: "session",
			scopeRef: "session:s-1",
			sessionId: "s-1",
			status: "active",
			updatedAt: now,
			startLine: 3,
			endLine: 8,
			expiresAt: new Date(now.getTime() + 86_400_000),
		})

		const ops = buildReadOps(fake)
		const inRange = await ops.readConversationChunk("sessions/s-1/turn-1", 4, 2)
		const outOfRange = await ops.readConversationChunk(
			"sessions/s-1/turn-1",
			20,
			5,
		)

		expect(inRange.text).toContain("range chunk text")
		expect(outOfRange.text).toBe("")
	})

	it("readBridgeChunk hides an expired bridge chunk", async () => {
		const fake = createStatefulMongoFake({ prefix: PREFIX })
		const now = new Date()
		await fake.collection("chunks").insertMany([
			{
				path: "windows/s-win/0",
				text: "live bridge text",
				hash: "h-b-live",
				source: "conversation",
				agentId: AGENT,
				scope: "workspace",
				scopeRef: WORKSPACE,
				status: "active",
				updatedAt: now,
				expiresAt: new Date(now.getTime() + 86_400_000),
			},
			{
				path: "windows/s-old/0",
				text: "expired bridge text",
				hash: "h-b-dead",
				source: "conversation",
				agentId: AGENT,
				scope: "workspace",
				scopeRef: WORKSPACE,
				status: "active",
				updatedAt: now,
				expiresAt: new Date(now.getTime() - 1_000),
			},
		])

		const ops = buildReadOps(fake)
		const live = await ops.readBridgeChunk("windows/s-win/0")
		const dead = await ops.readBridgeChunk("windows/s-old/0")

		expect(live.text).toContain("live bridge text")
		expect(dead.text).toBe("")
	})
})

describe("repairExtractionOutbox — expiry propagation (C-005 r1 defect 3)", () => {
	it("projects the chunk with the STORED event expiry", async () => {
		const fake = createStatefulMongoFake({ prefix: PREFIX })
		// Future date: getPendingExtractionEvents composes the unexpired
		// guard against the real clock.
		const expiresAt = new Date(Date.now() + 86_400_000)
		const pendingAt = new Date("2026-08-03T10:00:00.000Z")
		await fake.collection("events").insertOne({
			eventId: "evt-outbox",
			agentId: AGENT,
			sessionId: "s-1",
			role: "user",
			body: "outbox body",
			scope: "session",
			scopeRef: "session:s-1",
			timestamp: pendingAt,
			updatedAt: pendingAt,
			expiresAt,
			extractionJobPendingAt: pendingAt,
			projected: false,
		})

		const ops = new MongoDBManagerSyncOps({
			db: fake.db,
			prefix: PREFIX,
			agentId: AGENT,
			chunkCount: 0,
			closed: false,
			syncing: null,
			isDuplicateKeyError: () => false,
		} as unknown as MongoDBManagerHost)

		const receipt = await ops.repairExtractionOutbox({ limit: 10 })
		expect(receipt.eventsProcessed).toBe(1)

		const chunk = fake.findDoc("chunks", { path: "events/evt-outbox" })
		expect(chunk?.expiresAt).toEqual(expiresAt)
	})
})

describe("session evidence — expiry propagation (C-005 r1 defect 6)", () => {
	const CONVERSATIONS = [
		{
			sessionId: "s-evi-a",
			topic: "alpha",
			turns: [
				{
					role: "user",
					body: "session alpha user turn",
					timestamp: "2026-08-03T10:00:00.000Z",
				},
			],
		},
		{
			sessionId: "s-evi-b",
			topic: "beta",
			turns: [
				{
					role: "user",
					body: "session beta user turn",
					timestamp: "2026-08-03T11:00:00.000Z",
				},
			],
		},
	] as Parameters<typeof buildSessionEvidenceDocuments>[0]["conversations"]

	it("resolveSessionEvidenceExpiresAt maps each session to its latest source-event expiry", async () => {
		const fake = createStatefulMongoFake({ prefix: PREFIX })
		const early = new Date("2026-09-01T00:00:00.000Z")
		const late = new Date("2026-09-15T00:00:00.000Z")
		await fake.collection("events").insertMany([
			{
				eventId: "ev-a1",
				agentId: AGENT,
				expiresAt: early,
			},
			{ eventId: "ev-a2", agentId: AGENT, expiresAt: late },
			// Session B has one never-expiring event → no entry (permanent).
			{ eventId: "ev-b1", agentId: AGENT },
		])

		const map = await resolveSessionEvidenceExpiresAt({
			db: fake.db,
			prefix: PREFIX,
			agentId: AGENT,
			sessionEventMap: new Map([
				["s-evi-a", ["ev-a1", "ev-a2"]],
				["s-evi-b", ["ev-b1"]],
			]),
		})

		expect(map.get("s-evi-a")).toEqual(late)
		expect(map.has("s-evi-b")).toBe(false)
	})

	it("carries the resolved expiry onto the session-evidence documents", () => {
		const late = new Date("2026-09-15T00:00:00.000Z")
		const docs = buildSessionEvidenceDocuments({
			conversations: CONVERSATIONS,
			agentId: AGENT,
			scope: "agent",
			scopeRef: "agent:agent-1",
			eventIds: new Map([
				["s-evi-a", ["ev-a1", "ev-a2"]],
				["s-evi-b", ["ev-b1"]],
			]),
			sessionExpiresAt: new Map([["s-evi-a", late]]),
		})

		const alpha = docs.find((doc) => doc.sessionId === "s-evi-a")
		const beta = docs.find((doc) => doc.sessionId === "s-evi-b")
		expect(alpha?.expiresAt).toEqual(late)
		expect("expiresAt" in (beta ?? {})).toBe(false)
	})

	it("omits expiresAt when no expiry map is provided (legacy callers)", () => {
		const docs = buildSessionEvidenceDocuments({
			conversations: CONVERSATIONS,
			agentId: AGENT,
			scope: "agent",
			scopeRef: "agent:agent-1",
			eventIds: new Map([["s-evi-a", ["ev-a1"]]]),
		})
		for (const doc of docs) {
			expect("expiresAt" in doc).toBe(false)
		}
	})
})
