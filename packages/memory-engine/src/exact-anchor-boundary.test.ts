import { describe, expect, it } from "vitest"
import { applyHardConstraintRejections } from "./mongodb-search-executor.js"

function evaluate(query: string, snippet: string) {
	return applyHardConstraintRejections({
		request: { query, needExactEvidence: true },
		results: [
			{
				path: "events/turn-1",
				startLine: 0,
				endLine: 0,
				score: 0.9,
				snippet,
				source: "conversation",
				derivation: "user-extracted",
			},
		],
	})
}

describe("exact evidence anchor boundary matching", () => {
	it.each([
		["c++", "c++"],
		["$100", "$100"],
		["$100", "pay $100."],
		[".env", "the file is .env"],
		["value-", "stored value-"],
		["(foo)", "stored (foo)"],
		["+++", "+++"],
		["été", "été"],
		["你好啊", "你好啊"],
		["c++  guide", "c++\tguide"],
		["alpha", "alpha"],
		["user@example.com", "user@example.com"],
	])("retains quoted anchor %s when its literal text is present", (anchor, snippet) => {
		const result = evaluate(`find "${anchor}"`, snippet)
		expect(result.accepted).toHaveLength(1)
		expect(result.rejected).toHaveLength(0)
	})

	it.each([
		["alpha", "alphabet"],
		["alpha", "xalpha"],
		[".env", ".environment"],
		["$100", "$1000"],
		["value-", "xvalue-"],
		["user@example.com", "user@example.company"],
		["(foo)", "(bar)"],
	])("retains word-edge or literal mismatch rejection for %s", (anchor, snippet) => {
		const result = evaluate(`find "${anchor}"`, snippet)
		expect(result.accepted).toHaveLength(0)
		expect(result.rejected[0]?.reason).toBe(
			"missing requested entity/value anchor",
		)
	})
	it.each([
		["(foo)", "x(foo)y"],
		["-10", "x-10"],
	])("preserves existing adjacent-word acceptance for %s", (anchor, snippet) => {
		expect(evaluate(`find "${anchor}"`, snippet).accepted).toHaveLength(1)
	})
	it("characterizes unconstrained non-word edges as substring acceptance", () => {
		expect(evaluate('find "c++"', "c+++").accepted).toHaveLength(1)
	})
	it("preserves the existing capitalized fallback for uppercase C++", () => {
		expect(evaluate('find "C++"', "C++").accepted).toHaveLength(1)
	})
	it("keeps the existing OR rule for requested anchors", () => {
		expect(evaluate('find "alpha" and "beta"', "beta").accepted).toHaveLength(1)
	})
	it("leaves requests without anchors unchanged", () => {
		expect(
			evaluate("find recent conversation", "different content").accepted,
		).toHaveLength(1)
	})
})
