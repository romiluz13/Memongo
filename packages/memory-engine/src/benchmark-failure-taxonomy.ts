/**
 * Benchmark failure taxonomy (Task 1.4, Recommended Default #2 APPROVED).
 *
 * A canary run must classify every terminal failure into one of these 9
 * classes. "unknown" is the fall-through and means the run did NOT silently
 * pass — an unclassified failure still counts as a failure and is surfaced in
 * `failure.json`.
 *
 * Order is stable and tests assert on that order; do not reorder.
 */
export const BENCHMARK_FAILURE_CLASSES = [
	"harness-timeout",
	"queue-settle-timeout",
	"probe-timeout",
	"model-failure",
	"json-parse",
	"index-not-ready",
	"scope-leak",
	"retrieval-miss",
	"unknown",
] as const

export type BenchmarkFailureClass = (typeof BENCHMARK_FAILURE_CLASSES)[number]

/**
 * Classify an error value into one of the 9 benchmark failure classes.
 *
 * Precedence (first-match wins):
 * 1. queue-settle-timeout — "benchmark scenario manager ... settle timed out"
 * 2. probe-timeout — "benchmark event search probe timed out"
 * 3. harness-timeout — AbortError name or generic "aborted" / "timed out"
 * 4. json-parse — SyntaxError instance
 * 5. index-not-ready — search index status STALE / BUILDING / queryable=false
 * 6. scope-leak — the sentinel "scope-leak" substring
 * 7. retrieval-miss — the sentinel "retrieval-miss" substring
 * 8. model-failure — Voyage/rerank/LLM errors, network unreachable
 * 9. unknown — fall through; never silent.
 *
 * The precedence matters: a queue-settle or probe timeout is both a "timed
 * out" and a narrower class — we return the narrower class.
 */
export function classifyBenchmarkFailure(err: unknown): BenchmarkFailureClass {
	if (!(err instanceof Error)) return "unknown"
	const msg = err.message || ""
	const name = err.name || ""

	// 1. queue-settle-timeout (narrow: matches the exact sentinel string)
	if (
		/benchmark scenario manager \w+Queue settle timed out/i.test(msg) ||
		/\w+Queue settle timed out/i.test(msg)
	) {
		return "queue-settle-timeout"
	}

	// 2. probe-timeout (benchmark event-search probe ceiling)
	if (/benchmark event search probe timed out/i.test(msg)) {
		return "probe-timeout"
	}

	// 3. json-parse (SyntaxError comes from JSON.parse and similar)
	if (err instanceof SyntaxError) {
		return "json-parse"
	}

	// 4. index-not-ready (STALE / BUILDING / queryable=false)
	if (
		/search index.*status\s+STALE/i.test(msg) ||
		/search index.*BUILDING/i.test(msg) ||
		/search indexes? not fully queryable/i.test(msg) ||
		/search convergence timed out/i.test(msg) ||
		/queryable=false/i.test(msg) ||
		/index-not-ready/i.test(msg)
	) {
		return "index-not-ready"
	}

	// 5. scope-leak sentinel
	if (/scope-leak/i.test(msg)) {
		return "scope-leak"
	}

	// 6. retrieval-miss sentinel
	if (
		/retrieval-miss/i.test(msg) ||
		/searchV2 returned no results/i.test(msg) ||
		/planner search failed; legacy fallback disabled/i.test(msg)
	) {
		return "retrieval-miss"
	}

	// 7. harness-timeout (broad: aborted / generic timeouts)
	if (
		name === "AbortError" ||
		/\baborted\b/i.test(msg) ||
		/timed out/i.test(msg) ||
		/timeout/i.test(msg)
	) {
		return "harness-timeout"
	}

	// 8. model-failure (Voyage, rerank, LLM, network unreachable)
	//
	// A bare 5xx is NOT sufficient to classify as model-failure. A
	// bootstrap 500 (e.g. "MongoDB URI required") must NOT be mislabeled as a
	// Voyage/model problem. The 5xx rule now requires co-occurrence with a
	// model/network token so that config/bootstrap 500s fall through to
	// `unknown` (the intended escape valve — not silent, just not lying about
	// class).
	const MODEL_NETWORK_TOKEN =
		/voyage|rerank|embedding|\bllm\b|anthropic|openai|ECONNREFUSED|ENETUNREACH|ENOTFOUND/i
	if (
		/voyage/i.test(msg) ||
		/rerank/i.test(msg) ||
		/\bllm\b/i.test(msg) ||
		/ECONNREFUSED/.test(msg) ||
		/ENETUNREACH/.test(msg) ||
		/ENOTFOUND/.test(msg) ||
		(/\b5\d{2}\b/.test(msg) && MODEL_NETWORK_TOKEN.test(msg))
	) {
		return "model-failure"
	}

	// 9. Fall-through — never silent.
	return "unknown"
}
