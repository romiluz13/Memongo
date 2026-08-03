/* eslint-disable @typescript-eslint/unbound-method -- Vitest mock method assertions */
import { describe, it, expect, vi, beforeEach } from "vitest"
import {
	MongoDBMemoryManager,
	writeEventAndProject,
} from "./mongodb-manager.js"
import { computeIdempotencyFingerprint } from "./mongodb-idempotency-fingerprint.js"
import { emitTelemetry } from "./mongodb-telemetry.js"
import { mocked, fakeDb, fakePrefix } from "./test-helpers/manager-test-kit.js"

vi.mock("./mongodb-events.js", async () =>
	(await import("./test-helpers/manager-test-kit.js")).eventsModuleMock(),
)

vi.mock("./benchmark-quality-contracts.js", async (importOriginal) =>
	(
		await import("./test-helpers/manager-test-kit.js")
	).benchmarkQualityContractsModuleMock(importOriginal),
)

vi.mock("./mongodb-conversation-recall.js", async () =>
	(
		await import("./test-helpers/manager-test-kit.js")
	).conversationRecallModuleMock(),
)

vi.mock("./mongodb-ops.js", async () =>
	(await import("./test-helpers/manager-test-kit.js")).opsModuleMock(),
)

vi.mock("./mongodb-benchmark-harness.js", async () =>
	(
		await import("./test-helpers/manager-test-kit.js")
	).benchmarkHarnessModuleMock(),
)

vi.mock("./mongodb-retrieval-planner.js", async () =>
	(
		await import("./test-helpers/manager-test-kit.js")
	).retrievalPlannerModuleMock(),
)

vi.mock("./mongodb-episodes.js", async () =>
	(await import("./test-helpers/manager-test-kit.js")).episodesModuleMock(),
)

vi.mock("./mongodb-graph.js", async () =>
	(await import("./test-helpers/manager-test-kit.js")).graphModuleMock(),
)

vi.mock("./mongodb-schema.js", async () =>
	(await import("./test-helpers/manager-test-kit.js")).schemaModuleMock(),
)

vi.mock("./mongodb-query-cache.js", async () =>
	(await import("./test-helpers/manager-test-kit.js")).queryCacheModuleMock(),
)

vi.mock("./mongodb-query-rewriter.js", async () =>
	(
		await import("./test-helpers/manager-test-kit.js")
	).queryRewriterModuleMock(),
)

vi.mock("./mongodb-reranker.js", async () =>
	(await import("./test-helpers/manager-test-kit.js")).rerankerModuleMock(),
)

vi.mock("./mongodb-lane-coverage.js", async () =>
	(await import("./test-helpers/manager-test-kit.js")).laneCoverageModuleMock(),
)

vi.mock("./mongodb-memory-jobs.js", async () =>
	(await import("./test-helpers/manager-test-kit.js")).memoryJobsModuleMock(),
)

vi.mock("./mongodb-consolidator.js", async () =>
	(await import("./test-helpers/manager-test-kit.js")).consolidatorModuleMock(),
)

vi.mock("./mongodb-derived-memory.js", async () =>
	(
		await import("./test-helpers/manager-test-kit.js")
	).derivedMemoryModuleMock(),
)

vi.mock("./mongodb-benchmark-readiness.js", async () =>
	(
		await import("./test-helpers/manager-test-kit.js")
	).benchmarkReadinessModuleMock(),
)

vi.mock("./mongodb-telemetry.js", async () =>
	(await import("./test-helpers/manager-test-kit.js")).telemetryModuleMock(),
)

const { writeEvent, projectEventChunk } = await import("./mongodb-events.js")
const { recordIngestRun } = await import("./mongodb-ops.js")

// ---------------------------------------------------------------------------
// 8.1: writeEventAndProject
// ---------------------------------------------------------------------------

