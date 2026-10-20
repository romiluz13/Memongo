import { describe, expect, it } from "vitest"
import { createBudget } from "./budget.ts"
import {
	createFakeClock,
	createFakeContext,
	httpError,
	type Json,
} from "./fake-api.ts"
import {
	E_BARRIER_N,
	E_DEADLINE_MS,
	E_POLL_STEP_MS,
	E_PRIMARY_N,
} from "./probe-e-model.ts"
import { planProbeE, runProbeE } from "./probe-e.ts"

type Options = {
	delayMs?: number
	neverVisibleIndex?: number
	barrierLies?: boolean
	controlInvisible?: boolean
	searchErrorsAfterMs?: number
	statusFails?: boolean
	writeMs?: number
}

type Event = { body: string; visibleAt: number }
type Call = { kind: "write" | "search"; label: string; at: number }

function createFakeE(options: Options = {}) {
	const clock = createFakeClock()
	const events: Event[] = []
	const calls: Call[] = []
	let unbarriered = 0
	const api = {
		status: async () => {
			if (options.statusFails) throw httpError(500)
			return {
				version: "x",
				provider: "voyage",
				custom: { database: "memongo_probe_x" },
			}
		},
		getDetailedStatus: async () => ({
			health: { overall: "ok" },
			projectionLag: {},
			projectionHealth: {},
			laneCoverage: {},
		}),
		writeEvent: async (input: Json) => {
			calls.push({
				kind: "write",
				label: (input.body as string)
					.replace("Archive ", "")
					.split(" holds code ")[0] as string,
				at: clock.mono(),
			})
			clock.advance(options.writeMs ?? 0)
			const barrier = input.searchBarrier !== undefined
			let visibleAt: number
			if (barrier) {
				visibleAt = options.barrierLies
					? clock.now() + 5_000
					: options.controlInvisible &&
							(input.body as string).includes("control")
						? Number.POSITIVE_INFINITY
						: clock.now()
			} else {
				unbarriered += 1
				visibleAt =
					unbarriered === options.neverVisibleIndex
						? Number.POSITIVE_INFINITY
						: clock.now() + (options.delayMs ?? 2_500)
			}
			events.push({ body: input.body as string, visibleAt })
			return {
				ok: true,
				eventId: `ev-${events.length}`,
				chunkCreated: true,
				...(barrier
					? {
							searchBarrier: {
								committed: true,
								status: "searchable",
								targets: [],
							},
						}
					: {}),
			}
		},
		search: async (input: Json) => {
			calls.push({
				kind: "search",
				label: (input.query as string)
					.replace("Which code does archive ", "")
					.replace(" hold?", ""),
				at: clock.mono(),
			})
			if (
				options.searchErrorsAfterMs !== undefined &&
				clock.mono() > options.searchErrorsAfterMs
			) {
				throw httpError(503, "SEARCH_LANES_UNAVAILABLE")
			}
			return {
				results: events
					.filter((event) => event.visibleAt <= clock.now())
					.map((event) => ({ snippet: event.body })),
				outcomes: { status: "complete", lanes: [] },
			}
		},
	}
	return { api, clock, events, calls }
}

function context(options: Options = {}, overrides = {}) {
	const fake = createFakeE(options)
	const ctx = createFakeContext(fake.api, { clock: fake.clock, ...overrides })
	return { fake, ctx }
}

