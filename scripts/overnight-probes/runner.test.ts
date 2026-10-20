import { describe, expect, it } from "vitest"
import { BudgetRefusal } from "./budget.ts"
import type { ProbeContext } from "./context.ts"
import { createFakeClock, generousBudget, silentWriter } from "./fake-api.ts"
import type { Harness } from "./harness.ts"
import { planProbeA } from "./probe-a.ts"
import type { ProbeApi } from "./probe-api.ts"
import { planProbeB } from "./probe-b.ts"
import { planProbeF } from "./probe-f.ts"
import {
	adminPortFor,
	type InvocationInput,
	PROBES,
	planInvocation,
	type Registry,
	runInvocation,
} from "./runner.ts"
import type {
	CaseResult,
	Outcome,
	ProbeLetter,
	ProbeRunResult,
} from "./types.ts"

function result(
	probe: ProbeLetter,
	run: number,
	cases: CaseResult[],
	outcome: Outcome,
	rule = "rule-1",
): ProbeRunResult {
	return {
		probe,
		run,
		rule,
		version: "v1",
		outcome,
		reasons: outcome === "pass" ? [] : [`${probe} ${outcome}`],
		cases,
		counts: {},
	}
}

function failing(caseId: string, predicate: string): CaseResult {
	return { caseId, outcome: "fail", predicate, controlEligible: true }
}

function passing(caseId: string): CaseResult {
	return { caseId, outcome: "pass", controlEligible: true }
}

function stubRegistry(
	runFor: (letter: ProbeLetter, ctx: ProbeContext) => Promise<ProbeRunResult>,
): Registry {
	const entry = (letter: ProbeLetter) => ({
		plan: () => ({ "api-read": 3, "api-write": 2 }),
		run: (ctx: ProbeContext) => runFor(letter, ctx),
	})
	return {
		A: entry("A"),
		B: entry("B"),
		C: entry("C"),
		D: entry("D"),
		E: entry("E"),
		F: entry("F"),
		G: entry("G"),
	}
}

function baseInput(
	overrides: Partial<Omit<InvocationInput, "evidence">> & {
		registry: Registry
	},
): InvocationInput & { evidence: ReturnType<typeof silentWriter> } {
	let counter = 0
	const evidence = silentWriter()
	return {
		probes: ["A"],
		runs: 2,
		api: {} as ProbeApi,
		budget: generousBudget(),
		evidence,
		clock: createFakeClock(),
		token: (prefix) => `${prefix}${++counter}`,
		agentId: () => `probe-agent-${++counter}`,
		...overrides,
	}
}

describe("planInvocation", () => {
	it("scales each probe's per-run plan by the number of runs and sums paths across probes", () => {
		const plan = planInvocation(["A", "B"], 2)
		const a = planProbeA()
		const b = planProbeB()
		expect(plan.caps["api-read"]).toBe(2 * (a["api-read"] + b["api-read"]))
		expect(plan.caps["api-write"]).toBe(2 * (a["api-write"] + b["api-write"]))
		expect(plan.caps["answer-llm"]).toBe(2 * b["answer-llm"])
		expect(plan.caps["answer-llm"]).toBe(120)
		expect(plan.perRun.A).toEqual(a)
	})

	it("plans a kill operation only when probe F is selected", () => {
		expect(planInvocation(["A", "G"], 1).caps["kill-op"]).toBeUndefined()
		expect(planInvocation(["F"], 2).caps["kill-op"]).toBe(
			2 * planProbeF()["kill-op"],
		)
	})

	it("plans no answer calls unless probe B is selected", () => {
		expect(
			planInvocation(["A", "C", "D", "E", "G"], 2).caps,
		).not.toHaveProperty("answer-llm")
	})

	it("refuses invalid run counts before planning", () => {
		for (const runs of [0, -1, 1.5, Number.NaN, 6, Number.POSITIVE_INFINITY]) {
			expect(() => planInvocation(["A"], runs)).toThrow(BudgetRefusal)
		}
	})

	it("refuses a probe plan that is not a non-negative integer", () => {
		const registry = stubRegistry(async () => result("A", 1, [], "pass"))
		registry.A = { ...registry.A, plan: () => ({ "api-read": -1 }) }
		expect(() => planInvocation(["A"], 1, registry)).toThrow(/invalid count/)
		registry.A = { ...registry.A, plan: () => ({ "api-read": 1.5 }) }
		expect(() => planInvocation(["A"], 1, registry)).toThrow(/invalid count/)
	})

	it("knows every probe letter", () => {
		expect(Object.keys(PROBES).sort()).toEqual([
			"A",
			"B",
			"C",
			"D",
			"E",
			"F",
			"G",
		])
	})
})

