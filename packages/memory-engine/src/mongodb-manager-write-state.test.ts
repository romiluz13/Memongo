// P4.2 stateful write-path tests. The seam suite (mongodb-manager-write.test.ts)
// mocks every collection accessor and asserts call wiring; these tests drive
// writeConversationEvent / writeConversationEventsBatch against the stateful
// Mongo fake — the fake IS the database — and assert collection STATE:
// event/chunk/job/lane-coverage documents, idempotency replay, and the P0.1
// post-persist-failure regression.
//
// Still stubbed (in-process derived-work seams, not collection accessors):
//   - extractAndUpsertEntities (graph subsystem; covered by its own suites)
//   - schedulePostWriteDerivations / scheduleQueryCacheInvalidation /
//     memory-job worker start+wake (facade scheduling queues)
import { createHash } from "node:crypto"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { MongoDBMemoryManager } from "./mongodb-manager.js"
import { isIdempotencyConflictError } from "./mongodb-events.js"
import {
	buildMockManager,
	captureManagerPrototype,
} from "./test-helpers/manager-test-kit.js"
import { createStatefulMongoFake } from "./test-helpers/stateful-mongo-fake.js"

vi.mock("./mongodb-graph.js", async (importOriginal) => {
	const actual = await importOriginal()
	return {
		...actual,
		extractAndUpsertEntities: vi.fn(async () => ({ entities: [] })),
	}
})

captureManagerPrototype(MongoDBMemoryManager)

const PREFIX = "test_"
const AGENT = "agent-1"

function buildStatefulManager(
	fake: ReturnType<typeof createStatefulMongoFake>,
) {
	return buildMockManager({
		db: fake.db,
		prefix: PREFIX,
		agentId: AGENT,
		closed: false,
		memoryJobWorkerStopped: true,
		memoryJobRunContexts: new Map(),
		// In-process scheduling seams: stubbed so the test surface stays the
		// durable write path. Everything that touches a collection runs for
		// real against the fake.
		shouldRunPostWriteDerivedWork: () => true,
		startMemoryJobWorker: vi.fn(),
		wakeMemoryJobWorker: vi.fn(),
		schedulePostWriteDerivations: vi.fn(async () => {}),
		scheduleQueryCacheInvalidation: vi.fn(),
	})
}

function sha256(text: string): string {
	return createHash("sha256").update(text).digest("hex")
}

