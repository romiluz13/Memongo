import { describe, expect, it } from "vitest"
import { main } from "./cli.ts"
import { ENV, everything, records, setup } from "./fake-cli.ts"
import { httpError } from "./fake-api.ts"
import type { ProbeApi } from "./probe-api.ts"

const DEAD_API = new Proxy(
	{},
	{
		get: () => async () => {
			throw httpError(503, "unavailable", "backend down")
		},
	},
) as ProbeApi

function deadSetup() {
	const state = setup(async () => {
		throw new Error("unused")
	})
	delete state.io.registry
	state.io.createApi = () => DEAD_API
	state.io.createAnswer = () => ({
		provider: {
			chatCompletion: async () => {
				throw new Error("provider down")
			},
		} as never,
		model: "answer-model",
	})
	return state
}

describe("every real probe against an API that is down", () => {
	it("never reports a pass, never fails on nothing observed, stays inside the planned budget and still cleans up", async () => {
		const state = deadSetup()
		const code = await main(["--runs", "1"], ENV, state.io)
		expect(code).toBe(2)
		const list = records(state.out)
		const summaries = list.filter((item) => item.kind === "probe-summary")
		expect(summaries.map((item) => item.payload.probe)).toEqual([
			"A",
			"B",
			"C",
			"D",
			"E",
			"F",
			"G",
		])
		for (const summary of summaries) {
			expect(summary.payload.outcome).not.toBe("pass")
			expect(summary.payload.outcome).not.toBe("fail")
		}
		const runs = list.filter((item) => item.kind === "probe-run")
		expect(runs.map((item) => item.payload.probe)).toEqual([
			"A",
			"B",
			"C",
			"D",
			"E",
			"F",
			"G",
		])
		expect(new Set(runs.map((item) => item.payload.rule)).size).toBe(7)
		for (const run of runs) {
			expect(
				(run.payload.reasons as string[]).some((reason) =>
					reason.includes("budget-refusal"),
				),
			).toBe(false)
		}
		const invocation = list.find((item) => item.kind === "invocation")
		const budget = invocation?.payload.budget as {
			calls: Record<string, number>
			refusals: number
		}
		const plan = list[0]?.payload.caps as Record<string, number>
		for (const [path, used] of Object.entries(budget.calls)) {
			expect(used).toBeLessThanOrEqual(plan[path] as number)
		}
		expect(budget.refusals).toBe(0)
		expect(state.f.calls.dropped).toEqual(["memongo_probe_0a1b2c3d"])
		expect(everything(state)).not.toContain("answer-key-SENTINEL")
	}, 60_000)
})