describe("runInvocation", () => {
	it("runs every selected probe for every run with the run number in its context", async () => {
		const seen: string[] = []
		const registry = stubRegistry(async (letter, ctx) => {
			seen.push(`${letter}${ctx.run}`)
			return result(letter, ctx.run, [passing("c")], "pass")
		})
		const input = baseInput({ registry, probes: ["A", "C"], runs: 2 })
		const report = await runInvocation(input)
		expect(seen).toEqual(["A1", "C1", "A2", "C2"])
		expect(report.outcome).toBe("pass")
		expect(report.probes.map((item) => item.probe)).toEqual(["A", "C"])
	})

	it("hands each run a context that mints fresh agent ids and tokens", async () => {
		const agents: string[] = []
		const registry = stubRegistry(async (letter, ctx) => {
			agents.push(ctx.agentId(), ctx.agentId())
			return result(letter, ctx.run, [passing("c")], "pass")
		})
		await runInvocation(baseInput({ registry, runs: 2 }))
		expect(new Set(agents).size).toBe(4)
	})

	it("passes the optional answer and admin ports only when provided", async () => {
		let withPorts: ProbeContext | undefined
		let without: ProbeContext | undefined
		const registry = stubRegistry(async (letter, ctx) => {
			if (ctx.answer) withPorts = ctx
			else without = ctx
			return result(letter, ctx.run, [passing("c")], "pass")
		})
		await runInvocation(baseInput({ registry, runs: 1 }))
		expect(without?.answer).toBeUndefined()
		expect(without?.admin).toBeUndefined()
		const answer = { provider: {}, model: "m" } as ProbeContext["answer"]
		const admin = {
			database: "d",
			appName: "a",
			currentOps: async () => [],
			killOp: async () => {},
		}
		await runInvocation(baseInput({ registry, runs: 1, answer, admin }))
		expect(withPorts?.answer?.model).toBe("m")
		expect(withPorts?.admin?.appName).toBe("a")
	})

	it("labels a failure reproduced only when the same case fails with the same predicate in both runs", async () => {
		const registry = stubRegistry(async (letter, ctx) =>
			result(
				letter,
				ctx.run,
				[
					failing("same", "leak"),
					ctx.run === 1 ? failing("once", "leak") : passing("once"),
				],
				"fail",
			),
		)
		const report = await runInvocation(baseInput({ registry, runs: 2 }))
		const summary = report.probes[0]
		expect(report.outcome).toBe("fail")
		expect(summary?.reproduction.reproduced.map((item) => item.caseId)).toEqual(
			["same"],
		)
		expect(summary?.reproduction.singleRun.map((item) => item.caseId)).toEqual([
			"once",
		])
	})

	it("does not reproduce a failure whose predicate changed between runs", async () => {
		const registry = stubRegistry(async (letter, ctx) =>
			result(
				letter,
				ctx.run,
				[failing("case", ctx.run === 1 ? "leak" : "stale")],
				"fail",
			),
		)
		const report = await runInvocation(baseInput({ registry, runs: 2 }))
		expect(report.probes[0]?.reproduction.reproduced).toEqual([])
		expect(report.probes[0]?.reproduction.mismatched).toEqual([
			{ caseId: "case", predicates: ["leak", "stale"] },
		])
	})

	it("turns a throwing probe into an inconclusive run and keeps going", async () => {
		const registry = stubRegistry(async (letter, ctx) => {
			if (letter === "A") throw new Error("boom https://user:pw@host/")
			return result(letter, ctx.run, [passing("c")], "pass")
		})
		const input = baseInput({ registry, probes: ["A", "C"], runs: 2 })
		const report = await runInvocation(input)
		expect(report.probes[0]?.outcome).toBe("inconclusive")
		expect(report.probes[0]?.reasons.join(" ")).toContain("aborted:Error")
		expect(JSON.stringify(report)).not.toContain("user:pw")
		expect(report.probes[1]?.outcome).toBe("pass")
		expect(report.outcome).toBe("inconclusive")
	})

	it("does not let a crashed run veto the reproduction of the runs that executed", async () => {
		const registry = stubRegistry(async (letter, ctx) => {
			if (ctx.run === 3) throw new Error("late")
			return result(letter, ctx.run, [failing("case", "leak")], "fail")
		})
		const report = await runInvocation(baseInput({ registry, runs: 3 }))
		expect(report.probes[0]?.reproduction.ruleConsistent).toBe(true)
		expect(report.probes[0]?.reproduction.reproduced).toHaveLength(1)
		expect(report.outcome).toBe("fail")
	})

	it("reports a budget refusal as an abort reason, not a crash of the invocation", async () => {
		const registry = stubRegistry(async () => {
			throw new BudgetRefusal("cap", "path api-read would exceed its cap")
		})
		const report = await runInvocation(baseInput({ registry, runs: 1 }))
		expect(report.probes[0]?.reasons.join(" ")).toContain("budget-refusal:cap")
	})

	it("records every run and every probe summary as sanitized evidence in order", async () => {
		const registry = stubRegistry(async (letter, ctx) =>
			result(letter, ctx.run, [passing("c")], "pass"),
		)
		const input = baseInput({ registry, probes: ["A", "C"], runs: 2 })
		await runInvocation(input)
		expect(
			input.evidence.records.map((item) => (item as { kind: string }).kind),
		).toEqual([
			"probe-run",
			"probe-run",
			"probe-run",
			"probe-run",
			"probe-summary",
			"probe-summary",
		])
	})

	it("reports the budget snapshot with the final outcome", async () => {
		const registry = stubRegistry(async (letter, ctx) => {
			ctx.budget.settle(ctx.budget.reserveCount("api-read"))
			return result(letter, ctx.run, [passing("c")], "pass")
		})
		const report = await runInvocation(baseInput({ registry, runs: 2 }))
		expect(report.budget.calls["api-read"]).toBe(2)
	})

	it("treats an inconclusive probe as inconclusive even when another probe passes", async () => {
		const registry = stubRegistry(async (letter, ctx) =>
			letter === "A"
				? result(letter, ctx.run, [passing("c")], "pass")
				: result(letter, ctx.run, [], "inconclusive"),
		)
		const report = await runInvocation(
			baseInput({ registry, probes: ["A", "B"], runs: 1 }),
		)
		expect(report.outcome).toBe("inconclusive")
	})
})

describe("adminPortFor", () => {
	it("binds the kill interface to this run's database and client name", async () => {
		const killed: Array<number | string> = []
		const harness = {
			database: "memongo_probe_0a1b2c3d",
			appName: "memongo-probe-api-0a1b2c3d",
			mongo: {
				listOperations: async () => [{ opid: 1 }],
				killOperation: async (opid: number | string) => {
					killed.push(opid)
				},
			},
		} as unknown as Harness
		const port = adminPortFor(harness)
		expect(port.database).toBe("memongo_probe_0a1b2c3d")
		expect(port.appName).toBe("memongo-probe-api-0a1b2c3d")
		expect(await port.currentOps()).toEqual([{ opid: 1 }])
		await port.killOp(7)
		expect(killed).toEqual([7])
	})
})