describe("writeConversationEvent — collection state", () => {
	let fake: ReturnType<typeof createStatefulMongoFake>
	let manager: MongoDBMemoryManager

	beforeEach(() => {
		fake = createStatefulMongoFake({ prefix: PREFIX })
		manager = buildStatefulManager(fake)
	})

	it("persists the canonical event, projects the chunk, stages+releases the extraction job, and aggregates lane coverage", async () => {
		const receipt = await manager.writeConversationEvent({
			role: "user",
			body: "remember: the release train ships on Tuesdays",
			sessionId: "s-1",
			idempotencyKey: "key-1",
			timestamp: new Date("2026-08-03T10:00:00.000Z"),
		})

		expect(receipt.chunkCreated).toBe(true)

		// --- events collection state ---
		const events = fake.all("events")
		expect(events).toHaveLength(1)
		const event = events[0]
		expect(event.eventId).toBe(receipt.eventId)
		expect(event.agentId).toBe(AGENT)
		expect(event.role).toBe("user")
		expect(event.body).toBe("remember: the release train ships on Tuesdays")
		// P2.3: an implicit sessionId lands the write in session scope.
		expect(event.scope).toBe("session")
		expect(event.scopeRef).toBe("session:s-1")
		expect(event.sessionId).toBe("s-1")
		expect(event.idempotencyKey).toBe("key-1")
		expect(event.timestamp).toEqual(new Date("2026-08-03T10:00:00.000Z"))
		expect(event.validAt).toEqual(new Date("2026-08-03T10:00:00.000Z"))
		expect(event.recordedAt).toBeInstanceOf(Date)
		// Projection marker set; extraction outbox marker cleared once the job
		// became claimable.
		expect(event.projectedAt).toBeInstanceOf(Date)
		expect(event.extractionJobPendingAt).toBeUndefined()

		// --- chunk projection state ---
		const chunks = fake.all("chunks")
		expect(chunks).toHaveLength(1)
		const chunk = chunks[0]
		expect(chunk.path).toBe(`events/${receipt.eventId}`)
		expect(chunk.text).toBe(
			"User: remember: the release train ships on Tuesdays",
		)
		expect(chunk.hash).toBe(sha256(chunk.text as string))
		expect(chunk.source).toBe("conversation")
		expect(chunk.agentId).toBe(AGENT)
		expect(chunk.scope).toBe("session")
		expect(chunk.scopeRef).toBe("session:s-1")
		expect(chunk.sessionId).toBe("s-1")
		expect(chunk.timestamp).toEqual(new Date("2026-08-03T10:00:00.000Z"))

		// --- extraction job state ---
		const jobs = fake.all("memory_jobs")
		expect(jobs).toHaveLength(1)
		const job = jobs[0]
		expect(job.jobId).toBe(`extraction-${receipt.eventId}`)
		expect(job.jobType).toBe("extraction")
		expect(job.status).toBe("pending")
		// Staged through the outbox, then released.
		expect(job.stagedAt).toBeUndefined()
		expect(job.metadata).toEqual({ eventId: receipt.eventId })
		expect(job.payload).toEqual({
			eventId: receipt.eventId,
			scope: "session",
			scopeRef: "session:s-1",
		})

		// --- lane coverage aggregates ---
		const coverage = fake.all("lane_coverage")
		expect(coverage).toHaveLength(1)
		const lanes = coverage[0].lanes as Record<
			string,
			{ count: number; hasData: boolean }
		>
		expect(lanes["raw-window"].count).toBe(1)
		expect(lanes.hybrid.count).toBe(1)
		// "remember: …" yields one regex structured candidate (P3.9 counting).
		expect(lanes.structured.count).toBeGreaterThanOrEqual(1)
		expect(lanes["raw-window"].hasData).toBe(true)
	})

	it("replays the original receipt for a duplicate idempotency key — the collection holds exactly ONE event", async () => {
		const input = {
			role: "user" as const,
			body: "hello world",
			idempotencyKey: "key-dup",
		}
		const first = await manager.writeConversationEvent(input)
		const second = await manager.writeConversationEvent(input)

		expect(second.eventId).toBe(first.eventId)
		// The chunk from the accepted write already exists; a replay creates none.
		expect(second.chunkCreated).toBe(false)

		expect(fake.all("events")).toHaveLength(1)
		expect(fake.all("chunks")).toHaveLength(1)
		expect(fake.all("memory_jobs")).toHaveLength(1)
	})

	it("rejects key reuse with a different payload (IdempotencyConflictError) and stores nothing new", async () => {
		await manager.writeConversationEvent({
			role: "user",
			body: "original payload",
			idempotencyKey: "key-conflict",
		})

		const conflict = await manager
			.writeConversationEvent({
				role: "user",
				body: "different payload",
				idempotencyKey: "key-conflict",
			})
			.catch((err: unknown) => err)

		expect(isIdempotencyConflictError(conflict)).toBe(true)
		expect(fake.all("events")).toHaveLength(1)
		expect(fake.all("chunks")).toHaveLength(1)
	})
})

