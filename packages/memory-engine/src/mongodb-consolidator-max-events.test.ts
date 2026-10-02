import type { Db } from "mongodb"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { consolidateMemory } from "./mongodb-consolidator.js"
import { MongoDBManagerLifecycleOps } from "./mongodb-manager-lifecycle.js"
import type { MongoDBManagerHost } from "./mongodb-manager-host.js"

const seams = vi.hoisted(() => ({
	provider: vi.fn(() => null),
	createJob: vi.fn(async () => undefined),
	updateJob: vi.fn(async () => undefined),
	invalidate: vi.fn(async () => undefined),
}))

vi.mock("./mongodb-llm-enrichment.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("./mongodb-llm-enrichment.js")>()),
	isExtractionLlmDisabled: () => false,
	resolveEnrichmentProvider: seams.provider,
}))
vi.mock("./mongodb-memory-jobs.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("./mongodb-memory-jobs.js")>()),
	createMemoryJob: seams.createJob,
	updateMemoryJob: seams.updateJob,
}))
vi.mock("./mongodb-query-cache.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("./mongodb-query-cache.js")>()),
	invalidateQueryCache: seams.invalidate,
}))

function fixture() {
	const cursor = {
		sort: vi.fn(),
		limit: vi.fn(),
		toArray: vi.fn(async () => []),
	}
	cursor.sort.mockReturnValue(cursor)
	cursor.limit.mockReturnValue(cursor)
	const events = { find: vi.fn(() => cursor) }
	const runs = {
		findOneAndUpdate: vi.fn(async () => ({ status: "running" })),
		updateOne: vi.fn(async () => ({ matchedCount: 1 })),
	}
	const gate = { agentId: "agent-1", epoch: 0, state: "open", serial: 0 }
	const meta = {
		findOneAndUpdate: vi.fn(async () => ({ ...gate })),
		findOne: vi.fn(async () => ({ ...gate })),
		updateOne: vi.fn(async () => {
			gate.serial += 1
			return { matchedCount: 1, modifiedCount: 1 }
		}),
	}
	const collection = vi.fn((name: string) => {
		if (name === "test_meta") return meta
		if (name === "test_events") return events
		if (name === "test_consolidation_runs") return runs
		throw new Error(`Unexpected collection: ${name}`)
	})
	const session = {
		inTransaction: () => false,
		withTransaction: async (fn: () => Promise<unknown>) => fn(),
		endSession: async () => {},
	}
	const db = {
		collection,
		client: { startSession: () => session },
	} as unknown as Db
	const host = {
		db,
		prefix: "test_",
		agentId: "agent-1",
		workspaceDir: "/test",
	} as unknown as MongoDBManagerHost
	return {
		db,
		collection,
		cursor,
		events,
		runs,
		lifecycle: new MongoDBManagerLifecycleOps(host),
	}
}

const invalid = [
	0,
	-0,
	-1,
	1.5,
	Number.NaN,
	Number.POSITIVE_INFINITY,
	Number.NEGATIVE_INFINITY,
	2 ** 53,
	"5",
	{},
	true,
] as unknown as number[]
const controls = [
	{ value: undefined, expected: 100 },
	{ value: null as unknown as number, expected: 100 },
	{ value: 1, expected: 1 },
	{ value: 5, expected: 5 },
	{ value: Number.MAX_SAFE_INTEGER, expected: Number.MAX_SAFE_INTEGER },
]

beforeEach(() => vi.clearAllMocks())

describe("consolidation maxEvents admission", () => {
	it.each(
		invalid,
	)("engine rejects %s before provider or database access", async (value) => {
		const f = fixture()
		const options = Object.freeze({ maxEvents: value })
		const before = structuredClone(options)
		await expect(
			consolidateMemory({
				db: f.db,
				prefix: "test_",
				agentId: "agent-1",
				options,
			}),
		).rejects.toThrow("maxEvents must be a positive integer")
		expect(f.collection).not.toHaveBeenCalled()
		expect(seams.provider).not.toHaveBeenCalled()
		expect(options).toEqual(before)
	})

	it.each(
		invalid,
	)("lifecycle rejects %s before tracking or cache effects", async (value) => {
		const f = fixture()
		const options = Object.freeze({ maxEvents: value })
		await expect(f.lifecycle.consolidate(options)).rejects.toThrow(
			"maxEvents must be a positive integer",
		)
		expect(seams.createJob).not.toHaveBeenCalled()
		expect(seams.updateJob).not.toHaveBeenCalled()
		expect(seams.invalidate).not.toHaveBeenCalled()
		expect(f.collection).not.toHaveBeenCalled()
		expect(seams.provider).not.toHaveBeenCalled()
	})

	it.each(
		controls,
	)("engine keeps $value -> $expected and the empty receipt", async ({
		value,
		expected,
	}) => {
		const f = fixture()
		const options = Object.freeze({ maxEvents: value })
		const result = await consolidateMemory({
			db: f.db,
			prefix: "test_",
			agentId: "agent-1",
			options,
		})
		expect(f.cursor.sort).toHaveBeenCalledExactlyOnceWith({ timestamp: -1 })
		expect(f.cursor.limit).toHaveBeenCalledExactlyOnceWith(expected)
		expect(f.cursor.sort.mock.invocationCallOrder[0]).toBeLessThan(
			f.cursor.limit.mock.invocationCallOrder[0],
		)
		expect(f.runs.findOneAndUpdate).toHaveBeenCalledOnce()
		expect(f.runs.updateOne).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({
				runId: result.runId,
				status: "running",
				leaseToken: expect.any(String),
			}),
			expect.objectContaining({
				$set: expect.objectContaining({
					status: "completed",
					eventsProcessed: 0,
				}),
			}),
			expect.any(Object),
		)
		expect(result).toEqual({
			runId: expect.any(String),
			agentId: "agent-1",
			eventsProcessed: 0,
			factsPromoted: 0,
			factsPruned: 0,
			conflictsResolved: 0,
			durationMs: expect.any(Number),
			candidates: [],
		})
		expect(options.maxEvents).toBe(value)
	})

	it("lifecycle retains positive-limit tracking metadata and completion", async () => {
		const f = fixture()
		const options = Object.freeze({ maxEvents: 5 })
		const result = await f.lifecycle.consolidate(options)
		expect(f.cursor.limit).toHaveBeenCalledExactlyOnceWith(5)
		expect(seams.createJob).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({
				job: expect.objectContaining({
					status: "running",
					tracking: true,
					metadata: { maxEvents: 5 },
				}),
			}),
		)
		expect(seams.updateJob).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({
				status: "completed",
				metadata: expect.objectContaining({
					maxEvents: 5,
					runId: result.runId,
				}),
			}),
		)
		expect(seams.invalidate).toHaveBeenCalledOnce()
		expect(options).toEqual({ maxEvents: 5 })
	})
})
