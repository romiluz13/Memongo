import { describe, expect, it } from "vitest"
import { DEFAULT_USER_SEARCH_MAX_TIME_MS } from "./mongodb-search-budget.js"
import * as searchV2Module from "./mongodb-search-v2.js"

// WS-11 change 5 (09-report U2): every search stage is individually bounded,
// and this test pins the composition. M2 removed the HTTP reranker, so the
// only bounded retrieval stage left is the 10s maxTimeMS aggregate and the
// worst case is that bound alone. The benchmark contract gates P95 at 1,000ms
// (scripts/benchmark/benchmark-quality-contracts.ts), 10x below the tail, so
// the tail is headroom. This test fails red the moment a stage bound grows
// without the worst-case budget being re-derived.

/** The worst case with no post-retrieval network stage. */
const DOCUMENTED_TAIL_COMPOSITION_MS = 10_000

/** The benchmark quality-contract P95 ceiling (cited, not imported: the
 * contract lives in scripts/, outside the engine package boundary). */
const BENCHMARK_P95_CONTRACT_MS = 1_000

describe("tail-latency composition (sum of stage bounds vs end-to-end budget)", () => {
	it("the bounded stages compose to exactly the documented 10s tail", () => {
		expect(DEFAULT_USER_SEARCH_MAX_TIME_MS).toBe(DOCUMENTED_TAIL_COMPOSITION_MS)
	})

	it("the composed tail stays far above the P95 benchmark contract (tail = headroom)", () => {
		expect(DEFAULT_USER_SEARCH_MAX_TIME_MS).toBeGreaterThanOrEqual(
			BENCHMARK_P95_CONTRACT_MS * 10,
		)
	})

	it("searchV2 no longer exports a tail budget that included the reranker timeout", () => {
		expect(searchV2Module).not.toHaveProperty(
			"SEARCH_TAIL_COMPOSITION_BUDGET_MS",
		)
	})
})
