/* eslint-disable @typescript-eslint/unbound-method -- Vitest mock method assertions */
import {
	BSONRegExp,
	Code,
	MongoServerError,
	type ClientSession,
	type Collection,
	type Db,
	type Document,
} from "mongodb"
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import * as writeFence from "./mongodb-write-fence.js"

// Mock the schema module before imports
vi.mock("./mongodb-schema.js", () => ({
	eventsCollection: vi.fn(),
	chunksCollection: vi.fn(),
	projectionRunsCollection: vi.fn(() => ({
		insertOne: vi.fn(async () => ({ acknowledged: true })),
	})),
	telemetryCollection: vi.fn(() => ({
		insertOne: vi.fn(async () => ({ acknowledged: true })),
	})),
}))

import {
	writeEvent,
	writeEventsBatch,
	projectEventChunksBatch,
	projectEventChunk,
	clearEventExtractionJobPendingBatch,
	getPendingExtractionEvents,
	clearEventExtractionJobPending,
	getEventsByTimeRange,
	getEventsBySession,
	getUnprojectedEvents,
	markEventsProjected,
	pruneIdempotencyFingerprints,
	projectChunksFromEvents,
	isTransientMongoWriteError,
	type CanonicalEvent,
} from "./mongodb-events.js"
import {
	chunksCollection,
	eventsCollection,
	projectionRunsCollection,
} from "./mongodb-schema.js"

// ---------------------------------------------------------------------------
// Mock collection factories
// ---------------------------------------------------------------------------

function createMockEventsCol(): Collection {
	return {
		bsonOptions: {
			ignoreUndefined: false,
			serializeFunctions: false,
		},
		updateOne: vi.fn(async () => ({
			upsertedCount: 1,
			upsertedId: "new-id",
			matchedCount: 1,
			modifiedCount: 0,
		})),
		findOne: vi.fn(async () => null),
		updateMany: vi.fn(async () => ({
			modifiedCount: 0,
		})),
		find: vi.fn(() => ({
			sort: vi.fn(() => ({
				limit: vi.fn(() => ({
					toArray: vi.fn(async () => []),
				})),
			})),
		})),
	} as unknown as Collection
}

function createMockChunksCol(): Collection {
	return {
		updateOne: vi.fn(async () => ({
			upsertedCount: 1,
			upsertedId: "chunk-id",
			modifiedCount: 0,
		})),
	} as unknown as Collection
}

function mockDb(): Db {
	return {} as unknown as Db
}

// ---------------------------------------------------------------------------
// Tests: writeEventsBatch (P3.9)
// ---------------------------------------------------------------------------

describe("writeEventsBatch", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	function createBatchEventsCol(
		overrides: Record<string, unknown> = {},
	): Collection {
		return {
			bsonOptions: {
				ignoreUndefined: false,
				serializeFunctions: false,
			},
			insertMany: vi.fn(async () => ({
				acknowledged: true,
				insertedCount: 2,
			})),
			find: vi.fn(() => ({
				toArray: vi.fn(async () => []),
			})),
			updateMany: vi.fn(async () => ({ matchedCount: 2, modifiedCount: 2 })),
			...overrides,
		} as unknown as Collection
	}

	it("inserts every event in ONE insertMany with unordered majority writes", async () => {
		const col = createBatchEventsCol()
		vi.mocked(eventsCollection).mockReturnValue(col)

		const results = await writeEventsBatch({
			db: mockDb(),
			prefix: "test_",
			events: [
				{
					eventId: "evt-b1",
					agentId: "agent-1",
					role: "user",
					body: "first batch event",
					scope: "agent",
				},
				{
					eventId: "evt-b2",
					agentId: "agent-1",
					role: "assistant",
					body: "second batch event",
					scope: "agent",
				},
			],
		})

		expect(col.insertMany).toHaveBeenCalledTimes(1)
		const [docs, opts] = vi.mocked(col.insertMany).mock.calls[0]
		expect(opts).toEqual({
			ordered: false,
			writeConcern: { w: "majority", wtimeoutMS: 5_000 },
		})
		expect(docs).toHaveLength(2)
		expect((docs as CanonicalEvent[])[0].eventId).toBe("evt-b1")
		expect((docs as CanonicalEvent[])[0].scopeRef).toBe("agent:agent-1")
		expect((docs as CanonicalEvent[])[0].recordedAt).toBeInstanceOf(Date)
		expect(results).toHaveLength(2)
		expect(results[0]).toMatchObject({ ok: true, eventId: "evt-b1" })
		expect(results[1]).toMatchObject({ ok: true, eventId: "evt-b2" })
	})

	it("isolates a per-item validation failure without failing the batch", async () => {
		const col = createBatchEventsCol()
		vi.mocked(eventsCollection).mockReturnValue(col)

		const results = await writeEventsBatch({
			db: mockDb(),
			prefix: "test_",
			events: [
				{
					eventId: "evt-ok",
					agentId: "agent-1",
					role: "user",
					body: "valid event",
					scope: "agent",
				},
				{
					eventId: "evt-bad-dates",
					agentId: "agent-1",
					role: "user",
					body: "invalidAt before validAt",
					scope: "agent",
					validAt: new Date("2026-04-10T12:00:00.000Z"),
					invalidAt: new Date("2026-04-09T12:00:00.000Z"),
				},
			],
		})

		expect(results).toHaveLength(2)
		expect(results[0]).toMatchObject({ ok: true, eventId: "evt-ok" })
		expect(results[1]).toMatchObject({
			ok: false,
			duplicateKey: false,
		})
		// The invalid item is excluded from the insert.
		const [docs] = vi.mocked(col.insertMany).mock.calls[0]
		expect(docs).toHaveLength(1)
		expect((docs as CanonicalEvent[])[0].eventId).toBe("evt-ok")
	})

	it("maps a bulk E11000 to a per-item duplicateKey receipt and keeps siblings ok", async () => {
		const bulkError = Object.assign(new Error("BulkWriteError"), {
			name: "MongoBulkWriteError",
			writeErrors: [
				{
					index: 1,
					code: 11000,
					errmsg: "E11000 duplicate key error collection: test_events",
				},
			],
		})
		const col = createBatchEventsCol({
			insertMany: vi.fn(async () => {
				throw bulkError
			}),
		})
		vi.mocked(eventsCollection).mockReturnValue(col)

		const results = await writeEventsBatch({
			db: mockDb(),
			prefix: "test_",
			events: [
				{
					eventId: "evt-fresh",
					agentId: "agent-1",
					role: "user",
					body: "fresh event",
					scope: "agent",
				},
				{
					eventId: "evt-dupe",
					agentId: "agent-1",
					role: "user",
					body: "raced idempotency key",
					scope: "agent",
					idempotencyKey: "key-dupe",
				},
			],
		})

		expect(results).toHaveLength(2)
		expect(results[0]).toMatchObject({ ok: true, eventId: "evt-fresh" })
		expect(results[1]).toMatchObject({ ok: false, duplicateKey: true })
	})

	it("returns an empty receipt list for an empty batch", async () => {
		const col = createBatchEventsCol()
		vi.mocked(eventsCollection).mockReturnValue(col)
		await expect(
			writeEventsBatch({ db: mockDb(), prefix: "test_", events: [] }),
		).resolves.toEqual([])
		expect(col.insertMany).not.toHaveBeenCalled()
	})
})

// ---------------------------------------------------------------------------
// Tests: writeEventsBatch outcome reconciliation (W09)
// ---------------------------------------------------------------------------