describe("writeConversationEventsBatch — collection state", () => {
	let fake: ReturnType<typeof createStatefulMongoFake>
	let manager: MongoDBMemoryManager

	beforeEach(() => {
		fake = createStatefulMongoFake({ prefix: PREFIX })
		manager = buildStatefulManager(fake)
	})

	it("persists every event with per-item receipts and one aggregated lane-coverage update", async () => {
		const receipts = await manager.writeConversationEventsBatch([
			{ role: "user", body: "first turn", sessionId: "s-9" },
			{ role: "assistant", body: "second turn", sessionId: "s-9" },
			{ role: "user", body: "remember: batch lane coverage works" },
		])

		expect(receipts).toHaveLength(3)
		for (const receipt of receipts) {
			expect(receipt.ok).toBe(true)
			if (receipt.ok) {
				expect(receipt.chunkCreated).toBe(true)
			}
		}

		const events = fake.all("events")
		expect(events).toHaveLength(3)
		for (const event of events) {
			// Batch jobs are created directly claimable, so every outbox marker
			// is cleared by the batch cleanup pass.
			expect(event.extractionJobPendingAt).toBeUndefined()
			expect(event.projectedAt).toBeInstanceOf(Date)
		}
		const sessionEvents = events.filter((event) => event.sessionId === "s-9")
		expect(sessionEvents).toHaveLength(2)
		for (const event of sessionEvents) {
			expect(event.scope).toBe("session")
			expect(event.scopeRef).toBe("session:s-9")
		}

		const chunks = fake.all("chunks")
		expect(chunks).toHaveLength(3)
		expect(chunks.map((chunk) => chunk.path).sort()).toEqual(
			events.map((event) => `events/${event.eventId}`).sort(),
		)

		const jobs = fake.all("memory_jobs")
		expect(jobs).toHaveLength(3)
		for (const job of jobs) {
			expect(job.status).toBe("pending")
			expect(job.jobId).toMatch(/^extraction-/)
		}

		const coverage = fake.all("lane_coverage")
		expect(coverage).toHaveLength(1)
		const lanes = coverage[0].lanes as Record<string, { count: number }>
		expect(lanes["raw-window"].count).toBe(3)
		expect(lanes.hybrid.count).toBe(3)
		expect(lanes.structured.count).toBeGreaterThanOrEqual(1)
	})

	it("replays a pre-existing key inside the batch without duplicating the event", async () => {
		const original = await manager.writeConversationEvent({
			role: "user",
			body: "already stored",
			idempotencyKey: "key-existing",
		})

		const receipts = await manager.writeConversationEventsBatch([
			{ role: "user", body: "already stored", idempotencyKey: "key-existing" },
			{ role: "user", body: "brand new", idempotencyKey: "key-new" },
		])

		expect(receipts[0]).toEqual({
			ok: true,
			eventId: original.eventId,
			chunkCreated: false,
			replayed: true,
		})
		expect(receipts[1].ok).toBe(true)

		// One replayed + one new = two events total, not three.
		expect(fake.all("events")).toHaveLength(2)
		expect(
			fake
				.all("events")
				.filter((event) => event.idempotencyKey === "key-existing"),
		).toHaveLength(1)
	})

	it("collapses a duplicated key inside one batch via the unique index (E11000 → replay)", async () => {
		const item = {
			role: "user" as const,
			body: "same key twice in one batch",
			idempotencyKey: "key-twice",
		}
		const receipts = await manager.writeConversationEventsBatch([item, item])

		expect(receipts[0].ok).toBe(true)
		expect(receipts[1].ok).toBe(true)
		if (receipts[0].ok && receipts[1].ok) {
			expect(receipts[1].eventId).toBe(receipts[0].eventId)
			expect(receipts[1].replayed).toBe(true)
		}

		// The unique (agentId, idempotencyKey) index rejected the second
		// insert: exactly one event exists.
		expect(fake.all("events")).toHaveLength(1)
		expect(fake.all("chunks")).toHaveLength(1)
	})

	it("reports a per-item IDEMPOTENCY_CONFLICT for key reuse with a different payload", async () => {
		await manager.writeConversationEvent({
			role: "user",
			body: "original payload",
			idempotencyKey: "key-batch-conflict",
		})

		const receipts = await manager.writeConversationEventsBatch([
			{
				role: "user",
				body: "mutated payload",
				idempotencyKey: "key-batch-conflict",
			},
		])

		expect(receipts[0].ok).toBe(false)
		if (!receipts[0].ok) {
			expect(receipts[0].code).toBe("IDEMPOTENCY_CONFLICT")
		}
		expect(fake.all("events")).toHaveLength(1)
	})
})

