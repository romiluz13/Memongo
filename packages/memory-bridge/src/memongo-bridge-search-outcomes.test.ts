import { beforeEach, describe, expect, it, vi } from "vitest"

// #101 / decision 16 (matrix section 4 step 6): the bridge search accessors
// carry the engine's per-call outcome summary out with the results. The
// engine fires its onOutcomes sink once per call (proved at the engine seam
// in mongodb-manager-search-outcomes.test.ts); the bridge must capture it in
// a call-local closure, return it, and never swallow a typed failure.

const search = vi.fn()
const searchKB = vi.fn()
const requestCapabilities = vi.fn()

vi.mock("@memongo/memory-engine", () => ({
	getMemorySearchManager: vi.fn(async ({ agentId }: { agentId: string }) => ({
		manager: { agentId, search, searchKB, requestCapabilities },
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
	memongoBridgeCapabilities,
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
	requestCapabilities.mockReset()
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

	it("returns the KB partial summary with its hits and no degradation marker", async () => {
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
			opts.onOutcomes?.(kbPartial)
			return [hit]
		})

		const out = await memongoBridgeSearchKBWithDegradation({ query: "q" })

		expect(out).toEqual({
			results: [hit],
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

// M2 decision 8: both index-health reasons cross the bridge unchanged, as
// rows on a partial answer and as the typed rethrow on a failed one.
describe("bridge carries the index-health reasons (M2)", () => {
	const STALE_ROW = {
		lane: "structured",
		stage: "index-health",
		outcome: "failed",
		reason: "index-stale",
	} as const

	it("returns an index-health row beside a healthy sibling as a partial summary", async () => {
		const partial: SearchOutcomeSummary = {
			status: "partial",
			lanes: [
				STALE_ROW,
				{
					lane: "episodic",
					stage: "lane",
					outcome: "ok-empty",
					reason: "zero-hits",
				},
			],
		}
		search.mockImplementation(async (_q: string, opts: Sinks) => {
			opts.onOutcomes?.(partial)
			return []
		})

		const out = await memongoBridgeSearchWithDegradation({ query: "q" })

		expect(out).toEqual({ results: [], outcomes: partial })
	})

	it.each([
		"index-stale",
		"index-unavailable",
	] as const)("rethrows the typed %s failure of a KB search, never an empty answer", async (reason) => {
		const typed = Object.assign(new Error("search kb failed at index-health"), {
			name: "SearchLaneError",
			lane: "kb",
			stage: "index-health",
			reason,
		})
		searchKB.mockImplementation(async () => {
			throw typed
		})

		await expect(
			memongoBridgeSearchKBWithDegradation({ query: "q" }),
		).rejects.toBe(typed)
	})

	it("rethrows the typed index-unavailable failure of a search", async () => {
		const typed = Object.assign(new Error("search failed at index-health"), {
			name: "SearchLaneError",
			stage: "index-health",
			reason: "index-unavailable",
		})
		search.mockImplementation(async () => {
			throw typed
		})

		await expect(
			memongoBridgeSearchWithDegradation({ query: "q" }),
		).rejects.toBe(typed)
	})
})

describe("memongoBridgeCapabilities reads the live request view (M2)", () => {
	it("returns the manager's per-request capabilities, read on each call", async () => {
		requestCapabilities
			.mockResolvedValueOnce({ vectorSearch: false, textSearch: true })
			.mockResolvedValueOnce({ vectorSearch: true, textSearch: true })

		const during = await memongoBridgeCapabilities({ agentId: "a" })
		const after = await memongoBridgeCapabilities({ agentId: "a" })

		expect(during).toEqual({ vectorSearch: false, textSearch: true })
		expect(after).toEqual({ vectorSearch: true, textSearch: true })
		expect(requestCapabilities).toHaveBeenCalledTimes(2)
	})

	it("propagates a typed failure instead of returning a capability view", async () => {
		const typed = Object.assign(new Error("index health failed"), {
			name: "SearchLaneError",
			stage: "index-health",
			reason: "index-unavailable",
		})
		requestCapabilities.mockRejectedValue(typed)

		await expect(memongoBridgeCapabilities({ agentId: "a" })).rejects.toBe(
			typed,
		)
	})
})