describe("writeEventsBatch outcome reconciliation (W09)", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		vi.unstubAllEnvs()
	})

	afterEach(() => {
		vi.unstubAllEnvs()
	})

	const batchInput = [
		{
			eventId: "evt-r1",
			agentId: "agent-1",
			role: "user" as const,
			body: "reconciled one",
			scope: "agent" as const,
		},
		{
			eventId: "evt-r2",
			agentId: "agent-1",
			role: "user" as const,
			body: "reconciled two",
			scope: "agent" as const,
		},
	]
	const storedBatchTimestamp = new Date("2024-03-04T05:06:07.000Z")

	function matchingBatchStoredEvent(eventId: string): CanonicalEvent {
		const input = batchInput.find((event) => event.eventId === eventId)
		if (!input) {
			throw new Error(`missing batch fixture for ${eventId}`)
		}
		return {
			...input,
			scopeRef: `agent:${input.agentId}`,
			timestamp: storedBatchTimestamp,
			validAt: storedBatchTimestamp,
		}
	}

	function createReconcileCol(params: {
		insertManyImpl: () => Promise<unknown>
		existingIds?: string[]
		findImpl?: () => { toArray: () => Promise<Document[]> }
		bsonOptions?: Collection["bsonOptions"]
	}): Collection {
		return {
			bsonOptions: params.bsonOptions ?? {
				ignoreUndefined: false,
				serializeFunctions: false,
			},
			insertMany: vi.fn(params.insertManyImpl),
			find: vi.fn(
				params.findImpl ??
					(() => ({
						toArray: vi.fn(async () =>
							(params.existingIds ?? []).map(matchingBatchStoredEvent),
						),
					})),
			),
			updateMany: vi.fn(async () => ({ modifiedCount: 0 })),
		} as unknown as Collection
	}

	it("reconciles a write-concern-only error with a majority read and keeps absence uncertain", async () => {
		const col = createReconcileCol({
			insertManyImpl: async () => {
				throw Object.assign(new Error("wtimeout"), {
					writeConcernErrors: [{ code: 64, errmsg: "wtimeout" }],
				})
			},
			existingIds: ["evt-r1"],
		})
		vi.mocked(eventsCollection).mockReturnValue(col)

		const results = await writeEventsBatch({
			db: mockDb(),
			prefix: "test_",
			events: batchInput,
		})

		// A majority-visible presence confirms durability. Absence does not
		// prove an earlier attempt cannot still become majority committed.
		expect(results[0]).toMatchObject({
			ok: true,
			eventId: "evt-r1",
			duplicateKey: true,
			timestamp: storedBatchTimestamp,
			scopeRef: "agent:agent-1",
		})
		expect(results[1]).toMatchObject({
			ok: false,
			eventId: "evt-r2",
			duplicateKey: false,
		})
		if (!results[1].ok) {
			expect(results[1].message).toBe(
				"event durability unconfirmed; not found by majority reconciliation read; retry only with the same idempotency key or caller-pinned eventId",
			)
		}
		expect(col.find).toHaveBeenCalledWith(
			{ eventId: { $in: ["evt-r1", "evt-r2"] } },
			{
				projection: {
					_id: 0,
					eventId: 1,
					agentId: 1,
					sessionId: 1,
					channel: 1,
					role: 1,
					body: 1,
					metadata: 1,
					scope: 1,
					scopeRef: 1,
					timestamp: 1,
					validAt: 1,
					invalidAt: 1,
					expiresAt: 1,
				},
				raw: false,
				fieldsAsRaw: {},
				useBigInt64: false,
				promoteValues: false,
				promoteLongs: false,
				bsonRegExp: true,
				readConcern: { level: "majority" },
			},
		)
	})

	it("scopes NoWritesPerformed receipts to the final driver retry chain", async () => {
		// The writeEventsBatch-level retry loop retries NoWritesPerformed; one
		// attempt keeps this test fast.
		vi.stubEnv("MEMONGO_MONGODB_TRANSIENT_WRITE_RETRY_ATTEMPTS", "1")
		const col = createReconcileCol({
			insertManyImpl: async () => {
				const err = new Error("NoWritesPerformed") as Error & {
					hasErrorLabel: (label: string) => boolean
				}
				err.hasErrorLabel = (label: string) => label === "NoWritesPerformed"
				throw err
			},
		})
		vi.mocked(eventsCollection).mockReturnValue(col)

		const results = await writeEventsBatch({
			db: mockDb(),
			prefix: "test_",
			events: batchInput,
		})

		for (const result of results) {
			expect(result).toMatchObject({
				ok: false,
				duplicateKey: false,
			})
			if (!result.ok) {
				expect(result.message).toBe(
					"final driver retry chain performed no writes; earlier attempts may have committed; retry only with the same idempotency key or caller-pinned eventId",
				)
			}
		}
		// The label proves that this driver retry chain performed no writes.
		// It does not settle prior application-level attempts.
		expect(col.find).not.toHaveBeenCalled()
	})

	it("read-confirms a keyless E11000 as durable-exists instead of failing the durable write", async () => {
		const col = createReconcileCol({
			insertManyImpl: async () => {
				throw Object.assign(new Error("BulkWriteError"), {
					name: "MongoBulkWriteError",
					writeErrors: [
						{
							index: 1,
							code: 11000,
							errmsg:
								"E11000 duplicate key error collection: test_events index: uq_events_event_id",
						},
					],
				})
			},
			existingIds: ["evt-r2"],
		})
		vi.mocked(eventsCollection).mockReturnValue(col)

		const results = await writeEventsBatch({
			db: mockDb(),
			prefix: "test_",
			events: batchInput,
		})

		// evt-r1 was applied by the unordered insert; evt-r2 collided with an
		// earlier attempt of this same batch — the read proves it durable.
		expect(results[0]).toMatchObject({ ok: true, eventId: "evt-r1" })
		expect(results[0].ok && !results[0].duplicateKey).toBe(true)
		expect(results[1]).toMatchObject({
			ok: true,
			eventId: "evt-r2",
			duplicateKey: true,
			timestamp: storedBatchTimestamp,
			scopeRef: "agent:agent-1",
		})
	})

	it.each([
		[
			"driver-default null",
			{
				ignoreUndefined: false,
				serializeFunctions: false,
			},
			{ nested: { optional: null } },
			{ nested: {} },
		],
		[
			"inherited omission",
			{
				ignoreUndefined: true,
				serializeFunctions: false,
			},
			{ nested: {} },
			{ nested: { optional: null } },
		],
	])("batch replay uses the %s representation for nested undefined metadata", async (_label, bsonOptions, storedMetadata, conflictingMetadata) => {
		const attempted = {
			...batchInput[0],
			metadata: { nested: { optional: undefined } },
		}
		const col = createReconcileCol({
			insertManyImpl: async () => {
				throw Object.assign(new Error("BulkWriteError"), {
					name: "MongoBulkWriteError",
					writeErrors: [{ index: 0, code: 11000, errmsg: "E11000" }],
				})
			},
			findImpl: () => ({
				toArray: vi.fn(async () => [
					{
						...matchingBatchStoredEvent("evt-r1"),
						metadata: storedMetadata,
					},
				]),
			}),
			bsonOptions,
		})
		vi.mocked(eventsCollection).mockReturnValue(col)

		await expect(
			writeEventsBatch({
				db: mockDb(),
				prefix: "test_",
				events: [attempted],
			}),
		).resolves.toMatchObject([
			{ ok: true, eventId: "evt-r1", duplicateKey: true },
		])
		await expect(
			writeEventsBatch({
				db: mockDb(),
				prefix: "test_",
				events: [
					{
						...batchInput[0],
						metadata: conflictingMetadata,
					},
				],
			}),
		).resolves.toMatchObject([
			{ ok: false, eventId: "evt-r1", duplicateKey: false },
		])
	})

	it("rejects a conflicting duplicate event ID while preserving its inserted sibling", async () => {
		const storedTimestamp = new Date("2024-02-03T04:05:06.000Z")
		const col = createReconcileCol({
			insertManyImpl: async () => {
				throw Object.assign(new Error("BulkWriteError"), {
					name: "MongoBulkWriteError",
					writeErrors: [{ index: 1, code: 11000, errmsg: "E11000" }],
				})
			},
			findImpl: () => ({
				toArray: vi.fn(async () => [
					{
						eventId: "evt-r2",
						agentId: "other-agent",
						role: "user",
						body: "different owner holds this ID",
						scope: "agent",
						scopeRef: "agent:other-agent",
						timestamp: storedTimestamp,
						validAt: storedTimestamp,
					},
				]),
			}),
		})
		vi.mocked(eventsCollection).mockReturnValue(col)

		const results = await writeEventsBatch({
			db: mockDb(),
			prefix: "test_",
			events: batchInput,
		})

		expect(results[0]).toMatchObject({
			ok: true,
			eventId: "evt-r1",
		})
		expect(results[1]).toEqual({
			ok: false,
			eventId: "evt-r2",
			duplicateKey: false,
			message: 'event ID "evt-r2" is already assigned to a different event',
		})
	})

	it("keeps malformed stored identity unconfirmed while preserving its inserted sibling", async () => {
		const col = createReconcileCol({
			insertManyImpl: async () => {
				throw Object.assign(new Error("BulkWriteError"), {
					name: "MongoBulkWriteError",
					writeErrors: [{ index: 1, code: 11000, errmsg: "E11000" }],
				})
			},
			findImpl: () => ({
				toArray: vi.fn(async () => [{ eventId: "evt-r2" }]),
			}),
		})
		vi.mocked(eventsCollection).mockReturnValue(col)

		const results = await writeEventsBatch({
			db: mockDb(),
			prefix: "test_",
			events: batchInput,
		})

		expect(results[0]).toMatchObject({
			ok: true,
			eventId: "evt-r1",
		})
		expect(results[1]).toEqual({
			ok: false,
			eventId: "evt-r2",
			duplicateKey: false,
			message: "event replay identity unconfirmed; stored event was malformed",
		})
	})

	it("keeps a keyless E11000 whose event is absent as a per-item failure", async () => {
		const col = createReconcileCol({
			insertManyImpl: async () => {
				throw Object.assign(new Error("BulkWriteError"), {
					name: "MongoBulkWriteError",
					writeErrors: [{ index: 1, code: 11000, errmsg: "E11000" }],
				})
			},
			existingIds: [],
		})
		vi.mocked(eventsCollection).mockReturnValue(col)

		const results = await writeEventsBatch({
			db: mockDb(),
			prefix: "test_",
			events: batchInput,
		})

		expect(results[1]).toMatchObject({ ok: false, duplicateKey: false })
		if (!results[1].ok) {
			expect(results[1].message).toContain(
				"not found by majority reconciliation read",
			)
		}
	})

	it("keeps a keyed E11000 as a winner-replay failure when its event ID is absent", async () => {
		const col = createReconcileCol({
			insertManyImpl: async () => {
				throw Object.assign(new Error("BulkWriteError"), {
					name: "MongoBulkWriteError",
					writeErrors: [{ index: 1, code: 11000, errmsg: "E11000" }],
				})
			},
		})
		vi.mocked(eventsCollection).mockReturnValue(col)

		const results = await writeEventsBatch({
			db: mockDb(),
			prefix: "test_",
			events: [
				batchInput[0],
				{
					eventId: "evt-keyed",
					agentId: "agent-1",
					role: "user" as const,
					body: "raced idempotency key",
					scope: "agent" as const,
					idempotencyKey: "key-raced",
				},
			],
		})

		expect(results[1]).toMatchObject({
			ok: false,
			eventId: "evt-keyed",
			duplicateKey: true,
		})
		expect(col.find).toHaveBeenCalledOnce()
	})

	it("identity-checks a keyed E11000 when the event ID is already present", async () => {
		const storedTimestamp = new Date("2024-04-05T06:07:08.000Z")
		const col = createReconcileCol({
			insertManyImpl: async () => {
				throw Object.assign(new Error("BulkWriteError"), {
					name: "MongoBulkWriteError",
					writeErrors: [{ index: 1, code: 11000, errmsg: "E11000" }],
				})
			},
			findImpl: () => ({
				toArray: vi.fn(async () => [
					{
						eventId: "evt-keyed",
						agentId: "other-agent",
						role: "user",
						body: "different event",
						scope: "agent",
						scopeRef: "agent:other-agent",
						timestamp: storedTimestamp,
						validAt: storedTimestamp,
					},
				]),
			}),
		})
		vi.mocked(eventsCollection).mockReturnValue(col)

		const results = await writeEventsBatch({
			db: mockDb(),
			prefix: "test_",
			events: [
				batchInput[0],
				{
					eventId: "evt-keyed",
					agentId: "agent-1",
					role: "user",
					body: "raced idempotency key",
					scope: "agent",
					idempotencyKey: "key-raced",
				},
			],
		})

		expect(results[0]).toMatchObject({ ok: true, eventId: "evt-r1" })
		expect(results[1]).toEqual({
			ok: false,
			eventId: "evt-keyed",
			duplicateKey: false,
			message: 'event ID "evt-keyed" is already assigned to a different event',
		})
	})

	it("reconciles unlisted items when a write-concern error rides along with per-item errors", async () => {
		const col = createReconcileCol({
			insertManyImpl: async () => {
				throw Object.assign(new Error("BulkWriteError"), {
					name: "MongoBulkWriteError",
					err: { code: 64, errmsg: "wtimeout" },
					writeErrors: [{ index: 0, code: 11000, errmsg: "E11000" }],
				})
			},
			existingIds: ["evt-r2"],
		})
		vi.mocked(eventsCollection).mockReturnValue(col)

		const results = await writeEventsBatch({
			db: mockDb(),
			prefix: "test_",
			events: [
				{
					eventId: "evt-keyed",
					agentId: "agent-1",
					role: "user" as const,
					body: "raced idempotency key",
					scope: "agent" as const,
					idempotencyKey: "key-raced",
				},
				batchInput[1],
			],
		})

		// Keyed E11000 → winner-replay failure; unlisted evt-r2 is uncertain
		// under the write-concern error → read confirms it durable.
		expect(results[0]).toMatchObject({ ok: false, duplicateKey: true })
		expect(results[1]).toMatchObject({
			ok: true,
			eventId: "evt-r2",
			duplicateKey: true,
		})
	})

	it("yields durability-unconfirmed receipts when the reconciliation read itself fails", async () => {
		const col = createReconcileCol({
			insertManyImpl: async () => {
				throw Object.assign(new Error("wtimeout"), {
					writeConcernErrors: [{ code: 64, errmsg: "wtimeout" }],
				})
			},
			findImpl: () => {
				throw new Error("reconciliation read unavailable")
			},
		})
		vi.mocked(eventsCollection).mockReturnValue(col)

		// No throw: a throw after a possible durable commit is the W08
		// anti-pattern.
		const results = await writeEventsBatch({
			db: mockDb(),
			prefix: "test_",
			events: batchInput,
		})

		for (const result of results) {
			expect(result).toMatchObject({ ok: false, duplicateKey: false })
			if (!result.ok) {
				expect(result.message).toBe(
					"event durability unconfirmed (majority reconciliation read failed); outcome may have committed; retry only with the same idempotency key or caller-pinned eventId",
				)
			}
		}
		expect(col.find).toHaveBeenCalledWith(
			{ eventId: { $in: ["evt-r1", "evt-r2"] } },
			{
				projection: {
					_id: 0,
					eventId: 1,
					agentId: 1,
					sessionId: 1,
					channel: 1,
					role: 1,
					body: 1,
					metadata: 1,
					scope: 1,
					scopeRef: 1,
					timestamp: 1,
					validAt: 1,
					invalidAt: 1,
					expiresAt: 1,
				},
				raw: false,
				fieldsAsRaw: {},
				useBigInt64: false,
				promoteValues: false,
				promoteLongs: false,
				bsonRegExp: true,
				readConcern: { level: "majority" },
			},
		)
	})

	it("compares repeated event IDs independently by original position", async () => {
		const col = createReconcileCol({
			insertManyImpl: async () => {
				throw Object.assign(new Error("BulkWriteError"), {
					name: "MongoBulkWriteError",
					writeErrors: [
						{ index: 0, code: 11000, errmsg: "E11000" },
						{ index: 1, code: 11000, errmsg: "E11000" },
					],
				})
			},
			findImpl: () => ({
				toArray: vi.fn(async () => [matchingBatchStoredEvent("evt-r1")]),
			}),
		})
		vi.mocked(eventsCollection).mockReturnValue(col)

		const results = await writeEventsBatch({
			db: mockDb(),
			prefix: "test_",
			events: [
				batchInput[0],
				{
					...batchInput[0],
					body: "contradictory retry at the same event ID",
				},
			],
		})

		expect(results[0]).toEqual({
			ok: true,
			eventId: "evt-r1",
			timestamp: storedBatchTimestamp,
			scopeRef: "agent:agent-1",
			duplicateKey: true,
		})
		expect(results[1]).toEqual({
			ok: false,
			eventId: "evt-r1",
			duplicateKey: false,
			message: 'event ID "evt-r1" is already assigned to a different event',
		})
	})
})

