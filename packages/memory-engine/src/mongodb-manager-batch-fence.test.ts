import type { ClientSession, Collection, Db, Document } from "mongodb"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { computeIdempotencyFingerprint } from "./mongodb-idempotency-fingerprint.js"
import { ErasureGateConflictError } from "./mongodb-write-fence.js"
import {
	MongoDBManagerWriteOps,
	type WriteConversationEventInput,
} from "./mongodb-manager-write.js"
import type { MongoDBManagerHost } from "./mongodb-manager-host.js"

const mocks = vi.hoisted(() => ({
	captureAdmissionToken: vi.fn(),
	withFencedWrite: vi.fn(),
	eventsCollection: vi.fn(),
	projectEventChunksBatch: vi.fn(),
	clearEventExtractionJobPendingBatch: vi.fn(),
	createMemoryJobsBatch: vi.fn(),
	releaseStagedMemoryJobsBatch: vi.fn(),
	recordIngestRun: vi.fn(),
	recordProjectionRun: vi.fn(async () => "projection-run-id"),
	updateLaneCoverage: vi.fn(),
}))

vi.mock("./mongodb-write-fence.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("./mongodb-write-fence.js")>()),
	captureAdmissionToken: mocks.captureAdmissionToken,
	withFencedWrite: mocks.withFencedWrite,
}))

vi.mock("./mongodb-schema.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("./mongodb-schema.js")>()),
	eventsCollection: mocks.eventsCollection,
}))

vi.mock("./mongodb-events.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("./mongodb-events.js")>()),
	projectEventChunksBatch: mocks.projectEventChunksBatch,
	clearEventExtractionJobPendingBatch:
		mocks.clearEventExtractionJobPendingBatch,
}))

vi.mock("./mongodb-memory-jobs.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("./mongodb-memory-jobs.js")>()),
	createMemoryJobsBatch: mocks.createMemoryJobsBatch,
	releaseStagedMemoryJobsBatch: mocks.releaseStagedMemoryJobsBatch,
}))

vi.mock("./mongodb-ops.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("./mongodb-ops.js")>()),
	recordIngestRun: mocks.recordIngestRun,
	recordProjectionRun: mocks.recordProjectionRun,
}))

vi.mock("./mongodb-lane-coverage.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("./mongodb-lane-coverage.js")>()),
	updateLaneCoverage: mocks.updateLaneCoverage,
}))

type TestCollection = {
	bsonOptions: Record<string, never>
	find: ReturnType<typeof vi.fn>
	insertMany: ReturnType<typeof vi.fn>
}

function createCollection(params?: {
	stored?: Document[]
	insertMany?: (docs: Document[]) => Promise<unknown>
}): TestCollection {
	const stored = params?.stored ?? []
	return {
		bsonOptions: {},
		find: vi.fn(() => ({
			toArray: vi.fn(async () => stored),
		})),
		insertMany: vi.fn(
			params?.insertMany ??
				(async (docs: Document[]) => ({
					acknowledged: true,
					insertedCount: docs.length,
				})),
		),
	}
}

function createWriter(params?: {
	derivedWork?: boolean
	ttl?: { enabled: boolean; sessionDays: number }
}) {
	const host = {
		db: {} as Db,
		prefix: "test_",
		agentId: "agent-1",
		closed: false,
		config: {
			mongodb: {
				embeddingMode: "manual",
				episodes: { enabled: false, minEventsForEpisode: 6 },
				...(params?.ttl ? { ttl: params.ttl } : {}),
			},
		},
		workspaceDir: "/tmp/memongo",
		writeQueue: Promise.resolve(),
		writeQueueDepth: 0,
		chunkCount: 0,
		dirty: true,
		memoryJobWorkerStopped: false,
		memoryJobOperationContexts: new Map(),
		shouldRunPostWriteDerivedWork: vi.fn(() => params?.derivedWork ?? false),
		schedulePostWriteDerivations: vi.fn(async () => undefined),
		scheduleQueryCacheInvalidation: vi.fn(),
		startMemoryJobWorker: vi.fn(),
		wakeMemoryJobWorker: vi.fn(),
	} as unknown as MongoDBManagerHost
	return { host, writer: new MongoDBManagerWriteOps(host) }
}

