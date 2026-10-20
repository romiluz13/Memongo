import { describe, expect, it } from "vitest"
import { main } from "./cli.ts"
import {
	ALL_SENTINELS,
	ANSWER_KEY,
	caseOf,
	ENV,
	everything,
	passes,
	records,
	resultOf,
	setup,
} from "./fake-cli.ts"
import { URI, VOYAGE } from "./fake-harness.ts"

describe("a complete invocation", () => {
	it("prints the planned counts before starting, runs every probe in every run, cleans up and exits 0", async () => {
		const state = setup(passes)
		const code = await main(["--probes", "A,C", "--runs", "2"], ENV, state.io)
		expect(code).toBe(0)
		expect(state.events).toEqual(["start after 1 records"])
		const list = records(state.out)
		expect(list.map((item) => item.kind)).toEqual([
			"plan",
			"probe-run",
			"probe-run",
			"probe-run",
			"probe-run",
			"probe-summary",
			"probe-summary",
			"invocation",
			"cleanup",
		])
		expect(list[0]?.payload.caps).toEqual({ "api-read": 12, "api-write": 8 })
		expect(state.f.calls.dropped).toEqual(["memongo_probe_0a1b2c3d"])
		expect(state.f.calls.killed.map((item) => item.signal)).toEqual(["SIGTERM"])
		expect(state.err.join("")).toContain("overall: pass (exit 0)")
		expect(state.err.join("")).toContain("probe A: pass (2 runs)")
	})

	it("hands out fresh agent ids and tokens per run", async () => {
		const agents = new Set<string>()
		const tokens = new Set<string>()
		const state = setup(async (letter, ctx) => {
			agents.add(ctx.agentId())
			tokens.add(ctx.token("zq"))
			return resultOf(letter, ctx, "pass", [caseOf("c1", "pass")])
		})
		await main(["--probes", "A", "--runs", "3"], ENV, state.io)
		expect(agents.size).toBe(3)
		expect(tokens.size).toBe(3)
		for (const agent of agents) expect(agent).toMatch(/^probe-[0-9a-f-]{36}$/)
	})

	it("leaves stdout as JSON records only and drops the human summary under --json", async () => {
		const state = setup(passes)
		await main(["--probes", "A", "--json"], ENV, state.io)
		expect(state.err.join("")).not.toContain("overall:")
		expect(() => records(state.out)).not.toThrow()
	})

	it("prints no secret value or credential from the environment, the evidence or the child", async () => {
		const state = setup(
			async (letter, ctx) =>
				resultOf(letter, ctx, "fail", [caseOf("leaky", "fail", "leak")]),
			{
				onSpawn: (child) =>
					child.emit(`boot ${URI} key ${VOYAGE} ${ANSWER_KEY}`),
			},
		)
		const code = await main(["--probes", "A"], ENV, state.io)
		expect(code).toBe(1)
		for (const sentinel of ALL_SENTINELS) {
			expect(everything(state)).not.toContain(sentinel)
		}
		expect(everything(state)).toContain("[REDACTED")
	})
})

describe("exit codes", () => {
	it("exits 1 and labels a failure reproduced when the same case fails with the same predicate in both runs", async () => {
		const state = setup(async (letter, ctx) =>
			resultOf(letter, ctx, "fail", [
				caseOf("same", "fail", "leak"),
				ctx.run === 1 ? caseOf("once", "fail", "leak") : caseOf("once", "pass"),
			]),
		)
		const code = await main(["--probes", "A"], ENV, state.io)
		expect(code).toBe(1)
		const summary = records(state.out).find(
			(item) => item.kind === "probe-summary",
		)
		const reproduction = summary?.payload.reproduction as {
			reproduced: Array<{ caseId: string }>
			singleRun: Array<{ caseId: string }>
		}
		expect(reproduction.reproduced.map((item) => item.caseId)).toEqual(["same"])
		expect(reproduction.singleRun.map((item) => item.caseId)).toEqual(["once"])
		expect(state.err.join("")).toContain("reproduced same [leak]")
		expect(state.err.join("")).toContain("single-run once [leak]")
	})

	it("exits 2 for an inconclusive invocation and 3 when nothing could run", async () => {
		const inconclusive = setup(async (letter, ctx) =>
			resultOf(letter, ctx, "inconclusive", [caseOf("c1", "inconclusive")]),
		)
		expect(await main(["--probes", "A"], ENV, inconclusive.io)).toBe(2)
		const notRun = setup(async (letter, ctx) =>
			resultOf(letter, ctx, "not-run", [caseOf("c1", "not-run")]),
		)
		expect(await main(["--probes", "A"], ENV, notRun.io)).toBe(3)
	})

	it("turns a throwing probe into an inconclusive exit, still cleaning up", async () => {
		const state = setup(async () => {
			throw new Error(`boom ${URI}`)
		})
		const code = await main(["--probes", "A"], ENV, state.io)
		expect(code).toBe(2)
		expect(state.f.calls.dropped).toEqual(["memongo_probe_0a1b2c3d"])
		for (const sentinel of ALL_SENTINELS) {
			expect(everything(state)).not.toContain(sentinel)
		}
	})
})

describe("probe wiring", () => {
	it("passes the answer provider only to a run that includes probe B and admin only to one that includes F", async () => {
		const seen: Record<string, { answer: boolean; admin?: string }> = {}
		const state = setup(async (letter, ctx) => {
			seen[letter] = {
				answer: ctx.answer !== undefined,
				...(ctx.admin ? { admin: ctx.admin.appName } : {}),
			}
			return resultOf(letter, ctx, "pass", [caseOf("c1", "pass")])
		})
		await main(["--probes", "A,B,F", "--runs", "1"], ENV, state.io)
		expect(state.answered).toBe(1)
		expect(seen.B?.answer).toBe(true)
		expect(seen.A).toEqual({
			answer: true,
			admin: "memongo-probe-api-0a1b2c3d",
		})
		const plain = setup(async (letter, ctx) => {
			seen[`plain-${letter}`] = {
				answer: ctx.answer !== undefined,
				...(ctx.admin ? { admin: ctx.admin.appName } : {}),
			}
			return resultOf(letter, ctx, "pass", [caseOf("c1", "pass")])
		})
		await main(["--probes", "A", "--runs", "1"], ENV, plain.io)
		expect(plain.answered).toBe(0)
		expect(seen["plain-A"]).toEqual({ answer: false })
	})

	it("bounds each path by the planned counts times the number of runs", async () => {
		const state = setup(async (letter, ctx) => {
			for (let i = 0; i < 100; i += 1)
				ctx.budget.settle(ctx.budget.reserveCount("api-read"))
			return resultOf(letter, ctx, "pass", [caseOf("c1", "pass")])
		})
		const code = await main(["--probes", "A", "--runs", "2"], ENV, state.io)
		expect(code).toBe(2)
		const invocation = records(state.out).find(
			(item) => item.kind === "invocation",
		)
		const budget = invocation?.payload.budget as {
			calls: Record<string, number>
		}
		expect(budget.calls["api-read"]).toBe(6)
	})
})