// Covered by real-e2e-v2 E2E tests. This unit seam still depends
// on a stale module-mock architecture and should be rewritten around a fake Db.
describe("writeEventAndProject", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("calls writeEvent + projectEventChunk + recordIngestRun and returns result", async () => {
		mocked(writeEvent).mockResolvedValue({
			eventId: "evt-1",
			timestamp: new Date("2026-03-16T00:00:00.000Z"),
			scopeRef: "agent:agent-1",
		})
		mocked(projectEventChunk).mockResolvedValue({ chunkCreated: true })
		mocked(recordIngestRun).mockResolvedValue("run-1")

		const result = await writeEventAndProject(fakeDb, fakePrefix, {
			agentId: "agent-1",
			role: "user",
			body: "Hello world",
			scope: "agent",
		})

		expect(result.eventId).toBe("evt-1")
		expect(result.chunksCreated).toBe(1)

		expect(writeEvent).toHaveBeenCalledOnce()
		expect(projectEventChunk).toHaveBeenCalledOnce()
		expect(recordIngestRun).toHaveBeenCalledWith(
			expect.objectContaining({
				db: fakeDb,
				prefix: fakePrefix,
				run: expect.objectContaining({
					agentId: "agent-1",
					source: "event-write",
					status: "ok",
					itemsProcessed: 1,
					itemsFailed: 0,
				}),
			}),
		)
	})

	it("records failed ingest on error and re-throws", async () => {
		const error = new Error("write failed")
		mocked(writeEvent).mockRejectedValue(error)
		mocked(recordIngestRun).mockResolvedValue("run-fail")

		await expect(
			writeEventAndProject(fakeDb, fakePrefix, {
				agentId: "agent-1",
				role: "user",
				body: "Hello world",
				scope: "agent",
			}),
		).rejects.toThrow("write failed")

		// Should record a failed ingest run
		expect(recordIngestRun).toHaveBeenCalledWith(
			expect.objectContaining({
				run: expect.objectContaining({
					status: "failed",
					itemsProcessed: 0,
					itemsFailed: 1,
				}),
			}),
		)
	})

	it("swallows recordIngestRun failure in catch path to not mask real error", async () => {
		const realError = new Error("write failed")
		mocked(writeEvent).mockRejectedValue(realError)
		mocked(recordIngestRun).mockRejectedValue(
			new Error("ingest record also failed"),
		)

		await expect(
			writeEventAndProject(fakeDb, fakePrefix, {
				agentId: "agent-1",
				role: "user",
				body: "Hello world",
				scope: "agent",
			}),
		).rejects.toThrow("write failed")
	})

	it("rejects invalid scope values", async () => {
		await expect(
			writeEventAndProject(fakeDb, fakePrefix, {
				agentId: "agent-1",
				role: "user",
				body: "Hello world",
				scope: "invalid-scope",
			}),
		).rejects.toThrow("Invalid scope: invalid-scope")
	})

	it("rejects invalid role values", async () => {
		await expect(
			writeEventAndProject(fakeDb, fakePrefix, {
				agentId: "agent-1",
				role: "invalid-role",
				body: "Hello world",
				scope: "agent",
			}),
		).rejects.toThrow("Invalid role: invalid-role")
	})
})

// ---------------------------------------------------------------------------
// Telemetry emission from writeEventAndProject
// ---------------------------------------------------------------------------

describe("writeEventAndProject telemetry emission", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("emits event-write telemetry after successful write", async () => {
		const { writeEvent } = await import("./mongodb-events.js")
		const { projectEventChunk } = await import("./mongodb-events.js")
		const { recordIngestRun } = await import("./mongodb-ops.js")
		const { extractAndUpsertEntities } = await import("./mongodb-graph.js")

		mocked(writeEvent).mockResolvedValue({
			eventId: "evt-1",
			timestamp: new Date("2026-03-16T00:00:00.000Z"),
			scopeRef: "agent:agent-1",
		})
		mocked(projectEventChunk).mockResolvedValue({ chunkCreated: true })
		mocked(recordIngestRun).mockResolvedValue("run-1")
		mocked(extractAndUpsertEntities).mockResolvedValue({
			entities: [],
			relationsCreated: 0,
		})

		const fakeDb = { collection: vi.fn() } as unknown as import("mongodb").Db
		await writeEventAndProject(fakeDb, "test_", {
			agentId: "agent-1",
			role: "user",
			body: "Hello world",
			scope: "agent",
		})

		expect(emitTelemetry).toHaveBeenCalledWith(
			fakeDb,
			"test_",
			expect.objectContaining({
				meta: { agentId: "agent-1", operation: "event-write" },
				ok: true,
				eventType: "user",
				projectionTriggered: true,
				durationMs: expect.any(Number),
			}),
		)
	})
})

