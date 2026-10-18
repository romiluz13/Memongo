import { beforeEach, describe, expect, it, vi } from "vitest"

// #101 / decision 16 (matrix section 4 step 6): the bridge search accessors
// carry the engine's per-call outcome summary out with the results. The
// engine fires its onOutcomes sink once per call (proved at the engine seam
// in mongodb-manager-search-outcomes.test.ts); the bridge must capture it in
// a call-local closure, return it, and never swallow a typed failure.

const search = vi.fn()
const searchKB = vi.fn()

vi.mock("@memongo/memory-engine", () => ({
	getMemorySearchManager: vi.fn(async ({ agentId }: { agentId: string }) => ({
		manager: { agentId, search, searchKB },
		error: null,
	})),
	closeAllMemorySearchManagers: vi.fn(),
}))

vi.mock("@memongo/memory-engine/internal", () => ({
	materializeBlocks: vi.fn(),
}))

vi.mock("./memory-config.js", () => ({
	resolveBridgeConfig: vi.fn(() => ({})),
}))

import type { SearchOutcomeSummary } from "./memongo-bridge.js"
import {
	memongoBridgeSearchKBWithDegradation,
	memongoBridgeSearchWithDegradation,
} from "./memongo-bridge.js"

type Sinks = {
	onOutcomes?: (outcomes: SearchOutcomeSummary) => void
	onDegradation?: (degradation: unknown) => void
}

const PARTIAL: SearchOutcomeSummary = {
	status: "partial",
	lanes: [
		{
			lane: "structured",
			stage: "lane",
			outcome: "ok-empty",
			reason: "zero-hits",
		},
		{
			lane: "procedural",
			stage: "lane",
			outcome: "failed",
			reason: "query-error",
		},
	],
}

const FAILED: SearchOutcomeSummary = {
	status: "failed",
	lanes: [
		{
			lane: "structured",
			stage: "lane",
			outcome: "failed",
			reason: "lane-unavailable",
		},
	],
}

beforeEach(() => {
	search.mockReset()
	searchKB.mockReset()
})

describe("bridge search outcome passthrough (#101)", () => {
	it("returns the summary the engine fired for a partial empty answer", async () => {
		search.mockImplementation(async (_q: string, opts: Sinks) => {
			opts.onOutcomes?.(PARTIAL)
			return []
		})

		const out = await memongoBridgeSearchWithDegradation({ query: "q" })

		expect(out).toEqual({ results: [], outcomes: PARTIAL })
		expect(search).toHaveBeenCalledTimes(1)
	})

	it("returns a failed summary from a non-throwing failed call", async () => {
		search.mockImplementation(async (_q: string, opts: Sinks) => {
			opts.onOutcomes?.(FAILED)
			return []
		})

		const out = await memongoBridgeSearchWithDegradation({ query: "q" })

		expect(out).toEqual({ results: [], outcomes: FAILED })
	})

	it("keeps a throttled answer on its degradation marker without an outcome summary", async () => {
		search.mockImplementation(async (_q: string, opts: Sinks) => {
			opts.onDegradation?.({
				kind: "throttled",
				scope: "denied",
				retryAfterMs: 100,
			})
			return []
		})

		const out = await memongoBridgeSearchWithDegradation({ query: "q" })

		expect(out).toEqual({
			results: [],
			degradation: { kind: "throttled", scope: "denied", retryAfterMs: 100 },
		})
		expect("outcomes" in out).toBe(false)
	})

	it("propagates a typed failure (M5 rethrow) instead of returning an empty answer", async () => {
		const typed = Object.assign(new Error("search search failed at request"), {
			name: "SearchLaneError",
			stage: "request",
			reason: "query-error",
		})
		search.mockImplementation(async (_q: string, opts: Sinks) => {
			opts.onOutcomes?.(FAILED)
			throw typed
		})

		await expect(
			memongoBridgeSearchWithDegradation({ query: "q" }),
		).rejects.toBe(typed)
	})

	it("keeps each concurrent call's summary on its own envelope", async () => {
		search.mockImplementation(async (query: string, opts: Sinks) => {
			await new Promise((resolve) =>
				setTimeout(resolve, query === "slow" ? 20 : 0),
			)
			opts.onOutcomes?.(query === "slow" ? PARTIAL : FAILED)
			return []
		})

		const [slow, fast] = await Promise.all([
			memongoBridgeSearchWithDegradation({ query: "slow" }),
			memongoBridgeSearchWithDegradation({ query: "fast" }),
		])

		expect(slow.outcomes).toEqual(PARTIAL)
		expect(fast.outcomes).toEqual(FAILED)
	})

	it("returns the KB summary alongside a vector-lane-skipped marker", async () => {
		const kbPartial: SearchOutcomeSummary = {
			status: "partial",
			lanes: [
				{
					lane: "kb",
					stage: "vector",
					outcome: "failed",
					reason: "query-error",
				},
				{ lane: "kb", stage: "lane", outcome: "ok", resultCount: 1 },
			],
		}
		const hit = { path: "kb/a", score: 1 }
		searchKB.mockImplementation(async (_q: string, opts: Sinks) => {
			opts.onDegradation?.({
				kind: "throttled",
				scope: "vector-lane-skipped",
				retryAfterMs: 50,
			})
			opts.onOutcomes?.(kbPartial)
			return [hit]
		})

		const out = await memongoBridgeSearchKBWithDegradation({ query: "q" })

		expect(out).toEqual({
			results: [hit],
			degradation: {
				kind: "throttled",
				scope: "vector-lane-skipped",
				retryAfterMs: 50,
			},
			outcomes: kbPartial,
		})
	})

	it("propagates a typed KB failure (K12) instead of returning an empty answer", async () => {
		const typed = Object.assign(new Error("search kb failed at lane"), {
			name: "SearchLaneError",
			lane: "kb",
			stage: "lane",
			reason: "index-not-ready",
		})
		searchKB.mockImplementation(async () => {
			throw typed
		})

		await expect(
			memongoBridgeSearchKBWithDegradation({ query: "q" }),
		).rejects.toBe(typed)
	})
})
