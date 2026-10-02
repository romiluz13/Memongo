import type { Db } from "mongodb"
import { MongoServerError } from "mongodb"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
	getLatencyStats,
	getOperationDistribution,
} from "./mongodb-telemetry.js"
import {
	getDailyCostSums,
	recordEmbeddingSpend,
} from "./mongodb-cost-ledger.js"

vi.mock("./mongodb-write-fence.js", async () =>
	(await import("./test-helpers/manager-test-kit.js")).writeFenceModuleMock(),
)

const privateText = "violet confidential launch plan CANARY90"
afterEach(() => vi.restoreAllMocks())

describe("diagnostic persistence failure privacy", () => {
	it.each([
		"latency",
		"distribution",
		"cost-async",
		"cost-sync",
		"cost-daily",
	])("preserves %s fallback without serializing driver error content", async (channel) => {
		const error = new MongoServerError({
			errmsg: privateText,
			code: 2,
			codeName: privateText,
		})
		const lines: string[] = []
		vi.spyOn(console, "warn").mockImplementation((...args) =>
			lines.push(args.join(" ")),
		)
		const fail = () => {
			throw error
		}
		const db = {
			collection: () => ({
				aggregate: () => ({ toArray: async () => fail() }),
				updateOne: channel === "cost-sync" ? fail : async () => fail(),
			}),
		} as unknown as Db
		if (channel === "latency")
			expect(
				await getLatencyStats({ db, prefix: "test_", agentId: "a1" }),
			).toEqual({ p50: 0, p95: 0, p99: 0, count: 0 })
		else if (channel === "distribution")
			expect(
				await getOperationDistribution({ db, prefix: "test_", agentId: "a1" }),
			).toEqual([])
		else if (channel === "cost-daily")
			expect(await getDailyCostSums(db, "test_", "a1", 1)).toEqual([])
		else {
			expect(
				recordEmbeddingSpend(db, "test_", "a1", "search", 1),
			).toBeUndefined()
			await new Promise<void>((resolve) => setImmediate(resolve))
		}
		expect(lines).toHaveLength(1)
		expect(lines[0]).not.toContain(privateText)
		expect(lines[0]).toContain('"code":2')
		expect(lines[0]).not.toContain("errorResponse")
		expect(lines[0]).not.toContain("queryDigest")
	})
	it("does not invoke error getters or primitive conversion", async () => {
		const poison = vi.fn(() => {
			throw new Error("must not inspect private error")
		})
		const error = Object.defineProperties(
			{ [Symbol.toPrimitive]: poison },
			{
				code: { get: poison },
				message: { get: poison },
				name: { get: poison },
			},
		)
		const lines: string[] = []
		vi.spyOn(console, "warn").mockImplementation((...args) =>
			lines.push(args.join(" ")),
		)
		const db = {
			collection: () => ({
				aggregate: () => ({
					toArray: async () => {
						throw error
					},
				}),
			}),
		} as unknown as Db
		expect(
			await getOperationDistribution({ db, prefix: "test_", agentId: "a1" }),
		).toEqual([])
		expect(poison).not.toHaveBeenCalled()
		expect(lines).toHaveLength(1)
		expect(lines[0]).not.toContain('"code"')
	})
})