// ---------------------------------------------------------------------------
// Tests: pruneIdempotencyFingerprints (W10)
// ---------------------------------------------------------------------------

describe("pruneIdempotencyFingerprints (W10)", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("ages by the acceptance instant (recordedAt) with a legacy timestamp fallback", async () => {
		const updateMany = vi.fn(async () => ({ modifiedCount: 3 }))
		vi.mocked(eventsCollection).mockReturnValue({
			updateMany,
		} as unknown as Collection)

		const now = new Date("2026-09-06T00:00:00.000Z")
		const { pruned } = await pruneIdempotencyFingerprints({
			db: mockDb(),
			prefix: "test_",
			agentId: "agent-1",
			olderThanDays: 90,
			now,
		})

		expect(pruned).toBe(3)
		expect(updateMany).toHaveBeenCalledTimes(1)
		const [filter, update] = updateMany.mock.calls[0]
		const cutoff = new Date(now.getTime() - 90 * 86_400_000)
		// W10: retention ages by recordedAt (the immutable acceptance instant),
		// so a fresh import of historical events keeps its replay protection;
		// legacy rows without recordedAt keep the old timestamp rule.
		expect(filter).toEqual({
			agentId: "agent-1",
			idempotencyKey: { $exists: true },
			$or: [
				{ recordedAt: { $lt: cutoff } },
				{ recordedAt: { $exists: false }, timestamp: { $lt: cutoff } },
			],
		})
		expect(update).toEqual({
			$unset: { idempotencyKey: "", idempotencyFingerprint: "" },
		})
	})
})

// ---------------------------------------------------------------------------
// Tests: projection marker degradation (W08)
// ---------------------------------------------------------------------------

describe("projection marker degradation (W08)", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	function makeEvent(eventId: string): CanonicalEvent {
		return {
			eventId,
			agentId: "agent-1",
			role: "user",
			body: `body of ${eventId}`,
			scope: "agent",
			scopeRef: "agent:agent-1",
			timestamp: new Date("2026-04-09T12:00:00.000Z"),
		}
	}

	it("keeps batch chunk receipts when the projectedAt marker update fails", async () => {
		const chunksCol = {
			bulkWrite: vi.fn(async () => ({
				upsertedCount: 1,
				upsertedIds: { 0: "chunk-id-1" },
				matchedCount: 0,
			})),
		} as unknown as Collection
		vi.mocked(chunksCollection).mockReturnValue(chunksCol)
		const eventsCol = {
			updateMany: vi.fn(async () => {
				throw new Error("marker write exhausted retries")
			}),
		} as unknown as Collection
		vi.mocked(eventsCollection).mockReturnValue(eventsCol)

		// Not a throw: the chunks are durable; the events stay unprojected for
		// the repair pass.
		const results = await projectEventChunksBatch({
			db: mockDb(),
			prefix: "test_",
			events: [makeEvent("evt-w08-b")],
		})

		expect(results).toEqual([{ chunkCreated: true }])
	})

	it("keeps the single chunk receipt when its projectedAt marker update fails", async () => {
		const chunksCol = {
			updateOne: vi.fn(async () => ({
				upsertedCount: 1,
				upsertedId: "chunk-id-1",
				matchedCount: 0,
			})),
		} as unknown as Collection
		vi.mocked(chunksCollection).mockReturnValue(chunksCol)
		const eventsCol = {
			updateMany: vi.fn(async () => {
				throw new Error("marker write exhausted retries")
			}),
		} as unknown as Collection
		vi.mocked(eventsCollection).mockReturnValue(eventsCol)

		const result = await projectEventChunk({
			db: mockDb(),
			prefix: "test_",
			event: makeEvent("evt-w08-s"),
		})

		expect(result).toEqual({ chunkCreated: true })
	})

	it("uses one session for the chunk and marker and rethrows marker failure", async () => {
		const session = {} as ClientSession
		const chunksCol = {
			updateOne: vi.fn(async () => ({
				upsertedCount: 1,
				upsertedId: "chunk-id-1",
				matchedCount: 0,
			})),
		} as unknown as Collection
		vi.mocked(chunksCollection).mockReturnValue(chunksCol)
		const markerFailure = new MongoServerError({
			ok: 0,
			code: 251,
			errmsg: "transaction marker write failed",
			errorLabels: ["TransientTransactionError"],
		})
		const eventsCol = {
			updateMany: vi
				.fn()
				.mockRejectedValueOnce(markerFailure)
				.mockResolvedValueOnce({ modifiedCount: 1 }),
		} as unknown as Collection
		vi.mocked(eventsCollection).mockReturnValue(eventsCol)

		await expect(
			projectEventChunk({
				db: mockDb(),
				prefix: "test_",
				event: makeEvent("evt-w08-transaction"),
				session,
				recordRun: false,
			}),
		).rejects.toBe(markerFailure)
		expect(chunksCol.updateOne).toHaveBeenCalledWith(
			expect.any(Object),
			expect.any(Object),
			{ upsert: true, session },
		)
		expect(eventsCol.updateMany).toHaveBeenCalledWith(
			expect.any(Object),
			expect.any(Object),
			{ session },
		)
		expect(eventsCol.updateMany).toHaveBeenCalledOnce()
	})
})

// ---------------------------------------------------------------------------
// Tests: projectEventChunksBatch (P3.9)
// ---------------------------------------------------------------------------

describe("projectEventChunksBatch", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	function makeEvent(eventId: string): CanonicalEvent {
		return {
			eventId,
			agentId: "agent-1",
			role: "user",
			body: `body of ${eventId}`,
			scope: "agent",
			scopeRef: "agent:agent-1",
			timestamp: new Date("2026-04-09T12:00:00.000Z"),
		}
	}

	it("projects every chunk in ONE bulkWrite and marks events projected once", async () => {
		const bulkWrite = vi.fn(async () => ({
			upsertedCount: 1,
			upsertedIds: { 1: "chunk-id-2" },
			matchedCount: 1,
		}))
		const chunksCol = { bulkWrite } as unknown as Collection
		vi.mocked(chunksCollection).mockReturnValue(chunksCol)
		const eventsCol = {
			updateMany: vi.fn(async () => ({ modifiedCount: 2 })),
		} as unknown as Collection
		vi.mocked(eventsCollection).mockReturnValue(eventsCol)

		const results = await projectEventChunksBatch({
			db: mockDb(),
			prefix: "test_",
			events: [makeEvent("evt-c1"), makeEvent("evt-c2")],
		})

		expect(bulkWrite).toHaveBeenCalledTimes(1)
		const [ops, opts] = bulkWrite.mock.calls[0]
		expect(opts).toEqual({ ordered: false })
		expect(ops).toHaveLength(2)
		expect(ops[0]).toMatchObject({
			updateOne: {
				filter: { path: "events/evt-c1" },
				upsert: true,
			},
		})
		// Only index 1 upserted → only the second chunk reports created.
		expect(results).toEqual([{ chunkCreated: false }, { chunkCreated: true }])
		expect(eventsCol.updateMany).toHaveBeenCalledTimes(1)
		expect(eventsCol.updateMany).toHaveBeenCalledWith(
			{ eventId: { $in: ["evt-c1", "evt-c2"] } },
			{ $set: { projectedAt: expect.any(Date) } },
		)
	})

	it("degrades to chunkCreated:false for all when the bulk write fails outright", async () => {
		const chunksCol = {
			bulkWrite: vi.fn(async () => {
				throw new Error("bulk projection unavailable")
			}),
		} as unknown as Collection
		vi.mocked(chunksCollection).mockReturnValue(chunksCol)
		const eventsCol = {
			updateMany: vi.fn(async () => ({ modifiedCount: 0 })),
		} as unknown as Collection
		vi.mocked(eventsCollection).mockReturnValue(eventsCol)

		const results = await projectEventChunksBatch({
			db: mockDb(),
			prefix: "test_",
			events: [makeEvent("evt-c1"), makeEvent("evt-c2")],
		})

		expect(results).toEqual([{ chunkCreated: false }, { chunkCreated: false }])
		// Events stay unprojected so the repair pass can project them later.
		expect(eventsCol.updateMany).not.toHaveBeenCalled()
	})

	it("carries the event-valid interval on every batched chunk (C-026)", async () => {
		const bulkWrite = vi.fn(async () => ({
			upsertedCount: 2,
			upsertedIds: { 0: "chunk-id-1", 1: "chunk-id-2" },
			matchedCount: 0,
		}))
		const chunksCol = { bulkWrite } as unknown as Collection
		vi.mocked(chunksCollection).mockReturnValue(chunksCol)
		const eventsCol = {
			updateMany: vi.fn(async () => ({ modifiedCount: 2 })),
		} as unknown as Collection
		vi.mocked(eventsCollection).mockReturnValue(eventsCol)

		const validAt = new Date("2026-08-01T12:00:00.000Z")
		const invalidAt = new Date("2026-08-05T12:00:00.000Z")
		const events = [
			makeEvent("evt-c1"),
			{ ...makeEvent("evt-c2"), validAt, invalidAt },
		]
		await projectEventChunksBatch({
			db: mockDb(),
			prefix: "test_",
			events,
		})

		const ops = bulkWrite.mock.calls[0][0]
		// evt-c1 has no explicit interval: validAt defaults to the event
		// timestamp, invalidAt to null (still valid). evt-c2 carries its
		// explicit interval. Both ride $set so re-projection heals legacy
		// chunks written without them.
		expect(ops[0].updateOne.update.$set.validAt).toBe(events[0].timestamp)
		expect(ops[0].updateOne.update.$set.invalidAt).toBeNull()
		expect(ops[1].updateOne.update.$set.validAt).toBe(validAt)
		expect(ops[1].updateOne.update.$set.invalidAt).toBe(invalidAt)
		// RET-09: the authoring role rides $setOnInsert on every batched
		// chunk (immutable — a chunk's author never changes).
		expect(ops[0].updateOne.update.$setOnInsert.role).toBe("user")
		expect(ops[1].updateOne.update.$setOnInsert.role).toBe("user")
	})
})

// ---------------------------------------------------------------------------
// Tests: projectEventChunksBatch session path
// ---------------------------------------------------------------------------

