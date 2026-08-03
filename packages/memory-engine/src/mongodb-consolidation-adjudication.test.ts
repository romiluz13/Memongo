import type { Collection, Db } from "mongodb"
import { beforeEach, describe, expect, it, vi } from "vitest"

/**
 * P4.4 — unit tests for the consolidation-loop LLM adjudication helpers:
 *   - resolveConflictedCandidate (P4.4.2 contradiction wiring)
 *   - adjudicateFactMerge + foldSourceEventIds (P4.4.3 LLM-adjudicated dedup)
 *
 * The LLM seam (EnrichmentProvider) is a plain object here — no real HTTP.
 */

vi.mock("@memongo/lib", () => ({
	createSubsystemLogger: () => ({
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	}),
}))

const { detectContradictionsMock, invalidateContradictedFactsMock } =
	vi.hoisted(() => ({
		detectContradictionsMock: vi.fn(),
		invalidateContradictedFactsMock: vi.fn(),
	}))

vi.mock("./mongodb-contradiction.js", () => ({
	detectContradictions: detectContradictionsMock,
	invalidateContradictedFacts: invalidateContradictedFactsMock,
}))

function mockDbWithFacts(facts: Array<{ key: string; value: string }>): {
	db: Db
	structuredCol: Collection
	findMock: ReturnType<typeof vi.fn>
} {
	const findMock = vi.fn(() => ({
		sort: vi.fn(() => ({
			limit: vi.fn(() => ({
				toArray: vi.fn(async () => facts),
			})),
		})),
	}))
	const structuredCol = { find: findMock } as unknown as Collection
	const db = {
		collection: vi.fn(() => structuredCol),
	} as unknown as Db
	return { db, structuredCol, findMock }
}

beforeEach(() => {
	vi.clearAllMocks()
})

// ---------------------------------------------------------------------------
// adjudicateFactMerge (P4.4.3)
// ---------------------------------------------------------------------------

describe("adjudicateFactMerge", () => {
	const factA = { key: "city", value: "The user lives in Berlin" }
	const factB = {
		key: "city-detail",
		value: "The user lives in Berlin, Germany",
	}

	it("returns MERGE with the synthesized union text on a merge verdict", async () => {
		const { adjudicateFactMerge } = await import(
			"./mongodb-consolidation-adjudication.js"
		)
		const provider = {
			name: "stub",
			chatCompletion: vi.fn(async () => ({
				content: JSON.stringify({
					verdict: "MERGE",
					merged: "The user lives in Berlin, Germany",
				}),
			})),
		}

		const verdict = await adjudicateFactMerge({
			provider,
			model: "test-model",
			factA,
			factB,
		})

		expect(verdict).toEqual({
			verdict: "MERGE",
			mergedValue: "The user lives in Berlin, Germany",
		})
	})

	it("returns NO_MERGE on a no-merge verdict", async () => {
		const { adjudicateFactMerge } = await import(
			"./mongodb-consolidation-adjudication.js"
		)
		const provider = {
			name: "stub",
			chatCompletion: vi.fn(async () => ({
				content: JSON.stringify({ verdict: "NO_MERGE" }),
			})),
		}

		const verdict = await adjudicateFactMerge({
			provider,
			model: "test-model",
			factA: { key: "a", value: "The user likes tea" },
			factB: { key: "b", value: "The user runs daily" },
		})

		expect(verdict.verdict).toBe("NO_MERGE")
		expect(verdict.mergedValue).toBeUndefined()
	})

	it("treats malformed JSON as NO_MERGE and never throws", async () => {
		const { adjudicateFactMerge } = await import(
			"./mongodb-consolidation-adjudication.js"
		)
		const provider = {
			name: "stub",
			chatCompletion: vi.fn(async () => ({ content: "not json at all{" })),
		}

		const verdict = await adjudicateFactMerge({
			provider,
			model: "test-model",
			factA,
			factB,
		})

		expect(verdict.verdict).toBe("NO_MERGE")
	})

	it("treats an LLM failure as NO_MERGE and never throws", async () => {
		const { adjudicateFactMerge } = await import(
			"./mongodb-consolidation-adjudication.js"
		)
		const provider = {
			name: "stub",
			chatCompletion: vi.fn(async () => {
				throw new Error("connection reset")
			}),
		}

		await expect(
			adjudicateFactMerge({ provider, model: "test-model", factA, factB }),
		).resolves.toEqual({ verdict: "NO_MERGE" })
	})

	it("downgrades MERGE without union text to NO_MERGE", async () => {
		const { adjudicateFactMerge } = await import(
			"./mongodb-consolidation-adjudication.js"
		)
		const provider = {
			name: "stub",
			chatCompletion: vi.fn(async () => ({
				content: JSON.stringify({ verdict: "MERGE" }),
			})),
		}

		const verdict = await adjudicateFactMerge({
			provider,
			model: "test-model",
			factA,
			factB,
		})

		expect(verdict.verdict).toBe("NO_MERGE")
	})

	it("parses JSON wrapped in markdown code fences", async () => {
		const { adjudicateFactMerge } = await import(
			"./mongodb-consolidation-adjudication.js"
		)
		const provider = {
			name: "stub",
			chatCompletion: vi.fn(async () => ({
				content: `\`\`\`json\n{"verdict":"MERGE","merged":"union text"}\n\`\`\``,
			})),
		}

		const verdict = await adjudicateFactMerge({
			provider,
			model: "test-model",
			factA,
			factB,
		})

		expect(verdict).toEqual({ verdict: "MERGE", mergedValue: "union text" })
	})

	it("skips the LLM call when either fact has no text", async () => {
		const { adjudicateFactMerge } = await import(
			"./mongodb-consolidation-adjudication.js"
		)
		const provider = {
			name: "stub",
			chatCompletion: vi.fn(async () => ({
				content: JSON.stringify({ verdict: "MERGE", merged: "x" }),
			})),
		}

		const verdict = await adjudicateFactMerge({
			provider,
			model: "test-model",
			factA: { key: "a", value: "  " },
			factB,
		})

		expect(verdict.verdict).toBe("NO_MERGE")
		expect(provider.chatCompletion).not.toHaveBeenCalled()
	})
})

