/* eslint-disable @typescript-eslint/unbound-method -- Vitest mock method assertions */
import type { Db, Collection } from "mongodb"
import { describe, it, expect, vi, beforeEach } from "vitest"

// ---------------------------------------------------------------------------
// Mock mongodb-schema before importing module under test
// ---------------------------------------------------------------------------

vi.mock("./mongodb-schema.js", () => ({
	telemetryCollection: vi.fn(),
}))

import { telemetryCollection } from "./mongodb-schema.js"
import {
	emitTelemetry,
	getLatencyStats,
	getCacheHitRate,
	getOperationDistribution,
} from "./mongodb-telemetry.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockCollection(
	overrides: Partial<Record<string, unknown>> = {},
): Collection {
	return {
		insertOne: vi.fn().mockResolvedValue({ insertedId: "mock-id" }),
		aggregate: vi
			.fn()
			.mockReturnValue({ toArray: vi.fn().mockResolvedValue([]) }),
		...overrides,
	} as unknown as Collection
}

const PREFIX = "test_"
const AGENT_ID = "agent-1"

// ---------------------------------------------------------------------------
// emitTelemetry
// ---------------------------------------------------------------------------

describe("emitTelemetry", () => {
	let mockCol: Collection

	beforeEach(() => {
		vi.clearAllMocks()
		mockCol = createMockCollection()
		vi.mocked(telemetryCollection).mockReturnValue(mockCol)
	})

	it("calls insertOne with correct document shape", () => {
		emitTelemetry({} as Db, PREFIX, {
			meta: { agentId: AGENT_ID, operation: "search" },
			durationMs: 42,
			ok: true,
		})

		expect(mockCol.insertOne).toHaveBeenCalledOnce()
		const [doc] = vi.mocked(mockCol.insertOne).mock.calls[0]
		expect(doc).toEqual(
			expect.objectContaining({
				meta: { agentId: AGENT_ID, operation: "search" },
				durationMs: 42,
				ok: true,
				ts: expect.any(Date),
			}),
		)
	})

	it("adds ts field automatically", () => {
		const before = Date.now()
		emitTelemetry({} as Db, PREFIX, {
			meta: { agentId: AGENT_ID, operation: "event-write" },
			durationMs: 10,
			ok: true,
		})
		const after = Date.now()

		const [doc] = vi.mocked(mockCol.insertOne).mock.calls[0]
		const ts = (doc as Record<string, unknown>).ts as Date
		expect(ts.getTime()).toBeGreaterThanOrEqual(before)
		expect(ts.getTime()).toBeLessThanOrEqual(after)
	})

	it("does not throw on insertOne failure", () => {
		vi.mocked(mockCol.insertOne).mockReturnValue(
			Promise.reject(new Error("Write failed")) as never,
		)

		// Should not throw
		expect(() => {
			emitTelemetry({} as Db, PREFIX, {
				meta: { agentId: AGENT_ID, operation: "search" },
				durationMs: 10,
				ok: true,
			})
		}).not.toThrow()
	})

	it("includes optional fields when provided", () => {
		emitTelemetry({} as Db, PREFIX, {
			meta: { agentId: AGENT_ID, operation: "search" },
			durationMs: 100,
			ok: true,
			pathUsed: "conversation-vector",
			resultCount: 5,
			topScore: 0.95,
			fusionMethod: "rrf",
		})

		const [doc] = vi.mocked(mockCol.insertOne).mock.calls[0]
		expect(doc).toEqual(
			expect.objectContaining({
				pathUsed: "conversation-vector",
				resultCount: 5,
				topScore: 0.95,
				fusionMethod: "rrf",
			}),
		)
	})

	it("omits optional fields when not provided", () => {
		emitTelemetry({} as Db, PREFIX, {
			meta: { agentId: AGENT_ID, operation: "cache-check" },
			durationMs: 5,
			ok: true,
		})

		const [doc] = vi.mocked(mockCol.insertOne).mock.calls[0]
		const d = doc as Record<string, unknown>
		expect(d.pathUsed).toBeUndefined()
		expect(d.resultCount).toBeUndefined()
		expect(d.topScore).toBeUndefined()
		expect(d.fusionMethod).toBeUndefined()
	})

	it("passes correct collection prefix", () => {
		emitTelemetry({} as Db, "prod_", {
			meta: { agentId: AGENT_ID, operation: "search" },
			durationMs: 10,
			ok: true,
		})

		expect(telemetryCollection).toHaveBeenCalledWith({}, "prod_")
	})
})

// ---------------------------------------------------------------------------
// getLatencyStats
// ---------------------------------------------------------------------------

