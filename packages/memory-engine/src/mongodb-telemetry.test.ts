/* eslint-disable @typescript-eslint/unbound-method -- Vitest mock method assertions */
import type { ClientSession, Collection, Db } from "mongodb"
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

// ---------------------------------------------------------------------------
// Mock mongodb-schema before importing module under test
// ---------------------------------------------------------------------------

vi.mock("./mongodb-schema.js", () => ({
	telemetryCollection: vi.fn(),
}))

vi.mock("./mongodb-write-fence.js", () => ({
	captureAdmissionToken: vi.fn(async ({ agentId }: { agentId: string }) => ({
		kind: "admission",
		agentId,
		epoch: 0,
	})),
	ErasureGateConflictError: class extends Error {
		readonly code = "ERASURE_GATE_CONFLICT"
	},
	withFencedWrite: vi.fn(
		async ({ fn }: { fn: (session: ClientSession) => Promise<void> }) =>
			fn({} as ClientSession),
	),
}))
import {
	captureAdmissionToken,
	withFencedWrite,
} from "./mongodb-write-fence.js"
const fakeDb = {
	listCollections: vi.fn(() => ({
		toArray: vi.fn(async () => [{ type: "collection" }]),
	})),
} as unknown as Db
const drainEmission = () =>
	new Promise<void>((resolve) => setImmediate(resolve))

