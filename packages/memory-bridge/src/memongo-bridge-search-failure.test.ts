import { beforeEach, describe, expect, it, vi } from "vitest"

// M2 T10 (X-01, X-02): the bare bridge search accessors used to call the
// engine without an outcome or degradation sink, so a failed or throttled
// search came back as a plain []. They now return the envelope and throw the
// engine's typed lane errors when the whole call failed.

const search = vi.fn()
const searchKB = vi.fn()

vi.mock("@memongo/memory-engine", async () => {
	const actual = await vi.importActual<typeof import("@memongo/memory-engine")>(
		"@memongo/memory-engine",
	)
	return {
		...actual,
		getMemorySearchManager: vi.fn(async () => ({
			manager: { search, searchKB },
			error: null,
		})),
		closeAllMemorySearchManagers: vi.fn(),
	}
})
vi.mock("@memongo/memory-engine/internal", () => ({
	materializeBlocks: vi.fn(),
}))
vi.mock("./memory-config.js", () => ({
	resolveBridgeConfig: vi.fn(() => ({})),
}))

import {
	SearchBudgetDeniedError,
	SearchLaneError,
	type SearchOutcomeSummary,
} from "@memongo/memory-engine"
import { memongoBridgeSearch, memongoBridgeSearchKB } from "./memongo-bridge.js"

type Sinks = {
	onOutcomes?: (outcomes: SearchOutcomeSummary) => void
	onDegradation?: (degradation: unknown) => void
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
const BUDGET_DENIED: SearchOutcomeSummary = {
	status: "failed",
	lanes: [
		{
			lane: "hybrid",
			stage: "reservation",
			outcome: "budget-denied",
			reason: "budget-embeds",
		},
	],
}
const PARTIAL: SearchOutcomeSummary = {
	status: "partial",
	lanes: [
		{ lane: "structured", stage: "lane", outcome: "ok", resultCount: 1 },
		{
			lane: "procedural",
			stage: "lane",
			outcome: "failed",
			reason: "query-error",
		},
	],
}
const THROTTLED = { kind: "throttled", scope: "denied", retryAfterMs: 250 }

beforeEach(() => {
	search.mockReset()
	searchKB.mockReset()
})

describe.each([
	{ name: "memongoBridgeSearch", call: memongoBridgeSearch, engine: search },
	{
		name: "memongoBridgeSearchKB",
		call: memongoBridgeSearchKB,
		engine: searchKB,
	},
])("$name failure surfacing (X-01, X-02)", ({ call, engine }) => {
	it("throws the typed lane error when the engine returns [] for a failed call", async () => {
		engine.mockImplementation(async (_q: string, opts: Sinks) => {
			opts.onOutcomes?.(FAILED)
			return []
		})

		const error = await call({ query: "q" }).catch((e: unknown) => e)

		expect(error).toBeInstanceOf(SearchLaneError)
		expect(error).toMatchObject({
			lane: "structured",
			stage: "lane",
			reason: "lane-unavailable",
			outcomes: FAILED,
		})
	})

	it("throws a typed budget denial when every failing row is a denial", async () => {
		engine.mockImplementation(async (_q: string, opts: Sinks) => {
			opts.onOutcomes?.(BUDGET_DENIED)
			return []
		})

		const error = await call({ query: "q" }).catch((e: unknown) => e)

		expect(error).toBeInstanceOf(SearchBudgetDeniedError)
		expect(error).toMatchObject({
			stage: "reservation",
			reason: "budget-embeds",
			outcomes: BUDGET_DENIED,
		})
	})

	it("returns the healthy lanes with the failure rows for a partial call", async () => {
		const hit = { path: "a", score: 1 }
		engine.mockImplementation(async (_q: string, opts: Sinks) => {
			opts.onOutcomes?.(PARTIAL)
			return [hit]
		})

		await expect(call({ query: "q" })).resolves.toEqual({
			results: [hit],
			outcomes: PARTIAL,
		})
	})

	it("returns an empty envelope for a healthy zero-hit call", async () => {
		engine.mockImplementation(async (_q: string, opts: Sinks) => {
			opts.onOutcomes?.({
				status: "complete",
				lanes: [
					{
						lane: "hybrid",
						stage: "lane",
						outcome: "ok-empty",
						reason: "zero-hits",
					},
				],
			})
			return []
		})

		const out = await call({ query: "q" })

		expect(out.results).toEqual([])
		expect(out.outcomes?.status).toBe("complete")
	})

	it("keeps a thrown engine failure as the thrown error", async () => {
		const typed = new SearchLaneError({
			stage: "request",
			reason: "query-error",
		})
		engine.mockRejectedValue(typed)

		await expect(call({ query: "q" })).rejects.toBe(typed)
	})
})

describe("memongoBridgeSearch throttle marker", () => {
	it("returns the throttle marker instead of a bare empty answer", async () => {
		search.mockImplementation(async (_q: string, opts: Sinks) => {
			opts.onDegradation?.(THROTTLED)
			return []
		})

		await expect(memongoBridgeSearch({ query: "q" })).resolves.toEqual({
			results: [],
			degradation: THROTTLED,
		})
	})
})
