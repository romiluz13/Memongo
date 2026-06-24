import { describe, expect, test } from "vitest"
import {
	BENCHMARK_FAILURE_CLASSES,
	classifyBenchmarkFailure,
	type BenchmarkFailureClass,
} from "./benchmark-failure-taxonomy.js"

describe("classifyBenchmarkFailure (Task 1.4, Recommended Default #2)", () => {
	test("classifies harness-timeout from AbortError", () => {
		expect(classifyBenchmarkFailure(new Error("aborted"))).toBe(
			"harness-timeout",
		)
	})

	test("classifies harness-timeout from DOMException AbortError-shaped names", () => {
		const err = new Error("operation was aborted")
		;(err as Error & { name: string }).name = "AbortError"
		expect(classifyBenchmarkFailure(err)).toBe("harness-timeout")
	})

	test("classifies model-failure from Voyage 500", () => {
		expect(classifyBenchmarkFailure(new Error("Voyage API 500 Internal"))).toBe(
			"model-failure",
		)
	})

	test("classifies model-failure from unreachable voyage base URL", () => {
		const err = new Error("connect ECONNREFUSED 127.0.0.1:65530")
		expect(classifyBenchmarkFailure(err)).toBe("model-failure")
	})

	test("classifies json-parse from SyntaxError", () => {
		expect(classifyBenchmarkFailure(new SyntaxError("Unexpected token"))).toBe(
			"json-parse",
		)
	})

	test("classifies index-not-ready from STALE status error", () => {
		expect(
			classifyBenchmarkFailure(new Error("search index status STALE")),
		).toBe("index-not-ready")
	})

	test("classifies index-not-ready from queryable=false error", () => {
		expect(
			classifyBenchmarkFailure(
				new Error("search index queryable=false BUILDING"),
			),
		).toBe("index-not-ready")
	})

	test("classifies index-not-ready from strict bootstrap readiness failure", () => {
		expect(
			classifyBenchmarkFailure(
				new Error(
					"search indexes not fully queryable after bootstrap wait: memongo_canary_events pending=[memongo_canary_events_vector]",
				),
			),
		).toBe("index-not-ready")
	})

	test("classifies strict Search convergence timeout as index-not-ready", () => {
		expect(
			classifyBenchmarkFailure(
				new Error(
					"benchmark events search convergence timed out: indexed=493/494",
				),
			),
		).toBe("index-not-ready")
	})

	test("classifies queue-settle-timeout from the scenario manager error", () => {
		expect(
			classifyBenchmarkFailure(
				new Error(
					"benchmark scenario manager writeQueue settle timed out after 60000ms",
				),
			),
		).toBe("queue-settle-timeout")
	})

	test("classifies probe-timeout from event-search-probe error", () => {
		expect(
			classifyBenchmarkFailure(
				new Error("benchmark event search probe timed out after 1000ms"),
			),
		).toBe("probe-timeout")
	})

	test("classifies scope-leak from scope-leak sentinel error", () => {
		expect(
			classifyBenchmarkFailure(
				new Error("scope-leak detected across scopeRef"),
			),
		).toBe("scope-leak")
	})

	test("classifies retrieval-miss from zero-recall sentinel", () => {
		expect(
			classifyBenchmarkFailure(
				new Error("retrieval-miss: expected session not in top-10"),
			),
		).toBe("retrieval-miss")
	})

	test("classifies strict empty planner search as retrieval-miss", () => {
		expect(
			classifyBenchmarkFailure(
				new Error(
					"planner search failed; legacy fallback disabled: searchV2 returned no results; legacy fallback disabled",
				),
			),
		).toBe("retrieval-miss")
	})

	test("unknown falls through to `unknown` class, not silent pass", () => {
		expect(classifyBenchmarkFailure(new Error("wat"))).toBe("unknown")
	})

	test("5xx without model/network token falls through to `unknown`", () => {
		// A generic HTTP 500 from the benchmark endpoint (e.g. MongoDB URI
		// required) is NOT a model-failure. It's a bootstrap/config error.
		// Bucketing it into model-failure would misclassify root cause and
		// silently satisfy the forced-failure gate.
		expect(
			classifyBenchmarkFailure(
				new Error(
					'HTTP 500: {"error":{"code":"RELEVANCE_BENCHMARK_FAILED","message":"MongoDB URI required for Memongo."}}',
				),
			),
		).toBe("unknown")
	})

	test("5xx WITH voyage/network token still classifies as model-failure", () => {
		expect(
			classifyBenchmarkFailure(
				new Error("HTTP 500 from voyage embedding endpoint"),
			),
		).toBe("model-failure")
	})

	test("ECONNREFUSED without 5xx classifies as model-failure", () => {
		expect(
			classifyBenchmarkFailure(
				new Error("connect ECONNREFUSED 127.0.0.1:65530"),
			),
		).toBe("model-failure")
	})

	test("classifies non-Error values as unknown without throwing", () => {
		expect(classifyBenchmarkFailure("plain string")).toBe("unknown")
		expect(classifyBenchmarkFailure(undefined)).toBe("unknown")
		expect(classifyBenchmarkFailure(null)).toBe("unknown")
		expect(classifyBenchmarkFailure(42)).toBe("unknown")
	})

	test("all 9 classes are exported and stable", () => {
		expect(BENCHMARK_FAILURE_CLASSES).toEqual([
			"harness-timeout",
			"queue-settle-timeout",
			"probe-timeout",
			"model-failure",
			"json-parse",
			"index-not-ready",
			"scope-leak",
			"retrieval-miss",
			"unknown",
		] as BenchmarkFailureClass[])
	})
})
