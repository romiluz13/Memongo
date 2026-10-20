import { describe, expect, it } from "vitest"
import type { Clock } from "./context.ts"
import { createFakeContext, generousBudget } from "./fake-api.ts"
import {
	F2_ATTEMPTS_PER_ENTRY,
	F2_MAX_REISSUE_ATTEMPTS,
	F2_MAX_WATCH_POLLS,
	F2_MAX_WRITES,
	planKill,
	runKill,
} from "./probe-f-kill.ts"
import { createFake, killSetup } from "./probe-f-fake.ts"
import { evaluateKill } from "./probe-f-model.ts"

describe("runKill", () => {
	it("kills an owned in-flight write, reissues it once and proves recovery", async () => {
		const { ctx, clock, killCalls, events, listCalls } = killSetup()
		const facts = await clock.drive(runKill(ctx))
		expect(killCalls).toHaveLength(1)
		expect(listCalls()).toBeGreaterThan(1)
		expect(ctx.budget.snapshot().calls["current-op"]).toBe(listCalls())
		expect(facts.killed).toBe(true)
		expect(facts.interrupted).toBe(true)
		expect(facts.reissues.length).toBeGreaterThan(0)
		expect(facts.reissues.every((item) => item.ok)).toBe(true)
		expect(facts.dedupe?.firstEventId).toBe(facts.dedupe?.secondEventId)
		expect(facts.status.count).toBe(facts.expectedRecords)
		expect(
			events.filter((item) => item.body.startsWith("Recovery log entry"))
				.length,
		).toBeGreaterThanOrEqual(facts.expectedRecords)
		expect(facts.controls).toEqual({ writeAcked: true, search: "found" })
		expect(evaluateKill(facts).outcome).toBe("pass")
		expect(ctx.budget.snapshot().calls["kill-op"]).toBe(1)
	})

	it("reports not-run permission with the server error when killOp is denied", async () => {
		const { ctx, clock } = killSetup({ denyKill: true })
		const facts = await clock.drive(runKill(ctx))
		const result = evaluateKill(facts)
		expect(result.outcome).toBe("not-run")
		expect(result.reason).toContain(
			"permission: not authorized on admin to execute command killOp",
		)
	})

	it("reports not-run permission when listing operations is denied", async () => {
		const { ctx, clock, killCalls } = killSetup({ denyList: true })
		const facts = await clock.drive(runKill(ctx))
		expect(evaluateKill(facts).reason).toContain("permission:")
		expect(killCalls).toHaveLength(0)
	})

	it("reports no owned target when nothing eligible is running", async () => {
		const { ctx, clock, killCalls } = killSetup({ hideOps: true })
		const facts = await clock.drive(runKill(ctx))
		expect(evaluateKill(facts).reason).toBe("no-owned-target")
		expect(killCalls).toHaveLength(0)
	})

	it("never kills an operation of another database or client", async () => {
		const { ctx, clock, killCalls } = killSetup({ foreignOps: true })
		const facts = await clock.drive(runKill(ctx))
		expect(killCalls).toHaveLength(0)
		expect(evaluateKill(facts).reason).toBe("no-owned-target")
	})

	it("never calls killOp for an operation whose id is not a number or a string", async () => {
		const { ctx, clock, killCalls } = killSetup({ badOpid: true })
		const facts = await clock.drive(runKill(ctx))
		expect(killCalls).toHaveLength(0)
		expect(evaluateKill(facts).reason).toBe("no-owned-target")
	})

	it("reports operation-finished when revalidation never finds the target", async () => {
		const { ctx, clock, killCalls } = killSetup({ vanish: true })
		const facts = await clock.drive(runKill(ctx))
		expect(killCalls).toHaveLength(0)
		expect(evaluateKill(facts).reason).toBe("operation-finished")
	})

	it("reports not-interrupted when the killed write still succeeds", async () => {
		const { ctx, clock } = killSetup({ ignoreKill: true })
		const facts = await clock.drive(runKill(ctx))
		expect(facts.killed).toBe(true)
		const result = evaluateKill(facts)
		expect(result.outcome).toBe("not-run")
		expect(result.reason).toBe("not-interrupted")
	})

	it("is not-run without an admin interface", async () => {
		const { ctx, clock } = killSetup({}, false)
		const facts = await clock.drive(runKill(ctx))
		expect(evaluateKill(facts).reason).toBe("admin-unavailable")
	})

	it("fails when reissued writes are rejected after the kill", async () => {
		const { ctx, clock } = killSetup({ rejectAfterKill: true })
		const facts = await clock.drive(runKill(ctx))
		expect(evaluateKill(facts).predicate).toBe("reissue-failed")
	})

	it("fails when a repeated reissue creates a different record", async () => {
		const { ctx, clock } = killSetup({ nonIdempotent: true })
		const facts = await clock.drive(runKill(ctx))
		expect(evaluateKill(facts).predicate).toBe("non-idempotent-reissue")
	})

	it("fails when a replayed write leaves a duplicate logical record", async () => {
		const { ctx, clock } = killSetup({ doubleStoreOnReplay: true })
		const facts = await clock.drive(runKill(ctx))
		expect(evaluateKill(facts).predicate).toBe("duplicate-logical-record")
	})

	it("fails when records written after the kill are acknowledged but lost", async () => {
		const { ctx, clock } = killSetup({ dropAfterKill: true })
		const facts = await clock.drive(runKill(ctx))
		expect(evaluateKill(facts).predicate).toBe("lost-record")
	})

	it("plans exactly the writes its recovery tail can issue after the capped initial and reissue writes", async () => {
		const { ctx, clock } = killSetup({ failControlWrites: true })
		const facts = await clock.drive(runKill(ctx))
		const counted = ctx.budget.snapshot().calls["api-write"] ?? 0
		const attempts = facts.reissues.length
		expect(facts.reissues.every((item) => item.ok)).toBe(true)
		expect(facts.dedupe?.ok).toBe(true)
		expect(facts.controls.writeAcked).toBe(false)
		const tail = counted - facts.expectedRecords - attempts
		expect(tail).toBe(F2_ATTEMPTS_PER_ENTRY + 1)
		expect(planKill()["api-write"]).toBe(
			F2_MAX_WRITES + F2_MAX_REISSUE_ATTEMPTS + tail,
		)
	})

	it("plans exactly the reads of its slowest recovery: every status poll and every control poll", async () => {
		const { ctx, clock } = killSetup({
			statusDegraded: "partial",
			neverFindControl: true,
		})
		await clock.drive(runKill(ctx))
		expect(ctx.budget.snapshot().calls["api-read"]).toBe(planKill()["api-read"])
	})

	it("plans the operation listings it may issue as two per watch poll", () => {
		expect(planKill()["current-op"]).toBe(2 * F2_MAX_WATCH_POLLS)
		expect(F2_MAX_WATCH_POLLS).toBe(1334)
	})

	it("stops watching after its poll cap even when the clock never advances", async () => {
		const frozen: Clock = {
			now: () => 0,
			mono: () => 0,
			sleep: () => new Promise<void>((resolve) => setImmediate(resolve)),
		}
		const fake = createFake(frozen, {
			hideOps: true,
			opMs: 0,
			maxListings: 5_000,
		})
		const ctx = createFakeContext(fake.api, {
			clock: frozen,
			admin: fake.admin,
			budget: generousBudget(),
		})
		const facts = await runKill(ctx)
		expect(evaluateKill(facts).reason).toBe("no-owned-target")
		expect(fake.listCalls()).toBe(F2_MAX_WATCH_POLLS)
	})

	it("counts every operation listing against its own budget path and aborts at the cap", async () => {
		const { ctx, clock, listCalls, killCalls } = killSetup(
			{ hideOps: true },
			true,
			{ "current-op": 5 },
		)
		const facts = await clock.drive(runKill(ctx))
		expect(listCalls()).toBe(5)
		expect(ctx.budget.snapshot().calls["current-op"]).toBe(5)
		expect(killCalls).toHaveLength(0)
		expect(evaluateKill(facts).reason).toBe("aborted:budget-refusal:cap")
	})

	it("aborts when the kill budget is exhausted", async () => {
		const { ctx, clock, killCalls } = killSetup({}, true, { "kill-op": 0 })
		const facts = await clock.drive(runKill(ctx))
		expect(killCalls).toHaveLength(0)
		expect(evaluateKill(facts).reason).toBe("aborted:budget-refusal:cap")
	})
})