describe("MongoDBMemoryManager write idempotency (P0.1)", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	function makeManager() {
		return Object.assign(Object.create(MongoDBMemoryManager.prototype), {
			db: {} as import("mongodb").Db,
			prefix: "test_",
			agentId: "agent-1",
			client: undefined,
			config: {
				mongodb: {
					embeddingMode: "automated",
					episodes: { enabled: false, minEventsForEpisode: 6 },
				},
			},
			workspaceDir: "/tmp/memongo",
			writeQueue: Promise.resolve(),
			derivationQueue: Promise.resolve(),
			derivationSchedulingQueue: Promise.resolve(),
			memoryJobWorkerId: "worker-1",
			memoryJobWorkerStopped: false,
			memoryJobWorkerActive: false,
			memoryJobWorkerPromise: Promise.resolve(),
			memoryJobRunContexts: new Map(),
			chunkCount: 0,
			dirty: true,
		}) as MongoDBMemoryManager & {
			derivationSchedulingQueue: Promise<void>
			memoryJobWorkerPromise: Promise<void>
		}
	}

	async function mockWritePathDefaults() {
		const { writeEvent, projectEventChunk } = await import(
			"./mongodb-events.js"
		)
		const { extractAndUpsertEntities } = await import("./mongodb-graph.js")
		const { claimMemoryJob, createMemoryJob } = await import(
			"./mongodb-memory-jobs.js"
		)
		const { promoteDerivedMemoryFromEvent } = await import(
			"./mongodb-derived-memory.js"
		)
		mocked(writeEvent).mockResolvedValue({
			eventId: "evt-new-attempt",
			timestamp: new Date("2026-04-09T12:00:00.000Z"),
			scopeRef: "agent:agent-1",
		})
		mocked(projectEventChunk).mockResolvedValue({ chunkCreated: false })
		mocked(extractAndUpsertEntities).mockResolvedValue({
			entities: [],
			relationsCreated: 0,
		})
		mocked(createMemoryJob).mockResolvedValue("extraction-evt-new-attempt")
		mocked(claimMemoryJob).mockResolvedValue(null)
		mocked(promoteDerivedMemoryFromEvent).mockResolvedValue({
			structuredCreated: 0,
			proceduresCreated: 0,
			skipped: true,
			skipReason: "already-promoted",
		})
		return { writeEvent, createMemoryJob }
	}

	it("replays the original receipt when a key is retried with the same payload", async () => {
		const { eventsCollection } = await import("./mongodb-schema.js")
		const { writeEvent, createMemoryJob } = await mockWritePathDefaults()
		const existingDoc = {
			eventId: "evt-original",
			agentId: "agent-1",
			role: "user",
			body: "idempotent hello",
			scope: "agent",
			scopeRef: "agent:agent-1",
			idempotencyKey: "key-1",
			timestamp: new Date("2026-04-09T12:00:00.000Z"),
		}
		mocked(eventsCollection).mockReturnValue({
			findOne: vi.fn(async () => existingDoc),
		} as unknown as import("mongodb").Collection)

		const manager = makeManager()
		const result = await manager.writeConversationEvent({
			role: "user",
			body: "idempotent hello",
			scope: "agent",
			idempotencyKey: "key-1",
		})

		expect(result).toEqual({ eventId: "evt-original", chunkCreated: false })
		expect(writeEvent).not.toHaveBeenCalled()
		expect(createMemoryJob).not.toHaveBeenCalled()
	})

	it("rejects with IdempotencyConflictError when a key is reused with a different payload", async () => {
		const { eventsCollection } = await import("./mongodb-schema.js")
		await mockWritePathDefaults()
		mocked(eventsCollection).mockReturnValue({
			findOne: vi.fn(async () => ({
				eventId: "evt-original",
				agentId: "agent-1",
				role: "user",
				body: "the ORIGINAL payload",
				scope: "agent",
				scopeRef: "agent:agent-1",
				idempotencyKey: "key-2",
				timestamp: new Date("2026-04-09T12:00:00.000Z"),
			})),
		} as unknown as import("mongodb").Collection)

		const manager = makeManager()
		await expect(
			manager.writeConversationEvent({
				role: "user",
				body: "a DIFFERENT payload",
				scope: "agent",
				idempotencyKey: "key-2",
			}),
		).rejects.toMatchObject({ name: "IdempotencyConflictError" })
	})

	it("replays a stored-fingerprint write when only metadata key order differs (B4)", async () => {
		const { eventsCollection } = await import("./mongodb-schema.js")
		const { writeEvent } = await mockWritePathDefaults()
		const original = {
			role: "user" as const,
			body: "fingerprinted hello",
			scope: "agent" as const,
			metadata: { source: "chat", nested: { a: 1, b: 2 } },
			timestamp: new Date("2026-04-09T12:00:00.000Z"),
		}
		mocked(eventsCollection).mockReturnValue({
			findOne: vi.fn(async () => ({
				eventId: "evt-fp",
				agentId: "agent-1",
				...original,
				scopeRef: "agent:agent-1",
				idempotencyKey: "key-fp1",
				idempotencyFingerprint: computeIdempotencyFingerprint(
					original,
					"agent-1",
				),
			})),
		} as unknown as import("mongodb").Collection)

		const manager = makeManager()
		const result = await manager.writeConversationEvent({
			...original,
			// Same metadata, different key order at both levels: the canonical
			// fingerprint must normalize this to the original write.
			metadata: { nested: { b: 2, a: 1 }, source: "chat" },
			idempotencyKey: "key-fp1",
		})

		expect(result).toEqual({ eventId: "evt-fp", chunkCreated: false })
		expect(writeEvent).not.toHaveBeenCalled()
	})

	it.each([
		["metadata", { metadata: { source: "other", nested: { a: 1, b: 2 } } }],
		["timestamp", { timestamp: new Date("2026-04-10T12:00:00.000Z") }],
		["validAt", { validAt: new Date("2026-04-08T12:00:00.000Z") }],
		["invalidAt", { invalidAt: new Date("2026-05-09T12:00:00.000Z") }],
		["expiresAt", { expiresAt: new Date("2026-06-09T12:00:00.000Z") }],
	])("rejects with IdempotencyConflictError when a stored-fingerprint key is reused with changed %s (B4)", async (_label, patch) => {
		const { eventsCollection } = await import("./mongodb-schema.js")
		await mockWritePathDefaults()
		const original = {
			role: "user" as const,
			body: "fingerprinted hello",
			scope: "agent" as const,
			metadata: { source: "chat", nested: { a: 1, b: 2 } },
			timestamp: new Date("2026-04-09T12:00:00.000Z"),
		}
		// B4: with only role/body/session/scope compared, each of these
		// changed immutable inputs replayed silently — the caller believed
		// a write landed that never did.
		mocked(eventsCollection).mockReturnValue({
			findOne: vi.fn(async () => ({
				eventId: "evt-fp",
				agentId: "agent-1",
				...original,
				scopeRef: "agent:agent-1",
				idempotencyKey: "key-fp2",
				idempotencyFingerprint: computeIdempotencyFingerprint(
					original,
					"agent-1",
				),
			})),
		} as unknown as import("mongodb").Collection)

		const manager = makeManager()
		await expect(
			manager.writeConversationEvent({
				...original,
				...patch,
				idempotencyKey: "key-fp2",
			}),
		).rejects.toMatchObject({ name: "IdempotencyConflictError" })
	})

	it("returns the winner's receipt when the unique index rejects a raced insert", async () => {
		const { eventsCollection } = await import("./mongodb-schema.js")
		const { writeEvent } = await import("./mongodb-events.js")
		const { createMemoryJob } = await mockWritePathDefaults()
		const winnerDoc = {
			eventId: "evt-winner",
			agentId: "agent-1",
			role: "user",
			body: "raced hello",
			scope: "agent",
			scopeRef: "agent:agent-1",
			idempotencyKey: "key-3",
			timestamp: new Date("2026-04-09T12:00:00.000Z"),
		}
		mocked(eventsCollection).mockReturnValue({
			findOne: vi
				.fn()
				.mockResolvedValueOnce(null) // probe: no prior write
				.mockResolvedValueOnce(winnerDoc), // replay read after E11000
		} as unknown as import("mongodb").Collection)
		mocked(writeEvent).mockRejectedValue(
			Object.assign(new Error("E11000 duplicate key error"), { code: 11000 }),
		)

		const manager = makeManager()
		const result = await manager.writeConversationEvent({
			role: "user",
			body: "raced hello",
			scope: "agent",
			idempotencyKey: "key-3",
		})

		expect(result).toEqual({ eventId: "evt-winner", chunkCreated: false })
		expect(createMemoryJob).not.toHaveBeenCalled()
	})

	it("does not probe when no idempotency key is provided", async () => {
		const { eventsCollection } = await import("./mongodb-schema.js")
		await mockWritePathDefaults()
		const findOne = vi.fn(async () => null)
		mocked(eventsCollection).mockReturnValue({
			findOne,
		} as unknown as import("mongodb").Collection)

		const manager = makeManager()
		await manager.writeConversationEvent({
			role: "user",
			body: "plain write, no key",
			scope: "agent",
		})

		expect(findOne).not.toHaveBeenCalled()
	})

	it("does not throw after commit when the staged job release fails — the outbox repair recovers", async () => {
		const { clearEventExtractionJobPending } = await import(
			"./mongodb-events.js"
		)
		const { releaseStagedMemoryJob, getMemoryJob } = await import(
			"./mongodb-memory-jobs.js"
		)
		const { eventsCollection } = await import("./mongodb-schema.js")
		await mockWritePathDefaults()
		mocked(eventsCollection).mockReturnValue({
			findOne: vi.fn(async () => null),
		} as unknown as import("mongodb").Collection)
		mocked(releaseStagedMemoryJob).mockResolvedValue(false)
		mocked(getMemoryJob).mockResolvedValue({
			jobId: "extraction-evt-new-attempt",
			jobType: "extraction",
			agentId: "agent-1",
			status: "pending",
			stagedAt: new Date(),
		} as never)

		const manager = makeManager()
		const result = await manager.writeConversationEvent({
			role: "user",
			body: "committed, but the job release failed",
			scope: "agent",
		})
		await manager.derivationSchedulingQueue
		await manager.memoryJobWorkerPromise

		// The write is acknowledged — the extractionJobPendingAt marker is left
		// set so repairExtractionOutbox can re-stage the job.
		expect(result).toEqual({ eventId: "evt-new-attempt", chunkCreated: false })
		expect(clearEventExtractionJobPending).not.toHaveBeenCalled()
	})
})