// The session path runs INSIDE the caller's fenced transaction. That changes
// the contract vs. the sessionless path above: writes go straight to the
// collections carrying the session (no retryTransientMongoWrite wrapper — the
// outer transaction owns retry), failures rethrow RAW (the sessionless partial
// and W08 degrades must not run here), and no projection run is recorded (the
// caller owns diagnostics in separate fenced writes).
describe("projectEventChunksBatch session path", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	function makeEvent(eventId: string): CanonicalEvent {
		return {
			eventId,
			agentId: "agent-1",
			role: "user",
			body: `body of ${eventId}`,
			scope: "agent",
			scopeRef: "agent:agent-1",
			timestamp: new Date("2026-04-09T12:00:00.000Z"),
		}
	}

	it("requires recordRun:false when a session is provided (guard TypeError, no writes)", async () => {
		const session = {} as ClientSession
		const bulkWrite = vi.fn(async () => ({
			upsertedCount: 1,
			upsertedIds: { 0: "chunk-id-1" },
			matchedCount: 0,
		}))
		const chunksCol = { bulkWrite } as unknown as Collection
		vi.mocked(chunksCollection).mockReturnValue(chunksCol)
		const updateMany = vi.fn(async () => ({ modifiedCount: 1 }))
		const eventsCol = { updateMany } as unknown as Collection
		vi.mocked(eventsCollection).mockReturnValue(eventsCol)

		const failure = await projectEventChunksBatch({
			db: mockDb(),
			prefix: "test_",
			events: [makeEvent("evt-s-guard")],
			session,
		}).then(
			() => undefined,
			(err: unknown) => err,
		)

		expect(failure).toBeInstanceOf(TypeError)
		expect((failure as TypeError).message).toBe(
			"projectEventChunksBatch requires recordRun:false when a session is provided",
		)
		// The guard fires before any write: nothing reaches the collections.
		expect(bulkWrite).not.toHaveBeenCalled()
		expect(updateMany).not.toHaveBeenCalled()
	})

	it("awaits the bulk write and marker directly on the fence session", async () => {
		const session = {} as ClientSession
		const bulkWrite = vi.fn(async () => ({
			upsertedCount: 2,
			upsertedIds: { 0: "chunk-id-1", 1: "chunk-id-2" },
			matchedCount: 0,
		}))
		const chunksCol = { bulkWrite } as unknown as Collection
		vi.mocked(chunksCollection).mockReturnValue(chunksCol)
		const updateMany = vi.fn(async () => ({ modifiedCount: 2 }))
		const eventsCol = { updateMany } as unknown as Collection
		vi.mocked(eventsCollection).mockReturnValue(eventsCol)

		const results = await projectEventChunksBatch({
			db: mockDb(),
			prefix: "test_",
			events: [makeEvent("evt-s1"), makeEvent("evt-s2")],
			session,
			recordRun: false,
		})

		expect(results).toEqual([{ chunkCreated: true }, { chunkCreated: true }])
		// One direct awaited bulkWrite carrying the session — no retry wrapper.
		expect(bulkWrite).toHaveBeenCalledOnce()
		expect(bulkWrite).toHaveBeenCalledWith(expect.any(Array), {
			ordered: false,
			session,
		})
		expect(updateMany).toHaveBeenCalledOnce()
		expect(updateMany).toHaveBeenCalledWith(
			{ eventId: { $in: ["evt-s1", "evt-s2"] } },
			{ $set: { projectedAt: expect.any(Date) } },
			{ session },
		)
	})

	it("rethrows a transient-classified bulk failure RAW after a single call (no retry)", async () => {
		const session = {} as ClientSession
		const transient = new MongoServerError({
			ok: 0,
			code: 251,
			errmsg: "transaction bulk write failed",
			errorLabels: ["TransientTransactionError"],
		})
		const bulkWrite = vi.fn().mockRejectedValueOnce(transient)
		const chunksCol = { bulkWrite } as unknown as Collection
		vi.mocked(chunksCollection).mockReturnValue(chunksCol)
		const updateMany = vi.fn(async () => ({ modifiedCount: 1 }))
		const eventsCol = { updateMany } as unknown as Collection
		vi.mocked(eventsCollection).mockReturnValue(eventsCol)

		const failure = await projectEventChunksBatch({
			db: mockDb(),
			prefix: "test_",
			events: [makeEvent("evt-s-transient")],
			session,
			recordRun: false,
		}).then(
			() => undefined,
			(err: unknown) => err,
		)

		// The outer transaction owns retry: the session path never retries and
		// never degrades to chunkCreated:false receipts.
		expect(failure).toBe(transient)
		expect(bulkWrite).toHaveBeenCalledOnce()
		expect(bulkWrite).toHaveBeenCalledWith(expect.any(Array), {
			ordered: false,
			session,
		})
		expect(updateMany).not.toHaveBeenCalled()
	})

	it("rethrows a marker failure RAW instead of degrading (no W08 on the session path)", async () => {
		const session = {} as ClientSession
		const bulkWrite = vi.fn(async () => ({
			upsertedCount: 2,
			upsertedIds: { 0: "chunk-id-1", 1: "chunk-id-2" },
			matchedCount: 0,
		}))
		const chunksCol = { bulkWrite } as unknown as Collection
		vi.mocked(chunksCollection).mockReturnValue(chunksCol)
		const markerFailure = new MongoServerError({
			ok: 0,
			code: 251,
			errmsg: "transaction marker write failed",
			errorLabels: ["TransientTransactionError"],
		})
		const updateMany = vi
			.fn()
			.mockRejectedValueOnce(markerFailure)
			.mockResolvedValueOnce({ modifiedCount: 2 })
		const eventsCol = { updateMany } as unknown as Collection
		vi.mocked(eventsCollection).mockReturnValue(eventsCol)

		const failure = await projectEventChunksBatch({
			db: mockDb(),
			prefix: "test_",
			events: [makeEvent("evt-s-marker"), makeEvent("evt-s-marker-2")],
			session,
			recordRun: false,
		}).then(
			() => undefined,
			(err: unknown) => err,
		)

		// The chunk bulk write committed inside the fence; the marker failure
		// aborts the transaction RAW — the sessionless W08 degrade (keep the
		// receipts, leave the events unprojected) must not run here.
		expect(failure).toBe(markerFailure)
		expect(updateMany).toHaveBeenCalledOnce()
		expect(updateMany).toHaveBeenCalledWith(
			expect.any(Object),
			expect.any(Object),
			{ session },
		)
	})

	it("records no projection run under the session path", async () => {
		const session = {} as ClientSession
		const bulkWrite = vi.fn(async () => ({
			upsertedCount: 1,
			upsertedIds: { 0: "chunk-id-1" },
			matchedCount: 0,
		}))
		const chunksCol = { bulkWrite } as unknown as Collection
		vi.mocked(chunksCollection).mockReturnValue(chunksCol)
		const updateMany = vi.fn(async () => ({ modifiedCount: 1 }))
		const eventsCol = { updateMany } as unknown as Collection
		vi.mocked(eventsCollection).mockReturnValue(eventsCol)
		const runsInsert = vi.fn(async () => ({ acknowledged: true }))
		vi.mocked(projectionRunsCollection).mockReturnValue({
			insertOne: runsInsert,
		} as unknown as Collection)

		await projectEventChunksBatch({
			db: mockDb(),
			prefix: "test_",
			events: [makeEvent("evt-s-run")],
			session,
			recordRun: false,
		})

		// Diagnostics live in separate fenced writes owned by the caller; the
		// session path itself never records a run.
		expect(runsInsert).not.toHaveBeenCalled()
	})
})

// ---------------------------------------------------------------------------
// Tests: projectEventChunk bitemporal carry (C-026)
// ---------------------------------------------------------------------------

describe("projectEventChunk bitemporal carry (C-026)", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	function makeBitemporalEvent(eventId: string): CanonicalEvent {
		return {
			eventId,
			agentId: "agent-1",
			role: "user",
			body: `body of ${eventId}`,
			scope: "agent",
			scopeRef: "agent:agent-1",
			timestamp: new Date("2026-04-09T12:00:00.000Z"),
		}
	}

	function makeChunkCol() {
		const updateOne = vi.fn(async () => ({
			upsertedCount: 1,
			matchedCount: 0,
			modifiedCount: 0,
		}))
		const chunksCol = { updateOne } as unknown as Collection
		vi.mocked(chunksCollection).mockReturnValue(chunksCol)
		const eventsCol = {
			updateMany: vi.fn(async () => ({ modifiedCount: 1 })),
		} as unknown as Collection
		vi.mocked(eventsCollection).mockReturnValue(eventsCol)
		return { updateOne }
	}

	it("carries the event-valid interval in $set so re-projection heals legacy chunks", async () => {
		const { updateOne } = makeChunkCol()
		const validAt = new Date("2026-08-01T12:00:00.000Z")
		const invalidAt = new Date("2026-08-05T12:00:00.000Z")

		await projectEventChunk({
			db: mockDb(),
			prefix: "test_",
			event: { ...makeBitemporalEvent("evt-bt"), validAt, invalidAt },
		})

		const [, update] = updateOne.mock.calls[0]
		expect(update.$set.validAt).toBe(validAt)
		expect(update.$set.invalidAt).toBe(invalidAt)
		// $set, not $setOnInsert — re-projecting an old chunk that an earlier
		// projection path wrote without the interval rewrites it (heal).
		expect(update.$setOnInsert.validAt).toBeUndefined()
		expect(update.$setOnInsert.invalidAt).toBeUndefined()
	})

	it("defaults validAt to the event timestamp and invalidAt to null", async () => {
		const { updateOne } = makeChunkCol()
		const event = makeBitemporalEvent("evt-bt-default")

		await projectEventChunk({
			db: mockDb(),
			prefix: "test_",
			event,
		})

		const [, update] = updateOne.mock.calls[0]
		expect(update.$set.validAt).toBe(event.timestamp)
		expect(update.$set.invalidAt).toBeNull()
	})

	it("carries the authoring role on chunk insert (RET-09)", async () => {
		// Role goes in $setOnInsert (immutable): a chunk's author never
		// changes, and re-projecting must not rewrite it.
		const { updateOne } = makeChunkCol()
		const event = makeBitemporalEvent("evt-role")

		await projectEventChunk({
			db: mockDb(),
			prefix: "test_",
			event: { ...event, role: "assistant" },
		})

		const [, update] = updateOne.mock.calls[0]
		expect(update.$setOnInsert.role).toBe("assistant")
		expect(update.$set.role).toBeUndefined()
	})
})

// ---------------------------------------------------------------------------
// Tests: clearEventExtractionJobPendingBatch (P3.9)
// ---------------------------------------------------------------------------

describe("clearEventExtractionJobPendingBatch", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("clears the outbox marker for many events in one updateMany", async () => {
		const col = {
			updateMany: vi.fn(async () => ({ matchedCount: 2, modifiedCount: 2 })),
		} as unknown as Collection
		vi.mocked(eventsCollection).mockReturnValue(col)

		const cleared = await clearEventExtractionJobPendingBatch({
			db: mockDb(),
			prefix: "test_",
			eventIds: ["evt-1", "evt-2"],
			agentId: "agent-1",
		})

		expect(cleared).toBe(2)
		expect(col.updateMany).toHaveBeenCalledWith(
			{
				eventId: { $in: ["evt-1", "evt-2"] },
				agentId: "agent-1",
				extractionJobPendingAt: { $exists: true },
			},
			{ $unset: { extractionJobPendingAt: "" } },
			{ writeConcern: { w: "majority", wtimeoutMS: 5_000 } },
		)
	})

	it("no-ops on an empty id list", async () => {
		const col = {
			updateMany: vi.fn(async () => ({ matchedCount: 0, modifiedCount: 0 })),
		} as unknown as Collection
		vi.mocked(eventsCollection).mockReturnValue(col)
		await expect(
			clearEventExtractionJobPendingBatch({
				db: mockDb(),
				prefix: "test_",
				eventIds: [],
				agentId: "agent-1",
			}),
		).resolves.toBe(0)
		expect(col.updateMany).not.toHaveBeenCalled()
	})
})

// ---------------------------------------------------------------------------
// Tests: writeEvent
// ---------------------------------------------------------------------------