describe("P0.1 regression — post-persist failure does not produce a client-visible duplicate", () => {
	it("a chunk-projection failure after the event insert surfaces, and the same-key retry replays instead of duplicating", async () => {
		const fake = createStatefulMongoFake({ prefix: PREFIX })
		const manager = buildStatefulManager(fake)

		// Fail exactly the chunk projection (chunks.updateOne) — AFTER the
		// event insert has committed. Non-transient, so no retry masks it.
		fake.injectFailure({
			collection: "chunks",
			method: "updateOne",
			error: new Error("injected chunk projection failure"),
		})

		const input = {
			role: "user" as const,
			body: "durable but unprojected",
			sessionId: "s-p01",
			idempotencyKey: "key-p01",
		}
		await expect(manager.writeConversationEvent(input)).rejects.toThrow(
			"injected chunk projection failure",
		)

		// The event is durable even though the write surfaced an error; the
		// extraction outbox marker is still set (the job was never released)
		// so the repair pass can recover it.
		const eventsAfterFailure = fake.all("events")
		expect(eventsAfterFailure).toHaveLength(1)
		const durableEvent = eventsAfterFailure[0]
		expect(durableEvent.idempotencyKey).toBe("key-p01")
		expect(durableEvent.extractionJobPendingAt).toBeInstanceOf(Date)
		expect(durableEvent.projectedAt).toBeUndefined()
		expect(fake.all("chunks")).toHaveLength(0)
		const stagedJobs = fake.all("memory_jobs")
		expect(stagedJobs).toHaveLength(1)
		expect(stagedJobs[0].stagedAt).toBeInstanceOf(Date)

		// The client retries with the SAME idempotency key (Stripe model).
		const retry = await manager.writeConversationEvent(input)

		// The retry observes the replayed receipt — no error, no duplicate.
		expect(retry.eventId).toBe(durableEvent.eventId)
		expect(retry.chunkCreated).toBe(false)
		expect(fake.all("events")).toHaveLength(1)
		// Replay does not re-project; the projection repair pass owns recovery.
		expect(fake.all("chunks")).toHaveLength(0)
	})
})

describe("stateful fake self-checks (semantics the P0/P2 paths rely on)", () => {
	it("enforces the partial unique (agentId, idempotencyKey) index with code 11000", async () => {
		const fake = createStatefulMongoFake({ prefix: PREFIX })
		const events = fake.collection("events")
		await events.insertOne({
			eventId: "e-1",
			agentId: AGENT,
			idempotencyKey: "k",
		})
		// Keyless writes never collide (partial index).
		await events.insertOne({ eventId: "e-2", agentId: AGENT })
		await events.insertOne({ eventId: "e-3", agentId: AGENT })

		const duplicate = await events
			.insertOne({ eventId: "e-4", agentId: AGENT, idempotencyKey: "k" })
			.catch((err: unknown) => err)
		expect((duplicate as { code?: number }).code).toBe(11000)
		expect(String((duplicate as Error).message)).toContain("E11000")
		// A different agent may reuse the same key (tenant-scoped uniqueness).
		await events.insertOne({
			eventId: "e-5",
			agentId: "agent-2",
			idempotencyKey: "k",
		})
	})

	it("honors $setOnInsert on upsert (second write does not overwrite)", async () => {
		const fake = createStatefulMongoFake({ prefix: PREFIX })
		const events = fake.collection("events")
		await events.updateOne(
			{ eventId: "e-1" },
			{ $setOnInsert: { eventId: "e-1", body: "first" } },
			{ upsert: true },
		)
		const second = await events.updateOne(
			{ eventId: "e-1" },
			{ $setOnInsert: { eventId: "e-1", body: "second" } },
			{ upsert: true },
		)
		expect(second.upsertedCount).toBe(0)
		expect(second.matchedCount).toBe(1)
		expect(fake.findDoc("events", { eventId: "e-1" })?.body).toBe("first")
	})

	it("applies aggregation-pipeline updates ($$NOW, $add, $unset stage)", async () => {
		const fake = createStatefulMongoFake({ prefix: PREFIX })
		const runs = fake.collection("consolidation_runs")
		const claimed = await runs.findOneAndUpdate(
			{ gateKey: "g-1" },
			[
				{
					$set: {
						gateKey: "g-1",
						status: "running",
						startedAt: "$$NOW",
						leaseExpiresAt: { $add: ["$$NOW", 60_000] },
					},
				},
				{ $unset: ["completedAt", "error"] },
			],
			{ upsert: true, returnDocument: "after" },
		)
		expect(claimed?.status).toBe("running")
		expect(claimed?.startedAt).toBeInstanceOf(Date)
		expect(claimed?.leaseExpiresAt).toBeInstanceOf(Date)
		// A second claim with a non-matching filter collides on the unique gate.
		const collision = await runs
			.findOneAndUpdate(
				{ gateKey: "g-1", status: "completed" },
				[{ $set: { gateKey: "g-1", status: "running" } }],
				{ upsert: true, returnDocument: "after" },
			)
			.catch((err: unknown) => err)
		expect((collision as { code?: number }).code).toBe(11000)
	})
})
