/* eslint-disable @typescript-eslint/unbound-method -- Vitest mock method assertions */
import { describe, it, expect, vi, beforeEach } from "vitest"
import { MongoDBMemoryManager } from "./mongodb-manager.js"
import {
	EVENT_IDENTITY_READ_OPTIONS,
	type EventMetadataWriteOptions,
} from "./mongodb-event-metadata-identity.js"
import { computeIdempotencyFingerprint } from "./mongodb-idempotency-fingerprint.js"
import { MongoDBManagerWriteOps } from "./mongodb-manager-write.js"
import { mocked } from "./test-helpers/manager-test-kit.js"

const DEFAULT_EVENT_WRITE_OPTIONS: EventMetadataWriteOptions = {
	ignoreUndefined: false,
	serializeFunctions: false,
}

vi.mock("./mongodb-events.js", async () =>
	(await import("./test-helpers/manager-test-kit.js")).eventsModuleMock(),
)

vi.mock("./mongodb-conversation-recall.js", async () =>
	(
		await import("./test-helpers/manager-test-kit.js")
	).conversationRecallModuleMock(),
)

vi.mock("./mongodb-ops.js", async () =>
	(await import("./test-helpers/manager-test-kit.js")).opsModuleMock(),
)

vi.mock("./mongodb-retrieval-planner.js", async () =>
	(
		await import("./test-helpers/manager-test-kit.js")
	).retrievalPlannerModuleMock(),
)

vi.mock("./mongodb-episodes.js", async () => ({
	...(await import("./test-helpers/manager-test-kit.js")).episodesModuleMock(),
	checkAutoEpisodeTriggers: vi.fn(),
}))

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

vi.mock("./mongodb-telemetry.js", async () =>
	(await import("./test-helpers/manager-test-kit.js")).telemetryModuleMock(),
)