describe("writeEvent", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	afterEach(() => {
		vi.unstubAllEnvs()
	})

	function storedEvent(
		overrides: Partial<CanonicalEvent> = {},
	): CanonicalEvent {
		const timestamp = new Date("2024-01-02T03:04:05.000Z")
		return {
			eventId: "existing-id",
			agentId: "agent-1",
			role: "user",
			body: "Hello world",
			scope: "agent",
			scopeRef: "agent:agent-1",
			timestamp,
			validAt: timestamp,
			...overrides,
		}
	}

	function createMatchedEventCol(
		stored: Document,
		bsonOptions: Collection["bsonOptions"] = {
			ignoreUndefined: false,
			serializeFunctions: false,
		},
	): Collection {
		const col = createMockEventsCol()
		vi.mocked(col.updateOne).mockResolvedValue({
			upsertedCount: 0,
			upsertedId: null,
			modifiedCount: 0,
			matchedCount: 1,
			acknowledged: true,
		})
		vi.mocked(col.findOne).mockResolvedValue(stored)
		Object.assign(col, { bsonOptions })
		return col
	}

	const replayInput = (
		overrides: Partial<Parameters<typeof writeEvent>[0]["event"]> = {},
	): Parameters<typeof writeEvent>[0]["event"] => ({
		eventId: "existing-id",
		agentId: "agent-1",
		role: "user",
		body: "Hello world",
		scope: "agent",
		scopeRef: "agent:agent-1",
		...overrides,
	})

	it("inserts an event and returns the eventId", async () => {
		const col = createMockEventsCol()
		vi.mocked(eventsCollection).mockReturnValue(col)

		const result = await writeEvent({
			db: mockDb(),
			prefix: "test_",
			event: {
				agentId: "agent-1",
				role: "user",
				body: "Hello world",
				scope: "agent",
				scopeRef: "agent:agent-1",
			},
		})

		expect(result.eventId).toBeDefined()
		expect(typeof result.eventId).toBe("string")
		expect(result.eventId.length).toBeGreaterThan(0)

		// Verify upsert was called with $setOnInsert
		expect(col.updateOne).toHaveBeenCalledOnce()
		const [filter, update, opts] = vi.mocked(col.updateOne).mock.calls[0]
		expect(filter).toEqual({ eventId: result.eventId })
		expect(update).toHaveProperty("$setOnInsert")
		expect(opts).toEqual({
			upsert: true,
			writeConcern: { w: "majority", wtimeoutMS: 5_000 },
		})

		// Verify the doc has correct fields
		const doc = (update as Record<string, Record<string, unknown>>).$setOnInsert
		expect(doc.agentId).toBe("agent-1")
		expect(doc.role).toBe("user")
		expect(doc.body).toBe("Hello world")
		expect(doc.scope).toBe("agent")
		expect(doc.timestamp).toBeInstanceOf(Date)
	})

	it("propagates a transaction session to the canonical event write", async () => {
		const col = createMockEventsCol()
		vi.mocked(eventsCollection).mockReturnValue(col)
		const session = {} as ClientSession

		await writeEvent({
			db: mockDb(),
			prefix: "test_",
			session,
			event: {
				eventId: "event-transactional",
				agentId: "agent-1",
				role: "user",
				body: "Commit the event and extraction job together.",
				scope: "agent",
				scopeRef: "agent:agent-1",
			},
		})

		expect(col.updateOne).toHaveBeenCalledWith(
			{ eventId: "event-transactional" },
			expect.any(Object),
			{ upsert: true, session },
		)
	})

	it("returns a labeled session write failure unchanged after one attempt", async () => {
		vi.stubEnv("MEMONGO_MONGODB_TRANSIENT_WRITE_RETRY_ATTEMPTS", "2")
		vi.stubEnv("MEMONGO_MONGODB_TRANSIENT_WRITE_RETRY_MIN_DELAY_MS", "0")
		vi.stubEnv("MEMONGO_MONGODB_TRANSIENT_WRITE_RETRY_MAX_DELAY_MS", "0")
		const transient = new MongoServerError({
			ok: 0,
			code: 251,
			errmsg: "transaction operation failed",
			errorLabels: ["TransientTransactionError"],
		})
		const col = createMockEventsCol()
		vi.mocked(col.updateOne)
			.mockRejectedValueOnce(transient)
			.mockResolvedValueOnce({
				acknowledged: true,
				upsertedCount: 1,
				upsertedId: "must-not-run",
				matchedCount: 0,
				modifiedCount: 0,
			})
		vi.mocked(eventsCollection).mockReturnValue(col)
		const session = {} as ClientSession

		await expect(
			writeEvent({
				db: mockDb(),
				prefix: "test_",
				session,
				event: {
					eventId: "event-transaction-error",
					agentId: "agent-1",
					role: "user",
					body: "Let the outer transaction retry this.",
					scope: "agent",
					scopeRef: "agent:agent-1",
				},
			}),
		).rejects.toBe(transient)
		expect(transient.hasErrorLabel("TransientTransactionError")).toBe(true)
		expect(col.updateOne).toHaveBeenCalledOnce()
	})

	it("keeps retrying labeled transient failures without a session", async () => {
		vi.stubEnv("MEMONGO_MONGODB_TRANSIENT_WRITE_RETRY_ATTEMPTS", "2")
		vi.stubEnv("MEMONGO_MONGODB_TRANSIENT_WRITE_RETRY_MIN_DELAY_MS", "0")
		vi.stubEnv("MEMONGO_MONGODB_TRANSIENT_WRITE_RETRY_MAX_DELAY_MS", "0")
		const transient = new MongoServerError({
			ok: 0,
			code: 91,
			errmsg: "primary stepped down",
			errorLabels: ["RetryableWriteError"],
		})
		const col = createMockEventsCol()
		vi.mocked(col.updateOne)
			.mockRejectedValueOnce(transient)
			.mockResolvedValueOnce({
				acknowledged: true,
				upsertedCount: 1,
				upsertedId: "new-id",
				matchedCount: 0,
				modifiedCount: 0,
			})
		vi.mocked(eventsCollection).mockReturnValue(col)

		await expect(
			writeEvent({
				db: mockDb(),
				prefix: "test_",
				event: {
					eventId: "event-standalone-retry",
					agentId: "agent-1",
					role: "user",
					body: "Retry this standalone write.",
					scope: "agent",
					scopeRef: "agent:agent-1",
				},
			}),
		).resolves.toMatchObject({ eventId: "event-standalone-retry" })
		expect(col.updateOne).toHaveBeenCalledTimes(2)
		for (const [, , options] of vi.mocked(col.updateOne).mock.calls) {
			expect(options).toEqual({
				upsert: true,
				writeConcern: { w: "majority", wtimeoutMS: 5_000 },
			})
		}
	})

	it("persists a durable extraction outbox marker with the event", async () => {
		const col = createMockEventsCol()
		vi.mocked(eventsCollection).mockReturnValue(col)
		const extractionJobPendingAt = new Date("2026-04-09T12:00:00.000Z")

		await writeEvent({
			db: mockDb(),
			prefix: "test_",
			event: {
				eventId: "event-with-extraction-outbox",
				agentId: "agent-1",
				role: "user",
				body: "Recover my extraction after a process crash.",
				scope: "agent",
				scopeRef: "agent:agent-1",
				extractionJobPendingAt,
			} as CanonicalEvent,
		})

		const [, update] = vi.mocked(col.updateOne).mock.calls[0]
		const doc = (update as Record<string, Record<string, unknown>>).$setOnInsert
		expect(doc.extractionJobPendingAt).toEqual(extractionJobPendingAt)
	})

	it("lists only this agent's pending extraction outbox events oldest first", async () => {
		const pending = [
			{
				eventId: "pending-1",
				agentId: "agent-1",
				extractionJobPendingAt: new Date("2026-04-09T12:00:00.000Z"),
			},
		] as CanonicalEvent[]
		const toArray = vi.fn().mockResolvedValue(pending)
		const limit = vi.fn(() => ({ toArray }))
		const sort = vi.fn(() => ({ limit }))
		const find = vi.fn(() => ({ sort }))
		const col = createMockEventsCol()
		vi.mocked(col.find).mockImplementation(find)
		vi.mocked(eventsCollection).mockReturnValue(col)

		await expect(
			getPendingExtractionEvents({
				db: mockDb(),
				prefix: "test_",
				agentId: "agent-1",
				limit: 25,
			}),
		).resolves.toEqual(pending)
		expect(find).toHaveBeenCalledWith({
			agentId: "agent-1",
			extractionJobPendingAt: { $exists: true },
			// P4.4.1: expired events are hidden until the TTL sweep runs.
			$or: [
				{ expiresAt: { $exists: false } },
				{ expiresAt: { $gt: expect.any(Date) } },
			],
		})
		expect(sort).toHaveBeenCalledWith({ extractionJobPendingAt: 1, _id: 1 })
		expect(limit).toHaveBeenCalledWith(25)
	})

	it("clears the extraction outbox marker durably", async () => {
		const col = createMockEventsCol()
		vi.mocked(eventsCollection).mockReturnValue(col)

		await expect(
			clearEventExtractionJobPending({
				db: mockDb(),
				prefix: "test_",
				eventId: "pending-1",
				agentId: "agent-1",
			}),
		).resolves.toBe(true)
		expect(col.updateOne).toHaveBeenCalledWith(
			{
				eventId: "pending-1",
				agentId: "agent-1",
				extractionJobPendingAt: { $exists: true },
			},
			{ $unset: { extractionJobPendingAt: "" } },
			{ writeConcern: { w: "majority", wtimeoutMS: 5_000 } },
		)
	})

	it("clears the extraction outbox marker in the caller transaction", async () => {
		const col = createMockEventsCol()
		vi.mocked(eventsCollection).mockReturnValue(col)
		const session = {} as ClientSession

		await expect(
			clearEventExtractionJobPending({
				db: mockDb(),
				prefix: "test_",
				eventId: "pending-transaction",
				agentId: "agent-1",
				session,
			}),
		).resolves.toBe(true)
		expect(col.updateOne).toHaveBeenCalledWith(
			expect.any(Object),
			expect.any(Object),
			{ session },
		)
	})

	it("stores event validity separately from the write clock", async () => {
		const col = createMockEventsCol()
		vi.mocked(eventsCollection).mockReturnValue(col)
		const eventTime = new Date("2021-04-05T12:00:00.000Z")

		await writeEvent({
			db: mockDb(),
			prefix: "test_",
			event: {
				agentId: "agent-1",
				role: "user",
				body: "Historical message",
				scope: "agent",
				scopeRef: "agent:agent-1",
				timestamp: eventTime,
			},
		})

		const [, update] = vi.mocked(col.updateOne).mock.calls[0]
		const doc = (update as Record<string, Record<string, unknown>>).$setOnInsert
		expect(doc.timestamp).toEqual(eventTime)
		expect(doc.validAt).toEqual(eventTime)
		expect(doc.recordedAt).toBeInstanceOf(Date)
	})

	it("owns recordedAt even when an untyped caller supplies one", async () => {
		const col = createMockEventsCol()
		vi.mocked(eventsCollection).mockReturnValue(col)
		const callerRecordedAt = new Date("2000-01-01T00:00:00.000Z")
		const beforeWrite = Date.now()

		await writeEvent({
			db: mockDb(),
			prefix: "test_",
			event: {
				agentId: "agent-1",
				role: "user",
				body: "Current transaction",
				scope: "agent",
				scopeRef: "agent:agent-1",
				recordedAt: callerRecordedAt,
			} as CanonicalEvent,
		})

		const [, update] = vi.mocked(col.updateOne).mock.calls[0]
		const doc = (update as Record<string, Record<string, unknown>>).$setOnInsert
		expect(doc.recordedAt).not.toEqual(callerRecordedAt)
		expect((doc.recordedAt as Date).getTime()).toBeGreaterThanOrEqual(
			beforeWrite,
		)
	})

	it("stores an explicit event validity window", async () => {
		const col = createMockEventsCol()
		vi.mocked(eventsCollection).mockReturnValue(col)
		const validAt = new Date("2021-04-05T12:00:00.000Z")
		const invalidAt = new Date("2021-04-06T12:00:00.000Z")

		await writeEvent({
			db: mockDb(),
			prefix: "test_",
			event: {
				agentId: "agent-1",
				role: "user",
				body: "Historical message",
				scope: "agent",
				scopeRef: "agent:agent-1",
				timestamp: validAt,
				validAt,
				invalidAt,
			},
		})

		const [, update] = vi.mocked(col.updateOne).mock.calls[0]
		const doc = (update as Record<string, Record<string, unknown>>).$setOnInsert
		expect(doc.validAt).toEqual(validAt)
		expect(doc.invalidAt).toEqual(invalidAt)
	})

	it.each([
		["timestamp", { timestamp: new Date("invalid") }],
		["validAt", { validAt: new Date("invalid") }],
		["invalidAt", { invalidAt: new Date("invalid") }],
	])("rejects an invalid %s", async (label, dates) => {
		const col = createMockEventsCol()
		vi.mocked(eventsCollection).mockReturnValue(col)

		await expect(
			writeEvent({
				db: mockDb(),
				prefix: "test_",
				event: {
					agentId: "agent-1",
					role: "user",
					body: "Invalid event",
					scope: "agent",
					scopeRef: "agent:agent-1",
					...dates,
				},
			}),
		).rejects.toThrow(`invalid event ${label}`)
		expect(col.updateOne).not.toHaveBeenCalled()
	})

	it("rejects a validity window that does not advance", async () => {
		const col = createMockEventsCol()
		vi.mocked(eventsCollection).mockReturnValue(col)
		const validAt = new Date("2021-04-05T12:00:00.000Z")

		await expect(
			writeEvent({
				db: mockDb(),
				prefix: "test_",
				event: {
					agentId: "agent-1",
					role: "user",
					body: "Invalid event",
					scope: "agent",
					scopeRef: "agent:agent-1",
					validAt,
					invalidAt: validAt,
				},
			}),
		).rejects.toThrow("event invalidAt must be later than validAt")
	})

	it("returns the stored receipt when optional identity is omitted on both sides", async () => {
		const storedTimestamp = new Date("2024-01-02T03:04:05.000Z")
		const storedValidAt = new Date("2024-01-01T00:00:00.000Z")
		const col = createMatchedEventCol(
			storedEvent({
				timestamp: storedTimestamp,
				validAt: storedValidAt,
			}),
		)
		vi.mocked(eventsCollection).mockReturnValue(col)

		const result = await writeEvent({
			db: mockDb(),
			prefix: "test_",
			event: replayInput(),
		})

		expect(result).toEqual({
			eventId: "existing-id",
			timestamp: storedTimestamp,
			scopeRef: "agent:agent-1",
		})
		expect(col.updateOne).toHaveBeenCalledOnce()
		expect(col.findOne).toHaveBeenCalledWith(
			{ eventId: "existing-id" },
			{
				projection: {
					_id: 0,
					eventId: 1,
					agentId: 1,
					sessionId: 1,
					channel: 1,
					role: 1,
					body: 1,
					metadata: 1,
					scope: 1,
					scopeRef: 1,
					timestamp: 1,
					validAt: 1,
					invalidAt: 1,
					expiresAt: 1,
				},
				raw: false,
				fieldsAsRaw: {},
				useBigInt64: false,
				promoteValues: false,
				promoteLongs: false,
				bsonRegExp: true,
				readConcern: { level: "majority" },
			},
		)
	})

	it.each([
		["timestamp", { timestamp: new Date("2024-01-03T03:04:05.000Z") }],
		[
			"validAt",
			{
				timestamp: new Date("2024-01-02T03:04:05.000Z"),
				validAt: new Date("2024-01-02T04:04:05.000Z"),
			},
		],
	])("rejects an explicit %s contradiction", async (_label, overrides) => {
		const col = createMatchedEventCol(storedEvent())
		vi.mocked(eventsCollection).mockReturnValue(col)

		await expect(
			writeEvent({
				db: mockDb(),
				prefix: "test_",
				event: replayInput(overrides),
			}),
		).rejects.toThrow(
			'event ID "existing-id" is already assigned to a different event',
		)
	})

	it("replays a legacy row missing validAt when the explicit timestamp matches", async () => {
		const { validAt: _legacyMissingValidAt, ...legacyStored } = storedEvent()
		const col = createMatchedEventCol(legacyStored)
		vi.mocked(eventsCollection).mockReturnValue(col)

		await expect(
			writeEvent({
				db: mockDb(),
				prefix: "test_",
				event: replayInput({
					timestamp: legacyStored.timestamp,
				}),
			}),
		).resolves.toMatchObject({ eventId: "existing-id" })
	})

	it("rejects an explicit validAt when the legacy stored row lacks it", async () => {
		const { validAt: _legacyMissingValidAt, ...legacyStored } = storedEvent()
		const col = createMatchedEventCol(legacyStored)
		vi.mocked(eventsCollection).mockReturnValue(col)

		await expect(
			writeEvent({
				db: mockDb(),
				prefix: "test_",
				event: replayInput({
					timestamp: legacyStored.timestamp,
					validAt: legacyStored.timestamp,
				}),
			}),
		).rejects.toThrow(
			'event ID "existing-id" is already assigned to a different event',
		)
	})

	it.each([
		[
			"owner",
			{
				agentId: "agent-2",
				scopeRef: "agent:agent-2",
			},
			{},
		],
		[
			"scope",
			{
				scope: "workspace" as const,
				scopeRef: "workspace:agent-1",
			},
			{},
		],
		["session", { sessionId: "session-new" }, { sessionId: "session-old" }],
		["body", { body: "Changed body" }, { body: "Stored private body" }],
		["role", { role: "assistant" as const }, { role: "system" as const }],
		["channel", { channel: "api" }, { channel: "discord" }],
	])("rejects a duplicate eventId with conflicting %s identity", async (_label, inputOverrides, storedOverrides) => {
		const col = createMatchedEventCol(storedEvent(storedOverrides))
		vi.mocked(eventsCollection).mockReturnValue(col)

		let thrown: unknown
		try {
			await writeEvent({
				db: mockDb(),
				prefix: "test_",
				event: replayInput(inputOverrides),
			})
		} catch (err) {
			thrown = err
		}
		expect(thrown).toBeInstanceOf(Error)
		expect((thrown as Error).message).toBe(
			'event ID "existing-id" is already assigned to a different event',
		)
		expect((thrown as Error).message).not.toContain("Stored private body")
	})

	it("accepts BSON metadata with reordered object keys", async () => {
		const col = createMatchedEventCol(
			storedEvent({
				metadata: {
					first: 1,
					nested: { alpha: true, beta: "two" },
				},
			}),
		)
		vi.mocked(eventsCollection).mockReturnValue(col)

		await expect(
			writeEvent({
				db: mockDb(),
				prefix: "test_",
				event: replayInput({
					metadata: {
						nested: { beta: "two", alpha: true },
						first: 1,
					},
				}),
			}),
		).resolves.toMatchObject({ eventId: "existing-id" })
	})

	it("replays nested undefined metadata using the driver default write representation", async () => {
		const col = createMatchedEventCol(
			storedEvent({
				metadata: { nested: { optional: null } },
			}),
		)
		vi.mocked(eventsCollection).mockReturnValue(col)

		await expect(
			writeEvent({
				db: mockDb(),
				prefix: "test_",
				event: replayInput({
					metadata: { nested: { optional: undefined } },
				}),
			}),
		).resolves.toMatchObject({ eventId: "existing-id" })
	})

	it("honors inherited ignoreUndefined when comparing metadata", async () => {
		const col = createMatchedEventCol(
			storedEvent({
				metadata: { nested: {} },
			}),
			{
				ignoreUndefined: true,
				serializeFunctions: false,
			},
		)
		vi.mocked(eventsCollection).mockReturnValue(col)

		await expect(
			writeEvent({
				db: mockDb(),
				prefix: "test_",
				event: replayInput({
					metadata: { nested: { optional: undefined } },
				}),
			}),
		).resolves.toMatchObject({ eventId: "existing-id" })
		await expect(
			writeEvent({
				db: mockDb(),
				prefix: "test_",
				event: replayInput({
					metadata: { nested: { optional: null } },
				}),
			}),
		).rejects.toThrow(
			'event ID "existing-id" is already assigned to a different event',
		)
	})

	it("honors inherited serializeFunctions when comparing metadata", async () => {
		function transform(value: unknown): unknown {
			return value
		}
		const col = createMatchedEventCol(
			storedEvent({
				metadata: { transform: new Code(transform.toString()) },
			}),
			{
				ignoreUndefined: false,
				serializeFunctions: true,
			},
		)
		vi.mocked(eventsCollection).mockReturnValue(col)

		await expect(
			writeEvent({
				db: mockDb(),
				prefix: "test_",
				event: replayInput({ metadata: { transform } }),
			}),
		).resolves.toMatchObject({ eventId: "existing-id" })
		await expect(
			writeEvent({
				db: mockDb(),
				prefix: "test_",
				event: replayInput({
					metadata: {
						transform(value: unknown): unknown {
							return { value }
						},
					},
				}),
			}),
		).rejects.toThrow(
			'event ID "existing-id" is already assigned to a different event',
		)
	})

	it.each([
		[
			"Date and ISO string",
			{ observedAt: new Date("2024-02-03T04:05:06.000Z") },
			{ observedAt: "2024-02-03T04:05:06.000Z" },
		],
		[
			"different regular expressions",
			{ pattern: new BSONRegExp("alpha", "i") },
			{ pattern: /beta/i },
		],
		[
			"different array order",
			{ ranked: ["first", "second"] },
			{ ranked: ["second", "first"] },
		],
	])("rejects metadata with %s", async (_label, storedMetadata, attemptedMetadata) => {
		const col = createMatchedEventCol(storedEvent({ metadata: storedMetadata }))
		vi.mocked(eventsCollection).mockReturnValue(col)

		await expect(
			writeEvent({
				db: mockDb(),
				prefix: "test_",
				event: replayInput({ metadata: attemptedMetadata }),
			}),
		).rejects.toThrow(
			'event ID "existing-id" is already assigned to a different event',
		)
	})

	it.each([
		["sessionId", { sessionId: "stored-session" }],
		["channel", { channel: "stored-channel" }],
		["metadata", { metadata: { stored: true } }],
	])("rejects omitted %s when the stored event contains it", async (_label, storedOverrides) => {
		const col = createMatchedEventCol(storedEvent(storedOverrides))
		vi.mocked(eventsCollection).mockReturnValue(col)

		await expect(
			writeEvent({
				db: mockDb(),
				prefix: "test_",
				event: replayInput(),
			}),
		).rejects.toThrow(
			'event ID "existing-id" is already assigned to a different event',
		)
	})

	it.each([
		["sessionId", { sessionId: "" }],
		["channel", { channel: "" }],
	])("normalizes an empty %s to canonical omission", async (_label, inputOverrides) => {
		const col = createMatchedEventCol(storedEvent())
		vi.mocked(eventsCollection).mockReturnValue(col)

		await expect(
			writeEvent({
				db: mockDb(),
				prefix: "test_",
				event: replayInput(inputOverrides),
			}),
		).resolves.toMatchObject({ eventId: "existing-id" })
	})

	it("keeps absent metadata distinct from supplied empty metadata", async () => {
		const col = createMatchedEventCol(storedEvent())
		vi.mocked(eventsCollection).mockReturnValue(col)

		await expect(
			writeEvent({
				db: mockDb(),
				prefix: "test_",
				event: replayInput({ metadata: {} }),
			}),
		).rejects.toThrow(
			'event ID "existing-id" is already assigned to a different event',
		)
	})

	it("treats omitted lifecycle bounds as no contradictory evidence", async () => {
		const storedTimestamp = new Date("2024-01-02T03:04:05.000Z")
		const col = createMatchedEventCol(
			storedEvent({
				invalidAt: new Date("2025-01-01T00:00:00.000Z"),
				expiresAt: new Date("2026-01-01T00:00:00.000Z"),
				timestamp: storedTimestamp,
				validAt: new Date("2023-01-01T00:00:00.000Z"),
			}),
		)
		vi.mocked(eventsCollection).mockReturnValue(col)

		await expect(
			writeEvent({
				db: mockDb(),
				prefix: "test_",
				event: replayInput(),
			}),
		).resolves.toEqual({
			eventId: "existing-id",
			timestamp: storedTimestamp,
			scopeRef: "agent:agent-1",
		})
	})

	it("ignores pruned idempotency state and mutable operational fields", async () => {
		const col = createMatchedEventCol(
			storedEvent({
				projectedAt: new Date("2024-01-03T00:00:00.000Z"),
				consolidatedAt: new Date("2024-01-04T00:00:00.000Z"),
				consolidatedIntoEpisodeId: "episode-later",
				accessCount: 9,
			}),
		)
		vi.mocked(eventsCollection).mockReturnValue(col)

		await expect(
			writeEvent({
				db: mockDb(),
				prefix: "test_",
				event: replayInput({
					idempotencyKey: "already-pruned",
					idempotencyFingerprint: "already-pruned",
					extractionJobPendingAt: new Date("2024-01-01T00:00:00.000Z"),
				}),
			}),
		).resolves.toMatchObject({ eventId: "existing-id" })
	})

	it("uses the transaction session without an operation read concern", async () => {
		const col = createMatchedEventCol(storedEvent())
		vi.mocked(eventsCollection).mockReturnValue(col)
		const session = {} as ClientSession

		await writeEvent({
			db: mockDb(),
			prefix: "test_",
			session,
			event: replayInput(),
		})

		expect(col.findOne).toHaveBeenCalledWith(
			{ eventId: "existing-id" },
			{
				projection: expect.any(Object),
				raw: false,
				fieldsAsRaw: {},
				useBigInt64: false,
				promoteValues: false,
				promoteLongs: false,
				bsonRegExp: true,
				session,
			},
		)
		const options = vi.mocked(col.findOne).mock.calls[0][1]
		expect(options).not.toHaveProperty("readConcern")
	})

	it.each([
		["missing", null],
		["malformed", { eventId: "existing-id" }],
	])("fails honestly when the stored replay row is %s", async (_label, row) => {
		const col = createMatchedEventCol(row as Document)
		vi.mocked(eventsCollection).mockReturnValue(col)

		await expect(
			writeEvent({
				db: mockDb(),
				prefix: "test_",
				event: replayInput(),
			}),
		).rejects.toThrow(
			'event replay confirmation failed for event ID "existing-id"; stored event was missing or malformed',
		)
	})

	it("fails honestly when the stored replay row cannot be read", async () => {
		const col = createMatchedEventCol(storedEvent())
		vi.mocked(col.findOne).mockRejectedValue(
			new Error("sensitive read implementation detail"),
		)
		vi.mocked(eventsCollection).mockReturnValue(col)

		await expect(
			writeEvent({
				db: mockDb(),
				prefix: "test_",
				event: replayInput(),
			}),
		).rejects.toThrow(
			'event replay confirmation failed for event ID "existing-id"; stored event could not be read',
		)
	})

	it("retries transient MongoDB write errors with the same eventId", async () => {
		vi.useFakeTimers()
		const col = createMockEventsCol()
		vi.mocked(col.updateOne)
			.mockRejectedValueOnce(
				Object.assign(
					new Error(
						"Connection to memongo-shard interrupted due to server monitor timeout",
					),
					{ name: "MongoNetworkError" },
				),
			)
			.mockResolvedValueOnce({
				upsertedCount: 1,
				upsertedId: "new-id",
				modifiedCount: 0,
				matchedCount: 0,
				acknowledged: true,
			})
		vi.mocked(eventsCollection).mockReturnValue(col)

		const promise = writeEvent({
			db: mockDb(),
			prefix: "test_",
			event: {
				agentId: "agent-1",
				role: "user",
				body: "Hello world",
				scope: "agent",
				scopeRef: "agent:agent-1",
			},
		})
		await vi.advanceTimersByTimeAsync(1_000)
		const result = await promise
		vi.useRealTimers()

		expect(result.eventId).toBeDefined()
		expect(col.updateOne).toHaveBeenCalledTimes(2)
		const [firstFilter] = vi.mocked(col.updateOne).mock.calls[0]
		const [secondFilter] = vi.mocked(col.updateOne).mock.calls[1]
		expect(secondFilter).toEqual(firstFilter)
	})

	it("classifies retryable MongoDB write labels as transient", () => {
		const err = {
			hasErrorLabel: (label: string) => label === "NoWritesPerformed",
		}

		expect(isTransientMongoWriteError(err)).toBe(true)
		expect(isTransientMongoWriteError(new Error("getaddrinfo ENOTFOUND"))).toBe(
			true,
		)
		expect(isTransientMongoWriteError(new Error("ReplicaSetNoPrimary"))).toBe(
			true,
		)
		expect(isTransientMongoWriteError(new Error("connect ECONNREFUSED"))).toBe(
			true,
		)
		expect(isTransientMongoWriteError(new Error("duplicate key"))).toBe(false)
	})

	it("defaults scope to agent when not provided", async () => {
		const col = createMockEventsCol()
		vi.mocked(eventsCollection).mockReturnValue(col)

		await writeEvent({
			db: mockDb(),
			prefix: "test_",
			event: {
				agentId: "agent-1",
				role: "assistant",
				body: "Response",
			} as Parameters<typeof writeEvent>[0]["event"],
		})

		const [, update] = vi.mocked(col.updateOne).mock.calls[0]
		const doc = (update as Record<string, Record<string, unknown>>).$setOnInsert
		expect(doc.scope).toBe("agent")
	})

	// P2.3: writes share the search identity rule — an implicit sessionId lands
	// the event in the session scope a sessionKey search reads from.
	it("P2.3: a sessionId with no explicit scope lands in the session scope", async () => {
		const col = createMockEventsCol()
		vi.mocked(eventsCollection).mockReturnValue(col)

		const result = await writeEvent({
			db: mockDb(),
			prefix: "test_",
			event: {
				agentId: "agent-1",
				role: "user",
				body: "session-scoped hello",
				sessionId: "s1",
			} as Parameters<typeof writeEvent>[0]["event"],
		})

		const [, update] = vi.mocked(col.updateOne).mock.calls[0]
		const doc = (update as Record<string, Record<string, unknown>>).$setOnInsert
		expect(doc.scope).toBe("session")
		expect(doc.scopeRef).toBe("session:s1")
		expect(result.scopeRef).toBe("session:s1")
	})

	it("P2.3: explicit scope still wins over an implicit sessionId", async () => {
		const col = createMockEventsCol()
		vi.mocked(eventsCollection).mockReturnValue(col)

		await writeEvent({
			db: mockDb(),
			prefix: "test_",
			event: {
				agentId: "agent-1",
				role: "user",
				body: "explicit agent scope with a session id",
				scope: "agent",
				sessionId: "s1",
			},
		})

		const [, update] = vi.mocked(col.updateOne).mock.calls[0]
		const doc = (update as Record<string, Record<string, unknown>>).$setOnInsert
		expect(doc.scope).toBe("agent")
		expect(doc.scopeRef).toBe("agent:agent-1")
	})

	it("stores idempotencyKey on the event document when provided", async () => {
		const col = createMockEventsCol()
		vi.mocked(eventsCollection).mockReturnValue(col)

		await writeEvent({
			db: mockDb(),
			prefix: "test_",
			event: {
				agentId: "agent-1",
				role: "user",
				body: "Hello",
				idempotencyKey: "key-9",
			} as Parameters<typeof writeEvent>[0]["event"],
		})

		const [, update] = vi.mocked(col.updateOne).mock.calls[0]
		const doc = (update as Record<string, Record<string, unknown>>).$setOnInsert
		expect(doc.idempotencyKey).toBe("key-9")
	})

	it("preserves optional fields when provided", async () => {
		const col = createMockEventsCol()
		vi.mocked(eventsCollection).mockReturnValue(col)

		await writeEvent({
			db: mockDb(),
			prefix: "test_",
			event: {
				agentId: "agent-1",
				role: "user",
				body: "Hello",
				scope: "session",
				scopeRef: "session:sess-1",
				sessionId: "sess-123",
				channel: "discord",
				metadata: { key: "value" },
			},
		})

		const [, update] = vi.mocked(col.updateOne).mock.calls[0]
		const doc = (update as Record<string, Record<string, unknown>>).$setOnInsert
		expect(doc.sessionId).toBe("sess-123")
		expect(doc.channel).toBe("discord")
		expect(doc.metadata).toEqual({ key: "value" })
	})
})

