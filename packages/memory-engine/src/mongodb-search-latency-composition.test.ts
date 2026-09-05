import { describe, expect, it } from "vitest"
import { DEFAULT_USER_SEARCH_MAX_TIME_MS } from "./mongodb-search-budget.js"
import { RERANK_TIMEOUT_MS } from "./mongodb-reranker.js"
import { SEMANTIC_PROBE_MAX_TIME_MS } from "./mongodb-query-cache.js"

// WS-11 change 5 (09-report U2): every uncached-search stage was
// individually bounded, but no test pinned the COMPOSITION — 1.5s semantic
// probe + 10s maxTimeMS aggregate + 2s rerank timeout = 13.5s worst case,
// arithmetic that had never been asserted anywhere. The benchmark contract
// gates P95 at 1,000ms (scripts/benchmark/benchmark-quality-contracts.ts),
// 13.5x below the tail, so the tail is headroom — but only if the sum
// stays bounded. This test fails red the moment any stage bound grows
// without the worst-case budget being re-derived, which is exactly the
// drift U2 warned about ("no stage aware of the others' budgets").
//
// Shared artifact with WS-16 change 2/3: WS-16 lands the live tail-
// composition path (probe-fail + slow-lane + rerank-timeout in one
// request) and derives the rerank timeout from the remaining budget; this
// file stays the static arithmetic pin both workstreams cite.

/** The 09-report U2 documented worst case for one uncached search. */
const DOCUMENTED_TAIL_COMPOSITION_MS = 13_500

/** The benchmark quality-contract P95 ceiling (cited, not imported: the
 * contract lives in scripts/, outside the engine package boundary). */
const BENCHMARK_P95_CONTRACT_MS = 1_000

describe("tail-latency composition (sum of stage bounds vs end-to-end budget)", () => {
	it("the three bounded stages compose to exactly the documented 13.5s tail", () => {
		const worstCaseMs =
			SEMANTIC_PROBE_MAX_TIME_MS +
			DEFAULT_USER_SEARCH_MAX_TIME_MS +
			RERANK_TIMEOUT_MS
		expect(worstCaseMs).toBe(DOCUMENTED_TAIL_COMPOSITION_MS)
	})

	it("each stage bound matches its individually documented value", () => {
		// 09-report U2: "1.5s semantic probe + 10s maxTimeMS on a slow
		// aggregate + 2s rerank timeout". Pin all three literals.
		expect(SEMANTIC_PROBE_MAX_TIME_MS).toBe(1_500)
		expect(DEFAULT_USER_SEARCH_MAX_TIME_MS).toBe(10_000)
		expect(RERANK_TIMEOUT_MS).toBe(2_000)
	})

	it("the composed tail stays far above the P95 benchmark contract (tail = headroom)", () => {
		const worstCaseMs =
			SEMANTIC_PROBE_MAX_TIME_MS +
			DEFAULT_USER_SEARCH_MAX_TIME_MS +
			RERANK_TIMEOUT_MS
		expect(worstCaseMs).toBeGreaterThan(BENCHMARK_P95_CONTRACT_MS * 10)
	})
})