describe("MongoDBMemoryManager writeConversationEventsBatch (P3.9)", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	function makeManager(writeQueue: Promise<void> = Promise.resolve()) {
		return Object.assign(Object.create(MongoDBMemoryManager.prototype), {
			db: {} as import("mongodb").Db,
			prefix: "test_",
			agentId: "agent-1",
			client: undefined,
			closed: false,
			config: {
				mongodb: {
					embeddingMode: "automated",
					episodes: { enabled: false, minEventsForEpisode: 6 },
				},
			},
			workspaceDir: "/tmp/memongo",
			writeQueue,
			derivationQueue: Promise.resolve(),
			derivationSchedulingQueue: Promise.resolve(),
			memoryJobWorkerId: "worker-1",
			memoryJobWorkerStopped: false,
			memoryJobWorkerActive: false,
			memoryJobWorkerPromise: Promise.resolve(),
			memoryJobRunContexts: new Map(),
			chunkCount: 0,
			dirty: true,
		}) as MongoDBMemoryManager & {
			writeQueue: Promise<void>
			memoryJobWorkerPromise: Promise<void>
		}
	}

	async function mockBatchPath() {
		const {
			writeEventsBatch,
			projectEventChunksBatch,
			clearEventExtractionJobPendingBatch,
		} = await import("./mongodb-events.js")
		const { extractAndUpsertEntities } = await import("./mongodb-graph.js")
		const { claimMemoryJob, createMemoryJobsBatch } = await import(
			"./mongodb-memory-jobs.js"
		)
		mocked(writeEventsBatch).mockImplementation(
			async ({ events }: { events: Array<{ eventId?: string }> }) =>
				events.map((event) => ({
					ok: true as const,
					eventId: event.eventId ?? "evt-generated",
					timestamp: new Date("2026-04-09T12:00:00.000Z"),
					scopeRef: "agent:agent-1",
				})),
		)
		mocked(projectEventChunksBatch).mockImplementation(
			async ({ events }: { events: Array<{ eventId: string }> }) =>
				events.map((_, index) => ({ chunkCreated: index === 0 })),
		)
		mocked(clearEventExtractionJobPendingBatch).mockResolvedValue(2)
		mocked(extractAndUpsertEntities).mockResolvedValue({
			entities: [],
			relationsCreated: 0,
		})
		mocked(createMemoryJobsBatch).mockImplementation(
			async ({ jobs }: { jobs: Array<{ jobId: string }> }) =>
				jobs.map((job) => ({ ok: true as const, jobId: job.jobId })),
		)
		mocked(claimMemoryJob).mockResolvedValue(null)
		return {
			writeEventsBatch,
			projectEventChunksBatch,
			createMemoryJobsBatch,
			clearEventExtractionJobPendingBatch,
		}
	}

	it("amortizes a batch into one insertMany/bulkWrite pass with per-item receipts", async () => {
		const {
			writeEventsBatch,
			projectEventChunksBatch,
			createMemoryJobsBatch,
			clearEventExtractionJobPendingBatch,
		} = await mockBatchPath()
		const { eventsCollection } = await import("./mongodb-schema.js")
		const { updateLaneCoverage } = await import("./mongodb-lane-coverage.js")
		const find = vi.fn(() => ({ toArray: vi.fn(async () => []) }))
		mocked(eventsCollection).mockReturnValue({ find } as never)

		const manager = makeManager()
		const receipts = await manager.writeConversationEventsBatch([
			{ role: "user", body: "first batched event", scope: "agent" },
			{
				role: "assistant",
				body: "second batched event",
				scope: "agent",
				idempotencyKey: "key-b2",
			},
		])
		await manager.memoryJobWorkerPromise

		expect(receipts).toHaveLength(2)
		expect(receipts[0]).toMatchObject({ ok: true, chunkCreated: true })
		expect(receipts[1]).toMatchObject({ ok: true, chunkCreated: false })

		// ONE insertMany for events, ONE bulkWrite for chunks, ONE insertMany
		// for jobs, ONE updateMany clearing the outbox markers.
		expect(writeEventsBatch).toHaveBeenCalledTimes(1)
		expect(mocked(writeEventsBatch).mock.calls[0][0].events).toHaveLength(2)
		expect(projectEventChunksBatch).toHaveBeenCalledTimes(1)
		expect(createMemoryJobsBatch).toHaveBeenCalledTimes(1)
		expect(clearEventExtractionJobPendingBatch).toHaveBeenCalledTimes(1)
		// Lane coverage is aggregated into a single update for the batch.
		expect(updateLaneCoverage).toHaveBeenCalledTimes(1)
		expect(updateLaneCoverage).toHaveBeenCalledWith(
			expect.objectContaining({
				increments: expect.objectContaining({
					"raw-window": 2,
					hybrid: 1,
				}),
			}),
		)
		expect(manager.chunkCount).toBe(1)
	})

	it("replays a known idempotency key from ONE batched lookup and writes the rest", async () => {
		const { writeEventsBatch, createMemoryJobsBatch } = await mockBatchPath()
		const { eventsCollection } = await import("./mongodb-schema.js")
		const find = vi.fn(() => ({
			toArray: vi.fn(async () => [
				{
					eventId: "evt-original",
					agentId: "agent-1",
					role: "user",
					body: "idempotent hello",
					scope: "agent",
					scopeRef: "agent:agent-1",
					idempotencyKey: "key-replay",
					timestamp: new Date("2026-04-09T12:00:00.000Z"),
				},
			]),
		}))
		mocked(eventsCollection).mockReturnValue({ find } as never)

		const manager = makeManager()
		const receipts = await manager.writeConversationEventsBatch([
			{
				role: "user",
				body: "idempotent hello",
				scope: "agent",
				idempotencyKey: "key-replay",
			},
			{ role: "user", body: "brand new event", scope: "agent" },
		])

		expect(receipts[0]).toEqual({
			ok: true,
			eventId: "evt-original",
			chunkCreated: false,
			replayed: true,
		})
		expect(receipts[1]).toMatchObject({ ok: true, chunkCreated: true })
		// ONE batched $in lookup, and only the non-replayed item was inserted.
		expect(find).toHaveBeenCalledTimes(1)
		expect(find).toHaveBeenCalledWith({
			agentId: "agent-1",
			idempotencyKey: { $in: ["key-replay"] },
		})
		expect(mocked(writeEventsBatch).mock.calls[0][0].events).toHaveLength(1)
		expect(createMemoryJobsBatch).toHaveBeenCalledTimes(1)
	})

	it("maps key+payload mismatch to a per-item conflict receipt; the sibling writes", async () => {
		const { writeEventsBatch } = await mockBatchPath()
		const { eventsCollection } = await import("./mongodb-schema.js")
		const find = vi.fn(() => ({
			toArray: vi.fn(async () => [
				{
					eventId: "evt-original",
					agentId: "agent-1",
					role: "user",
					body: "the ORIGINAL payload",
					scope: "agent",
					scopeRef: "agent:agent-1",
					idempotencyKey: "key-conflict",
					timestamp: new Date("2026-04-09T12:00:00.000Z"),
				},
			]),
		}))
		mocked(eventsCollection).mockReturnValue({ find } as never)

		const manager = makeManager()
		const receipts = await manager.writeConversationEventsBatch([
			{
				role: "user",
				body: "a DIFFERENT payload",
				scope: "agent",
				idempotencyKey: "key-conflict",
			},
			{ role: "user", body: "unrelated event", scope: "agent" },
		])

		expect(receipts[0]).toMatchObject({
			ok: false,
			code: "IDEMPOTENCY_CONFLICT",
		})
		expect(receipts[1]).toMatchObject({ ok: true })
		expect(mocked(writeEventsBatch).mock.calls[0][0].events).toHaveLength(1)
	})

	it("batch: stored fingerprint conflicts on changed metadata and replays on reordered metadata (B4)", async () => {
		const { writeEventsBatch } = await mockBatchPath()
		const { eventsCollection } = await import("./mongodb-schema.js")
		const original = {
			role: "user" as const,
			body: "batched fingerprint hello",
			scope: "agent" as const,
			metadata: { source: "chat", nested: { a: 1, b: 2 } },
			timestamp: new Date("2026-04-09T12:00:00.000Z"),
		}
		const find = vi.fn(() => ({
			toArray: vi.fn(async () => [
				{
					eventId: "evt-batch-fp",
					agentId: "agent-1",
					...original,
					scopeRef: "agent:agent-1",
					idempotencyKey: "key-batch-fp",
					idempotencyFingerprint: computeIdempotencyFingerprint(
						original,
						"agent-1",
					),
				},
			]),
		}))
		mocked(eventsCollection).mockReturnValue({ find } as never)

		const manager = makeManager()
		// Changed metadata on the same key conflicts — the batch path shares
		// the single path's full-fingerprint comparison.
		const conflict = await manager.writeConversationEventsBatch([
			{
				...original,
				metadata: { source: "other", nested: { a: 1, b: 2 } },
				idempotencyKey: "key-batch-fp",
			},
		])
		expect(conflict[0]).toMatchObject({
			ok: false,
			code: "IDEMPOTENCY_CONFLICT",
		})

		// Reordered (but equal) metadata replays the original receipt.
		const replay = await manager.writeConversationEventsBatch([
			{
				...original,
				metadata: { nested: { b: 2, a: 1 }, source: "chat" },
				idempotencyKey: "key-batch-fp",
			},
		])
		expect(replay[0]).toEqual({
			ok: true,
			eventId: "evt-batch-fp",
			chunkCreated: false,
			replayed: true,
		})
		// Neither the conflicted nor the replayed item reached the insert set
		// (the batch seam still invokes the helper with an empty write set,
		// which no-ops).
		for (const call of mocked(writeEventsBatch).mock.calls) {
			expect(call[0].events).toHaveLength(0)
		}
	})

	it("replays the winner when the batch insert loses an idempotency race", async () => {
		const { writeEventsBatch } = await mockBatchPath()
		const { eventsCollection } = await import("./mongodb-schema.js")
		const find = vi.fn(() => ({ toArray: vi.fn(async () => []) }))
		const findOne = vi.fn(async () => ({
			eventId: "evt-winner",
			agentId: "agent-1",
			role: "user",
			body: "raced hello",
			scope: "agent",
			scopeRef: "agent:agent-1",
			idempotencyKey: "key-race",
			timestamp: new Date("2026-04-09T12:00:00.000Z"),
		}))
		mocked(eventsCollection).mockReturnValue({ find, findOne } as never)
		mocked(writeEventsBatch).mockResolvedValue([
			{
				ok: false,
				eventId: "evt-loser",
				duplicateKey: true,
				message: "E11000 duplicate key error",
			},
		])

		const manager = makeManager()
		const receipts = await manager.writeConversationEventsBatch([
			{
				role: "user",
				body: "raced hello",
				scope: "agent",
				idempotencyKey: "key-race",
			},
		])

		expect(receipts[0]).toEqual({
			ok: true,
			eventId: "evt-winner",
			chunkCreated: false,
			replayed: true,
		})
	})

	it("isolates a per-item write failure without failing the batch", async () => {
		const { writeEventsBatch } = await mockBatchPath()
		const { eventsCollection } = await import("./mongodb-schema.js")
		mocked(eventsCollection).mockReturnValue({
			find: vi.fn(() => ({ toArray: vi.fn(async () => []) })),
		} as never)
		mocked(writeEventsBatch).mockResolvedValue([
			{
				ok: true,
				eventId: "evt-good",
				timestamp: new Date("2026-04-09T12:00:00.000Z"),
				scopeRef: "agent:agent-1",
			},
			{
				ok: false,
				eventId: "evt-bad",
				duplicateKey: false,
				message: "invalid event timestamp",
			},
		])

		const manager = makeManager()
		const receipts = await manager.writeConversationEventsBatch([
			{ role: "user", body: "good event", scope: "agent" },
			{ role: "user", body: "bad event", scope: "agent" },
		])

		expect(receipts[0]).toMatchObject({ ok: true, chunkCreated: true })
		expect(receipts[1]).toMatchObject({ ok: false, code: "WRITE_ERROR" })
	})

	it("queues the whole batch behind a previously queued write", async () => {
		const { writeEventsBatch } = await mockBatchPath()
		const { eventsCollection } = await import("./mongodb-schema.js")
		mocked(eventsCollection).mockReturnValue({
			find: vi.fn(() => ({ toArray: vi.fn(async () => []) })),
		} as never)

		let releasePrior: (() => void) | undefined
		const prior = new Promise<void>((resolve) => {
			releasePrior = () => resolve()
		})
		const manager = makeManager(prior)

		let batchRan = false
		const batch = manager
			.writeConversationEventsBatch([
				{ role: "user", body: "queued batch event", scope: "agent" },
			])
			.then((receipts) => {
				batchRan = true
				return receipts
			})

		await new Promise((resolve) => setTimeout(resolve, 10))
		expect(batchRan).toBe(false)
		expect(writeEventsBatch).not.toHaveBeenCalled()

		releasePrior?.()
		await expect(batch).resolves.toHaveLength(1)
		expect(writeEventsBatch).toHaveBeenCalledTimes(1)
	})

	it("refuses to queue a batch after close", async () => {
		const manager = makeManager()
		;(manager as unknown as { closed: boolean }).closed = true
		await expect(
			manager.writeConversationEventsBatch([
				{ role: "user", body: "too late", scope: "agent" },
			]),
		).rejects.toThrow(/closed/)
	})
})