// ---------------------------------------------------------------------------
// Tests: getEventsByTimeRange
// ---------------------------------------------------------------------------

describe("getEventsByTimeRange", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("returns events in timestamp order within range", async () => {
		const now = new Date()
		const earlier = new Date(now.getTime() - 60000)
		const mockEvents: CanonicalEvent[] = [
			{
				eventId: "e1",
				agentId: "agent-1",
				role: "user",
				body: "First",
				scope: "agent",
				scopeRef: "agent:agent-1",
				timestamp: earlier,
			},
			{
				eventId: "e2",
				agentId: "agent-1",
				role: "assistant",
				body: "Second",
				scope: "agent",
				scopeRef: "agent:agent-1",
				timestamp: now,
			},
		]

		const toArrayFn = vi.fn(async () => mockEvents)
		const limitFn = vi.fn(() => ({ toArray: toArrayFn }))
		const sortFn = vi.fn(() => ({ limit: limitFn }))
		const findFn = vi.fn(() => ({ sort: sortFn }))

		const col = Object.assign(createMockEventsCol(), { find: findFn })
		vi.mocked(eventsCollection).mockReturnValue(col)

		const start = new Date(now.getTime() - 120000)
		const end = new Date(now.getTime() + 1000)
		const result = await getEventsByTimeRange({
			db: mockDb(),
			prefix: "test_",
			agentId: "agent-1",
			start,
			end,
		})

		expect(result).toHaveLength(2)
		expect(result[0].eventId).toBe("e1")
		expect(result[1].eventId).toBe("e2")

		// Verify filter
		expect(findFn).toHaveBeenCalledWith({
			agentId: "agent-1",
			timestamp: { $gte: start, $lte: end },
			// P4.4.1: expired events are hidden until the TTL sweep runs.
			$or: [
				{ expiresAt: { $exists: false } },
				{ expiresAt: { $gt: expect.any(Date) } },
			],
		})
		expect(sortFn).toHaveBeenCalledWith({ timestamp: 1, _id: 1 })
		expect(limitFn).toHaveBeenCalledWith(1000) // default limit
	})

	it("applies scope filter when provided", async () => {
		const toArrayFn = vi.fn(async () => [])
		const limitFn = vi.fn(() => ({ toArray: toArrayFn }))
		const sortFn = vi.fn(() => ({ limit: limitFn }))
		const findFn = vi.fn(() => ({ sort: sortFn }))

		const col = Object.assign(createMockEventsCol(), { find: findFn })
		vi.mocked(eventsCollection).mockReturnValue(col)

		const start = new Date("2025-01-01")
		const end = new Date("2025-12-31")
		await getEventsByTimeRange({
			db: mockDb(),
			prefix: "test_",
			agentId: "agent-1",
			start,
			end,
			scope: "session",
			scopeRef: "session:sess-1",
		})

		expect(findFn).toHaveBeenCalledWith({
			agentId: "agent-1",
			timestamp: { $gte: start, $lte: end },
			scope: "session",
			scopeRef: "session:sess-1",
			// P4.4.1: expired events are hidden until the TTL sweep runs.
			$or: [
				{ expiresAt: { $exists: false } },
				{ expiresAt: { $gt: expect.any(Date) } },
			],
		})
	})
})

