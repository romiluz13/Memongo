import { describe, expect, it } from "vitest"
import { AdminDenied } from "./context.ts"
import {
	createFakeContext,
	createTimerClock,
	generousBudget,
	httpError,
	type Json,
} from "./fake-api.ts"
import { planProbeF, runProbeF } from "./probe-f.ts"
import { runKill } from "./probe-f-kill.ts"
import { planLoadPhase, runLoadPhase } from "./probe-f-load.ts"
import { evaluateKill, evaluateLoadPhase, F_PHASES } from "./probe-f-model.ts"

const DATABASE = "memongo_probe_ab12cd34"
const APP = "memongo-probe-api-ab12cd34"

type Options = {
	opMs?: number
	dropAcked?: boolean
	duplicate?: boolean
	loseControlAfter?: number
	throttleAfter?: number
	neverFindControl?: boolean
	statusDegraded?: "failed-check" | "partial"
	rejectAfterKill?: boolean
	nonIdempotent?: boolean
	doubleStoreOnReplay?: boolean
	dropAfterKill?: boolean
	ignoreKill?: boolean
	hideOps?: boolean
	foreignOps?: boolean
	vanish?: boolean
	denyList?: boolean
	denyKill?: boolean
	echoQueries?: boolean
	badOpid?: boolean
}

type Stored = {
	agentId: string
	customId: string
	eventId: string
	body: string
}

function createFake(
	clock: ReturnType<typeof createTimerClock>,
	options: Options = {},
) {
	const events: Stored[] = []
	const acks = new Map<string, string>()
	const inflight = new Map<
		number,
		{ opid: number; body: string; killed: boolean }
	>()
	const killCalls: Array<number | string> = []
	let opCounter = 0
	let writes = 0
	let listings = 0
	let killedOnce = false
	const tokensOf = (query: string) =>
		query.split(" ").filter((word) => word.startsWith("zq"))

	const api = {
		writeEvent: async (input: Json) => {
			writes += 1
			opCounter += 1
			const op = {
				opid: 1000 + opCounter,
				body: input.body as string,
				killed: false,
			}
			inflight.set(op.opid, op)
			await clock.sleep(options.opMs ?? 3)
			inflight.delete(op.opid)
			if (op.killed) {
				killedOnce = true
				throw httpError(500, "INTERRUPTED")
			}
			if (options.rejectAfterKill && killedOnce) throw httpError(500, "BROKEN")
			if (
				options.throttleAfter !== undefined &&
				writes > options.throttleAfter
			) {
				throw httpError(429, "RATE_LIMITED")
			}
			const customId = input.customId as string
			const known = options.nonIdempotent ? undefined : acks.get(customId)
			if (known) {
				const stored = events.find((item) => item.customId === customId)
				if (options.doubleStoreOnReplay && stored) events.push({ ...stored })
				return { ok: true, eventId: known, chunkCreated: false }
			}
			const eventId = `ev-${events.length + 1}-${writes}`
			acks.set(customId, eventId)
			const body = input.body as string
			const record = {
				agentId: input.agentId as string,
				customId,
				eventId,
				body,
			}
			const dropped =
				(options.dropAcked && body.startsWith("Concurrency log entry")) ||
				(options.dropAfterKill && killedOnce)
			if (!dropped) {
				events.push(record)
				if (options.duplicate) events.push({ ...record })
			}
			return { ok: true, eventId, chunkCreated: true }
		},
		search: async (input: Json) => {
			await clock.sleep(2)
			const tokens = tokensOf(input.query as string)
			const control = tokens.some((token) => token.startsWith("zqfctl"))
			const hide =
				(control && options.neverFindControl) ||
				(control &&
					options.loseControlAfter !== undefined &&
					events.length > options.loseControlAfter)
			const results = hide
				? []
				: events
						.filter((item) => tokens.some((token) => item.body.includes(token)))
						.map((item) => ({ snippet: item.body }))
			return {
				results,
				outcomes: { status: "complete", lanes: [] },
				...(options.echoQueries
					? {
							query: input.query,
							metadata: { queriesTried: [input.query] },
						}
					: {}),
			}
		},
		getDetailedStatus: async (agentId: string) =>
			options.statusDegraded
				? {
						events: { count: 0 },
						health: {
							dataCompleteness:
								options.statusDegraded === "partial" ? "partial" : "complete",
							failedChecks:
								options.statusDegraded === "failed-check"
									? ["events.count"]
									: [],
						},
					}
				: {
						events: {
							count: events.filter((item) => item.agentId === agentId).length,
						},
						health: { dataCompleteness: "complete", failedChecks: [] },
					},
	}

	const admin = {
		database: DATABASE,
		appName: APP,
		currentOps: async () => {
			listings += 1
			if (options.denyList)
				throw new AdminDenied(
					"not authorized on admin to execute command currentOp",
				)
			if (options.hideOps) return []
			if (options.vanish && listings % 2 === 0) return []
			const foreign = options.foreignOps === true
			return [...inflight.values()].map((op) => ({
				opid: options.badOpid ? undefined : op.opid,
				active: true,
				op: "update",
				ns: foreign ? "other_db.events" : `${DATABASE}.events`,
				appName: foreign ? "someone-else" : APP,
				command: {
					update: "events",
					updates: [{ u: { $setOnInsert: { body: op.body } } }],
				},
			}))
		},
		killOp: async (opid: number | string) => {
			killCalls.push(opid)
			if (options.denyKill)
				throw new AdminDenied(
					"not authorized on admin to execute command killOp",
				)
			const op = inflight.get(Number(opid))
			if (op && !options.ignoreKill) op.killed = true
		},
	}
	return { api, admin, events, killCalls }
}

function setup(
	options: Options = {},
	withAdmin = true,
	caps: Record<string, number> = {},
) {
	const clock = createTimerClock()
	const fake = createFake(clock, options)
	const ctx = createFakeContext(fake.api, {
		clock,
		...(withAdmin ? { admin: fake.admin } : {}),
		budget: generousBudget(caps),
	})
	return { clock, ctx, ...fake }
}

const w20 = F_PHASES[0]

function killSetup(
	options: Options = {},
	withAdmin = true,
	caps: Record<string, number> = {},
) {
	return setup({ opMs: 40, ...options }, withAdmin, caps)
}

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

describe("runKill", () => {
	it("kills an owned in-flight write, reissues it once and proves recovery", async () => {
		const { ctx, clock, killCalls, events } = killSetup()
		const facts = await clock.drive(runKill(ctx))
		expect(killCalls).toHaveLength(1)
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

	it("aborts when the kill budget is exhausted", async () => {
		const { ctx, clock, killCalls } = killSetup({}, true, { "kill-op": 0 })
		const facts = await clock.drive(runKill(ctx))
		expect(killCalls).toHaveLength(0)
		expect(evaluateKill(facts).reason).toBe("aborted:budget-refusal:cap")
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