// ---------------------------------------------------------------------------
// foldSourceEventIds (P4.4.3 — proof-count analog)
// ---------------------------------------------------------------------------

describe("foldSourceEventIds", () => {
	it("unions and dedupes both sides", async () => {
		const { foldSourceEventIds } = await import(
			"./mongodb-consolidation-adjudication.js"
		)

		expect(foldSourceEventIds(["e1", "e2"], ["e2", "e3"])).toEqual([
			"e1",
			"e2",
			"e3",
		])
	})

	it("tolerates missing/non-array inputs", async () => {
		const { foldSourceEventIds } = await import(
			"./mongodb-consolidation-adjudication.js"
		)

		expect(foldSourceEventIds(undefined, ["e1"])).toEqual(["e1"])
		expect(foldSourceEventIds(null, undefined)).toEqual([])
	})

	it("caps the union at MAX_SOURCE_EVENT_IDS keeping the most recent", async () => {
		const { foldSourceEventIds, MAX_SOURCE_EVENT_IDS } = await import(
			"./mongodb-consolidation-adjudication.js"
		)
		const kept = Array.from({ length: 150 }, (_, i) => `k${i + 1}`)
		const mergedAway = Array.from({ length: 100 }, (_, i) => `d${i + 1}`)

		const folded = foldSourceEventIds(kept, mergedAway)

		expect(MAX_SOURCE_EVENT_IDS).toBe(200)
		expect(folded).toHaveLength(200)
		// Oldest entries drop off the front, mirroring mergeSourceEventIds.
		expect(folded[0]).toBe("k51")
		expect(folded[folded.length - 1]).toBe("d100")
	})
})

// ---------------------------------------------------------------------------
// resolveConflictedCandidate (P4.4.2)
// ---------------------------------------------------------------------------