// ---------------------------------------------------------------------------
// Tests: getEventsBySession
// ---------------------------------------------------------------------------

describe("getEventsBySession", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("filters by agentId and sessionId", async () => {
		const mockEvents: CanonicalEvent[] = [
			{
				eventId: "e1",
				agentId: "agent-1",
				sessionId: "sess-1",
				role: "user",
				body: "Hello",
				scope: "agent",
				scopeRef: "agent:agent-1",
				timestamp: new Date(),
			},
		]

		const toArrayFn = vi.fn(async () => mockEvents)
		const limitFn = vi.fn(() => ({ toArray: toArrayFn }))
		const sortFn = vi.fn(() => ({ limit: limitFn }))
		const findFn = vi.fn(() => ({ sort: sortFn }))

		const col = Object.assign(createMockEventsCol(), { find: findFn })
		vi.mocked(eventsCollection).mockReturnValue(col)

		const result = await getEventsBySession({
			db: mockDb(),
			prefix: "test_",
			agentId: "agent-1",
			sessionId: "sess-1",
		})

		expect(result).toHaveLength(1)
		expect(result[0].sessionId).toBe("sess-1")
		expect(findFn).toHaveBeenCalledWith({
			agentId: "agent-1",
			sessionId: "sess-1",
			// P4.4.1: expired events are hidden until the TTL sweep runs.
			$or: [
				{ expiresAt: { $exists: false } },
				{ expiresAt: { $gt: expect.any(Date) } },
			],
		})
		expect(sortFn).toHaveBeenCalledWith({ timestamp: 1, _id: 1 })
	})
})