function write(
	writer: MongoDBManagerWriteOps,
	events: WriteConversationEventInput[],
) {
	return writer.writeConversationEventsBatch(events)
}

describe("MongoDBManagerWriteOps fenced batch", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mocks.captureAdmissionToken.mockResolvedValue({
			kind: "admission",
			agentId: "agent-1",
			epoch: 7,
		})
		mocks.withFencedWrite.mockImplementation(
			async ({ fn }: { fn: (session: ClientSession) => Promise<unknown> }) =>
				fn({} as ClientSession),
		)
		mocks.projectEventChunksBatch.mockImplementation(
			async ({ events }: { events: unknown[] }) =>
				events.map(() => ({ chunkCreated: true })),
		)
		mocks.clearEventExtractionJobPendingBatch.mockResolvedValue(0)
		mocks.createMemoryJobsBatch.mockImplementation(
			async ({ jobs }: { jobs: Array<{ jobId: string }> }) =>
				jobs.map((job) => ({ ok: true, jobId: job.jobId })),
		)
		mocks.releaseStagedMemoryJobsBatch.mockImplementation(
			async ({ jobIds }: { jobIds: string[] }) => jobIds.length,
		)
		mocks.recordIngestRun.mockResolvedValue(undefined)
		mocks.updateLaneCoverage.mockResolvedValue(undefined)
		mocks.eventsCollection.mockReturnValue(
			createCollection() as unknown as Collection,
		)
	})

	it("captures admission before queue delay and reuses the token", async () => {
		let releaseQueue = () => {}
		const queuedAhead = new Promise<void>((resolve) => {
			releaseQueue = resolve
		})
		const { host, writer } = createWriter()
		host.writeQueue = queuedAhead

		const result = write(writer, [
			{ role: "user", body: "queued", scope: "agent" },
		])

		expect(mocks.captureAdmissionToken).toHaveBeenCalledOnce()
		expect(mocks.withFencedWrite).not.toHaveBeenCalled()
		releaseQueue()
		await result
		expect(mocks.withFencedWrite).toHaveBeenCalledWith(
			expect.objectContaining({
				token: {
					kind: "admission",
					agentId: "agent-1",
					epoch: 7,
				},
			}),
		)
	})

	it("rebuilds callback-local drafts while preserving prepared ids and clocks", async () => {
		const collection = createCollection()
		mocks.eventsCollection.mockReturnValue(collection as unknown as Collection)
		mocks.withFencedWrite.mockImplementationOnce(
			async ({ fn }: { fn: (session: ClientSession) => Promise<unknown> }) => {
				await fn({} as ClientSession)
				return fn({} as ClientSession)
			},
		)
		const { writer } = createWriter({ derivedWork: true })

		const receipts = await write(writer, [
			{ role: "user", body: "retry callback", scope: "agent" },
		])

		expect(receipts[0]).toMatchObject({ ok: true })
		expect(collection.insertMany).toHaveBeenCalledTimes(2)
		const firstEvent = collection.insertMany.mock.calls[0][0][0]
		const secondEvent = collection.insertMany.mock.calls[1][0][0]
		expect(secondEvent.eventId).toBe(firstEvent.eventId)
		expect(secondEvent.timestamp).toEqual(firstEvent.timestamp)
		expect(secondEvent.recordedAt).toEqual(firstEvent.recordedAt)
		const firstJob = mocks.createMemoryJobsBatch.mock.calls[0][0].jobs[0]
		const secondJob = mocks.createMemoryJobsBatch.mock.calls[1][0].jobs[0]
		expect(secondJob.jobId).toBe(firstJob.jobId)
		expect(secondJob.createdAt).toEqual(firstJob.createdAt)
		expect(secondJob.stagedAt).toEqual(firstJob.stagedAt)
	})

	it("publishes only the final callback draft after a driver rerun", async () => {
		const stored = {
			eventId: "evt-first-callback-only",
			agentId: "agent-1",
			role: "user",
			body: "retry callback state",
			scope: "agent",
			scopeRef: "agent:agent-1",
			idempotencyKey: "retry-callback-key",
			timestamp: new Date("2026-09-08T12:00:00.000Z"),
		}
		let findCalls = 0
		const collection = createCollection()
		collection.find.mockImplementation(() => ({
			toArray: vi.fn(async () => (++findCalls === 1 ? [stored] : [])),
		}))
		mocks.eventsCollection.mockReturnValue(collection as unknown as Collection)
		mocks.withFencedWrite.mockImplementationOnce(
			async ({ fn }: { fn: (session: ClientSession) => Promise<unknown> }) => {
				await fn({} as ClientSession)
				return fn({} as ClientSession)
			},
		)
		const { writer } = createWriter()

		const receipts = await write(writer, [
			{
				role: "user",
				body: "retry callback state",
				scope: "agent",
				idempotencyKey: "retry-callback-key",
			},
		])

		expect(collection.insertMany).toHaveBeenCalledOnce()
		expect(receipts[0]).toMatchObject({ ok: true })
		expect(receipts[0]).not.toMatchObject({
			eventId: "evt-first-callback-only",
			replayed: true,
		})
	})

	it("inserts one leader for identical local keys and replays its receipt", async () => {
		const collection = createCollection()
		mocks.eventsCollection.mockReturnValue(collection as unknown as Collection)
		const { writer } = createWriter({ derivedWork: true })

		const receipts = await write(writer, [
			{
				role: "user",
				body: "same",
				scope: "agent",
				idempotencyKey: "shared",
			},
			{
				role: "user",
				body: "same",
				scope: "agent",
				idempotencyKey: "shared",
			},
		])

		expect(collection.insertMany.mock.calls[0][0]).toHaveLength(1)
		expect(mocks.createMemoryJobsBatch.mock.calls[0][0].jobs).toHaveLength(1)
		expect(receipts[0]).toMatchObject({ ok: true })
		expect(receipts[1]).toEqual({
			ok: true,
			eventId: (receipts[0] as { eventId: string }).eventId,
			chunkCreated: true,
			replayed: true,
		})
	})

	it("treats identical local keys as replays when implicit TTL clocks differ", async () => {
		vi.useFakeTimers()
		try {
			const firstNow = new Date("2026-09-08T12:00:00.000Z")
			vi.setSystemTime(firstNow)
			const secondInput = {
				role: "user" as const,
				body: "same TTL payload",
				sessionId: "session-1",
				idempotencyKey: "shared-ttl",
			}
			Object.defineProperty(secondInput, "scope", {
				configurable: true,
				get() {
					vi.setSystemTime(new Date(firstNow.getTime() + 1_000))
					return undefined
				},
			})
			const collection = createCollection()
			mocks.eventsCollection.mockReturnValue(
				collection as unknown as Collection,
			)
			const { writer } = createWriter({
				ttl: { enabled: true, sessionDays: 1 },
			})

			const receipts = await write(writer, [
				{
					role: "user",
					body: "same TTL payload",
					sessionId: "session-1",
					idempotencyKey: "shared-ttl",
				},
				secondInput,
			])

			expect(collection.insertMany.mock.calls[0][0]).toHaveLength(1)
			expect(receipts[0]).toMatchObject({ ok: true })
			expect(receipts[1]).toMatchObject({
				ok: true,
				replayed: true,
				eventId: (receipts[0] as { eventId: string }).eventId,
			})
		} finally {
			vi.useRealTimers()
		}
	})

	it.each([
		[
			"Date/string",
			{ value: new Date("2026-09-08T12:00:00.000Z") },
			{ value: "2026-09-08T12:00:00.000Z" },
		],
		["RegExp", { value: /alpha/i }, { value: /beta/i }],
	])("preserves BSON-distinct %s metadata for local followers", async (_label, leaderMetadata, followerMetadata) => {
		const leader = {
			role: "user" as const,
			body: "typed metadata",
			scope: "agent" as const,
			metadata: leaderMetadata,
			idempotencyKey: "typed-metadata",
		}
		const follower = { ...leader, metadata: followerMetadata }
		expect(computeIdempotencyFingerprint(leader, "agent-1")).toBe(
			computeIdempotencyFingerprint(follower, "agent-1"),
		)
		const { writer } = createWriter()

		const receipts = await write(writer, [leader, follower])

		expect(receipts[0]).toMatchObject({ ok: true })
		expect(receipts[1]).toMatchObject({
			ok: false,
			code: "IDEMPOTENCY_CONFLICT",
		})
	})

	it("isolates a local follower whose metadata cannot be BSON-serialized", async () => {
		const leader = {
			role: "user" as const,
			body: "unserializable follower",
			scope: "agent" as const,
			metadata: { value: {} },
			idempotencyKey: "unserializable-follower",
		}
		const follower = {
			...leader,
			metadata: {
				value: {
					toBSON() {
						throw new Error("sensitive serialization failure")
					},
				},
			},
		}
		expect(computeIdempotencyFingerprint(leader, "agent-1")).toBe(
			computeIdempotencyFingerprint(follower, "agent-1"),
		)
		const { writer } = createWriter()

		const receipts = await write(writer, [leader, follower])

		expect(receipts[0]).toMatchObject({ ok: true })
		expect(receipts[1]).toEqual({
			ok: false,
			code: "WRITE_ERROR",
			message: "idempotency payload comparison could not be completed",
		})
		expect(receipts[1]?.ok === false ? receipts[1].message : "").not.toContain(
			"sensitive",
		)
	})

	it("promotes a prepared same-key successor after code 121", async () => {
		let call = 0
		const collection = createCollection({
			insertMany: async () => {
				call++
				if (call === 1) {
					throw {
						writeErrors: [
							{ index: 0, code: 121, errmsg: "document failed validation" },
						],
					}
				}
				return { acknowledged: true }
			},
		})
		mocks.eventsCollection.mockReturnValue(collection as unknown as Collection)
		let commits = 0
		mocks.withFencedWrite.mockImplementation(
			async ({ fn }: { fn: (session: ClientSession) => Promise<unknown> }) => {
				const value = await fn({} as ClientSession)
				commits++
				return value
			},
		)
		const { writer } = createWriter()

		const receipts = await write(writer, [
			{
				role: "user",
				body: "server-invalid leader",
				scope: "agent",
				idempotencyKey: "shared",
			},
			{
				role: "assistant",
				body: "valid successor",
				scope: "agent",
				idempotencyKey: "shared",
			},
			{ role: "user", body: "unrelated", scope: "agent" },
		])

		expect(receipts[0]).toMatchObject({ ok: false, code: "WRITE_ERROR" })
		expect(receipts[1]).toMatchObject({ ok: true })
		expect(receipts[2]).toMatchObject({ ok: true })
		expect(collection.insertMany).toHaveBeenCalledTimes(2)
		expect(collection.insertMany.mock.calls[0][0]).toHaveLength(2)
		expect(collection.insertMany.mock.calls[1][0]).toHaveLength(2)
		expect(collection.insertMany.mock.calls[1][0][0].body).toBe(
			"valid successor",
		)
		expect(commits).toBe(5)
	})

	it("runs a final fence-only round when code 121 removes the last item", async () => {
		const collection = createCollection({
			insertMany: async () => {
				throw {
					writeErrors: [
						{ index: 0, code: 121, errmsg: "document failed validation" },
					],
				}
			},
		})
		mocks.eventsCollection.mockReturnValue(collection as unknown as Collection)
		const { writer } = createWriter()

		const receipts = await write(writer, [
			{ role: "user", body: "server-invalid", scope: "agent" },
		])

		expect(receipts[0]).toMatchObject({ ok: false, code: "WRITE_ERROR" })
		expect(mocks.withFencedWrite).toHaveBeenCalledTimes(3)
		expect(collection.insertMany).toHaveBeenCalledOnce()
	})

	it("propagates a typed erasure conflict from the final fence-only round", async () => {
		const collection = createCollection({
			insertMany: async () => {
				throw {
					writeErrors: [
						{ index: 0, code: 121, errmsg: "document failed validation" },
					],
				}
			},
		})
		mocks.eventsCollection.mockReturnValue(collection as unknown as Collection)
		let round = 0
		mocks.withFencedWrite.mockImplementation(
			async ({ fn }: { fn: (session: ClientSession) => Promise<unknown> }) => {
				round++
				if (round === 2) {
					throw new ErasureGateConflictError("agent-1")
				}
				return fn({} as ClientSession)
			},
		)
		const { writer } = createWriter()

		await expect(
			write(writer, [{ role: "user", body: "server-invalid", scope: "agent" }]),
		).rejects.toBeInstanceOf(ErasureGateConflictError)
		expect(mocks.withFencedWrite).toHaveBeenCalledTimes(2)
	})

	it("confirms only exact minted identities after an uncertain outer error", async () => {
		let inserted: Document[] = []
		const collection = createCollection({
			insertMany: async (docs) => {
				inserted = docs
				return { acknowledged: true }
			},
		})
		collection.find.mockImplementation(() => ({
			toArray: vi.fn(async () => inserted),
		}))
		mocks.eventsCollection.mockReturnValue(collection as unknown as Collection)
		mocks.withFencedWrite.mockImplementationOnce(
			async ({ fn }: { fn: (session: ClientSession) => Promise<unknown> }) => {
				await fn({} as ClientSession)
				throw new Error("response lost after commit")
			},
		)
		const { writer } = createWriter()

		const receipts = await write(writer, [
			{ role: "user", body: "committed", scope: "agent" },
		])

		expect(receipts[0]).toMatchObject({ ok: true })
		expect(mocks.projectEventChunksBatch).toHaveBeenCalledOnce()
		expect(mocks.withFencedWrite).toHaveBeenCalledTimes(4)
	})

	it.each([
		{
			label: "wrong owner",
			input: {},
			change: (event: Document) => ({ ...event, agentId: "agent-other" }),
		},
		{
			label: "changed generated timestamp",
			input: {},
			change: (event: Document) => ({
				...event,
				timestamp: new Date((event.timestamp as Date).getTime() + 1),
			}),
		},
		{
			label: "changed generated validAt",
			input: {},
			change: (event: Document) => ({
				...event,
				validAt: new Date((event.validAt as Date).getTime() + 1),
			}),
		},
		{
			label: "changed invalidAt",
			input: {
				invalidAt: new Date(Date.now() + 24 * 60 * 60 * 1_000),
			},
			change: (event: Document) => ({
				...event,
				invalidAt: new Date((event.invalidAt as Date).getTime() + 1),
			}),
		},
		{
			label: "changed expiresAt",
			input: {
				expiresAt: new Date(Date.now() + 2 * 24 * 60 * 60 * 1_000),
			},
			change: (event: Document) => ({
				...event,
				expiresAt: new Date((event.expiresAt as Date).getTime() + 1),
			}),
		},
		{
			label: "added channel",
			input: {},
			change: (event: Document) => ({ ...event, channel: "other" }),
		},
		{
			label: "added empty metadata",
			input: {},
			change: (event: Document) => ({ ...event, metadata: {} }),
		},
		{
			label: "added invalidAt",
			input: {},
			change: (event: Document) => ({
				...event,
				invalidAt: new Date(
					(event.validAt as Date).getTime() + 24 * 60 * 60 * 1_000,
				),
			}),
		},
		{
			label: "added expiresAt",
			input: {},
			change: (event: Document) => ({
				...event,
				expiresAt: new Date(
					(event.validAt as Date).getTime() + 2 * 24 * 60 * 60 * 1_000,
				),
			}),
		},
	] satisfies Array<{
		label: string
		input: Partial<WriteConversationEventInput>
		change: (event: Document) => Document
	}>)("keeps a $label majority-confirmation document uncertain", async ({
		input,
		change,
	}) => {
		let inserted: Document[] = []
		const collection = createCollection({
			insertMany: async (docs) => {
				inserted = docs
				return { acknowledged: true }
			},
		})
		collection.find.mockImplementation(() => ({
			toArray: vi.fn(async () => [change(inserted[0] ?? {})]),
		}))
		mocks.eventsCollection.mockReturnValue(collection as unknown as Collection)
		mocks.withFencedWrite.mockImplementationOnce(
			async ({ fn }: { fn: (session: ClientSession) => Promise<unknown> }) => {
				await fn({} as ClientSession)
				throw new Error("response lost after commit")
			},
		)
		const { writer } = createWriter()

		const receipts = await write(writer, [
			{
				role: "user",
				body: "committed",
				scope: "agent",
				...input,
			},
		])

		expect(receipts[0]).toEqual({
			ok: false,
			code: "WRITE_ERROR",
			message:
				"event durability unconfirmed; a keyless outcome cannot be retried safely",
		})
		expect(mocks.projectEventChunksBatch).not.toHaveBeenCalled()
	})

	it.each([
		"malformed",
		"mismatched",
	] as const)("keeps a %s majority-confirmation document uncertain", async (confirmation) => {
		let inserted: Document[] = []
		const collection = createCollection({
			insertMany: async (docs) => {
				inserted = docs
				return { acknowledged: true }
			},
		})
		collection.find.mockImplementation(() => ({
			toArray: vi.fn(async () =>
				confirmation === "malformed"
					? [{ eventId: inserted[0]?.eventId }]
					: [{ ...inserted[0], body: "different body" }],
			),
		}))
		mocks.eventsCollection.mockReturnValue(collection as unknown as Collection)
		mocks.withFencedWrite.mockImplementationOnce(
			async ({ fn }: { fn: (session: ClientSession) => Promise<unknown> }) => {
				await fn({} as ClientSession)
				throw new Error("response lost after commit")
			},
		)
		const { writer } = createWriter()

		const receipts = await write(writer, [
			{ role: "user", body: "committed", scope: "agent" },
		])

		expect(receipts[0]).toEqual({
			ok: false,
			code: "WRITE_ERROR",
			message:
				"event durability unconfirmed; a keyless outcome cannot be retried safely",
		})
		expect(mocks.projectEventChunksBatch).not.toHaveBeenCalled()
	})

	it("does not claim that a keyless uncertain outcome is safely retryable", async () => {
		const collection = createCollection()
		mocks.eventsCollection.mockReturnValue(collection as unknown as Collection)
		mocks.withFencedWrite.mockRejectedValueOnce(new Error("unknown outcome"))
		const { writer } = createWriter()

		const receipts = await write(writer, [
			{ role: "user", body: "unknown", scope: "agent" },
		])

		expect(receipts[0]).toEqual({
			ok: false,
			code: "WRITE_ERROR",
			message:
				"event durability unconfirmed; a keyless outcome cannot be retried safely",
		})
	})

	it("does not enter a fence when every item fails local preparation", async () => {
		const { writer } = createWriter()
		const at = new Date("2026-09-08T12:00:00.000Z")

		const receipts = await write(writer, [
			{
				role: "user",
				body: "invalid interval",
				scope: "agent",
				validAt: at,
				invalidAt: at,
			},
		])

		expect(receipts[0]).toEqual({
			ok: false,
			code: "WRITE_ERROR",
			message: "event invalidAt must be later than validAt",
		})
		expect(mocks.captureAdmissionToken).toHaveBeenCalledOnce()
		expect(mocks.withFencedWrite).not.toHaveBeenCalled()
	})

	it("resolves an existing keyed event inside a fence without inserting", async () => {
		const collection = createCollection({
			stored: [
				{
					eventId: "evt-existing",
					agentId: "agent-1",
					role: "user",
					body: "existing",
					scope: "agent",
					scopeRef: "agent:agent-1",
					idempotencyKey: "existing-key",
					timestamp: new Date("2026-09-08T12:00:00.000Z"),
				},
			],
		})
		mocks.eventsCollection.mockReturnValue(collection as unknown as Collection)
		const { writer } = createWriter()

		const receipts = await write(writer, [
			{
				role: "user",
				body: "existing",
				scope: "agent",
				idempotencyKey: "existing-key",
			},
		])

		expect(receipts).toEqual([
			{
				ok: true,
				eventId: "evt-existing",
				chunkCreated: false,
				replayed: true,
			},
		])
		expect(mocks.withFencedWrite).toHaveBeenCalledOnce()
		expect(collection.insertMany).not.toHaveBeenCalled()
	})

	it("resolves an attributable idempotency-index race in a second fence", async () => {
		const winner = {
			eventId: "evt-winner",
			agentId: "agent-1",
			role: "user",
			body: "raced",
			scope: "agent",
			scopeRef: "agent:agent-1",
			idempotencyKey: "race-key",
			timestamp: new Date("2026-09-08T12:00:00.000Z"),
		}
		let findCalls = 0
		const collection = createCollection({
			insertMany: async () => {
				throw {
					writeErrors: [
						{
							index: 0,
							code: 11000,
							errmsg:
								"E11000 duplicate key error index: uq_events_agent_idempotency_key ",
						},
					],
				}
			},
		})
		collection.find.mockImplementation(() => ({
			toArray: vi.fn(async () => (++findCalls === 1 ? [] : [winner])),
		}))
		mocks.eventsCollection.mockReturnValue(collection as unknown as Collection)
		const { writer } = createWriter()

		const receipts = await write(writer, [
			{
				role: "user",
				body: "raced",
				scope: "agent",
				idempotencyKey: "race-key",
			},
		])

		expect(receipts).toEqual([
			{
				ok: true,
				eventId: "evt-winner",
				chunkCreated: false,
				replayed: true,
			},
		])
		expect(mocks.withFencedWrite).toHaveBeenCalledTimes(3)
		expect(collection.insertMany).toHaveBeenCalledOnce()
	})

	it("uses one replay-only fence for an absent structured idempotency winner", async () => {
		const collection = createCollection({
			insertMany: async () => {
				throw {
					writeErrors: [
						{
							index: 0,
							code: 11000,
							errInfo: {
								keyPattern: { agentId: 1, idempotencyKey: 1 },
							},
							errmsg: "duplicate key",
						},
					],
				}
			},
		})
		mocks.eventsCollection.mockReturnValue(collection as unknown as Collection)
		const { writer } = createWriter()

		const receipts = await write(writer, [
			{
				role: "user",
				body: "winner remains absent",
				scope: "agent",
				idempotencyKey: "absent-winner",
			},
		])

		expect(receipts).toEqual([
			{
				ok: false,
				code: "WRITE_ERROR",
				message:
					"event durability unconfirmed; retry with the same idempotency key",
			},
		])
		expect(mocks.withFencedWrite).toHaveBeenCalledTimes(3)
		expect(collection.find).toHaveBeenCalledTimes(2)
		expect(collection.insertMany).toHaveBeenCalledOnce()
	})

	it("does not attribute E11000 from a different unique index", async () => {
		const collection = createCollection({
			insertMany: async () => {
				throw {
					writeErrors: [
						{
							index: 0,
							code: 11000,
							errmsg: "E11000 duplicate key error index: uq_events_event_id ",
						},
					],
				}
			},
		})
		mocks.eventsCollection.mockReturnValue(collection as unknown as Collection)
		const { writer } = createWriter()

		const receipts = await write(writer, [
			{
				role: "user",
				body: "not an idempotency race",
				scope: "agent",
				idempotencyKey: "race-key",
			},
		])

		expect(receipts[0]).toMatchObject({
			ok: false,
			code: "WRITE_ERROR",
		})
		expect(mocks.withFencedWrite).toHaveBeenCalledTimes(2)
	})

	it("does not attribute a mixed valid and malformed bulk error", async () => {
		const collection = createCollection({
			insertMany: async () => {
				throw Object.assign(new Error("mixed bulk failure"), {
					writeErrors: [
						{ index: 0, code: 121, errmsg: "document failed validation" },
						{ code: 121, errmsg: "missing bulk position" },
					],
				})
			},
		})
		mocks.eventsCollection.mockReturnValue(collection as unknown as Collection)
		const { writer } = createWriter()

		const receipts = await write(writer, [
			{ role: "user", body: "unknown outcome", scope: "agent" },
		])

		expect(receipts[0]).toEqual({
			ok: false,
			code: "WRITE_ERROR",
			message: "mixed bulk failure",
		})
		expect(mocks.withFencedWrite).toHaveBeenCalledTimes(2)
	})

	it("replays a fingerprinted session write when only implicit TTL differs", async () => {
		const input = {
			role: "user" as const,
			body: "retry with implicit TTL",
			sessionId: "session-ttl",
			idempotencyKey: "existing-ttl",
		}
		const collection = createCollection({
			stored: [
				{
					eventId: "evt-existing-ttl",
					agentId: "agent-1",
					role: input.role,
					body: input.body,
					sessionId: input.sessionId,
					scope: "session",
					scopeRef: "session:session-ttl",
					idempotencyKey: input.idempotencyKey,
					idempotencyFingerprint: computeIdempotencyFingerprint(
						input,
						"agent-1",
						undefined,
						"/tmp/memongo",
					),
					timestamp: new Date("2026-09-08T12:00:00.000Z"),
					expiresAt: new Date("2026-09-09T12:00:00.000Z"),
				},
			],
		})
		mocks.eventsCollection.mockReturnValue(collection as unknown as Collection)
		const { writer } = createWriter({
			ttl: { enabled: true, sessionDays: 1 },
		})

		const receipts = await write(writer, [input])

		expect(receipts).toEqual([
			{
				ok: true,
				eventId: "evt-existing-ttl",
				chunkCreated: false,
				replayed: true,
			},
		])
		expect(collection.insertMany).not.toHaveBeenCalled()
	})

	it("does not publish event success when staged job insertion aborts", async () => {
		mocks.createMemoryJobsBatch.mockRejectedValueOnce(
			new Error("staged job insert failed"),
		)
		const { writer } = createWriter({ derivedWork: true })

		const receipts = await write(writer, [
			{ role: "user", body: "atomic event and job", scope: "agent" },
		])

		expect(receipts).toEqual([
			{
				ok: false,
				code: "WRITE_ERROR",
				message: "staged job insert failed",
			},
		])
		expect(mocks.projectEventChunksBatch).not.toHaveBeenCalled()
		expect(mocks.releaseStagedMemoryJobsBatch).not.toHaveBeenCalled()
	})

	it("keeps outbox markers when the staged-job batch release is partial", async () => {
		mocks.releaseStagedMemoryJobsBatch.mockResolvedValueOnce(0)
		const { writer } = createWriter({ derivedWork: true })

		const receipts = await write(writer, [
			{ role: "user", body: "release later", scope: "agent" },
		])

		expect(receipts[0]).toMatchObject({ ok: true })
		expect(mocks.releaseStagedMemoryJobsBatch).toHaveBeenCalledOnce()
		expect(mocks.clearEventExtractionJobPendingBatch).not.toHaveBeenCalled()
	})

	it("keeps primary success when post-commit projection fails", async () => {
		mocks.projectEventChunksBatch.mockRejectedValueOnce(
			new Error("projection unavailable"),
		)
		const { writer } = createWriter()

		const receipts = await write(writer, [
			{ role: "user", body: "durable primary", scope: "agent" },
		])

		expect(receipts[0]).toMatchObject({ ok: true, chunkCreated: false })
	})
})