// ---------------------------------------------------------------------------
// P4.4.1: session-scope TTL default wiring on the write seam
// ---------------------------------------------------------------------------

describe("MongoDBMemoryManager write TTL defaults (P4.4.1)", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	function makeTtlManager(ttl?: { enabled: boolean; sessionDays: number }) {
		return Object.assign(Object.create(MongoDBMemoryManager.prototype), {
			db: {} as import("mongodb").Db,
			prefix: "test_",
			agentId: "agent-1",
			client: undefined,
			closed: false,
			config: {
				mongodb: {
					embeddingMode: "automated",
					episodes: { enabled: false, minEventsForEpisode: 6 },
					ttl: ttl ?? { enabled: false, sessionDays: 30 },
				},
			},
			workspaceDir: "/tmp/memongo",
			writeQueue: Promise.resolve(),
			derivationQueue: Promise.resolve(),
			derivationSchedulingQueue: Promise.resolve(),
			memoryJobWorkerId: "worker-1",
			memoryJobWorkerStopped: false,
			memoryJobWorkerActive: false,
			memoryJobWorkerPromise: Promise.resolve(),
			memoryJobRunContexts: new Map(),
			chunkCount: 0,
			dirty: true,
		}) as MongoDBMemoryManager & {
			derivationSchedulingQueue: Promise<void>
			memoryJobWorkerPromise: Promise<void>
		}
	}

	async function mockTtlWritePath() {
		const { writeEvent, projectEventChunk } = await import(
			"./mongodb-events.js"
		)
		const { extractAndUpsertEntities } = await import("./mongodb-graph.js")
		const { createMemoryJob, claimMemoryJob } = await import(
			"./mongodb-memory-jobs.js"
		)
		const { promoteDerivedMemoryFromEvent } = await import(
			"./mongodb-derived-memory.js"
		)
		mocked(writeEvent).mockResolvedValue({
			eventId: "evt-ttl",
			timestamp: new Date("2026-08-03T12:00:00.000Z"),
			scopeRef: "session:sess-1",
		})
		mocked(projectEventChunk).mockResolvedValue({ chunkCreated: false })
		mocked(extractAndUpsertEntities).mockResolvedValue({
			entities: [],
			relationsCreated: 0,
		})
		mocked(createMemoryJob).mockResolvedValue("extraction-evt-ttl")
		mocked(claimMemoryJob).mockResolvedValue(null)
		mocked(promoteDerivedMemoryFromEvent).mockResolvedValue({
			structuredCreated: 0,
			proceduresCreated: 0,
			skipped: true,
			skipReason: "already-promoted",
		})
		return { writeEvent }
	}

	it("derives expiresAt from the session-scope TTL default for session writes", async () => {
		const { writeEvent } = await mockTtlWritePath()
		const manager = makeTtlManager({ enabled: true, sessionDays: 7 })
		const before = Date.now()

		await manager.writeConversationEvent({
			role: "user",
			body: "session-scoped memory",
			sessionId: "sess-1",
		})
		const after = Date.now()

		const payload = mocked(writeEvent).mock.calls[0][0].event as Record<
			string,
			unknown
		>
		const expiresAt = payload.expiresAt as Date
		expect(expiresAt).toBeInstanceOf(Date)
		expect(expiresAt.getTime()).toBeGreaterThanOrEqual(before + 7 * 86_400_000)
		expect(expiresAt.getTime()).toBeLessThanOrEqual(after + 7 * 86_400_000)
	})

	it("lets an explicit per-write expiresAt win over the session default", async () => {
		const { writeEvent } = await mockTtlWritePath()
		const manager = makeTtlManager({ enabled: true, sessionDays: 7 })
		const explicit = new Date("2026-08-20T00:00:00.000Z")

		await manager.writeConversationEvent({
			role: "user",
			body: "explicit expiry",
			sessionId: "sess-1",
			expiresAt: explicit,
		})

		const payload = mocked(writeEvent).mock.calls[0][0].event as Record<
			string,
			unknown
		>
		expect(payload.expiresAt).toBe(explicit)
	})

	it("writes no expiresAt when TTL is disabled and none is given (byte-identical)", async () => {
		const { writeEvent } = await mockTtlWritePath()
		const manager = makeTtlManager()

		await manager.writeConversationEvent({
			role: "user",
			body: "durable write",
			sessionId: "sess-1",
		})

		const payload = mocked(writeEvent).mock.calls[0][0].event as Record<
			string,
			unknown
		>
		expect(payload).not.toHaveProperty("expiresAt")
	})

	it("does not derive expiresAt for writes without a sessionId", async () => {
		const { writeEvent } = await mockTtlWritePath()
		const manager = makeTtlManager({ enabled: true, sessionDays: 7 })

		await manager.writeConversationEvent({
			role: "user",
			body: "agent-scoped durable write",
			scope: "agent",
		})

		const payload = mocked(writeEvent).mock.calls[0][0].event as Record<
			string,
			unknown
		>
		expect(payload).not.toHaveProperty("expiresAt")
	})

	it("carries the session TTL default through the batch write path", async () => {
		const {
			writeEventsBatch,
			projectEventChunksBatch,
			clearEventExtractionJobPendingBatch,
		} = await import("./mongodb-events.js")
		const { extractAndUpsertEntities } = await import("./mongodb-graph.js")
		const { claimMemoryJob, createMemoryJobsBatch } = await import(
			"./mongodb-memory-jobs.js"
		)
		const { eventsCollection } = await import("./mongodb-schema.js")
		mocked(writeEventsBatch).mockImplementation(
			async ({ events }: { events: Array<{ eventId?: string }> }) =>
				events.map((event) => ({
					ok: true as const,
					eventId: event.eventId ?? "evt-generated",
					timestamp: new Date("2026-08-03T12:00:00.000Z"),
					scopeRef: "agent:agent-1",
				})),
		)
		mocked(projectEventChunksBatch).mockImplementation(
			async ({ events }: { events: Array<{ eventId: string }> }) =>
				events.map(() => ({ chunkCreated: false })),
		)
		mocked(clearEventExtractionJobPendingBatch).mockResolvedValue(2)
		mocked(extractAndUpsertEntities).mockResolvedValue({
			entities: [],
			relationsCreated: 0,
		})
		mocked(createMemoryJobsBatch).mockImplementation(
			async ({ jobs }: { jobs: Array<{ jobId: string }> }) =>
				jobs.map((job) => ({ ok: true as const, jobId: job.jobId })),
		)
		mocked(claimMemoryJob).mockResolvedValue(null)
		mocked(eventsCollection).mockReturnValue({
			find: vi.fn(() => ({ toArray: vi.fn(async () => []) })),
		} as never)

		const manager = makeTtlManager({ enabled: true, sessionDays: 3 })
		const before = Date.now()
		await manager.writeConversationEventsBatch([
			{
				role: "user",
				body: "session item",
				sessionId: "sess-1",
			},
			{ role: "user", body: "agent item", scope: "agent" },
		])
		const after = Date.now()

		const events = mocked(writeEventsBatch).mock.calls[0][0].events as Array<
			Record<string, unknown>
		>
		expect(events).toHaveLength(2)
		const sessionExpiresAt = events[0].expiresAt as Date
		expect(sessionExpiresAt).toBeInstanceOf(Date)
		expect(sessionExpiresAt.getTime()).toBeGreaterThanOrEqual(
			before + 3 * 86_400_000,
		)
		expect(sessionExpiresAt.getTime()).toBeLessThanOrEqual(
			after + 3 * 86_400_000,
		)
		expect(events[1]).not.toHaveProperty("expiresAt")
	})
})
