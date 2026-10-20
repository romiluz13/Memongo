import { describe, expect, it } from "vitest"
import { compareRuns } from "./reproduction.ts"
import {
	aggregateInvocation,
	aggregateRun,
	combineRuns,
	exitCodeFor,
} from "./verdict.ts"
import type { CaseResult, Outcome, ProbeRunResult } from "./types.ts"

function c(
	caseId: string,
	outcome: Outcome,
	extra: Partial<CaseResult> = {},
): CaseResult {
	return { caseId, outcome, controlEligible: true, ...extra }
}

function run(
	runNo: number,
	cases: CaseResult[],
	overrides: Partial<ProbeRunResult> = {},
): ProbeRunResult {
	return {
		probe: "A",
		run: runNo,
		rule: "RULE-1",
		version: "v1",
		outcome: aggregateRun(
			cases,
			cases.map((x) => x.caseId),
		).outcome,
		reasons: [],
		cases,
		counts: {},
		...overrides,
	}
}

describe("aggregateRun precedence", () => {
	it("passes only when every required case passed", () => {
		expect(
			aggregateRun([c("a", "pass"), c("b", "pass")], ["a", "b"]).outcome,
		).toBe("pass")
	})

	it("fails when any case failed, even if other cases were inconclusive or unexecuted", () => {
		const result = aggregateRun(
			[
				c("a", "fail", { predicate: "leak" }),
				c("b", "inconclusive", { reason: "control failed" }),
			],
			["a", "b", "c"],
		)
		expect(result.outcome).toBe("fail")
		expect(result.reasons.join(" ")).toMatch(/unexecuted/)
	})

	it("is inconclusive when a required case was not executed", () => {
		const result = aggregateRun([c("a", "pass")], ["a", "b"])
		expect(result.outcome).toBe("inconclusive")
		expect(result.reasons).toContain("unexecuted required cases: b")
	})

	it("is inconclusive when a case is inconclusive or not-run next to passes", () => {
		expect(
			aggregateRun([c("a", "pass"), c("b", "inconclusive")], ["a", "b"])
				.outcome,
		).toBe("inconclusive")
		expect(
			aggregateRun(
				[c("a", "pass"), c("b", "not-run", { reason: "permission" })],
				["a", "b"],
			).outcome,
		).toBe("inconclusive")
	})

	it("is not-run when nothing was executed at all", () => {
		expect(aggregateRun([], []).outcome).toBe("not-run")
		expect(
			aggregateRun([c("a", "not-run", { reason: "permission" })], ["a"])
				.outcome,
		).toBe("not-run")
	})

	it("does not let an extra, non-required passing case mask a missing required one", () => {
		expect(aggregateRun([c("x", "pass")], ["a"]).outcome).toBe("inconclusive")
	})
})

describe("combineRuns and aggregateInvocation", () => {
	it("a probe fails if any run failed and is inconclusive if any run was", () => {
		expect(
			combineRuns([
				run(1, [c("a", "pass")]),
				run(2, [c("a", "fail", { predicate: "p" })]),
			]).outcome,
		).toBe("fail")
		expect(
			combineRuns([run(1, [c("a", "pass")]), run(2, [c("a", "inconclusive")])])
				.outcome,
		).toBe("inconclusive")
		expect(
			combineRuns([run(1, [c("a", "pass")]), run(2, [c("a", "pass")])]).outcome,
		).toBe("pass")
		expect(combineRuns([run(1, []), run(2, [])]).outcome).toBe("not-run")
	})

	it("a pass in one run and not-run in the other is incomplete, not a pass", () => {
		const notRun = run(2, [], { outcome: "not-run" })
		expect(combineRuns([run(1, [c("a", "pass")]), notRun]).outcome).toBe(
			"inconclusive",
		)
	})

	it("maps invocation outcomes to distinct exit codes with fail first", () => {
		expect(exitCodeFor("pass")).toBe(0)
		expect(exitCodeFor("fail")).toBe(1)
		expect(exitCodeFor("inconclusive")).toBe(2)
		expect(exitCodeFor("not-run")).toBe(3)
		expect(aggregateInvocation(["pass", "not-run", "inconclusive"])).toBe(
			"inconclusive",
		)
		expect(aggregateInvocation(["pass", "fail", "not-run"])).toBe("fail")
		expect(aggregateInvocation(["pass", "not-run"])).toBe("not-run")
		expect(aggregateInvocation(["pass", "pass"])).toBe("pass")
		expect(aggregateInvocation([])).toBe("not-run")
	})
})