describe("getLatencyStats", () => {
	let mockCol: Collection

	beforeEach(() => {
		vi.clearAllMocks()
		mockCol = createMockCollection()
		vi.mocked(telemetryCollection).mockReturnValue(mockCol)
	})

	it("returns percentiles from $percentile aggregation (M4 audit fix)", async () => {
		// M4: server-side $percentile returns arrays with one element per percentile
		const toArrayFn = vi.fn().mockResolvedValue([
			{
				_id: null,
				count: 10,
				p50: [55],
				p95: [95],
				p99: [99],
			},
		])
		vi.mocked(mockCol.aggregate).mockReturnValue({
			toArray: toArrayFn,
		} as never)

		const stats = await getLatencyStats({
			db: {} as Db,
			prefix: PREFIX,
			agentId: AGENT_ID,
		})

		expect(stats.count).toBe(10)
		expect(stats.p50).toBe(55)
		expect(stats.p95).toBe(95)
		expect(stats.p99).toBe(99)
	})

	it("uses $percentile in pipeline, not $push (M4 audit fix)", async () => {
		const toArrayFn = vi.fn().mockResolvedValue([])
		vi.mocked(mockCol.aggregate).mockReturnValue({
			toArray: toArrayFn,
		} as never)

		await getLatencyStats({ db: {} as Db, prefix: PREFIX, agentId: AGENT_ID })

		const [pipeline] = vi.mocked(mockCol.aggregate).mock.calls[0]
		const groupStage = (pipeline as Record<string, unknown>[])[1]
			.$group as Record<string, unknown>
		// Should NOT have $push durations
		expect(groupStage.durations).toBeUndefined()
		// Should have $percentile fields
		expect(groupStage.p50).toBeDefined()
		expect(
			(groupStage.p50 as Record<string, unknown>).$percentile,
		).toBeDefined()
	})

	it("returns zeros when no documents match", async () => {
		const toArrayFn = vi.fn().mockResolvedValue([])
		vi.mocked(mockCol.aggregate).mockReturnValue({
			toArray: toArrayFn,
		} as never)

		const stats = await getLatencyStats({
			db: {} as Db,
			prefix: PREFIX,
			agentId: AGENT_ID,
		})

		expect(stats).toEqual({ p50: 0, p95: 0, p99: 0, count: 0 })
	})

	it("filters by operation when provided", async () => {
		const toArrayFn = vi.fn().mockResolvedValue([])
		vi.mocked(mockCol.aggregate).mockReturnValue({
			toArray: toArrayFn,
		} as never)

		await getLatencyStats({
			db: {} as Db,
			prefix: PREFIX,
			agentId: AGENT_ID,
			operation: "search",
		})

		const [pipeline] = vi.mocked(mockCol.aggregate).mock.calls[0]
		const matchStage = (pipeline as Record<string, unknown>[])[0]
			.$match as Record<string, unknown>
		expect(matchStage["meta.operation"]).toBe("search")
	})

	it("respects windowMs parameter", async () => {
		const toArrayFn = vi.fn().mockResolvedValue([])
		vi.mocked(mockCol.aggregate).mockReturnValue({
			toArray: toArrayFn,
		} as never)

		const before = Date.now()
		await getLatencyStats({
			db: {} as Db,
			prefix: PREFIX,
			agentId: AGENT_ID,
			windowMs: 600_000, // 10 minutes
		})
		const after = Date.now()

		const [pipeline] = vi.mocked(mockCol.aggregate).mock.calls[0]
		const matchStage = (pipeline as Record<string, unknown>[])[0]
			.$match as Record<string, unknown>
		const tsFilter = matchStage.ts as { $gte: Date }
		// The $gte date should be approximately now - 600_000ms
		const sincMs = tsFilter.$gte.getTime()
		expect(sincMs).toBeGreaterThanOrEqual(before - 600_000 - 100)
		expect(sincMs).toBeLessThanOrEqual(after - 600_000 + 100)
	})

	it("does not include operation filter when not provided", async () => {
		const toArrayFn = vi.fn().mockResolvedValue([])
		vi.mocked(mockCol.aggregate).mockReturnValue({
			toArray: toArrayFn,
		} as never)

		await getLatencyStats({
			db: {} as Db,
			prefix: PREFIX,
			agentId: AGENT_ID,
		})

		const [pipeline] = vi.mocked(mockCol.aggregate).mock.calls[0]
		const matchStage = (pipeline as Record<string, unknown>[])[0]
			.$match as Record<string, unknown>
		expect(matchStage["meta.operation"]).toBeUndefined()
	})
})

