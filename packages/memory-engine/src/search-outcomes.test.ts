import { describe, expect, it } from "vitest"
import {
	classifySearchError,
	SearchBudgetDeniedError,
	SearchLaneError,
	SearchLaneUnavailableError,
	searchFailureRow,
	summarizeSearchOutcomes,
	type SearchLaneOutcome,
} from "./search-outcomes.js"

function named(name: string, extra: Record<string, unknown> = {}): Error {
	const err = new Error("provider said: secret query text")
	err.name = name
	return Object.assign(err, extra)
}

describe("classifySearchError (value-free)", () => {
	it("maps the typed lane-unavailable error", () => {
		expect(classifySearchError(new SearchLaneUnavailableError())).toBe(
			"lane-unavailable",
		)
	})

	it("keeps the reason a typed lane error already carries", () => {
		expect(
			classifySearchError(
				new SearchLaneError({ stage: "vector", reason: "index-not-ready" }),
			),
		).toBe("index-not-ready")
	})

	it.each([
		"MongoNetworkError",
		"MongoNetworkTimeoutError",
		"MongoServerSelectionError",
	])("maps the driver network name %s to dependency-unavailable", (name) => {
		expect(classifySearchError(named(name))).toBe("dependency-unavailable")
	})

	it("walks a bounded cause chain for the network names", () => {
		const outer = named("MongoRuntimeError", {
			cause: named("MongoNetworkError"),
		})
		expect(classifySearchError(outer)).toBe("dependency-unavailable")
	})

	it("R9: unobserved server codes 27 and 50 classify as query-error", () => {
		expect(
			classifySearchError(
				named("MongoServerError", { code: 27, codeName: "IndexNotFound" }),
			),
		).toBe("query-error")
		expect(
			classifySearchError(
				named("MongoServerError", { code: 50, codeName: "MaxTimeMSExpired" }),
			),
		).toBe("query-error")
	})

	it("maps any other server error to query-error and the rest to internal-error", () => {
		expect(classifySearchError(named("MongoServerError", { code: 2 }))).toBe(
			"query-error",
		)
		expect(classifySearchError(new TypeError("boom"))).toBe("internal-error")
		expect(classifySearchError("a string")).toBe("internal-error")
	})

	it("never reads the message: identical names with different text classify alike", () => {
		const a = named("MongoServerError", { code: 2 })
		const b = named("MongoServerError", { code: 2 })
		b.message = "index not ready to query NOT_STARTED"
		expect(classifySearchError(a)).toBe(classifySearchError(b))
	})
})

describe("typed errors carry no provider text", () => {
	it("builds the message from enums only and keeps the original as cause", () => {
		const cause = named("MongoServerError", { code: 2 })
		const err = new SearchLaneError({
			lane: "structured",
			stage: "atlas-search",
			reason: "query-error",
			cause,
		})
		expect(err.message).not.toContain("secret")
		expect(err.message).toContain("atlas-search")
		expect(err.cause).toBe(cause)
		const denied = new SearchBudgetDeniedError({
			stage: "vector",
			reason: "budget-embeds",
		})
		expect(denied.message).toContain("budget-embeds")
	})

	it("searchFailureRow yields an enum-only row with no error field", () => {
		const row = searchFailureRow(
			"hybrid:chunks",
			"lane",
			named("MongoServerError", { code: 2 }),
		)
		expect(row).toEqual({
			lane: "hybrid:chunks",
			stage: "lane",
			outcome: "failed",
			reason: "query-error",
		})
		expect(JSON.stringify(row)).not.toContain("secret")
		expect(
			searchFailureRow(
				"kb",
				"lane",
				new SearchBudgetDeniedError({
					stage: "atlas-search",
					reason: "budget-deadline",
				}),
			),
		).toEqual({
			lane: "kb",
			stage: "atlas-search",
			outcome: "budget-denied",
			reason: "budget-deadline",
		})
	})
})

describe("summarizeSearchOutcomes (matrix section 5)", () => {
	const ok = (
		lane: SearchLaneOutcome["lane"],
		count = 1,
	): SearchLaneOutcome => ({
		lane,
		stage: "lane",
		outcome: count > 0 ? "ok" : "ok-empty",
		...(count > 0 ? {} : { reason: "zero-hits" as const }),
		resultCount: count,
	})

	it("is complete when nothing failed, even with zero hits", () => {
		expect(summarizeSearchOutcomes([ok("hybrid", 0)], ["hybrid"]).status).toBe(
			"complete",
		)
	})

	it("is partial when one required lane failed and another succeeded empty", () => {
		const rows: SearchLaneOutcome[] = [
			ok("hybrid", 0),
			{
				lane: "structured",
				stage: "vector",
				outcome: "failed",
				reason: "query-error",
			},
		]
		expect(summarizeSearchOutcomes(rows, ["hybrid", "structured"]).status).toBe(
			"partial",
		)
	})

	it("is failed when every required lane failed or was denied", () => {
		const rows: SearchLaneOutcome[] = [
			{
				lane: "hybrid",
				stage: "lane",
				outcome: "failed",
				reason: "query-error",
			},
			{
				lane: "structured",
				stage: "vector",
				outcome: "budget-denied",
				reason: "budget-embeds",
			},
		]
		expect(summarizeSearchOutcomes(rows, ["hybrid", "structured"]).status).toBe(
			"failed",
		)
	})

	it("optional lanes make a request partial, never failed", () => {
		const rows: SearchLaneOutcome[] = [
			{
				lane: "turn-precision",
				stage: "lane",
				outcome: "failed",
				reason: "query-error",
			},
		]
		expect(summarizeSearchOutcomes(rows, ["hybrid"]).status).toBe("partial")
	})

	it("R4: explain failures never change the status", () => {
		const rows: SearchLaneOutcome[] = [
			ok("structured"),
			{
				lane: "structured",
				stage: "explain",
				outcome: "failed",
				reason: "query-error",
			},
		]
		expect(summarizeSearchOutcomes(rows, ["structured"]).status).toBe(
			"complete",
		)
	})

	it("R1: capability-absent rows are visible but do not make a request partial", () => {
		const rows: SearchLaneOutcome[] = [
			ok("structured"),
			{
				lane: "structured",
				stage: "atlas-search",
				outcome: "not-applicable",
				reason: "capability-absent",
			},
		]
		const summary = summarizeSearchOutcomes(rows, ["structured"])
		expect(summary.status).toBe("complete")
		expect(summary.lanes).toEqual(rows)
	})
})
