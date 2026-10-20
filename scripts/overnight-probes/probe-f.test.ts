import { describe, expect, it } from "vitest"
import { planProbeF, runProbeF } from "./probe-f.ts"
import { killSetup, setup } from "./probe-f-fake.ts"
import { planLoadPhase, runLoadPhase } from "./probe-f-load.ts"
import { evaluateLoadPhase, F_PHASES } from "./probe-f-model.ts"

const w20 = F_PHASES[0]

describe("runLoadPhase", () => {
	it("passes a complete workload and records every write and search", async () => {
		const { ctx, clock } = setup()
		const facts = await clock.drive(runLoadPhase(ctx, w20))
		expect(facts.writes.attempted).toBe(600)
		expect(facts.searches.attempted).toBe(600)
		expect(facts.startedWriters).toBe(20)
		expect(facts.startedSearchers).toBe(20)
		expect(facts.elapsedMs).toBeGreaterThanOrEqual(60_000)
		expect(facts.verification).toMatchObject({
			statusTrusted: true,
			eventsCount: 601,
			sampled: 10,
			sampledFound: 10,
		})
		expect(evaluateLoadPhase(facts).outcome).toBe("pass")
	})

	it("stays within the planned call counts", async () => {
		const { ctx, clock } = setup()
		await clock.drive(runLoadPhase(ctx, w20))
		const plan = planLoadPhase(w20)
		const counted = ctx.budget.snapshot().calls
		expect(counted["api-write"]).toBe(plan["api-write"])
		expect(counted["api-read"]).toBeLessThanOrEqual(plan["api-read"])
	})

	it("fails when acknowledged writes are not stored", async () => {
		const { ctx, clock } = setup({ dropAcked: true })
		const facts = await clock.drive(runLoadPhase(ctx, w20))
		expect(evaluateLoadPhase(facts).predicate).toBe("lost-acked-writes")
	})

	it("does not count a query the API echoes back as a stored record when sampling", async () => {
		const { ctx, clock } = setup({ dropAcked: true, echoQueries: true })
		const facts = await clock.drive(runLoadPhase(ctx, w20))
		expect(facts.verification).toMatchObject({ sampled: 10, sampledFound: 0 })
		expect(evaluateLoadPhase(facts).predicate).toBe("lost-acked-writes")
	})

	it("fails when more records exist than writes attempted", async () => {
		const { ctx, clock } = setup({ duplicate: true })
		const facts = await clock.drive(runLoadPhase(ctx, w20))
		expect(evaluateLoadPhase(facts).predicate).toBe("phantom-writes")
	})

	it("fails when healthy searches lose the control under load", async () => {
		const { ctx, clock } = setup({ loseControlAfter: 100 })
		const facts = await clock.drive(runLoadPhase(ctx, w20))
		expect(facts.searches.healthyMissingControl).toBeGreaterThan(0)
		expect(evaluateLoadPhase(facts).predicate).toBe("silent-miss-under-load")
	})

	it("counts backpressure apart and cannot pass when it dominates", async () => {
		const { ctx, clock } = setup({ throttleAfter: 50 })
		const facts = await clock.drive(runLoadPhase(ctx, w20))
		expect(facts.writes.backpressure).toBeGreaterThan(400)
		expect(facts.writes.errors).toBe(0)
		const result = evaluateLoadPhase(facts)
		expect(result.outcome).toBe("inconclusive")
		expect(result.reason).toBe("backpressure-dominated")
	})

	it("does not read a degraded status count as a lost write", async () => {
		for (const statusDegraded of ["failed-check", "partial"] as const) {
			const { ctx, clock } = setup({ statusDegraded })
			const facts = await clock.drive(runLoadPhase(ctx, w20))
			expect(facts.verification.statusTrusted).toBe(false)
			const result = evaluateLoadPhase(facts)
			expect(result.outcome).toBe("inconclusive")
			expect(result.reason).toBe("count-unverified")
		}
	})

	it("does not run the workload when the control record cannot be seeded", async () => {
		const { ctx, clock } = setup({ neverFindControl: true })
		const facts = await clock.drive(runLoadPhase(ctx, w20))
		expect(facts.controlSeeded).toBe(false)
		expect(facts.writes.attempted).toBe(0)
		expect(evaluateLoadPhase(facts).reason).toBe("control-not-seeded")
	})

	it("reports a workload the API could not keep up with as shortened", async () => {
		const { ctx, clock } = setup({ opMs: 5_000 })
		const facts = await clock.drive(runLoadPhase(ctx, w20))
		expect(facts.writes.attempted).toBeLessThan(540)
		expect(evaluateLoadPhase(facts).reason).toBe("workload-shortened")
	})

	it("aborts cleanly when the write budget runs out", async () => {
		const { ctx, clock } = setup({}, true, { "api-write": 100 })
		const facts = await clock.drive(runLoadPhase(ctx, w20))
		expect(facts.aborted).toBe("budget-refusal:cap")
		expect(ctx.budget.snapshot().calls["api-write"]).toBeLessThanOrEqual(100)
		expect(evaluateLoadPhase(facts).outcome).toBe("inconclusive")
	})
})

describe("runProbeF", () => {
	it("passes end to end when both workloads and the recovery pass", async () => {
		const { ctx, clock } = killSetup()
		const result = await clock.drive(runProbeF(ctx))
		expect(result.cases.map((item) => item.outcome)).toEqual([
			"pass",
			"pass",
			"pass",
		])
		expect(result.outcome).toBe("pass")
		expect(result.counts.writesAttempted).toBe(2100)
		const plan = planProbeF()
		const counted = ctx.budget.snapshot().calls
		expect(counted["api-write"]).toBeLessThanOrEqual(plan["api-write"])
		expect(counted["api-read"]).toBeLessThanOrEqual(plan["api-read"])
		expect(counted["kill-op"]).toBeLessThanOrEqual(plan["kill-op"])
		expect(counted["current-op"]).toBeGreaterThan(0)
		expect(counted["current-op"]).toBeLessThanOrEqual(plan["current-op"])
	})

	it("reports inconclusive with a not-run recovery when killOp is denied", async () => {
		const { ctx, clock } = killSetup({ denyKill: true })
		const result = await clock.drive(runProbeF(ctx))
		expect(result.cases.slice(0, 2).map((item) => item.outcome)).toEqual([
			"pass",
			"pass",
		])
		expect(result.cases[2]?.outcome).toBe("not-run")
		expect(result.outcome).toBe("inconclusive")
	})
})