describe("compareRuns (reproduction rule)", () => {
	const failing = (predicate: string, extra: Partial<CaseResult> = {}) =>
		c("A/search/other-agent/pre-erase", "fail", { predicate, ...extra })

	it("labels a failure reproduced only when the same case fails with the same predicate in two runs", () => {
		const result = compareRuns([
			run(1, [failing("forbidden:other-agent")]),
			run(2, [failing("forbidden:other-agent")]),
		])
		expect(result.reproduced).toEqual([
			{
				caseId: "A/search/other-agent/pre-erase",
				predicate: "forbidden:other-agent",
				runs: [1, 2],
			},
		])
		expect(result.singleRun).toEqual([])
	})

	it("does not reproduce when the same case fails for two different reasons under one label", () => {
		const result = compareRuns([
			run(1, [failing("forbidden:other-agent")]),
			run(2, [failing("forbidden:other-scope")]),
		])
		expect(result.reproduced).toEqual([])
		expect(result.singleRun.map((s) => s.predicate).sort()).toEqual([
			"forbidden:other-agent",
			"forbidden:other-scope",
		])
		expect(result.mismatched).toEqual([
			{
				caseId: "A/search/other-agent/pre-erase",
				predicates: ["forbidden:other-agent", "forbidden:other-scope"],
			},
		])
	})

	it("does not reproduce a failure that appears in one run only", () => {
		const result = compareRuns([
			run(1, [failing("p")]),
			run(2, [c("A/search/other-agent/pre-erase", "pass")]),
		])
		expect(result.reproduced).toEqual([])
		expect(result.singleRun).toEqual([
			{
				caseId: "A/search/other-agent/pre-erase",
				predicate: "p",
				run: 1,
				reason: "failed in one run only",
			},
		])
	})

	it("does not reproduce when the other run skipped or was inconclusive on that case", () => {
		const result = compareRuns([
			run(1, [failing("p")]),
			run(2, [
				c("A/search/other-agent/pre-erase", "inconclusive", {
					reason: "http-503",
				}),
			]),
		])
		expect(result.reproduced).toEqual([])
		expect(result.singleRun).toHaveLength(1)
	})

	it("requires eligible controls in both failing runs", () => {
		const result = compareRuns([
			run(1, [failing("p", { controlEligible: false })]),
			run(2, [failing("p")]),
		])
		expect(result.reproduced).toEqual([])
		expect(
			result.singleRun.some((s) => s.reason === "controls ineligible"),
		).toBe(true)
	})

	it("does not reproduce across a changed rule or fixture version", () => {
		const ruleChange = compareRuns([
			run(1, [failing("p")]),
			run(2, [failing("p")], { rule: "RULE-2" }),
		])
		expect(ruleChange.reproduced).toEqual([])
		expect(ruleChange.ruleConsistent).toBe(false)
		const versionChange = compareRuns([
			run(1, [failing("p")]),
			run(2, [failing("p")], { version: "v2" }),
		])
		expect(versionChange.reproduced).toEqual([])
	})

	it("reproduces from any two of three runs and keeps the third as context", () => {
		const result = compareRuns([
			run(1, [failing("p")]),
			run(2, [c("A/search/other-agent/pre-erase", "pass")]),
			run(3, [failing("p")]),
		])
		expect(result.reproduced[0]?.runs).toEqual([1, 3])
	})

	it("a single run can never reproduce anything", () => {
		expect(compareRuns([run(1, [failing("p")])]).reproduced).toEqual([])
	})
})
