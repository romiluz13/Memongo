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
		const relevant = warnings.filter(
			(x) =>
				x.includes(
					seam === "lane"
						? "searchV2 lane failed"
						: "searchV2 exact procedural backstop failed",
				) ||
				(seam === "lane" && x.includes("searchV2 structured failed")),
		)
		expect(relevant).toHaveLength(1)
		expect(relevant[0]).not.toContain(privateText)
		expect(relevant[0].length).toBeLessThan(250)
		expect(relevant[0]).not.toContain("queryDigest")
		if (kind === "driver") expect(relevant[0]).toContain('"code":2')
		expect(poison).not.toHaveBeenCalled()
		if (seam === "lane") {
			expect(onPathFailure).toHaveBeenCalledWith("structured", err)
			expect(result.metadata.laneOutcomes).toContainEqual({
				lane: "structured",
				status: "failed",
				error: err.message,
			})
		} else expect(onPathFailure).not.toHaveBeenCalled()
	})
	it(`${seam} strict mode preserves original error`, async () => {
		vi.stubEnv("MEMONGO_BENCHMARK_STRICT", "true")
		const err = new Error(privateText)
		if (seam === "lane")
			vi.mocked(searchStructuredMemory).mockRejectedValue(err)
		else vi.mocked(findExactProcedureMatches).mockRejectedValue(err)
		vi.spyOn(console, "warn").mockImplementation(() => {})
		vi.spyOn(console, "error").mockImplementation(() => {})
		await expect(
			searchV2({} as Db, "test_", "ordinary question", "agent-1", {
				availablePaths: new Set(
					seam === "lane" ? ["structured"] : ["structured", "procedural"],
				),
			}),
		).rejects.toBe(err)
	})
}
