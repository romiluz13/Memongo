import type { MemongoScope } from "@memongo/client"
import {
	abortReason,
	API_READ,
	API_WRITE,
	asRecord,
	countedObserve,
	type ProbeContext,
} from "./context.ts"
import { evaluateRouteHealth } from "./health.ts"
import {
	classifyRead,
	E_BARRIER_N,
	E_DEADLINE_MS,
	E_POLL_STEP_MS,
	E_PRIMARY_N,
	type EControl,
	type EItem,
	type EPoll,
	evaluateProbeE,
	PROBE_E_RULE,
	PROBE_E_VERSION,
} from "./probe-e-model.ts"
import type { ProbeRunResult } from "./types.ts"

const CONTROL_WAIT_MS = 10_000
const BARRIER = { timeoutMs: 10_000 }

type Target = { agentId: string; scope: MemongoScope; scopeRef: string }

export function planProbeE(): { "api-read": number; "api-write": number } {
	const rounds = E_DEADLINE_MS / E_POLL_STEP_MS + 1
	const controlPolls = CONTROL_WAIT_MS / E_POLL_STEP_MS + 1
	return {
		"api-read": 2 + controlPolls + E_PRIMARY_N * rounds + E_BARRIER_N + 1,
		"api-write": 1 + E_PRIMARY_N + E_BARRIER_N,
	}
}

function sentence(label: string, marker: string): string {
	return `Archive ${label} holds code ${marker}`
}

async function pollItem(
	ctx: ProbeContext,
	target: Target,
	label: string,
): Promise<EPoll> {
	const atMs = ctx.clock.mono()
	const observation = await countedObserve(ctx, API_READ, "search", () =>
		ctx.api.search({
			query: `Which code does archive ${label} hold?`,
			limit: 20,
			...target,
		}),
	)
	return {
		atMs,
		observation,
		health: evaluateRouteHealth("search", observation),
		request: { route: "search", label },
	}
}

async function writeItem(
	ctx: ProbeContext,
	target: Target,
	input: {
		variant: EItem["variant"]
		index: number
		label: string
		marker: string
		barrier: boolean
	},
): Promise<EItem> {
	const dispatchAt = ctx.clock.mono()
	const observation = await countedObserve(ctx, API_WRITE, "writeEvent", () =>
		ctx.api.writeEvent({
			role: "user",
			body: sentence(input.label, input.marker),
			sessionId: `session-${input.variant}`,
			customId: ctx.token(`e-${input.variant}-${input.index}-`),
			...target,
			...(input.barrier ? { searchBarrier: BARRIER } : {}),
		}),
	)
	const ackAt = ctx.clock.mono()
	const body =
		observation.kind === "response" ? asRecord(observation.body) : undefined
	const barrier = asRecord(body?.searchBarrier)
	const ok = body !== undefined && typeof body.eventId === "string"
	return {
		variant: input.variant,
		index: input.index,
		marker: input.marker,
		dispatchAt,
		ackAt,
		ack: {
			ok,
			...(ok
				? {}
				: {
						reason:
							observation.kind === "http-error"
								? `http-${observation.status}`
								: observation.kind,
					}),
			...(barrier
				? {
						barrier: {
							...(typeof barrier.status === "string"
								? { status: barrier.status }
								: {}),
							...(typeof barrier.reason === "string"
								? { reason: barrier.reason }
								: {}),
						},
					}
				: {}),
		},
		polls: [],
	}
}

async function runControl(
	ctx: ProbeContext,
	target: Target,
	marker: string,
): Promise<EControl> {
	const control: EControl = { marker }
	const written = await writeItem(ctx, target, {
		variant: "barrier",
		index: 0,
		label: "control",
		marker,
		barrier: true,
	})
	if (!written.ack.ok) return control
	const start = ctx.clock.mono()
	for (;;) {
		const polled = await pollItem(ctx, target, "control")
		control.start = polled
		if (classifyRead(polled, marker) === "visible") break
		if (ctx.clock.mono() - start >= CONTROL_WAIT_MS) break
		await ctx.clock.sleep(E_POLL_STEP_MS)
	}
	return control
}