import { telemetryCollection } from "./mongodb-schema.js"
import {
	emitTelemetry,
	getLatencyStats,
	getOperationDistribution,
	resolveTelemetrySampling,
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

	it("calls insertOne with correct document shape", async () => {
		emitTelemetry(fakeDb, PREFIX, {
			meta: { agentId: AGENT_ID, operation: "search" },
			durationMs: 42,
			ok: true,
		})

		await drainEmission()
		expect(mockCol.insertOne).toHaveBeenCalledOnce()
		await drainEmission()
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

	it("adds ts field automatically", async () => {
		const before = Date.now()
		emitTelemetry(fakeDb, PREFIX, {
			meta: { agentId: AGENT_ID, operation: "event-write" },
			durationMs: 10,
			ok: true,
		})
		const after = Date.now()

		await drainEmission()
		const [doc] = vi.mocked(mockCol.insertOne).mock.calls[0]
		const ts = (doc as Record<string, unknown>).ts as Date
		expect(ts.getTime()).toBeGreaterThanOrEqual(before)
		expect(ts.getTime()).toBeLessThanOrEqual(after)
	})

	it("does not throw on insertOne failure", async () => {
		vi.mocked(mockCol.insertOne).mockReturnValue(
			Promise.reject(new Error("Write failed")) as never,
		)

		// Should not throw
		expect(() => {
			emitTelemetry(fakeDb, PREFIX, {
				meta: { agentId: AGENT_ID, operation: "search" },
				durationMs: 10,
				ok: true,
			})
		}).not.toThrow()
		await drainEmission()
	})

	it("includes optional fields when provided", async () => {
		emitTelemetry(fakeDb, PREFIX, {
			meta: { agentId: AGENT_ID, operation: "search" },
			durationMs: 100,
			ok: true,
			pathUsed: "conversation-vector",
			resultCount: 5,
			topScore: 0.95,
			fusionMethod: "rrf",
		})

		await drainEmission()
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

	it("omits optional fields when not provided", async () => {
		emitTelemetry(fakeDb, PREFIX, {
			meta: { agentId: AGENT_ID, operation: "cache-check" },
			durationMs: 5,
			ok: true,
		})

		await drainEmission()
		const [doc] = vi.mocked(mockCol.insertOne).mock.calls[0]
		const d = doc as Record<string, unknown>
		expect(d.pathUsed).toBeUndefined()
		expect(d.resultCount).toBeUndefined()
		expect(d.topScore).toBeUndefined()
		expect(d.fusionMethod).toBeUndefined()
	})

	it("passes correct collection prefix", async () => {
		emitTelemetry(fakeDb, "prod_", {
			meta: { agentId: AGENT_ID, operation: "search" },
			durationMs: 10,
			ok: true,
		})

		await drainEmission()
		expect(telemetryCollection).toHaveBeenCalledWith(fakeDb, "prod_")
	})

	it("returns an awaited session-bound write for fenced diagnostics", async () => {
		const session = {} as ClientSession
		let resolveInsert: (() => void) | undefined
		const insertPending = new Promise<void>((resolve) => {
			resolveInsert = resolve
		})
		vi.mocked(mockCol.insertOne).mockReturnValueOnce(insertPending as never)

		const emission = emitTelemetry(
			fakeDb,
			PREFIX,
			{
				meta: { agentId: AGENT_ID, operation: "entity-extraction" },
				durationMs: 12,
				ok: true,
			},
			{ session },
		)
		expect(emission).toBeInstanceOf(Promise)
		expect(mockCol.insertOne).toHaveBeenCalledWith(expect.any(Object), {
			session,
		})

		let settled = false
		void emission.then(() => {
			settled = true
		})
		await Promise.resolve()
		expect(settled).toBe(false)

		resolveInsert?.()
		await emission
		expect(settled).toBe(true)
	})

	it("rejects a session-bound write so its diagnostic transaction aborts", async () => {
		const failure = new Error("diagnostic insert failed")
		vi.mocked(mockCol.insertOne).mockRejectedValueOnce(failure)

		await expect(
			emitTelemetry(
				fakeDb,
				PREFIX,
				{
					meta: { agentId: AGENT_ID, operation: "entity-extraction" },
					durationMs: 12,
					ok: false,
				},
				{ session: {} as ClientSession },
			),
		).rejects.toBe(failure)
	})

	it("uses supplied admission without capturing a new intent", async () => {
		const admission = {
			kind: "admission" as const,
			agentId: AGENT_ID,
			epoch: 37,
		}
		await emitTelemetry(
			fakeDb,
			PREFIX,
			{
				meta: { agentId: AGENT_ID, operation: "search" },
				durationMs: 1,
				ok: true,
			},
			{ admission },
		)
		expect(captureAdmissionToken).not.toHaveBeenCalled()
		expect(withFencedWrite).toHaveBeenCalledWith(
			expect.objectContaining({ token: admission }),
		)
	})
	it("captures legacy admission at invocation", async () => {
		emitTelemetry(fakeDb, PREFIX, {
			meta: { agentId: AGENT_ID, operation: "search" },
			durationMs: 1,
			ok: true,
		})
		expect(captureAdmissionToken).toHaveBeenCalledWith({
			db: fakeDb,
			prefix: PREFIX,
			agentId: AGENT_ID,
		})
		await drainEmission()
	})
	it("rejects sink inspection failure without opening a fence", async () => {
		const failure = new Error("private rejected command body")
		const db = {
			listCollections: vi.fn(() => ({
				toArray: vi.fn().mockRejectedValue(failure),
			})),
		} as unknown as Db
		await expect(
			emitTelemetry(
				db,
				PREFIX,
				{
					meta: { agentId: AGENT_ID, operation: "search" },
					durationMs: 1,
					ok: true,
				},
				{ admission: { kind: "admission", agentId: AGENT_ID, epoch: 0 } },
			),
		).rejects.toBe(failure)
		expect(withFencedWrite).not.toHaveBeenCalled()
		expect(mockCol.insertOne).not.toHaveBeenCalled()
	})
	it("disabled admitted emissions never inspect or capture", async () => {
		vi.stubEnv("MEMONGO_TELEMETRY_ENABLED", "false")
		try {
			const db = { listCollections: vi.fn() } as unknown as Db
			await emitTelemetry(
				db,
				PREFIX,
				{
					meta: { agentId: AGENT_ID, operation: "search" },
					durationMs: 1,
					ok: true,
				},
				{ admission: { kind: "admission", agentId: AGENT_ID, epoch: 0 } },
			)
			expect(db.listCollections).not.toHaveBeenCalled()
			expect(captureAdmissionToken).not.toHaveBeenCalled()
			expect(withFencedWrite).not.toHaveBeenCalled()
			expect(mockCol.insertOne).not.toHaveBeenCalled()
		} finally {
			vi.unstubAllEnvs()
		}
	})

	describe("sampling controls (08-report fleet audit)", () => {
		const previousEnabled = process.env.MEMONGO_TELEMETRY_ENABLED
		const previousRate = process.env.MEMONGO_TELEMETRY_SAMPLE_RATE

		const emitOnce = () =>
			emitTelemetry(fakeDb, PREFIX, {
				meta: { agentId: AGENT_ID, operation: "search" },
				durationMs: 10,
				ok: true,
			})

		afterEach(() => {
			if (previousEnabled === undefined) {
				delete process.env.MEMONGO_TELEMETRY_ENABLED
			} else {
				process.env.MEMONGO_TELEMETRY_ENABLED = previousEnabled
			}
			if (previousRate === undefined) {
				delete process.env.MEMONGO_TELEMETRY_SAMPLE_RATE
			} else {
				process.env.MEMONGO_TELEMETRY_SAMPLE_RATE = previousRate
			}
		})

		it("kill switch: ENABLED=false never touches the driver", () => {
			process.env.MEMONGO_TELEMETRY_ENABLED = "false"
			emitOnce()
			expect(telemetryCollection).not.toHaveBeenCalled()
			expect(mockCol.insertOne).not.toHaveBeenCalled()
		})

		it("kill switch accepts 0/off/no aliases", () => {
			for (const disabled of ["0", "off", "no"]) {
				vi.clearAllMocks()
				process.env.MEMONGO_TELEMETRY_ENABLED = disabled
				emitOnce()
				expect(mockCol.insertOne).not.toHaveBeenCalled()
			}
		})

		it("sample rate 0 drops every emit without touching the driver", () => {
			process.env.MEMONGO_TELEMETRY_SAMPLE_RATE = "0"
			emitOnce()
			expect(telemetryCollection).not.toHaveBeenCalled()
			expect(mockCol.insertOne).not.toHaveBeenCalled()
		})

		it("default (unset) emits every document", async () => {
			delete process.env.MEMONGO_TELEMETRY_ENABLED
			delete process.env.MEMONGO_TELEMETRY_SAMPLE_RATE
			for (let i = 0; i < 10; i++) {
				emitOnce()
			}
			await drainEmission()
			expect(mockCol.insertOne).toHaveBeenCalledTimes(10)
		})

		it("sample rate 1 emits every document", async () => {
			process.env.MEMONGO_TELEMETRY_SAMPLE_RATE = "1"
			for (let i = 0; i < 10; i++) {
				emitOnce()
			}
			await drainEmission()
			expect(mockCol.insertOne).toHaveBeenCalledTimes(10)
		})

		it("sample rate 0.5 emits a subset within statistical bounds", async () => {
			process.env.MEMONGO_TELEMETRY_SAMPLE_RATE = "0.5"
			for (let i = 0; i < 500; i++) {
				emitOnce()
			}
			await drainEmission()
			const emitted = vi.mocked(mockCol.insertOne).mock.calls.length
			// 500 Bernoulli(0.5) trials: P(outside 40..60%) < 1e-5
			expect(emitted).toBeGreaterThan(150)
			expect(emitted).toBeLessThan(350)
		})

		it("invalid rate falls back to full emission (telemetry fails open)", async () => {
			process.env.MEMONGO_TELEMETRY_SAMPLE_RATE = "banana"
			for (let i = 0; i < 10; i++) {
				emitOnce()
			}
			await drainEmission()
			expect(mockCol.insertOne).toHaveBeenCalledTimes(10)
		})

		it("resolveTelemetrySampling parses env values and defaults", () => {
			expect(resolveTelemetrySampling({})).toEqual({
				enabled: true,
				sampleRate: 1,
			})
			expect(
				resolveTelemetrySampling({ MEMONGO_TELEMETRY_ENABLED: "FALSE " }),
			).toEqual({ enabled: false, sampleRate: 1 })
			expect(
				resolveTelemetrySampling({
					MEMONGO_TELEMETRY_ENABLED: "true",
					MEMONGO_TELEMETRY_SAMPLE_RATE: " 0.25 ",
				}),
			).toEqual({ enabled: true, sampleRate: 0.25 })
			expect(
				resolveTelemetrySampling({ MEMONGO_TELEMETRY_SAMPLE_RATE: "1.5" }),
			).toEqual({ enabled: true, sampleRate: 1 })
			expect(
				resolveTelemetrySampling({ MEMONGO_TELEMETRY_SAMPLE_RATE: "-0.1" }),
			).toEqual({ enabled: true, sampleRate: 1 })
			expect(
				resolveTelemetrySampling({ MEMONGO_TELEMETRY_SAMPLE_RATE: "" }),
			).toEqual({ enabled: true, sampleRate: 1 })
		})
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