describe("resolveConflictedCandidate", () => {
	const provider = { name: "stub", chatCompletion: vi.fn() }

	it("detects, invalidates the losing side, then reports resolved (ordering asserted)", async () => {
		const { resolveConflictedCandidate } = await import(
			"./mongodb-consolidation-adjudication.js"
		)
		const { db, findMock } = mockDbWithFacts([
			{ key: "city", value: "The user lives in London" },
		])
		detectContradictionsMock.mockResolvedValueOnce([
			{ contradictedKey: "city", rationale: "cannot live in two cities" },
		])
		invalidateContradictedFactsMock.mockResolvedValueOnce(1)

		const result = await resolveConflictedCandidate({
			db,
			prefix: "test_",
			provider,
			model: "test-model",
			agentId: "agent-1",
			candidate: {
				key: "city-now",
				value: "The user lives in Berlin",
				scope: "agent",
				scopeRef: "agent:agent-1",
			},
			runId: "run-1",
		})

		expect(result).toEqual({ resolved: true, invalidatedCount: 1 })
		// detect ran against the tenant-scoped existing facts...
		expect(findMock).toHaveBeenCalledWith(
			expect.objectContaining({
				agentId: "agent-1",
				scope: "agent",
				scopeRef: "agent:agent-1",
				type: "fact",
				state: "active",
			}),
			expect.anything(),
		)
		expect(detectContradictionsMock).toHaveBeenCalledWith(
			expect.objectContaining({
				newFact: { key: "city-now", value: "The user lives in Berlin" },
				existingFacts: [{ key: "city", value: "The user lives in London" }],
			}),
		)
		expect(invalidateContradictedFactsMock).toHaveBeenCalledWith(
			expect.objectContaining({
				agentId: "agent-1",
				scope: "agent",
				scopeRef: "agent:agent-1",
				newFacts: [{ key: "city-now", value: "The user lives in Berlin" }],
				runId: "run-1",
			}),
		)
		// detect → invalidate ordering
		expect(detectContradictionsMock.mock.invocationCallOrder[0]).toBeLessThan(
			invalidateContradictedFactsMock.mock.invocationCallOrder[0],
		)
	})

	it("does not invalidate anything when the candidate is the loser (no findings)", async () => {
		const { resolveConflictedCandidate } = await import(
			"./mongodb-consolidation-adjudication.js"
		)
		const { db } = mockDbWithFacts([
			{ key: "city", value: "The user lives in London" },
		])
		detectContradictionsMock.mockResolvedValueOnce([])

		const result = await resolveConflictedCandidate({
			db,
			prefix: "test_",
			provider,
			model: "test-model",
			agentId: "agent-1",
			candidate: { key: "city-now", value: "The user visited London once" },
		})

		expect(result).toEqual({ resolved: false, invalidatedCount: 0 })
		expect(invalidateContradictedFactsMock).not.toHaveBeenCalled()
	})

	it("short-circuits without an LLM call when there is nothing to compare against", async () => {
		const { resolveConflictedCandidate } = await import(
			"./mongodb-consolidation-adjudication.js"
		)
		const { db } = mockDbWithFacts([])

		const result = await resolveConflictedCandidate({
			db,
			prefix: "test_",
			provider,
			model: "test-model",
			agentId: "agent-1",
			candidate: { key: "city", value: "The user lives in Berlin" },
		})

		expect(result).toEqual({ resolved: false, invalidatedCount: 0 })
		expect(detectContradictionsMock).not.toHaveBeenCalled()
		expect(invalidateContradictedFactsMock).not.toHaveBeenCalled()
	})

	it("defaults scope/scopeRef to the agent tenant when the candidate has none", async () => {
		const { resolveConflictedCandidate } = await import(
			"./mongodb-consolidation-adjudication.js"
		)
		const { db, findMock } = mockDbWithFacts([
			{ key: "city", value: "The user lives in London" },
		])
		detectContradictionsMock.mockResolvedValueOnce([
			{ contradictedKey: "city", rationale: "r" },
		])
		invalidateContradictedFactsMock.mockResolvedValueOnce(1)

		await resolveConflictedCandidate({
			db,
			prefix: "test_",
			provider,
			model: "test-model",
			agentId: "agent-1",
			candidate: { key: "city-now", value: "The user lives in Berlin" },
		})

		expect(findMock).toHaveBeenCalledWith(
			expect.objectContaining({ scope: "agent", scopeRef: "agent:agent-1" }),
			expect.anything(),
		)
		expect(invalidateContradictedFactsMock).toHaveBeenCalledWith(
			expect.objectContaining({ scope: "agent", scopeRef: "agent:agent-1" }),
		)
	})

	it("degrades to unresolved (never throws) when the store read fails", async () => {
		const { resolveConflictedCandidate } = await import(
			"./mongodb-consolidation-adjudication.js"
		)
		const db = {
			collection: vi.fn(() => {
				throw new Error("db down")
			}),
		} as unknown as Db

		await expect(
			resolveConflictedCandidate({
				db,
				prefix: "test_",
				provider,
				model: "test-model",
				agentId: "agent-1",
				candidate: { key: "k", value: "v" },
			}),
		).resolves.toEqual({ resolved: false, invalidatedCount: 0 })
	})
})