vi.mock("./mongodb-write-fence.js", () => ({
	readErasureGate: vi.fn(async ({ agentId }: { agentId: string }) => ({
		agentId,
		epoch: 0,
		state: "open",
		serial: 0,
	})),
	isErasureGateConflictError: (error: unknown) =>
		Reflect.get(Object(error), "code") === "ERASURE_GATE_CONFLICT",
	ErasureGateConflictError: class extends Error {
		constructor(message = "erasure gate changed during write") {
			super(message)
			this.name = "ErasureGateConflictError"
		}
	},
	captureAdmissionToken: vi.fn(async ({ agentId }: { agentId: string }) => ({
		kind: "admission" as const,
		agentId,
		epoch: 0,
	})),
	withFencedWrite: vi.fn(
		async ({
			fn,
		}: {
			fn: (session: import("mongodb").ClientSession) => Promise<unknown>
		}) => fn({} as import("mongodb").ClientSession),
	),
}))

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
			writeQueueDepth: 0,
			derivationQueue: Promise.resolve(),
			derivationSchedulingQueue: Promise.resolve(),
			memoryJobWorkerId: "worker-1",
			memoryJobWorkerStopped: false,
			memoryJobWorkerActive: false,
			memoryJobWorkerPromise: Promise.resolve(),
			memoryJobOperationContexts: new Map(),
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

	it("captures admission before queue delay and uses its epoch in one fenced event+job transaction", async () => {
		const { writeEvent } = await mockWritePathDefaults()
		const { createMemoryJob } = await import("./mongodb-memory-jobs.js")
		const { captureAdmissionToken, withFencedWrite } = await import(
			"./mongodb-write-fence.js"
		)
		const token = {
			kind: "admission" as const,
			agentId: "agent-1",
			epoch: 7,
		}
		mocked(captureAdmissionToken).mockResolvedValueOnce(token)
		const transactionSession = {
			id: "fenced-session",
		} as unknown as import("mongodb").ClientSession
		mocked(withFencedWrite).mockImplementationOnce(async ({ fn }) =>
			fn(transactionSession),
		)
		let releaseQueue = () => {}
		const queuedAhead = new Promise<void>((resolve) => {
			releaseQueue = resolve
		})
		const db = {} as import("mongodb").Db
		const manager = makeManager()
		const wake = vi.fn()
		Object.assign(manager, {
			db,
			writeQueue: queuedAhead,
			memoryJobWorkerGeneration: 0,
			wakeMemoryJobWorker: wake,
		})

		const write = manager.writeConversationEvent({
			role: "user",
			body: "admitted before waiting",
			scope: "agent",
		})

		expect(captureAdmissionToken).toHaveBeenCalledWith({
			db,
			prefix: "test_",
			agentId: "agent-1",
		})
		await Promise.resolve()
		expect(withFencedWrite).not.toHaveBeenCalled()

		Reflect.set(manager, "memoryJobWorkerGeneration", 1)
		releaseQueue()
		await write
		expect(wake).toHaveBeenCalledWith(token, 0)

		expect(withFencedWrite).toHaveBeenCalledWith({
			db,
			prefix: "test_",
			token,
			fn: expect.any(Function),
		})
		expect(writeEvent).toHaveBeenCalledWith(
			expect.objectContaining({ session: transactionSession }),
		)
		expect(createMemoryJob).toHaveBeenCalledWith(
			expect.objectContaining({
				session: transactionSession,
				job: expect.objectContaining({ admissionEpoch: 7 }),
			}),
		)
	})

	it("settles a rejected admission when queue saturation fast-fails first", async () => {
		const { captureAdmissionToken, withFencedWrite } = await import(
			"./mongodb-write-fence.js"
		)
		mocked(captureAdmissionToken).mockRejectedValueOnce(
			new Error("admission read failed"),
		)
		const manager = makeManager()
		Object.assign(manager, { writeQueueDepth: 1 })
		const previousCap = process.env.MEMONGO_WRITE_QUEUE_MAX_DEPTH
		process.env.MEMONGO_WRITE_QUEUE_MAX_DEPTH = "1"
		try {
			await expect(
				manager.writeConversationEvent({
					role: "user",
					body: "queue is full",
					scope: "agent",
				}),
			).rejects.toMatchObject({ name: "WriteQueueFullError" })
			await Promise.resolve()
			expect(withFencedWrite).not.toHaveBeenCalled()
		} finally {
			if (previousCap === undefined) {
				delete process.env.MEMONGO_WRITE_QUEUE_MAX_DEPTH
			} else {
				process.env.MEMONGO_WRITE_QUEUE_MAX_DEPTH = previousCap
			}
		}
	})

	it("fences event-only mode without staging an extraction job", async () => {
		const { writeEvent, createMemoryJob } = await mockWritePathDefaults()
		const { withFencedWrite } = await import("./mongodb-write-fence.js")
		const manager = makeManager()
		Object.assign(manager, {
			shouldRunPostWriteDerivedWork: () => false,
		})

		await manager.writeConversationEvent({
			role: "user",
			body: "event only",
			scope: "agent",
		})

		expect(withFencedWrite).toHaveBeenCalledTimes(6)
		expect(writeEvent).toHaveBeenCalledTimes(1)
		expect(createMemoryJob).not.toHaveBeenCalled()
	})

	it("reuses one admission token when the fenced transaction callback retries", async () => {
		const { writeEvent, createMemoryJob } = await mockWritePathDefaults()
		const { captureAdmissionToken, withFencedWrite } = await import(
			"./mongodb-write-fence.js"
		)
		const transactionSession = {
			id: "retry-session",
		} as unknown as import("mongodb").ClientSession
		mocked(writeEvent).mockRejectedValueOnce(
			new Error("simulated transient transaction attempt"),
		)
		mocked(withFencedWrite).mockImplementationOnce(async ({ fn }) => {
			try {
				await fn(transactionSession)
			} catch {
				return fn(transactionSession)
			}
			throw new Error("expected the first transaction attempt to fail")
		})

		const manager = makeManager()
		manager.wakeMemoryJobWorker = vi.fn()
		await manager.writeConversationEvent({
			role: "user",
			body: "retry with one admission",
			scope: "agent",
		})

		expect(captureAdmissionToken).toHaveBeenCalledTimes(1)
		expect(withFencedWrite).toHaveBeenCalledTimes(6)
		expect(writeEvent).toHaveBeenCalledTimes(2)
		expect(createMemoryJob).toHaveBeenCalledWith(
			expect.objectContaining({
				session: transactionSession,
				job: expect.objectContaining({ admissionEpoch: 0 }),
			}),
		)
	})

	it("does not fall back to direct writes when transactions are unsupported", async () => {
		const { writeEvent, createMemoryJob } = await mockWritePathDefaults()
		const { withFencedWrite } = await import("./mongodb-write-fence.js")
		mocked(withFencedWrite).mockRejectedValueOnce(
			Object.assign(new Error("transactions unsupported"), { code: 20 }),
		)

		const manager = makeManager()
		await expect(
			manager.writeConversationEvent({
				role: "user",
				body: "must remain transactional",
				scope: "agent",
			}),
		).rejects.toMatchObject({ code: 20 })
		expect(writeEvent).not.toHaveBeenCalled()
		expect(createMemoryJob).not.toHaveBeenCalled()
	})

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
			bsonOptions: DEFAULT_EVENT_WRITE_OPTIONS,
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

	it("does not return an idempotent replay until its fenced transaction commits", async () => {
		const { eventsCollection } = await import("./mongodb-schema.js")
		const { writeEvent, createMemoryJob } = await mockWritePathDefaults()
		const { withFencedWrite } = await import("./mongodb-write-fence.js")
		const existingDoc = {
			eventId: "evt-committed-replay",
			agentId: "agent-1",
			role: "user",
			body: "wait for commit",
			scope: "agent",
			scopeRef: "agent:agent-1",
			idempotencyKey: "key-commit",
			timestamp: new Date("2026-04-09T12:00:00.000Z"),
		}
		const findOne = vi.fn(async () => existingDoc)
		mocked(eventsCollection).mockReturnValue({
			bsonOptions: DEFAULT_EVENT_WRITE_OPTIONS,
			findOne,
		} as unknown as import("mongodb").Collection)
		const transactionSession = {
			id: "replay-session",
		} as unknown as import("mongodb").ClientSession
		let releaseCommit = () => {}
		const commit = new Promise<void>((resolve) => {
			releaseCommit = resolve
		})
		let callbackFinished = () => {}
		const callbackDone = new Promise<void>((resolve) => {
			callbackFinished = resolve
		})
		mocked(withFencedWrite).mockImplementationOnce(async ({ fn }) => {
			const result = await fn(transactionSession)
			callbackFinished()
			await commit
			return result
		})

		const manager = makeManager()
		const write = manager.writeConversationEvent({
			role: "user",
			body: "wait for commit",
			scope: "agent",
			idempotencyKey: "key-commit",
		})
		let settled = false
		void write.then(
			() => {
				settled = true
			},
			() => {
				settled = true
			},
		)

		await callbackDone
		expect(settled).toBe(false)
		expect(findOne).toHaveBeenCalledWith(
			{ agentId: "agent-1", idempotencyKey: "key-commit" },
			{
				...EVENT_IDENTITY_READ_OPTIONS,
				session: transactionSession,
			},
		)
		releaseCommit()

		await expect(write).resolves.toEqual({
			eventId: "evt-committed-replay",
			chunkCreated: false,
		})
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
			bsonOptions: DEFAULT_EVENT_WRITE_OPTIONS,
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

	it("rejects a fingerprinted Date/string metadata collision in the fenced pre-read", async () => {
		const { eventsCollection } = await import("./mongodb-schema.js")
		const { writeEvent } = await mockWritePathDefaults()
		const observedAt = new Date("2026-01-01T00:00:00.000Z")
		const original = {
			role: "user" as const,
			body: "typed metadata",
			scope: "agent" as const,
			metadata: { observedAt },
		}
		const findOne = vi.fn(async () => ({
			eventId: "evt-date",
			agentId: "agent-1",
			...original,
			scopeRef: "agent:agent-1",
			idempotencyKey: "key-date",
			idempotencyFingerprint: computeIdempotencyFingerprint(
				original,
				"agent-1",
			),
			timestamp: new Date("2026-04-09T12:00:00.000Z"),
		}))
		mocked(eventsCollection).mockReturnValue({
			bsonOptions: DEFAULT_EVENT_WRITE_OPTIONS,
			findOne,
		} as unknown as import("mongodb").Collection)

		const manager = makeManager()
		await expect(
			manager.writeConversationEvent({
				...original,
				metadata: { observedAt: observedAt.toISOString() },
				idempotencyKey: "key-date",
			}),
		).rejects.toMatchObject({ name: "IdempotencyConflictError" })

		expect(findOne).toHaveBeenCalledWith(
			{ agentId: "agent-1", idempotencyKey: "key-date" },
			{
				...EVENT_IDENTITY_READ_OPTIONS,
				session: expect.anything(),
			},
		)
		expect(writeEvent).not.toHaveBeenCalled()
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
			bsonOptions: DEFAULT_EVENT_WRITE_OPTIONS,
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
		const { withFencedWrite } = await import("./mongodb-write-fence.js")
		expect(withFencedWrite).toHaveBeenCalledTimes(2)
		expect(mocked(withFencedWrite).mock.calls[0][0].token).toBe(
			mocked(withFencedWrite).mock.calls[1][0].token,
		)
	})

	it("rejects a fingerprinted RegExp collision after a single-write E11000 race", async () => {
		const { eventsCollection } = await import("./mongodb-schema.js")
		const { writeEvent } = await mockWritePathDefaults()
		const original = {
			role: "user" as const,
			body: "raced typed metadata",
			scope: "agent" as const,
			metadata: { pattern: /alpha/i },
		}
		const findOne = vi
			.fn()
			.mockResolvedValueOnce(null)
			.mockResolvedValueOnce({
				eventId: "evt-regexp-winner",
				agentId: "agent-1",
				...original,
				scopeRef: "agent:agent-1",
				idempotencyKey: "key-regexp-race",
				idempotencyFingerprint: computeIdempotencyFingerprint(
					original,
					"agent-1",
				),
				timestamp: new Date("2026-04-09T12:00:00.000Z"),
			})
		mocked(eventsCollection).mockReturnValue({
			bsonOptions: DEFAULT_EVENT_WRITE_OPTIONS,
			findOne,
		} as unknown as import("mongodb").Collection)
		mocked(writeEvent).mockRejectedValue(
			Object.assign(new Error("E11000 duplicate key error"), { code: 11000 }),
		)

		const manager = makeManager()
		await expect(
			manager.writeConversationEvent({
				...original,
				metadata: { pattern: /beta/i },
				idempotencyKey: "key-regexp-race",
			}),
		).rejects.toMatchObject({ name: "IdempotencyConflictError" })

		expect(findOne).toHaveBeenCalledTimes(2)
		for (const [, options] of findOne.mock.calls) {
			expect(options).toEqual({
				...EVENT_IDENTITY_READ_OPTIONS,
				session: expect.anything(),
			})
		}
	})

	it.each([
		{ storedMetadata: undefined, attemptedMetadata: {} },
		{ storedMetadata: {}, attemptedMetadata: undefined },
	])("keeps absent metadata equivalent to an empty document for fingerprinted and legacy rows", ({
		storedMetadata,
		attemptedMetadata,
	}) => {
		const manager = makeManager()
		const writeOps = new MongoDBManagerWriteOps(manager as never)
		const event = {
			role: "user" as const,
			body: "absence compatibility",
			scope: "agent" as const,
			...(attemptedMetadata === undefined
				? {}
				: { metadata: attemptedMetadata }),
		}
		const stored = {
			eventId: "evt-absence",
			agentId: "agent-1",
			role: event.role,
			body: event.body,
			scope: event.scope,
			scopeRef: "agent:agent-1",
			timestamp: new Date("2026-04-09T12:00:00.000Z"),
			...(storedMetadata === undefined ? {} : { metadata: storedMetadata }),
		}

		expect(
			writeOps.idempotencyPayloadMatches(
				{
					...stored,
					idempotencyFingerprint: computeIdempotencyFingerprint(
						event,
						"agent-1",
					),
				},
				event,
				DEFAULT_EVENT_WRITE_OPTIONS,
			),
		).toBe(true)
		expect(
			writeOps.idempotencyPayloadMatches(
				stored,
				event,
				DEFAULT_EVENT_WRITE_OPTIONS,
			),
		).toBe(true)
	})

	it("preserves BSON metadata types when comparing legacy rows", () => {
		const manager = makeManager()
		const writeOps = new MongoDBManagerWriteOps(manager as never)
		const observedAt = new Date("2026-01-01T00:00:00.000Z")
		const stored = {
			eventId: "evt-legacy-types",
			agentId: "agent-1",
			role: "user" as const,
			body: "legacy typed metadata",
			scope: "agent" as const,
			scopeRef: "agent:agent-1",
			timestamp: new Date("2026-04-09T12:00:00.000Z"),
			metadata: { observedAt, pattern: /alpha/i },
		}
		const event = {
			role: stored.role,
			body: stored.body,
			scope: stored.scope,
			metadata: {
				observedAt: new Date(observedAt),
				pattern: /alpha/i,
			},
		}

		expect(
			writeOps.idempotencyPayloadMatches(
				stored,
				event,
				DEFAULT_EVENT_WRITE_OPTIONS,
			),
		).toBe(true)
		expect(
			writeOps.idempotencyPayloadMatches(
				stored,
				{
					...event,
					metadata: {
						observedAt: observedAt.toISOString(),
						pattern: /alpha/i,
					},
				},
				DEFAULT_EVENT_WRITE_OPTIONS,
			),
		).toBe(false)
		expect(
			writeOps.idempotencyPayloadMatches(
				stored,
				{
					...event,
					metadata: {
						observedAt,
						pattern: /beta/i,
					},
				},
				DEFAULT_EVENT_WRITE_OPTIONS,
			),
		).toBe(false)
	})

	it.each([
		{ label: "fingerprint", idempotencyFingerprint: "known-mismatch" },
		{ label: "legacy fields", idempotencyFingerprint: undefined },
	])("short-circuits a failed $label gate before BSON metadata normalization", ({
		idempotencyFingerprint,
	}) => {
		const manager = makeManager()
		const writeOps = new MongoDBManagerWriteOps(manager as never)
		const metadataThatCannotBeSerialized = {
			value: {
				toBSON() {
					throw new Error("metadata BSON normalization must not run")
				},
			},
		}

		expect(
			writeOps.idempotencyPayloadMatches(
				{
					eventId: "evt-mismatch",
					agentId: "agent-1",
					role: "user",
					body: "original",
					scope: "agent",
					scopeRef: "agent:agent-1",
					timestamp: new Date("2026-04-09T12:00:00.000Z"),
					...(idempotencyFingerprint ? { idempotencyFingerprint } : {}),
				},
				{
					role: "user",
					body: "changed",
					scope: "agent",
					metadata: metadataThatCannotBeSerialized,
				},
				DEFAULT_EVENT_WRITE_OPTIONS,
			),
		).toBe(false)
	})

	it("does not probe when no idempotency key is provided", async () => {
		const { eventsCollection } = await import("./mongodb-schema.js")
		const { extractAndUpsertEntities } = await import("./mongodb-graph.js")
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
		expect(extractAndUpsertEntities).not.toHaveBeenCalled()
	})

	it("records an ingest run at the production write boundary (W16)", async () => {
		const { eventsCollection } = await import("./mongodb-schema.js")
		const { recordIngestRun } = await import("./mongodb-ops.js")
		await mockWritePathDefaults()
		mocked(eventsCollection).mockReturnValue({
			findOne: vi.fn(async () => null),
		} as unknown as import("mongodb").Collection)

		const manager = makeManager()
		await manager.writeConversationEvent({
			role: "user",
			body: "ingest-run recording boundary",
			scope: "agent",
		})

		// The canonicalIngest health lane reads ingest_runs; the production
		// write path (unlike the legacy helper) must feed it. status stays ok
		// even though inline chunk projection degraded elsewhere.
		expect(recordIngestRun).toHaveBeenCalledTimes(1)
		const [[call]] = mocked(recordIngestRun).mock.calls
		expect(call.prefix).toBe("test_")
		expect(call.run).toMatchObject({
			agentId: "agent-1",
			source: "event-write",
			status: "ok",
			itemsProcessed: 1,
			itemsFailed: 0,
		})
		expect(typeof call.run.durationMs).toBe("number")
	})

	it("does not record an ingest run for an idempotent replay (W16)", async () => {
		const { eventsCollection } = await import("./mongodb-schema.js")
		const { recordIngestRun } = await import("./mongodb-ops.js")
		const { writeEvent } = await mockWritePathDefaults()
		mocked(eventsCollection).mockReturnValue({
			bsonOptions: DEFAULT_EVENT_WRITE_OPTIONS,
			findOne: vi.fn(async () => ({
				eventId: "evt-original",
				agentId: "agent-1",
				role: "user",
				body: "idempotent hello",
				scope: "agent",
				scopeRef: "agent:agent-1",
				idempotencyKey: "key-replay",
				timestamp: new Date("2026-04-09T12:00:00.000Z"),
			})),
		} as unknown as import("mongodb").Collection)

		const manager = makeManager()
		const result = await manager.writeConversationEvent({
			role: "user",
			body: "idempotent hello",
			scope: "agent",
			idempotencyKey: "key-replay",
		})
		void writeEvent

		expect(result).toEqual({ eventId: "evt-original", chunkCreated: false })
		// A replay is not an ingest: no new data landed, so no run is recorded
		// (the ingestStartMs clock starts only after the replay short-circuit).
		expect(recordIngestRun).not.toHaveBeenCalled()
	})

	it("does not fail the write when ingest run recording fails (W16)", async () => {
		const { eventsCollection } = await import("./mongodb-schema.js")
		const { recordIngestRun } = await import("./mongodb-ops.js")
		await mockWritePathDefaults()
		mocked(eventsCollection).mockReturnValue({
			findOne: vi.fn(async () => null),
		} as unknown as import("mongodb").Collection)
		mocked(recordIngestRun).mockRejectedValue(
			new Error("ingest_runs unavailable"),
		)

		const manager = makeManager()
		const result = await manager.writeConversationEvent({
			role: "user",
			body: "durable write, ledger insert failed",
			scope: "agent",
		})

		// Best-effort by design: the write is already durable, so a failed
		// ledger insert logs but never rejects it.
		expect(result).toEqual({ eventId: "evt-new-attempt", chunkCreated: false })
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

	it("acknowledges the write when chunk projection throws after commit (W08)", async () => {
		const { projectEventChunk } = await import("./mongodb-events.js")
		const { eventsCollection } = await import("./mongodb-schema.js")
		await mockWritePathDefaults()
		mocked(eventsCollection).mockReturnValue({
			findOne: vi.fn(async () => null),
		} as unknown as import("mongodb").Collection)
		mocked(projectEventChunk).mockRejectedValue(
			new Error("chunk upsert exhausted retries"),
		)

		const manager = makeManager()
		const result = await manager.writeConversationEvent({
			role: "user",
			body: "durable, but projection failed",
			scope: "agent",
		})
		await manager.derivationSchedulingQueue
		await manager.memoryJobWorkerPromise

		// The event is durable; the failed projection degrades to a
		// diagnostic and the repair pass re-projects it — never a rejection.
		expect(result).toEqual({ eventId: "evt-new-attempt", chunkCreated: false })
		expect(manager.chunkCount).toBe(0)
	})

	it("acknowledges the write when the staged job release throws after commit (W08)", async () => {
		const { clearEventExtractionJobPending } = await import(
			"./mongodb-events.js"
		)
		const { releaseStagedMemoryJob } = await import("./mongodb-memory-jobs.js")
		const { eventsCollection } = await import("./mongodb-schema.js")
		await mockWritePathDefaults()
		mocked(eventsCollection).mockReturnValue({
			findOne: vi.fn(async () => null),
		} as unknown as import("mongodb").Collection)
		mocked(releaseStagedMemoryJob).mockRejectedValue(
			new Error("release update exhausted retries"),
		)

		const manager = makeManager()
		const result = await manager.writeConversationEvent({
			role: "user",
			body: "committed, but the job release threw",
			scope: "agent",
		})
		await manager.derivationSchedulingQueue
		await manager.memoryJobWorkerPromise

		// Same P0.1 treatment as an unreleased job: the marker stays set for
		// the repair pass and the durable write is acknowledged.
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
			memoryJobOperationContexts: new Map(),
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
		const {
			claimMemoryJob,
			createMemoryJobsBatch,
			releaseStagedMemoryJobsBatch,
		} = await import("./mongodb-memory-jobs.js")
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
		mocked(releaseStagedMemoryJobsBatch).mockImplementation(
			async ({ jobIds }: { jobIds: string[] }) => jobIds.length,
		)
		mocked(claimMemoryJob).mockResolvedValue(null)
		return {
			writeEventsBatch,
			projectEventChunksBatch,
			createMemoryJobsBatch,
			releaseStagedMemoryJobsBatch,
			clearEventExtractionJobPendingBatch,
		}
	}

	it("captures admission before queue delay and fences the batch with the original token", async () => {
		await mockBatchPath()
		const { eventsCollection } = await import("./mongodb-schema.js")
		const { captureAdmissionToken, withFencedWrite } = await import(
			"./mongodb-write-fence.js"
		)
		const token = {
			kind: "admission" as const,
			agentId: "agent-1",
			epoch: 9,
		}
		mocked(captureAdmissionToken).mockResolvedValueOnce(token)
		mocked(eventsCollection).mockReturnValue({
			bsonOptions: DEFAULT_EVENT_WRITE_OPTIONS,
			find: vi.fn(() => ({ toArray: vi.fn(async () => []) })),
		} as never)
		let releaseQueue = () => {}
		const queuedAhead = new Promise<void>((resolve) => {
			releaseQueue = resolve
		})
		const manager = makeManager(queuedAhead)
		const wake = vi.fn()
		Object.assign(manager, {
			memoryJobWorkerGeneration: 0,
			wakeMemoryJobWorker: wake,
		})

		const write = manager.writeConversationEventsBatch([
			{ role: "user", body: "admitted batch", scope: "agent" },
		])

		expect(captureAdmissionToken).toHaveBeenCalledWith({
			db: manager.db,
			prefix: "test_",
			agentId: "agent-1",
		})
		await Promise.resolve()
		expect(withFencedWrite).not.toHaveBeenCalled()

		Reflect.set(manager, "memoryJobWorkerGeneration", 1)
		releaseQueue()
		await write
		expect(wake).toHaveBeenCalledWith(token, 0)

		expect(withFencedWrite).toHaveBeenCalledWith({
			db: manager.db,
			prefix: "test_",
			token,
			fn: expect.any(Function),
		})
	})

	it("amortizes a batch into one insertMany/bulkWrite pass with per-item receipts", async () => {
		const {
			writeEventsBatch,
			projectEventChunksBatch,
			createMemoryJobsBatch,
			clearEventExtractionJobPendingBatch,
		} = await mockBatchPath()
		const { extractAndUpsertEntities } = await import("./mongodb-graph.js")
		const { eventsCollection } = await import("./mongodb-schema.js")
		const { updateLaneCoverage } = await import("./mongodb-lane-coverage.js")
		const find = vi.fn(() => ({ toArray: vi.fn(async () => []) }))
		mocked(eventsCollection).mockReturnValue({
			bsonOptions: DEFAULT_EVENT_WRITE_OPTIONS,
			find,
		} as never)

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
		// The durable extraction jobs own entity extraction. The write path must
		// not extract and persist the same entities before those jobs run.
		expect(extractAndUpsertEntities).not.toHaveBeenCalled()
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

	it("records one ingest run summarizing the batch outcomes (W16)", async () => {
		await mockBatchPath()
		const { recordIngestRun } = await import("./mongodb-ops.js")
		const { eventsCollection } = await import("./mongodb-schema.js")
		mocked(eventsCollection).mockReturnValue({
			find: vi.fn(() => ({ toArray: vi.fn(async () => []) })),
		} as never)

		const manager = makeManager()
		await manager.writeConversationEventsBatch([
			{ role: "user", body: "first", scope: "agent" },
			{ role: "assistant", body: "second", scope: "agent" },
		])
		await manager.memoryJobWorkerPromise

		// ONE run for the whole call; both inserts landed → status ok.
		expect(recordIngestRun).toHaveBeenCalledTimes(1)
		const [[call]] = mocked(recordIngestRun).mock.calls
		expect(call.run).toMatchObject({
			agentId: "agent-1",
			source: "event-write",
			status: "ok",
			itemsProcessed: 2,
			itemsFailed: 0,
		})
		expect(typeof call.run.durationMs).toBe("number")
	})

	it("marks the batch ingest run partial when an insert fails (W16)", async () => {
		const { writeEventsBatch } = await mockBatchPath()
		const { recordIngestRun } = await import("./mongodb-ops.js")
		const { eventsCollection } = await import("./mongodb-schema.js")
		mocked(eventsCollection).mockReturnValue({
			find: vi.fn(() => ({ toArray: vi.fn(async () => []) })),
		} as never)
		mocked(writeEventsBatch).mockImplementation(
			async ({ events }: { events: Array<{ eventId?: string }> }) =>
				events.map((event, index) =>
					index === 2
						? {
								ok: false as const,
								duplicateKey: false,
								message: "validation failed",
							}
						: {
								ok: true as const,
								eventId: event.eventId ?? "evt-generated",
								timestamp: new Date("2026-04-09T12:00:00.000Z"),
								scopeRef: "agent:agent-1",
							},
				),
		)

		const manager = makeManager()
		const receipts = await manager.writeConversationEventsBatch([
			{ role: "user", body: "first", scope: "agent" },
			{ role: "assistant", body: "second", scope: "agent" },
			{ role: "user", body: "third, invalid", scope: "agent" },
		])
		await manager.memoryJobWorkerPromise

		expect(receipts[2]).toMatchObject({ ok: false, code: "WRITE_ERROR" })
		// The failed insert never became durable, so it counts as an ingest
		// failure — not silently dropped from the run summary.
		expect(recordIngestRun).toHaveBeenCalledTimes(1)
		const [[call]] = mocked(recordIngestRun).mock.calls
		expect(call.run).toMatchObject({
			status: "partial",
			itemsProcessed: 2,
			itemsFailed: 1,
		})
	})

	it("records no ingest run when every batch item was a pre-write replay (W16)", async () => {
		await mockBatchPath()
		const { recordIngestRun } = await import("./mongodb-ops.js")
		const { eventsCollection } = await import("./mongodb-schema.js")
		const originalTs = new Date("2026-04-09T12:00:00.000Z")
		mocked(eventsCollection).mockReturnValue({
			bsonOptions: DEFAULT_EVENT_WRITE_OPTIONS,
			find: vi.fn(() => ({
				toArray: vi.fn(async () => [
					{
						eventId: "evt-original-1",
						agentId: "agent-1",
						role: "user",
						body: "first replayed",
						scope: "agent",
						scopeRef: "agent:agent-1",
						idempotencyKey: "key-br1",
						timestamp: originalTs,
					},
				]),
			})),
		} as never)

		const manager = makeManager()
		const receipts = await manager.writeConversationEventsBatch([
			{
				role: "user",
				body: "first replayed",
				scope: "agent",
				idempotencyKey: "key-br1",
			},
		])
		await manager.memoryJobWorkerPromise

		expect(receipts[0]).toMatchObject({ ok: true, replayed: true })
		// No item attempted an insert, so no ingest happened at this boundary.
		expect(recordIngestRun).not.toHaveBeenCalled()
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
		mocked(eventsCollection).mockReturnValue({
			bsonOptions: DEFAULT_EVENT_WRITE_OPTIONS,
			find,
		} as never)

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
		expect(find).toHaveBeenCalledWith(
			{
				agentId: "agent-1",
				idempotencyKey: { $in: ["key-replay"] },
			},
			expect.objectContaining(EVENT_IDENTITY_READ_OPTIONS),
		)
		expect(mocked(writeEventsBatch).mock.calls[0][0].events).toHaveLength(1)
		expect(createMemoryJobsBatch).toHaveBeenCalledTimes(1)
	})

	it("rejects a failed batch preflight before attempting any writes", async () => {
		const { writeEventsBatch, projectEventChunksBatch, createMemoryJobsBatch } =
			await mockBatchPath()
		const { eventsCollection } = await import("./mongodb-schema.js")
		const find = vi.fn(() => ({
			toArray: vi.fn(async () => {
				throw new Error("idempotency preflight unavailable")
			}),
		}))
		mocked(eventsCollection).mockReturnValue({ find } as never)

		const manager = makeManager()
		await expect(
			manager.writeConversationEventsBatch([
				{
					role: "user",
					body: "must stop before insert",
					scope: "agent",
					idempotencyKey: "key-preflight",
				},
				{ role: "assistant", body: "unkeyed sibling", scope: "agent" },
			]),
		).resolves.toEqual([
			{
				ok: false,
				code: "WRITE_ERROR",
				message: "idempotency preflight unavailable",
			},
			{
				ok: false,
				code: "WRITE_ERROR",
				message: "idempotency preflight unavailable",
			},
		])

		expect(find).toHaveBeenCalledWith(
			{
				agentId: "agent-1",
				idempotencyKey: { $in: ["key-preflight"] },
			},
			expect.objectContaining(EVENT_IDENTITY_READ_OPTIONS),
		)
		expect(writeEventsBatch).not.toHaveBeenCalled()
		expect(projectEventChunksBatch).not.toHaveBeenCalled()
		expect(createMemoryJobsBatch).not.toHaveBeenCalled()
	})

	it("acknowledges a keyless durable-exists receipt as a replay and still converges projection and jobs (W09)", async () => {
		const { writeEventsBatch, projectEventChunksBatch } = await mockBatchPath()
		const { clearEventExtractionJobPendingBatch } = await import(
			"./mongodb-events.js"
		)
		const { createMemoryJobsBatch } = await import("./mongodb-memory-jobs.js")
		const { eventsCollection } = await import("./mongodb-schema.js")
		const find = vi.fn(() => ({ toArray: vi.fn(async () => []) }))
		mocked(eventsCollection).mockReturnValue({
			bsonOptions: DEFAULT_EVENT_WRITE_OPTIONS,
			find,
		} as never)
		// A prior attempt of the same logical write holds the slot: the
		// receipt is ok with duplicateKey set (retry E11000 on our own
		// eventId, or a read-confirmed uncertain outcome).
		mocked(writeEventsBatch).mockImplementationOnce(
			async ({ events }: { events: Array<{ eventId?: string }> }) =>
				events.map((event, index) =>
					index === 0
						? {
								ok: true as const,
								eventId: event.eventId ?? "evt-prior-attempt",
								timestamp: new Date("2026-04-09T12:00:00.000Z"),
								scopeRef: "agent:agent-1",
								duplicateKey: true as const,
							}
						: {
								ok: true as const,
								eventId: event.eventId ?? "evt-fresh-2",
								timestamp: new Date("2026-04-09T12:00:00.000Z"),
								scopeRef: "agent:agent-1",
							},
				),
		)

		const manager = makeManager()
		const receipts = await manager.writeConversationEventsBatch([
			{ role: "user", body: "prior attempt made this durable", scope: "agent" },
			{ role: "user", body: "fresh sibling", scope: "agent" },
		])
		await manager.memoryJobWorkerPromise

		// The manager assigns eventIds before the batch insert; the duplicate
		// receipt echoes the same id.
		const pendingIds: Array<string | undefined> = mocked(
			writeEventsBatch,
		).mock.calls[0][0].events.map(
			(event: { eventId?: string }) => event.eventId,
		)

		// The durable-exists item is acknowledged as a replay, and BOTH items
		// flow through projection and job staging in this pass (idempotent
		// convergence) instead of being failed as WRITE_ERROR.
		expect(receipts[0]).toEqual({
			ok: true,
			eventId: pendingIds[0],
			chunkCreated: true,
		})
		expect(receipts[1]).toMatchObject({
			ok: true,
			eventId: pendingIds[1],
			chunkCreated: false,
		})
		expect(receipts[1]).not.toHaveProperty("replayed")
		expect(
			mocked(projectEventChunksBatch).mock.calls[0][0].events,
		).toHaveLength(2)
		expect(mocked(createMemoryJobsBatch).mock.calls[0][0].jobs).toHaveLength(2)
		expect(clearEventExtractionJobPendingBatch).toHaveBeenCalledWith(
			expect.objectContaining({ eventIds: pendingIds }),
		)
	})

	it("evaluates automatic episode triggers once per scope identity in a batch", async () => {
		await mockBatchPath()
		const { writeEventsBatch } = await import("./mongodb-events.js")
		const { checkAutoEpisodeTriggers } = await import("./mongodb-episodes.js")
		const { eventsCollection } = await import("./mongodb-schema.js")
		mocked(eventsCollection).mockReturnValue({
			find: vi.fn(() => ({ toArray: vi.fn(async () => []) })),
		} as never)
		mocked(writeEventsBatch).mockImplementationOnce(
			async ({
				events,
			}: {
				events: Array<{
					eventId?: string
					scopeRef?: string
				}>
			}) =>
				events.map((event) => ({
					ok: true as const,
					eventId: event.eventId ?? "evt-generated",
					timestamp: new Date("2026-04-09T12:00:00.000Z"),
					scopeRef: event.scopeRef ?? "agent:agent-1",
				})),
		)
		mocked(checkAutoEpisodeTriggers).mockResolvedValue({ triggered: false })

		const manager = makeManager()
		if (!manager.config.mongodb) {
			throw new Error("test manager requires MongoDB configuration")
		}
		manager.config.mongodb.episodes.enabled = true
		await manager.writeConversationEventsBatch([
			{
				role: "user",
				body: "workspace one, first event",
				scope: "workspace",
				scopeRef: "workspace:one",
			},
			{
				role: "assistant",
				body: "workspace one, second event",
				scope: "workspace",
				scopeRef: "workspace:one",
			},
			{
				role: "user",
				body: "workspace two",
				scope: "workspace",
				scopeRef: "workspace:two",
			},
		])
		await manager.derivationQueue

		expect(checkAutoEpisodeTriggers).toHaveBeenCalledTimes(2)
		expect(checkAutoEpisodeTriggers).toHaveBeenCalledWith(
			expect.objectContaining({
				scope: "workspace",
				scopeRef: "workspace:one",
			}),
		)
		expect(checkAutoEpisodeTriggers).toHaveBeenCalledWith(
			expect.objectContaining({
				scope: "workspace",
				scopeRef: "workspace:two",
			}),
		)
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
		mocked(eventsCollection).mockReturnValue({
			bsonOptions: DEFAULT_EVENT_WRITE_OPTIONS,
			find,
		} as never)

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

	it.each([
		"before",
		"after",
	] as const)("isolates an unserializable keyed preflight item %s a matching replay sibling", async (position) => {
		const { writeEventsBatch } = await mockBatchPath()
		const { eventsCollection } = await import("./mongodb-schema.js")
		const failedStoredPayload = {
			role: "user" as const,
			body: "unserializable keyed metadata",
			scope: "agent" as const,
			metadata: {},
		}
		const matchingPayload = {
			role: "assistant" as const,
			body: "matching keyed sibling",
			scope: "agent" as const,
			metadata: { source: "stored" },
		}
		const find = vi.fn(() => ({
			toArray: vi.fn(async () => [
				{
					eventId: "evt-unserializable",
					agentId: "agent-1",
					...failedStoredPayload,
					scopeRef: "agent:agent-1",
					idempotencyKey: "key-unserializable",
					idempotencyFingerprint: computeIdempotencyFingerprint(
						failedStoredPayload,
						"agent-1",
					),
					timestamp: new Date("2026-04-09T12:00:00.000Z"),
				},
				{
					eventId: "evt-matching-sibling",
					agentId: "agent-1",
					...matchingPayload,
					scopeRef: "agent:agent-1",
					idempotencyKey: "key-matching-sibling",
					idempotencyFingerprint: computeIdempotencyFingerprint(
						matchingPayload,
						"agent-1",
					),
					timestamp: new Date("2026-04-09T12:00:00.000Z"),
				},
			]),
		}))
		mocked(eventsCollection).mockReturnValue({
			bsonOptions: DEFAULT_EVENT_WRITE_OPTIONS,
			find,
		} as unknown as import("mongodb").Collection)
		const failedAttempt = {
			...failedStoredPayload,
			metadata: {
				toBSON() {
					throw new Error("sensitive metadata serialization failure")
				},
			},
			idempotencyKey: "key-unserializable",
		}
		const matchingAttempt = {
			...matchingPayload,
			idempotencyKey: "key-matching-sibling",
		}
		const inputs =
			position === "before"
				? [failedAttempt, matchingAttempt]
				: [matchingAttempt, failedAttempt]

		const manager = makeManager()
		const receipts = await manager.writeConversationEventsBatch(inputs)
		const failedIndex = position === "before" ? 0 : 1
		const matchingIndex = position === "before" ? 1 : 0
		const failedReceipt = receipts[failedIndex]

		expect(failedReceipt).toEqual({
			ok: false,
			code: "WRITE_ERROR",
			message: "idempotency payload comparison could not be completed",
		})
		if (failedReceipt.ok) {
			throw new Error("expected failed preflight receipt")
		}
		expect(failedReceipt.message).not.toContain("sensitive")
		expect(receipts[matchingIndex]).toEqual({
			ok: true,
			eventId: "evt-matching-sibling",
			chunkCreated: false,
			replayed: true,
		})
		expect(mocked(writeEventsBatch)).not.toHaveBeenCalled()
	})

	it("batch pre-read rejects a fingerprinted Date/string metadata collision", async () => {
		const { writeEventsBatch } = await mockBatchPath()
		const { eventsCollection } = await import("./mongodb-schema.js")
		const observedAt = new Date("2026-01-01T00:00:00.000Z")
		const original = {
			role: "user" as const,
			body: "batched typed metadata",
			scope: "agent" as const,
			metadata: { observedAt },
		}
		const find = vi.fn(() => ({
			toArray: vi.fn(async () => [
				{
					eventId: "evt-batch-date",
					agentId: "agent-1",
					...original,
					scopeRef: "agent:agent-1",
					idempotencyKey: "key-batch-date",
					idempotencyFingerprint: computeIdempotencyFingerprint(
						original,
						"agent-1",
					),
					timestamp: new Date("2026-04-09T12:00:00.000Z"),
				},
			]),
		}))
		mocked(eventsCollection).mockReturnValue({
			bsonOptions: DEFAULT_EVENT_WRITE_OPTIONS,
			find,
		} as unknown as import("mongodb").Collection)

		const manager = makeManager()
		const receipts = await manager.writeConversationEventsBatch([
			{
				...original,
				metadata: { observedAt: observedAt.toISOString() },
				idempotencyKey: "key-batch-date",
			},
		])

		expect(receipts[0]).toMatchObject({
			ok: false,
			code: "IDEMPOTENCY_CONFLICT",
		})
		expect(find).toHaveBeenCalledWith(
			{
				agentId: "agent-1",
				idempotencyKey: { $in: ["key-batch-date"] },
			},
			expect.objectContaining(EVENT_IDENTITY_READ_OPTIONS),
		)
		expect(mocked(writeEventsBatch)).not.toHaveBeenCalled()
	})

	it("replays the winner when the batch insert loses an idempotency race", async () => {
		const { writeEventsBatch } = await mockBatchPath()
		const { eventsCollection } = await import("./mongodb-schema.js")
		const winner = {
			eventId: "evt-winner",
			agentId: "agent-1",
			role: "user",
			body: "raced hello",
			scope: "agent",
			scopeRef: "agent:agent-1",
			idempotencyKey: "key-race",
			timestamp: new Date("2026-04-09T12:00:00.000Z"),
		}
		let findCalls = 0
		const find = vi.fn(() => ({
			toArray: vi.fn(async () => (++findCalls === 1 ? [] : [winner])),
		}))
		mocked(eventsCollection).mockReturnValue({
			bsonOptions: DEFAULT_EVENT_WRITE_OPTIONS,
			find,
		} as never)
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
		expect(find).toHaveBeenCalledTimes(2)
	})

	it("batch lost-race replay rejects a fingerprinted RegExp collision", async () => {
		const { writeEventsBatch } = await mockBatchPath()
		const { eventsCollection } = await import("./mongodb-schema.js")
		const original = {
			role: "user" as const,
			body: "batched raced metadata",
			scope: "agent" as const,
			metadata: { pattern: /alpha/i },
		}
		const winner = {
			eventId: "evt-batch-regexp-winner",
			agentId: "agent-1",
			...original,
			scopeRef: "agent:agent-1",
			idempotencyKey: "key-batch-regexp-race",
			idempotencyFingerprint: computeIdempotencyFingerprint(
				original,
				"agent-1",
			),
			timestamp: new Date("2026-04-09T12:00:00.000Z"),
		}
		let findCalls = 0
		const find = vi.fn(() => ({
			toArray: vi.fn(async () => (++findCalls === 1 ? [] : [winner])),
		}))
		mocked(eventsCollection).mockReturnValue({
			bsonOptions: DEFAULT_EVENT_WRITE_OPTIONS,
			find,
		} as unknown as import("mongodb").Collection)
		mocked(writeEventsBatch).mockResolvedValue([
			{
				ok: false,
				eventId: "evt-batch-regexp-loser",
				duplicateKey: true,
				message: "E11000 duplicate key error",
			},
		])

		const manager = makeManager()
		const receipts = await manager.writeConversationEventsBatch([
			{
				...original,
				metadata: { pattern: /beta/i },
				idempotencyKey: "key-batch-regexp-race",
			},
		])

		expect(receipts[0]).toMatchObject({
			ok: false,
			code: "IDEMPOTENCY_CONFLICT",
		})
		expect(find).toHaveBeenCalledTimes(2)
	})

	it("fails every still-pending item when a retry-round preflight read fails", async () => {
		const {
			writeEventsBatch,
			projectEventChunksBatch,
			createMemoryJobsBatch,
			clearEventExtractionJobPendingBatch,
		} = await mockBatchPath()
		const { eventsCollection } = await import("./mongodb-schema.js")
		const { recordIngestRun } = await import("./mongodb-ops.js")
		let findCalls = 0
		const find = vi.fn(() => ({
			toArray: vi.fn(async () => {
				if (++findCalls === 1) {
					return []
				}
				throw new Error("winner replay read unavailable")
			}),
		}))
		mocked(eventsCollection).mockReturnValue({ find } as never)
		mocked(writeEventsBatch).mockImplementationOnce(
			async ({ events }: { events: Array<{ eventId?: string }> }) =>
				events.map((event, index) =>
					index === 1
						? {
								ok: false as const,
								eventId: event.eventId,
								duplicateKey: true,
								message: "E11000 duplicate key error",
							}
						: {
								ok: true as const,
								eventId: event.eventId ?? "evt-generated",
								timestamp: new Date("2026-04-09T12:00:00.000Z"),
								scopeRef: "agent:agent-1",
							},
				),
		)

		const manager = makeManager()
		const receipts = await manager.writeConversationEventsBatch([
			{ role: "user", body: "committed first", scope: "agent" },
			{
				role: "assistant",
				body: "lost keyed race",
				scope: "agent",
				idempotencyKey: "key-read-failure",
			},
			{ role: "user", body: "committed third", scope: "agent" },
		])
		await manager.memoryJobWorkerPromise

		expect(receipts).toEqual([
			{
				ok: false,
				code: "WRITE_ERROR",
				message: "winner replay read unavailable",
			},
			{
				ok: false,
				code: "WRITE_ERROR",
				message: "winner replay read unavailable",
			},
			{
				ok: false,
				code: "WRITE_ERROR",
				message: "winner replay read unavailable",
			},
		])
		expect(find).toHaveBeenCalledTimes(2)
		expect(projectEventChunksBatch).not.toHaveBeenCalled()
		expect(createMemoryJobsBatch).not.toHaveBeenCalled()
		expect(clearEventExtractionJobPendingBatch).not.toHaveBeenCalled()
		expect(recordIngestRun).toHaveBeenCalledWith(
			expect.objectContaining({
				run: expect.objectContaining({
					status: "failed",
					itemsProcessed: 0,
					itemsFailed: 3,
				}),
			}),
		)
	})

	it("isolates a per-item write failure without failing the batch", async () => {
		const { writeEventsBatch } = await mockBatchPath()
		const { eventsCollection } = await import("./mongodb-schema.js")
		mocked(eventsCollection).mockReturnValue({
			find: vi.fn(() => ({ toArray: vi.fn(async () => []) })),
		} as never)
		mocked(writeEventsBatch).mockImplementation(
			async ({
				events,
			}: {
				events: Array<{ eventId?: string; body: string }>
			}) =>
				events.map((event) =>
					event.body === "bad event"
						? {
								ok: false as const,
								eventId: event.eventId,
								duplicateKey: false,
								message: "invalid event timestamp",
							}
						: {
								ok: true as const,
								eventId: event.eventId ?? "evt-good",
								timestamp: new Date("2026-04-09T12:00:00.000Z"),
								scopeRef: "agent:agent-1",
							},
				),
		)

		const manager = makeManager()
		const receipts = await manager.writeConversationEventsBatch([
			{ role: "user", body: "good event", scope: "agent" },
			{ role: "user", body: "bad event", scope: "agent" },
		])

		expect(receipts[0]).toMatchObject({ ok: true, chunkCreated: true })
		expect(receipts[1]).toMatchObject({ ok: false, code: "WRITE_ERROR" })
	})

	it("fails the transactional batch when staged job insertion fails", async () => {
		const { createMemoryJobsBatch, clearEventExtractionJobPendingBatch } =
			await mockBatchPath()
		const { eventsCollection } = await import("./mongodb-schema.js")
		mocked(eventsCollection).mockReturnValue({
			find: vi.fn(() => ({ toArray: vi.fn(async () => []) })),
		} as never)
		mocked(createMemoryJobsBatch).mockRejectedValue(
			new Error("forced batch job insert failure"),
		)

		const manager = makeManager()
		const receipts = await manager.writeConversationEventsBatch([
			{ role: "user", body: "durable event one", scope: "agent" },
			{ role: "user", body: "durable event two", scope: "agent" },
		])
		await manager.memoryJobWorkerPromise

		expect(receipts[0]).toMatchObject({ ok: false, code: "WRITE_ERROR" })
		expect(receipts[1]).toMatchObject({ ok: false, code: "WRITE_ERROR" })
		// The transaction did not commit, so no post-primary cleanup ran.
		expect(clearEventExtractionJobPendingBatch).not.toHaveBeenCalled()
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
// UU-3 fold (WS-13 change 6): batch and single write receipts must stay
// comparable in shape and coverage. Every outcome class the single path can
// produce has a batch counterpart carrying the same facts.
// ---------------------------------------------------------------------------

describe("Receipts parity: batch vs single write (UU-3)", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	function makeManager() {
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
			writeQueue: Promise.resolve(),
			derivationQueue: Promise.resolve(),
			derivationSchedulingQueue: Promise.resolve(),
			memoryJobWorkerId: "worker-1",
			memoryJobWorkerStopped: false,
			memoryJobWorkerActive: false,
			memoryJobWorkerPromise: Promise.resolve(),
			memoryJobOperationContexts: new Map(),
			chunkCount: 0,
			dirty: true,
		}) as MongoDBMemoryManager & { memoryJobWorkerPromise: Promise<void> }
	}

	/** Mock BOTH write paths against one shared collection state. */
	async function mockBothPaths() {
		const {
			writeEvent,
			writeEventsBatch,
			projectEventChunk,
			projectEventChunksBatch,
		} = await import("./mongodb-events.js")
		const { extractAndUpsertEntities } = await import("./mongodb-graph.js")
		const {
			claimMemoryJob,
			createMemoryJob,
			createMemoryJobsBatch,
			releaseStagedMemoryJob,
		} = await import("./mongodb-memory-jobs.js")
		const { promoteDerivedMemoryFromEvent } = await import(
			"./mongodb-derived-memory.js"
		)
		const { eventsCollection } = await import("./mongodb-schema.js")

		mocked(writeEvent).mockResolvedValue({
			eventId: "evt-single",
			timestamp: new Date("2026-09-05T12:00:00.000Z"),
			scopeRef: "agent:agent-1",
		})
		mocked(projectEventChunk).mockResolvedValue({ chunkCreated: true })
		mocked(writeEventsBatch).mockImplementation(
			async ({ events }: { events: Array<{ eventId?: string }> }) =>
				events.map((event) => ({
					ok: true as const,
					eventId: event.eventId ?? "evt-batch",
					timestamp: new Date("2026-09-05T12:00:00.000Z"),
					scopeRef: "agent:agent-1",
				})),
		)
		mocked(projectEventChunksBatch).mockImplementation(
			async ({ events }: { events: Array<{ eventId: string }> }) =>
				events.map(() => ({ chunkCreated: true })),
		)
		mocked(createMemoryJob).mockResolvedValue("extraction-staged")
		mocked(createMemoryJobsBatch).mockImplementation(
			async ({ jobs }: { jobs: Array<{ jobId: string }> }) =>
				jobs.map((job) => ({ ok: true as const, jobId: job.jobId })),
		)
		mocked(releaseStagedMemoryJob).mockResolvedValue(true)
		mocked(claimMemoryJob).mockResolvedValue(null)
		mocked(extractAndUpsertEntities).mockResolvedValue({
			entities: [],
			relationsCreated: 0,
		})
		mocked(promoteDerivedMemoryFromEvent).mockResolvedValue({
			structuredCreated: 0,
			proceduresCreated: 0,
			skipped: true,
			skipReason: "already-promoted",
		})
		return { writeEvent, writeEventsBatch, eventsCollection }
	}

	it("success: the batch receipt carries every field the single receipt carries", async () => {
		const { writeEvent, writeEventsBatch, eventsCollection } =
			await mockBothPaths()
		const find = vi.fn(() => ({ toArray: vi.fn(async () => []) }))
		mocked(eventsCollection).mockReturnValue({
			findOne: vi.fn(async () => null),
			find,
		} as never)

		const payload = {
			role: "user" as const,
			body: "parity hello",
			scope: "agent" as const,
		}
		const manager = makeManager()
		const single = await manager.writeConversationEvent(payload)
		const batch = await manager.writeConversationEventsBatch([payload])
		await manager.memoryJobWorkerPromise

		expect(single).toEqual({ eventId: "evt-single", chunkCreated: true })
		expect(batch).toHaveLength(1)
		// Shape parity: every field the single receipt reports, the batch
		// receipt reports too, plus the per-item ok envelope.
		expect(batch[0]).toMatchObject({
			ok: true,
			eventId: expect.any(String),
			chunkCreated: single.chunkCreated,
		})
		// Same durability contract: each path made exactly one durable write.
		expect(mocked(writeEvent)).toHaveBeenCalledTimes(1)
		expect(
			mocked(writeEventsBatch).mock.calls[0]?.[0].events ?? [],
		).toHaveLength(1)
	})

	it("idempotent replay: both paths return the SAME original eventId with chunkCreated:false", async () => {
		const { writeEvent, writeEventsBatch, eventsCollection } =
			await mockBothPaths()
		const existing = {
			eventId: "evt-original",
			agentId: "agent-1",
			role: "user",
			body: "idempotent hello",
			scope: "agent",
			scopeRef: "agent:agent-1",
			idempotencyKey: "key-parity",
			timestamp: new Date("2026-09-05T12:00:00.000Z"),
		}
		const findOne = vi.fn(async () => existing)
		const find = vi.fn(() => ({ toArray: vi.fn(async () => [existing]) }))
		mocked(eventsCollection).mockReturnValue({
			bsonOptions: DEFAULT_EVENT_WRITE_OPTIONS,
			findOne,
			find,
		} as never)

		const payload = {
			role: "user" as const,
			body: "idempotent hello",
			scope: "agent" as const,
			idempotencyKey: "key-parity",
		}
		const manager = makeManager()
		const single = await manager.writeConversationEvent(payload)
		const batch = await manager.writeConversationEventsBatch([payload])

		expect(single).toEqual({ eventId: "evt-original", chunkCreated: false })
		// The batch receipt is a strict superset: same facts, plus the
		// explicit replayed marker the single shape leaves implicit.
		expect(batch[0]).toMatchObject({
			ok: true,
			eventId: "evt-original",
			chunkCreated: false,
			replayed: true,
		})
		// Coverage parity: neither path re-wrote the durable event.
		expect(mocked(writeEvent)).not.toHaveBeenCalled()
		expect(
			mocked(writeEventsBatch).mock.calls[0]?.[0].events ?? [],
		).toHaveLength(0)
	})

	it("idempotency conflict: the single path's IdempotencyConflictError maps to a per-item IDEMPOTENCY_CONFLICT receipt", async () => {
		const { writeEvent, writeEventsBatch, eventsCollection } =
			await mockBothPaths()
		const existing = {
			eventId: "evt-original",
			agentId: "agent-1",
			role: "user",
			body: "the ORIGINAL payload",
			scope: "agent",
			scopeRef: "agent:agent-1",
			idempotencyKey: "key-conflict",
			timestamp: new Date("2026-09-05T12:00:00.000Z"),
		}
		const findOne = vi.fn(async () => existing)
		const find = vi.fn(() => ({ toArray: vi.fn(async () => [existing]) }))
		mocked(eventsCollection).mockReturnValue({ findOne, find } as never)

		const payload = {
			role: "user" as const,
			body: "a DIFFERENT payload",
			scope: "agent" as const,
			idempotencyKey: "key-conflict",
		}
		const manager = makeManager()
		await expect(manager.writeConversationEvent(payload)).rejects.toMatchObject(
			{ name: "IdempotencyConflictError" },
		)
		const batch = await manager.writeConversationEventsBatch([payload])

		expect(batch).toHaveLength(1)
		expect(batch[0]).toMatchObject({
			ok: false,
			code: "IDEMPOTENCY_CONFLICT",
			message: expect.any(String),
		})
		// Coverage parity: neither path wrote the conflicting payload.
		expect(mocked(writeEvent)).not.toHaveBeenCalled()
		expect(
			mocked(writeEventsBatch).mock.calls[0]?.[0].events ?? [],
		).toHaveLength(0)
	})

	it("write failure: the single path's thrown error maps to a per-item WRITE_ERROR receipt", async () => {
		const { writeEvent } = await mockBothPaths()
		const { writeEventsBatch } = await import("./mongodb-events.js")
		mocked(writeEvent).mockRejectedValue(new Error("disk full"))
		mocked(writeEventsBatch).mockResolvedValue([
			{ ok: false as const, message: "disk full" },
		])

		const payload = {
			role: "user" as const,
			body: "doomed write",
			scope: "agent" as const,
		}
		const manager = makeManager()
		await expect(manager.writeConversationEvent(payload)).rejects.toThrow(
			"disk full",
		)
		const batch = await manager.writeConversationEventsBatch([payload])

		expect(batch).toHaveLength(1)
		expect(batch[0]).toMatchObject({
			ok: false,
			code: "WRITE_ERROR",
			message: "disk full",
		})
		// The failed single attempt left nothing durable to contradict.
		expect(mocked(writeEvent)).toHaveBeenCalledTimes(1)
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
			memoryJobOperationContexts: new Map(),
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

describe("MongoDBMemoryManager workspace-scope identity (W06)", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	function makeManager() {
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
			writeQueue: Promise.resolve(),
			derivationQueue: Promise.resolve(),
			derivationSchedulingQueue: Promise.resolve(),
			memoryJobWorkerId: "worker-1",
			memoryJobWorkerStopped: false,
			memoryJobWorkerActive: false,
			memoryJobWorkerPromise: Promise.resolve(),
			memoryJobOperationContexts: new Map(),
			chunkCount: 0,
			dirty: true,
		}) as MongoDBMemoryManager & {
			writeQueue: Promise<void>
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
			eventId: "evt-w06",
			timestamp: new Date("2026-09-06T12:00:00.000Z"),
			scopeRef: "agent:agent-1",
		})
		mocked(projectEventChunk).mockResolvedValue({ chunkCreated: false })
		mocked(extractAndUpsertEntities).mockResolvedValue({
			entities: [],
			relationsCreated: 0,
		})
		mocked(createMemoryJob).mockResolvedValue("extraction-evt-w06")
		mocked(claimMemoryJob).mockResolvedValue(null)
		mocked(promoteDerivedMemoryFromEvent).mockResolvedValue({
			structuredCreated: 0,
			proceduresCreated: 0,
			skipped: true,
			skipReason: "already-promoted",
		})
		return { writeEvent }
	}

	it("lands an implicit workspace write in the hashed workspace partition, not workspace:<agentId>", async () => {
		const { writeEvent } = await mockWritePathDefaults()
		const { resolveScopeIdentity } = await import("./mongodb-scope.js")

		const manager = makeManager()
		await manager.writeConversationEvent({
			role: "user",
			body: "implicit workspace event",
			scope: "workspace",
		})

		// The canonical partition the search side reads from: same resolver,
		// same workspaceDir. Anything else here is a write/read mismatch.
		const { scopeRef: expectedScopeRef } = resolveScopeIdentity({
			scope: "workspace",
			agentId: "agent-1",
			workspaceDir: "/tmp/memongo",
		})
		expect(expectedScopeRef).toMatch(/^workspace:/)
		expect(expectedScopeRef).not.toBe("workspace:agent-1")

		const writtenEvent = mocked(writeEvent).mock.calls[0][0].event as {
			scope: string
			scopeRef: string
		}
		expect(writtenEvent.scope).toBe("workspace")
		expect(writtenEvent.scopeRef).toBe(expectedScopeRef)
	})

	it("batches implicit workspace writes into the hashed workspace partition", async () => {
		const { writeEvent } = await import("./mongodb-events.js")
		const {
			writeEventsBatch,
			projectEventChunksBatch,
			clearEventExtractionJobPendingBatch,
		} = await import("./mongodb-events.js")
		const { extractAndUpsertEntities } = await import("./mongodb-graph.js")
		const { claimMemoryJob, createMemoryJobsBatch } = await import(
			"./mongodb-memory-jobs.js"
		)
		const { resolveScopeIdentity } = await import("./mongodb-scope.js")
		const { eventsCollection } = await import("./mongodb-schema.js")
		mocked(writeEvent)
		mocked(writeEventsBatch).mockImplementation(
			async ({ events }: { events: Array<{ eventId?: string }> }) =>
				events.map((event) => ({
					ok: true as const,
					eventId: event.eventId ?? "evt-generated",
					timestamp: new Date("2026-09-06T12:00:00.000Z"),
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

		const manager = makeManager()
		await manager.writeConversationEventsBatch([
			{
				role: "user",
				body: "batched implicit workspace event",
				scope: "workspace",
			},
			{
				role: "user",
				body: "batched explicit workspace event",
				scope: "workspace",
				scopeRef: "workspace:explicit-ref",
			},
		])

		const events = mocked(writeEventsBatch).mock.calls[0][0].events as Array<{
			scope: string
			scopeRef: string
		}>
		expect(events).toHaveLength(2)

		const { scopeRef: expectedScopeRef } = resolveScopeIdentity({
			scope: "workspace",
			agentId: "agent-1",
			workspaceDir: "/tmp/memongo",
		})
		expect(events[0].scope).toBe("workspace")
		expect(events[0].scopeRef).toBe(expectedScopeRef)
		// Explicit scopeRef still wins verbatim (no double-hashing).
		expect(events[1].scopeRef).toBe("workspace:explicit-ref")
	})

	it("fingerprints a workspace write against the hashed partition it lands in", async () => {
		const { writeEvent } = await mockWritePathDefaults()
		const { eventsCollection } = await import("./mongodb-schema.js")
		const { computeIdempotencyFingerprint } = await import(
			"./mongodb-idempotency-fingerprint.js"
		)
		// No prior document: the idempotency pre-check misses and the write
		// proceeds with the freshly computed fingerprint.
		mocked(eventsCollection).mockReturnValue({
			findOne: vi.fn(async () => null),
		} as unknown as import("mongodb").Collection)

		const manager = makeManager()
		await manager.writeConversationEvent({
			role: "user",
			body: "workspace fingerprint event",
			scope: "workspace",
			idempotencyKey: "key-w06",
		})

		const writtenEvent = mocked(writeEvent).mock.calls[0][0].event as {
			idempotencyFingerprint?: string
		}
		// The persisted fingerprint must key to the hashed partition (with
		// workspaceDir), matching what the conflict detector computes — not the
		// workspace:<agentId> fallback the request-level fields alone produce.
		expect(writtenEvent.idempotencyFingerprint).toBe(
			computeIdempotencyFingerprint(
				{
					role: "user",
					body: "workspace fingerprint event",
					scope: "workspace",
					idempotencyKey: "key-w06",
				},
				"agent-1",
				undefined,
				"/tmp/memongo",
			),
		)
	})
})
