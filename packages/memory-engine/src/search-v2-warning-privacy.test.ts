import type { Db } from "mongodb"
import { MongoServerError } from "mongodb"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
vi.mock("./mongodb-telemetry.js", () => ({
	emitTelemetry: vi.fn().mockResolvedValue(undefined),
}))
vi.mock("./mongodb-lane-coverage.js", () => ({
	getLaneCoverage: vi.fn().mockResolvedValue(null),
}))
vi.mock("./mongodb-retrieval-planner.js", async (original) => ({
	...(await original<typeof import("./mongodb-retrieval-planner.js")>()),
	planRetrieval: vi.fn(() => ({
		paths: ["structured"],
		confidence: "high",
		reasoning: "owned fixture",
	})),
}))
vi.mock("./mongodb-schema.js", async (original) => ({
	...(await original<typeof import("./mongodb-schema.js")>()),
	structuredMemCollection: vi.fn(() => ({})),
	proceduresCollection: vi.fn(() => ({})),
}))
vi.mock("./mongodb-structured-memory.js", async (original) => ({
	...(await original<typeof import("./mongodb-structured-memory.js")>()),
	searchStructuredMemory: vi.fn(),
}))
vi.mock("./mongodb-procedures.js", async (original) => ({
	...(await original<typeof import("./mongodb-procedures.js")>()),
	findExactProcedureMatches: vi.fn(),
	searchProcedures: vi.fn().mockResolvedValue([]),
}))
import { searchV2 } from "./mongodb-search-v2.js"
import { searchStructuredMemory } from "./mongodb-structured-memory.js"
import { findExactProcedureMatches } from "./mongodb-procedures.js"
import { resetSearchAdmissionForTests } from "./mongodb-search-admission.js"
import { SearchLaneError } from "./search-outcomes.js"
const privateText = "CANARY164 confidential project and medical details"
beforeEach(() => {
	vi.clearAllMocks()
	vi.stubEnv("MEMONGO_BENCHMARK_STRICT", "false")
	vi.stubEnv("MEMONGO_CONVERSATION_EVIDENCE_MODE", "disabled")
	resetSearchAdmissionForTests(Date.now())
	vi.mocked(searchStructuredMemory).mockResolvedValue([])
	vi.mocked(findExactProcedureMatches).mockResolvedValue([])
})
afterEach(() => {
	vi.restoreAllMocks()
	vi.unstubAllEnvs()
})
for (const seam of ["lane", "exact-backstop"] as const) {
	it.each([
		"driver",
		"poison",
		"long",
	] as const)(`${seam} %s preserves behavior without raw warning content`, async (kind) => {
		const poison = vi.fn(() => {
			throw new Error("private conversion must not run")
		})
		const err =
			kind === "driver"
				? new MongoServerError({
						errmsg: privateText,
						code: 2,
						codeName: privateText,
					})
				: new Error(
						kind === "long" ? privateText + "x".repeat(10000) : privateText,
					)
		if (kind === "poison")
			Object.defineProperty(err, Symbol.toPrimitive, { value: poison })
		const warnings: string[] = []
		vi.spyOn(console, "warn").mockImplementation((...args) =>
			warnings.push(args.join(" ")),
		)
		const onPathFailure = vi.fn()
		if (seam === "lane")
			vi.mocked(searchStructuredMemory).mockRejectedValue(err)
		else vi.mocked(findExactProcedureMatches).mockRejectedValue(err)
		const result = await searchV2(
			{} as Db,
			"test_",
			"ordinary question",
			"agent-1",
			{
				availablePaths: new Set(
					seam === "lane" ? ["structured"] : ["structured", "procedural"],
				),
				onPathFailure,
			},
		)
		expect(result.results).toEqual([])
		const lane = seam === "lane" ? "structured" : "backstop:procedural-exact"
		const relevant = warnings.filter((x) => x.includes("searchV2 lane failed"))
		expect(relevant).toHaveLength(1)
		expect(relevant[0]).toContain(`"lane":"${lane}"`)
		expect(relevant[0]).not.toContain(privateText)
		expect(relevant[0].length).toBeLessThan(250)
		expect(relevant[0]).not.toContain("queryDigest")
		if (kind === "driver") expect(relevant[0]).toContain('"code":2')
		expect(poison).not.toHaveBeenCalled()
		expect(onPathFailure).toHaveBeenCalledOnce()
		const [hookLane, hookErr] = onPathFailure.mock.calls[0] as [string, Error]
		expect(hookLane).toBe(lane)
		expect(hookErr).toBeInstanceOf(SearchLaneError)
		expect(hookErr.cause).toBe(err)
		expect(hookErr.message).not.toContain(privateText)
		expect(result.metadata.laneOutcomes).toContainEqual({
			lane,
			stage: "lane",
			outcome: "failed",
			reason: kind === "driver" ? "query-error" : "internal-error",
		})
		expect(JSON.stringify(result.metadata.laneOutcomes)).not.toContain(
			privateText,
		)
	})
	it(`${seam} strict mode throws typed with the original as cause`, async () => {
		vi.stubEnv("MEMONGO_BENCHMARK_STRICT", "true")
		const err = new Error(privateText)
		if (seam === "lane")
			vi.mocked(searchStructuredMemory).mockRejectedValue(err)
		else vi.mocked(findExactProcedureMatches).mockRejectedValue(err)
		vi.spyOn(console, "warn").mockImplementation(() => {})
		vi.spyOn(console, "error").mockImplementation(() => {})
		const failure = await searchV2(
			{} as Db,
			"test_",
			"ordinary question",
			"agent-1",
			{
				availablePaths: new Set(
					seam === "lane" ? ["structured"] : ["structured", "procedural"],
				),
			},
		).catch((caught: unknown) => caught)
		expect(failure).toBeInstanceOf(SearchLaneError)
		expect((failure as Error).cause).toBe(err)
		expect((failure as Error).message).not.toContain(privateText)
	})
}