async function pollPrimary(
	ctx: ProbeContext,
	target: Target,
	items: EItem[],
): Promise<void> {
	let pending = items.filter((item) => item.ack.ok)
	while (pending.length > 0) {
		await Promise.all(
			pending.map(async (item) => {
				item.polls.push(await pollItem(ctx, target, `shelf ${item.index}`))
			}),
		)
		pending = pending.filter((item) => {
			const last = item.polls.at(-1)
			if (!last) return true
			if (classifyRead(last, item.marker) === "visible") return false
			return last.atMs - item.dispatchAt < E_DEADLINE_MS
		})
		if (pending.length > 0) await ctx.clock.sleep(E_POLL_STEP_MS)
	}
}

async function snapshotSettings(ctx: ProbeContext, agentId: string) {
	const status = await countedObserve(ctx, API_READ, "status", () =>
		ctx.api.status(agentId),
	)
	const detailed = await countedObserve(
		ctx,
		API_READ,
		"getDetailedStatus",
		() => ctx.api.getDetailedStatus(agentId),
	)
	const pick = (body: unknown, keys: string[]) => {
		const record = asRecord(body)
		return Object.fromEntries(
			keys
				.filter((key) => record?.[key] !== undefined)
				.map((key) => [key, record?.[key]]),
		)
	}
	const reported = {
		status:
			status.kind === "response"
				? pick(status.body, [
						"version",
						"provider",
						"model",
						"fts",
						"vector",
						"custom",
					])
				: { unavailable: status.kind },
		detailed:
			detailed.kind === "response"
				? pick(detailed.body, [
						"health",
						"projectionLag",
						"projectionHealth",
						"laneCoverage",
					])
				: { unavailable: detailed.kind },
	}
	return reported
}

export async function runProbeE(ctx: ProbeContext): Promise<ProbeRunResult> {
	const target: Target = {
		agentId: ctx.agentId(),
		scope: "workspace",
		scopeRef: ctx.token("probe-e-"),
	}
	const controlMarker = ctx.token("zqctl")
	const items: EItem[] = []
	let control: EControl = { marker: controlMarker }
	let reported: unknown = { unavailable: "not-read" }
	const notes: string[] = []
	try {
		reported = await snapshotSettings(ctx, target.agentId)
		control = await runControl(ctx, target, controlMarker)
		for (let index = 1; index <= E_PRIMARY_N; index += 1) {
			items.push(
				await writeItem(ctx, target, {
					variant: "primary",
					index,
					label: `shelf ${index}`,
					marker: ctx.token("zqe"),
					barrier: false,
				}),
			)
		}
		await pollPrimary(ctx, target, items)
		for (let index = 1; index <= E_BARRIER_N; index += 1) {
			const item = await writeItem(ctx, target, {
				variant: "barrier",
				index,
				label: `barrier shelf ${index}`,
				marker: ctx.token("zqb"),
				barrier: true,
			})
			if (item.ack.ok) {
				item.polls.push(await pollItem(ctx, target, `barrier shelf ${index}`))
			}
			items.push(item)
		}
		control.end = await pollItem(ctx, target, "control")
	} catch (error) {
		notes.push(abortReason(error))
	}
	const evaluation = evaluateProbeE({ control, items })
	return {
		probe: "E",
		run: ctx.run,
		rule: PROBE_E_RULE,
		version: PROBE_E_VERSION,
		outcome: evaluation.outcome,
		reasons: [...notes, ...evaluation.reasons],
		cases: evaluation.cases,
		counts: {
			primaryObserved: evaluation.metrics.primary.observed,
			primaryCensored: evaluation.metrics.primary.censored,
			primaryN: evaluation.metrics.primary.n,
			barrierN: evaluation.metrics.barrier.n,
		},
		extra: {
			metrics: evaluation.metrics,
			reportedSettings: reported,
			unobservable: ["readiness-timeout", "readiness-poll-interval"],
			barrierVariant:
				"labelled separately; not part of the primary latency statistics",
			agentId: target.agentId,
		},
	}
}
