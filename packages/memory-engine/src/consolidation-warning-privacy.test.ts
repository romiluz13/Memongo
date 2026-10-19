import type { Db } from "mongodb"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
	adjudicateFactMerge,
	prepareConflictedCandidateResolution,
	resolveConflictedCandidate,
} from "./mongodb-consolidation-adjudication.js"
import { deduceFactsFromMemories } from "./mongodb-consolidation-reasoning.js"
import type { EnrichmentProvider } from "./mongodb-llm-enrichment.js"
import type { AdmissionToken } from "./mongodb-erasure-epoch.js"

const contradiction = vi.hoisted(() => vi.fn())
vi.mock("./mongodb-contradiction.js", () => ({
	detectContradictions: contradiction,
	invalidateContradictedFacts: vi.fn(),
	prepareContradictionInvalidations: vi.fn(),
	persistPreparedContradictionInvalidations: vi.fn(),
}))
const privateText = "PRIVATE181 medical and project facts"
const db = {
	collection: () => ({
		find: () => ({
			sort: () => ({
				limit: () => ({
					toArray: async () => [{ key: "old", value: "existing fact" }],
				}),
			}),
		}),
	}),
} as unknown as Db
function params(error: unknown) {
	const provider: EnrichmentProvider = {
		name: "owned-stub",
		chatCompletion: vi.fn(async () => {
			throw error
		}),
	}
	return {
		db,
		prefix: "test_",
		provider,
		model: "fixture",
		agentId: "agent-1",
		candidate: { key: "new", value: "candidate fact" },
	}
}
const seams = [
	{
		name: "resolution",
		call: (error: unknown) => resolveConflictedCandidate(params(error)),
	},
	{
		name: "preparation",
		call: (error: unknown) =>
			prepareConflictedCandidateResolution(params(error)),
	},
	{
		name: "merge",
		call: (error: unknown) =>
			adjudicateFactMerge({
				...params(error),
				factA: { key: "a", value: "fact A" },
				factB: { key: "b", value: "fact B" },
			}),
	},
	{
		name: "reasoning",
		call: (error: unknown) =>
			deduceFactsFromMemories({
				...params(error),
				facts: ["fact A", "fact B"],
			}),
	},
]
beforeEach(() => {
	vi.clearAllMocks()
	vi.stubEnv("MEMONGO_LOG_LEVEL", "warn")
})
afterEach(() => {
	vi.restoreAllMocks()
	vi.unstubAllEnvs()
})
describe.each(seams)("$name failure warning", (seam) => {
	it.each([
		"private",
		"symbol",
		"toString",
		"message",
		"numeric-code",
		"string-code",
	])("rejects with the original %s error and logs no memory content", async (kind) => {
		const poison = vi.fn(() => {
			throw new Error("conversion must not run")
		})
		let error: unknown = new Error(privateText)
		if (kind === "symbol") error = Symbol(privateText)
		if (kind === "toString") error = { toString: poison }
		if (kind === "message")
			Object.defineProperty(error, "message", { get: poison })
		if (kind === "numeric-code") error = { message: privateText, code: 503 }
		if (kind === "string-code")
			error = { message: privateText, code: privateText }
		contradiction.mockRejectedValue(error)
		const lines: string[] = []
		vi.spyOn(console, "warn").mockImplementation((...args) => {
			lines.push(args.join(" "))
		})
		await expect(seam.call(error)).rejects.toBe(error)
		for (const line of lines) {
			expect(line).not.toContain(privateText)
		}
		expect(poison).not.toHaveBeenCalled()
	})
})
it.each([
	resolveConflictedCandidate,
	prepareConflictedCandidateResolution,
])("preserves admission-bound failure identity", async (call) => {
	const error = new Error(privateText)
	contradiction.mockRejectedValue(error)
	await expect(
		call({ ...params(error), admission: {} as AdmissionToken }),
	).rejects.toBe(error)
})