describe("runProbeE", () => {
	it("passes and reports sampled intervals for every primary item", async () => {
		const { ctx } = context()
		const result = await runProbeE(ctx)
		expect(result.outcome).toBe("pass")
		const metrics = result.extra?.metrics as {
			primary: {
				intervals: { lowerMs: number; upperMs: number }[]
				observed: number
			}
		}
		expect(metrics.primary.observed).toBe(E_PRIMARY_N)
		for (const interval of metrics.primary.intervals) {
			expect(interval.lowerMs).toBe(2_000)
			expect(interval.upperMs).toBe(3_000)
		}
	})

	it("polls immediately and then at 1 s spacing", async () => {
		const { ctx, fake } = context({ delayMs: 3_500 })
		await runProbeE(ctx)
		const unique = [...new Set(fake.clock.sleeps)]
		expect(unique).toEqual([1_000])
	})

	it("polls each primary item right after its own acknowledgment, before the next item is written", async () => {
		const { ctx, fake } = context({ delayMs: 3_500, writeMs: 400 })
		await runProbeE(ctx)
		for (let index = 1; index < E_PRIMARY_N; index += 1) {
			const firstPoll = fake.calls.findIndex(
				(call) => call.kind === "search" && call.label === `shelf ${index}`,
			)
			const nextWrite = fake.calls.findIndex(
				(call) => call.kind === "write" && call.label === `shelf ${index + 1}`,
			)
			expect(firstPoll).toBeGreaterThan(-1)
			expect(firstPoll).toBeLessThan(nextWrite)
		}
	})

	it("dispatches the first poll at the item's own acknowledgment time", async () => {
		const { ctx, fake } = context({ delayMs: 3_500, writeMs: 400 })
		await runProbeE(ctx)
		for (let index = 1; index <= E_PRIMARY_N; index += 1) {
			const write = fake.calls.find(
				(call) => call.kind === "write" && call.label === `shelf ${index}`,
			)
			const poll = fake.calls.find(
				(call) => call.kind === "search" && call.label === `shelf ${index}`,
			)
			expect(poll?.at).toBe((write?.at ?? Number.NaN) + 400)
		}
	})

	it("keeps each item's own polls at least 1 s apart and not more than a write apart beyond that", async () => {
		const { ctx, fake } = context({ delayMs: 3_500, writeMs: 400 })
		await runProbeE(ctx)
		for (let index = 1; index <= E_PRIMARY_N; index += 1) {
			const times = fake.calls
				.filter(
					(call) => call.kind === "search" && call.label === `shelf ${index}`,
				)
				.map((call) => call.at)
			expect(times.length).toBeGreaterThan(2)
			for (let at = 1; at < times.length; at += 1) {
				const gap = (times[at] ?? 0) - (times[at - 1] ?? 0)
				expect(gap).toBeGreaterThanOrEqual(1_000)
				expect(gap).toBeLessThanOrEqual(1_400)
			}
		}
	})

	it("stops polling a never-visible item exactly 60 s after its dispatch", async () => {
		const { ctx, fake } = context({ neverVisibleIndex: 4 })
		await runProbeE(ctx)
		const times = fake.calls
			.filter((call) => call.kind === "search" && call.label === "shelf 4")
			.map((call) => call.at)
		const dispatch = fake.calls.find(
			(call) => call.kind === "write" && call.label === "shelf 4",
		)?.at
		expect(times).toHaveLength(E_DEADLINE_MS / E_POLL_STEP_MS + 1)
		expect((times.at(-1) ?? 0) - (dispatch ?? 0)).toBe(E_DEADLINE_MS)
	})

	it("stays within the announced call plan", async () => {
		const { ctx } = context({ neverVisibleIndex: 2 })
		await runProbeE(ctx)
		const plan = planProbeE()
		const counted = ctx.budget.snapshot().calls
		expect(counted["api-write"]).toBe(plan["api-write"])
		expect(counted["api-read"]).toBeLessThanOrEqual(plan["api-read"])
	})

	it("fails an item that never becomes visible and keeps the other items passing", async () => {
		const { ctx } = context({ neverVisibleIndex: 4 })
		const result = await runProbeE(ctx)
		const failed = result.cases.filter((item) => item.outcome === "fail")
		expect(failed.map((item) => item.caseId)).toEqual(["E/primary/item-4"])
		expect(result.counts.primaryCensored).toBe(1)
		expect(result.counts.primaryObserved).toBe(E_PRIMARY_N - 1)
		expect(result.outcome).toBe("fail")
	})

	it("fails the barrier variant when the barrier reports searchable but the item is invisible", async () => {
		const { ctx } = context({ barrierLies: true })
		const result = await runProbeE(ctx)
		const lies = result.cases.filter(
			(item) => item.predicate === "barrier-searchable-but-invisible",
		)
		expect(lies).toHaveLength(E_BARRIER_N)
	})

	it("is inconclusive when the already-visible control cannot be read", async () => {
		const { ctx } = context({ controlInvisible: true, neverVisibleIndex: 1 })
		const result = await runProbeE(ctx)
		expect(result.outcome).toBe("inconclusive")
		expect(
			result.cases.find((item) => item.caseId === "E/primary/item-1")?.outcome,
		).toBe("inconclusive")
	})

	it("treats an unhealthy read path as inconclusive, not as never-visible", async () => {
		const { ctx } = context({
			neverVisibleIndex: 4,
			searchErrorsAfterMs: 20_000,
		})
		const result = await runProbeE(ctx)
		expect(result.cases.some((item) => item.outcome === "fail")).toBe(false)
		expect(result.outcome).toBe("inconclusive")
	})

	it("reports what the status routes expose and what is unobservable", async () => {
		const { ctx } = context()
		const result = await runProbeE(ctx)
		const reported = result.extra?.reportedSettings as {
			status: { custom: unknown }
		}
		expect(reported.status.custom).toEqual({ database: "memongo_probe_x" })
		expect(result.extra?.unobservable).toEqual([
			"readiness-timeout",
			"readiness-poll-interval",
		])
	})

	it("records an unavailable status route instead of failing", async () => {
		const { ctx } = context({ statusFails: true })
		const result = await runProbeE(ctx)
		const reported = result.extra?.reportedSettings as {
			status: { unavailable: string }
		}
		expect(reported.status.unavailable).toBe("http-error")
		expect(result.outcome).toBe("pass")
	})

	it("keeps partial observations when the budget refuses", async () => {
		const budget = createBudget({
			ceilingUsd: 1,
			prices: {},
			caps: { "api-read": 25, "api-write": 100 },
		})
		const { ctx } = context({}, { budget })
		const result = await runProbeE(ctx)
		expect(result.reasons.join(" ")).toMatch(/budget-refusal:cap/)
		expect(result.outcome).toBe("inconclusive")
	})
})