// ---------------------------------------------------------------------------
// getCacheHitRate
// ---------------------------------------------------------------------------

describe("getCacheHitRate", () => {
	let mockCol: Collection

	beforeEach(() => {
		vi.clearAllMocks()
		mockCol = createMockCollection()
		vi.mocked(telemetryCollection).mockReturnValue(mockCol)
	})

	it("calculates correct hit rate", async () => {
		const toArrayFn = vi.fn().mockResolvedValue([
			{ _id: true, count: 7 },
			{ _id: false, count: 3 },
		])
		vi.mocked(mockCol.aggregate).mockReturnValue({
			toArray: toArrayFn,
		} as never)

		const result = await getCacheHitRate({
			db: {} as Db,
			prefix: PREFIX,
			agentId: AGENT_ID,
		})

		expect(result.hits).toBe(7)
		expect(result.misses).toBe(3)
		expect(result.total).toBe(10)
		expect(result.hitRate).toBeCloseTo(0.7)
	})

	it("returns zero rate when no data", async () => {
		const toArrayFn = vi.fn().mockResolvedValue([])
		vi.mocked(mockCol.aggregate).mockReturnValue({
			toArray: toArrayFn,
		} as never)

		const result = await getCacheHitRate({
			db: {} as Db,
			prefix: PREFIX,
			agentId: AGENT_ID,
		})

		expect(result).toEqual({ hitRate: 0, hits: 0, misses: 0, total: 0 })
	})

	it("handles only hits (no misses)", async () => {
		const toArrayFn = vi.fn().mockResolvedValue([{ _id: true, count: 5 }])
		vi.mocked(mockCol.aggregate).mockReturnValue({
			toArray: toArrayFn,
		} as never)

		const result = await getCacheHitRate({
			db: {} as Db,
			prefix: PREFIX,
			agentId: AGENT_ID,
		})

		expect(result.hitRate).toBe(1)
		expect(result.hits).toBe(5)
		expect(result.misses).toBe(0)
	})

	it("filters by cache-check operation", async () => {
		const toArrayFn = vi.fn().mockResolvedValue([])
		vi.mocked(mockCol.aggregate).mockReturnValue({
			toArray: toArrayFn,
		} as never)

		await getCacheHitRate({
			db: {} as Db,
			prefix: PREFIX,
			agentId: AGENT_ID,
		})

		const [pipeline] = vi.mocked(mockCol.aggregate).mock.calls[0]
		const matchStage = (pipeline as Record<string, unknown>[])[0]
			.$match as Record<string, unknown>
		expect(matchStage["meta.operation"]).toBe("cache-check")
	})
})

// ---------------------------------------------------------------------------
// getOperationDistribution
// ---------------------------------------------------------------------------

describe("getOperationDistribution", () => {
	let mockCol: Collection

	beforeEach(() => {
		vi.clearAllMocks()
		mockCol = createMockCollection()
		vi.mocked(telemetryCollection).mockReturnValue(mockCol)
	})

	it("groups by operation with count and avgDurationMs", async () => {
		const toArrayFn = vi.fn().mockResolvedValue([
			{ _id: "search", count: 10, avgDurationMs: 42.7 },
			{ _id: "cache-check", count: 8, avgDurationMs: 3.2 },
		])
		vi.mocked(mockCol.aggregate).mockReturnValue({
			toArray: toArrayFn,
		} as never)

		const result = await getOperationDistribution({
			db: {} as Db,
			prefix: PREFIX,
			agentId: AGENT_ID,
		})

		expect(result).toEqual([
			{ operation: "search", count: 10, avgDurationMs: 43 },
			{ operation: "cache-check", count: 8, avgDurationMs: 3 },
		])
	})

	it("returns empty array when no data", async () => {
		const toArrayFn = vi.fn().mockResolvedValue([])
		vi.mocked(mockCol.aggregate).mockReturnValue({
			toArray: toArrayFn,
		} as never)

		const result = await getOperationDistribution({
			db: {} as Db,
			prefix: PREFIX,
			agentId: AGENT_ID,
		})

		expect(result).toEqual([])
	})

	it("rounds avgDurationMs to integer", async () => {
		const toArrayFn = vi
			.fn()
			.mockResolvedValue([{ _id: "search", count: 1, avgDurationMs: 99.9 }])
		vi.mocked(mockCol.aggregate).mockReturnValue({
			toArray: toArrayFn,
		} as never)

		const result = await getOperationDistribution({
			db: {} as Db,
			prefix: PREFIX,
			agentId: AGENT_ID,
		})

		expect(result[0].avgDurationMs).toBe(100)
	})
})