// ---------------------------------------------------------------------------
// Tests: getUnprojectedEvents
// ---------------------------------------------------------------------------

describe("getUnprojectedEvents", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("returns events where projectedAt does not exist", async () => {
		const mockEvents: CanonicalEvent[] = [
			{
				eventId: "e1",
				agentId: "agent-1",
				role: "user",
				body: "Unprojected",
				scope: "agent",
				scopeRef: "agent:agent-1",
				timestamp: new Date(),
			},
		]

		const toArrayFn = vi.fn(async () => mockEvents)
		const limitFn = vi.fn(() => ({ toArray: toArrayFn }))
		const sortFn = vi.fn(() => ({ limit: limitFn }))
		const findFn = vi.fn(() => ({ sort: sortFn }))

		const col = Object.assign(createMockEventsCol(), { find: findFn })
		vi.mocked(eventsCollection).mockReturnValue(col)

		const result = await getUnprojectedEvents({
			db: mockDb(),
			prefix: "test_",
			agentId: "agent-1",
		})

		expect(result).toHaveLength(1)
		expect(findFn).toHaveBeenCalledWith({
			agentId: "agent-1",
			projectedAt: { $exists: false },
			// P4.4.1: expired events are hidden until the TTL sweep runs.
			$or: [
				{ expiresAt: { $exists: false } },
				{ expiresAt: { $gt: expect.any(Date) } },
			],
		})
		expect(limitFn).toHaveBeenCalledWith(500) // default limit
	})
})

// ---------------------------------------------------------------------------
// Tests: markEventsProjected
// ---------------------------------------------------------------------------

describe("markEventsProjected", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("sets projectedAt on given eventIds", async () => {
		const col = createMockEventsCol()
		vi.mocked(col.updateMany).mockResolvedValue({
			modifiedCount: 3,
			matchedCount: 3,
			upsertedCount: 0,
			upsertedId: null,
			acknowledged: true,
		})
		vi.mocked(eventsCollection).mockReturnValue(col)

		const result = await markEventsProjected({
			db: mockDb(),
			prefix: "test_",
			eventIds: ["e1", "e2", "e3"],
		})

		expect(result).toBe(3)
		expect(col.updateMany).toHaveBeenCalledOnce()
		const [filter, update] = vi.mocked(col.updateMany).mock.calls[0]
		expect(filter).toEqual({ eventId: { $in: ["e1", "e2", "e3"] } })
		expect(update).toHaveProperty("$set")
		const setClause = (update as Record<string, Record<string, unknown>>).$set
		expect(setClause.projectedAt).toBeInstanceOf(Date)
	})

	it("returns 0 for empty eventIds array", async () => {
		const col = createMockEventsCol()
		vi.mocked(eventsCollection).mockReturnValue(col)

		const result = await markEventsProjected({
			db: mockDb(),
			prefix: "test_",
			eventIds: [],
		})

		expect(result).toBe(0)
		expect(col.updateMany).not.toHaveBeenCalled()
	})
})

// ---------------------------------------------------------------------------
// Tests: projectChunksFromEvents
// ---------------------------------------------------------------------------

describe("projectChunksFromEvents", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		vi.spyOn(writeFence, "captureAdmissionToken").mockImplementation(
			async ({ agentId }) => ({ kind: "admission", agentId, epoch: 0 }),
		)
		vi.spyOn(writeFence, "readErasureGate").mockImplementation(
			async ({ agentId }) => ({
				_id: "gate",
				agentId,
				epoch: 0,
				state: "open",
				serial: 0,
			}),
		)
		vi.spyOn(writeFence, "withFencedWrite").mockImplementation(async ({ fn }) =>
			fn({} as ClientSession),
		)
	})
	afterEach(() => vi.restoreAllMocks())

	it("creates chunks and marks events as projected", async () => {
		const mockEvents: CanonicalEvent[] = [
			{
				eventId: "evt-1",
				agentId: "agent-1",
				role: "user",
				body: "Hello world",
				scope: "agent",
				scopeRef: "agent:agent-1",
				timestamp: new Date(),
			},
			{
				eventId: "evt-2",
				agentId: "agent-1",
				role: "assistant",
				body: "Hi there",
				scope: "agent",
				scopeRef: "agent:agent-1",
				timestamp: new Date(),
			},
		]

		// Events collection mock
		const toArrayFn = vi.fn(async () => mockEvents)
		const limitFn = vi.fn(() => ({ toArray: toArrayFn }))
		const sortFn = vi.fn(() => ({ limit: limitFn }))
		const findFn = vi.fn(() => ({ sort: sortFn }))

		const eventCol = {
			find: findFn,
			updateMany: vi.fn(async () => ({
				modifiedCount: 2,
				matchedCount: 2,
				upsertedCount: 0,
				upsertedId: null,
				acknowledged: true,
			})),
			updateOne: vi.fn(async () => ({
				upsertedCount: 1,
				upsertedId: "new-id",
				modifiedCount: 0,
			})),
		} as unknown as Collection

		// Chunks collection mock
		const chunkCol = createMockChunksCol()

		vi.mocked(eventsCollection).mockReturnValue(eventCol)
		vi.mocked(chunksCollection).mockReturnValue(chunkCol)

		const result = await projectChunksFromEvents({
			db: mockDb(),
			prefix: "test_",
			agentId: "agent-1",
		})

		expect(result.eventsProcessed).toBe(2)
		expect(result.chunksCreated).toBe(2)

		// Verify chunks were created with correct path and source
		expect(chunkCol.updateOne).toHaveBeenCalledTimes(2)
		const firstCall = vi.mocked(chunkCol.updateOne).mock.calls[0]
		const firstFilter = firstCall[0] as Record<string, unknown>
		expect(firstFilter.path).toBe("events/evt-1")

		const firstUpdate = firstCall[1] as Record<string, Record<string, unknown>>
		const firstDoc = firstUpdate.$setOnInsert
		expect(firstDoc.source).toBe("conversation")
		expect(firstDoc.text).toBe("User: Hello world")
		expect(typeof firstDoc.hash).toBe("string")

		// Verify events were marked as projected per projected event.
		expect(eventCol.updateMany).toHaveBeenCalledTimes(2)
	})

	it("with zero unprojected events is a no-op", async () => {
		const toArrayFn = vi.fn(async () => [])
		const limitFn = vi.fn(() => ({ toArray: toArrayFn }))
		const sortFn = vi.fn(() => ({ limit: limitFn }))
		const findFn = vi.fn(() => ({ sort: sortFn }))

		const eventCol = {
			find: findFn,
			updateMany: vi.fn(),
			updateOne: vi.fn(),
		} as unknown as Collection

		const chunkCol = createMockChunksCol()

		vi.mocked(eventsCollection).mockReturnValue(eventCol)
		vi.mocked(chunksCollection).mockReturnValue(chunkCol)

		const result = await projectChunksFromEvents({
			db: mockDb(),
			prefix: "test_",
			agentId: "agent-1",
		})

		expect(result.eventsProcessed).toBe(0)
		expect(result.chunksCreated).toBe(0)
		expect(chunkCol.updateOne).not.toHaveBeenCalled()
		expect(eventCol.updateMany).not.toHaveBeenCalled()
	})

	it("projected chunks have correct source and path format", async () => {
		const eventTimestamp = new Date("2025-01-01T12:00:00.000Z")
		const mockEvents: CanonicalEvent[] = [
			{
				eventId: "abc-def-123",
				agentId: "agent-1",
				role: "user",
				body: "Test content",
				scope: "agent",
				scopeRef: "agent:agent-1",
				timestamp: eventTimestamp,
			},
		]

		const toArrayFn = vi.fn(async () => mockEvents)
		const limitFn = vi.fn(() => ({ toArray: toArrayFn }))
		const sortFn = vi.fn(() => ({ limit: limitFn }))
		const findFn = vi.fn(() => ({ sort: sortFn }))

		const eventCol = {
			find: findFn,
			updateMany: vi.fn(async () => ({
				modifiedCount: 1,
				matchedCount: 1,
				upsertedCount: 0,
				upsertedId: null,
				acknowledged: true,
			})),
			updateOne: vi.fn(),
		} as unknown as Collection

		const chunkCol = createMockChunksCol()

		vi.mocked(eventsCollection).mockReturnValue(eventCol)
		vi.mocked(chunksCollection).mockReturnValue(chunkCol)

		await projectChunksFromEvents({
			db: mockDb(),
			prefix: "test_",
			agentId: "agent-1",
		})

		const call = vi.mocked(chunkCol.updateOne).mock.calls[0]
		const filter = call[0] as Record<string, unknown>
		expect(filter.path).toBe("events/abc-def-123")

		const update = call[1] as Record<string, Record<string, unknown>>
		const doc = update.$setOnInsert
		expect(doc.source).toBe("conversation")
		expect(doc.path).toBe("events/abc-def-123")
		expect(doc.agentId).toBe("agent-1")
		expect(doc.timestamp).toEqual(eventTimestamp)
	})

	it("only counts chunksCreated when upsertedCount > 0 (not duplicates)", async () => {
		const mockEvents: CanonicalEvent[] = [
			{
				eventId: "evt-new",
				agentId: "agent-1",
				role: "user",
				body: "New event",
				scope: "agent",
				scopeRef: "agent:agent-1",
				timestamp: new Date(),
			},
			{
				eventId: "evt-dup",
				agentId: "agent-1",
				role: "assistant",
				body: "Duplicate event",
				scope: "agent",
				scopeRef: "agent:agent-1",
				timestamp: new Date(),
			},
		]

		const toArrayFn = vi.fn(async () => mockEvents)
		const limitFn = vi.fn(() => ({ toArray: toArrayFn }))
		const sortFn = vi.fn(() => ({ limit: limitFn }))
		const findFn = vi.fn(() => ({ sort: sortFn }))

		const eventCol = {
			find: findFn,
			updateMany: vi.fn(async () => ({
				modifiedCount: 2,
				matchedCount: 2,
				upsertedCount: 0,
				upsertedId: null,
				acknowledged: true,
			})),
			updateOne: vi.fn(),
		} as unknown as Collection

		// First call: upsert (new chunk), second call: no upsert (duplicate)
		const chunkCol = {
			updateOne: vi
				.fn()
				.mockResolvedValueOnce({
					upsertedCount: 1,
					upsertedId: "new-id",
					modifiedCount: 0,
				})
				.mockResolvedValueOnce({
					upsertedCount: 0,
					upsertedId: null,
					modifiedCount: 0,
				}),
		} as unknown as Collection

		vi.mocked(eventsCollection).mockReturnValue(eventCol)
		vi.mocked(chunksCollection).mockReturnValue(chunkCol)

		const result = await projectChunksFromEvents({
			db: mockDb(),
			prefix: "test_",
			agentId: "agent-1",
		})

		expect(result.eventsProcessed).toBe(2)
		// Only 1 chunk was actually created (the other was a duplicate)
		expect(result.chunksCreated).toBe(1)
	})
})
