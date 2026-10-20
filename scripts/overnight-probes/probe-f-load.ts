import {
	abortReason,
	API_READ,
	API_WRITE,
	asRecord,
	countedObserve,
	type ProbeContext,
} from "./context.ts"
import { evaluateRouteHealth } from "./health.ts"
import { pollUntil, type Scope, stamped } from "./kit.ts"
import { containsMarker } from "./markers.ts"
import {
	classifySearch,
	classifyWrite,
	F_DRAIN_MS,
	F_DURATION_MS,
	F_PACE_MS,
	F_SAMPLE,
	F_SEARCHERS,
	F_TICKS,
	type FPhaseFacts,
} from "./probe-f-model.ts"

const BARRIER = { timeoutMs: 10_000 }
const SAMPLE_STEP_MS = 2_000
const STATUS_STEP_MS = 2_000
const SEARCH_LIMIT = 20
const CONTROL_PREFIX = "Concurrency control record"
const ENTRY_PREFIX = "Concurrency log entry"

export const F_SAMPLE_ROUNDS = F_DRAIN_MS / SAMPLE_STEP_MS + 1
export const F_STATUS_POLLS = F_DRAIN_MS / STATUS_STEP_MS + 1

export type PhaseSpec = { variant: "w20" | "w50"; writers: number }

export function planLoadPhase(spec: PhaseSpec): {
	"api-read": number
	"api-write": number
} {
	const settlePolls = 31
	return {
		"api-write": 1 + spec.writers * F_TICKS,
		"api-read":
			settlePolls +
			F_SEARCHERS * F_TICKS +
			F_STATUS_POLLS +
			F_SAMPLE * F_SAMPLE_ROUNDS,
	}
}

type Abort = { reason?: string }

type Shared = {
	facts: FPhaseFacts
	acked: string[]
	abort: Abort
}

async function paced(
	ctx: ProbeContext,
	start: number,
	offset: number,
	shared: Shared,
	op: () => Promise<void>,
): Promise<boolean> {
	let due = start + offset
	let started = false
	while (due < start + F_DURATION_MS && shared.abort.reason === undefined) {
		const wait = due - ctx.clock.mono()
		if (wait > 0) await ctx.clock.sleep(wait)
		if (shared.abort.reason !== undefined) break
		started = true
		try {
			await op()
		} catch (error) {
			shared.abort.reason ??= abortReason(error)
			break
		}
		due = Math.max(due + F_PACE_MS, ctx.clock.mono())
	}
	return started
}

async function writeOnce(
	ctx: ProbeContext,
	scope: Scope,
	shared: Shared,
	index: number,
): Promise<void> {
	const marker = ctx.token("zqf")
	const startedAt = ctx.clock.mono()
	const observation = await countedObserve(ctx, API_WRITE, "writeEvent", () =>
		ctx.api.writeEvent({
			role: "user",
			body: `${ENTRY_PREFIX} ${marker}`,
			sessionId: `session-f-${index}`,
			customId: ctx.token("f-"),
			...scope,
		}),
	)
	shared.facts.writes.attempted += 1
	shared.facts.writes.latenciesMs.push(ctx.clock.mono() - startedAt)
	const kind = classifyWrite(observation)
	if (kind === "acked") {
		shared.facts.writes.acked += 1
		shared.acked.push(marker)
	} else if (kind === "backpressure") {
		shared.facts.writes.backpressure += 1
	} else {
		shared.facts.writes.errors += 1
	}
}

async function searchOnce(
	ctx: ProbeContext,
	scope: Scope,
	shared: Shared,
	controlMarker: string,
): Promise<void> {
	const startedAt = ctx.clock.mono()
	const observation = await countedObserve(ctx, API_READ, "search", () =>
		ctx.api.search({
			query: `${CONTROL_PREFIX} ${controlMarker}`,
			limit: SEARCH_LIMIT,
			...scope,
		}),
	)
	shared.facts.searches.attempted += 1
	shared.facts.searches.latenciesMs.push(ctx.clock.mono() - startedAt)
	const kind = classifySearch(
		observation,
		evaluateRouteHealth("search", observation),
		controlMarker,
	)
	const { searches } = shared.facts
	if (kind === "healthy") searches.healthy += 1
	else if (kind === "healthy-missing-control")
		searches.healthyMissingControl += 1
	else if (kind === "degraded") searches.degraded += 1
	else if (kind === "backpressure") searches.backpressure += 1
	else searches.errors += 1
}

async function seedControl(
	ctx: ProbeContext,
	scope: Scope,
	controlMarker: string,
): Promise<boolean> {
	const written = await countedObserve(ctx, API_WRITE, "writeEvent", () =>
		ctx.api.writeEvent({
			role: "user",
			body: `${CONTROL_PREFIX} ${controlMarker}`,
			sessionId: "session-f-control",
			customId: ctx.token("f-control-"),
			searchBarrier: BARRIER,
			...scope,
		}),
	)
	if (classifyWrite(written) !== "acked") return false
	const settle = await pollUntil(
		ctx,
		() =>
			stamped(ctx, "search", "pre", (api) =>
				api.search({
					query: `${CONTROL_PREFIX} ${controlMarker}`,
					limit: SEARCH_LIMIT,
					...scope,
				}),
			),
		(read) =>
			read.health.evaluable && containsMarker(read.observation, controlMarker),
	)
	return settle.satisfied
}

function trustedCount(body: unknown): number | undefined {
	const status = asRecord(body)
	const events = asRecord(status?.events)
	const health = asRecord(status?.health)
	const failed = Array.isArray(health?.failedChecks) ? health.failedChecks : []
	if (typeof events?.count !== "number") return undefined
	if (failed.includes("events.count")) return undefined
	if (health?.dataCompleteness === "partial") return undefined
	return events.count
}

export async function verifyCount(
	ctx: ProbeContext,
	scope: Scope,
	expectedMin: number,
): Promise<{ trusted: boolean; count?: number }> {
	const start = ctx.clock.mono()
	let last: number | undefined
	for (;;) {
		const observation = await countedObserve(
			ctx,
			API_READ,
			"getDetailedStatus",
			() => ctx.api.getDetailedStatus(scope.agentId),
		)
		const count =
			observation.kind === "response"
				? trustedCount(observation.body)
				: undefined
		if (count !== undefined) last = count
		if (
			(count !== undefined && count >= expectedMin) ||
			ctx.clock.mono() - start >= F_DRAIN_MS
		) {
			return last === undefined
				? { trusted: false }
				: { trusted: true, count: last }
		}
		await ctx.clock.sleep(STATUS_STEP_MS)
	}
}

function sampleOf(acked: readonly string[]): string[] {
	const size = Math.min(F_SAMPLE, acked.length)
	return Array.from(
		{ length: size },
		(_, index) => acked[Math.floor((index * acked.length) / size)] as string,
	)
}

async function verifySample(
	ctx: ProbeContext,
	scope: Scope,
	acked: readonly string[],
): Promise<{ sampled: number; found: number; unverified: number }> {
	const pending = new Map(sampleOf(acked).map((marker) => [marker, true]))
	const sampled = pending.size
	let found = 0
	const lastUnverified = new Set<string>()
	for (let round = 0; round < F_SAMPLE_ROUNDS && pending.size > 0; round++) {
		for (const marker of [...pending.keys()]) {
			const observation = await countedObserve(ctx, API_READ, "search", () =>
				ctx.api.search({
					query: `${ENTRY_PREFIX} ${marker}`,
					limit: SEARCH_LIMIT,
					...scope,
				}),
			)
			const health = evaluateRouteHealth("search", observation)
			if (!health.evaluable) {
				lastUnverified.add(marker)
			} else {
				lastUnverified.delete(marker)
				if (containsMarker(observation, marker)) {
					pending.delete(marker)
					found += 1
				}
			}
		}
		if (pending.size > 0 && round < F_SAMPLE_ROUNDS - 1) {
			await ctx.clock.sleep(SAMPLE_STEP_MS)
		}
	}
	const unverified = [...pending.keys()].filter((marker) =>
		lastUnverified.has(marker),
	).length
	return { sampled, found, unverified }
}

function emptyFacts(spec: PhaseSpec): FPhaseFacts {
	return {
		variant: spec.variant,
		writers: spec.writers,
		searchers: F_SEARCHERS,
		durationMs: F_DURATION_MS,
		elapsedMs: 0,
		startedWriters: 0,
		startedSearchers: 0,
		scheduledWrites: spec.writers * F_TICKS,
		scheduledSearches: F_SEARCHERS * F_TICKS,
		writes: {
			attempted: 0,
			acked: 0,
			backpressure: 0,
			errors: 0,
			latenciesMs: [],
		},
		searches: {
			attempted: 0,
			healthy: 0,
			healthyMissingControl: 0,
			degraded: 0,
			backpressure: 0,
			errors: 0,
			latenciesMs: [],
		},
		controlSeeded: false,
		verification: {
			statusTrusted: false,
			sampled: 0,
			sampledFound: 0,
			sampledUnverified: 0,
		},
	}
}

export async function runLoadPhase(
	ctx: ProbeContext,
	spec: PhaseSpec,
): Promise<FPhaseFacts> {
	const scope: Scope = {
		agentId: ctx.agentId(),
		scope: "workspace",
		scopeRef: ctx.token("probe-f-"),
	}
	const shared: Shared = { facts: emptyFacts(spec), acked: [], abort: {} }
	const controlMarker = ctx.token("zqfctl")
	try {
		shared.facts.controlSeeded = await seedControl(ctx, scope, controlMarker)
		if (!shared.facts.controlSeeded) return shared.facts
		const start = ctx.clock.mono()
		const writers = Array.from({ length: spec.writers }, (_, index) =>
			paced(ctx, start, (index * F_PACE_MS) / spec.writers, shared, () =>
				writeOnce(ctx, scope, shared, index),
			),
		)
		const searchers = Array.from({ length: F_SEARCHERS }, (_, index) =>
			paced(ctx, start, (index * F_PACE_MS) / F_SEARCHERS, shared, () =>
				searchOnce(ctx, scope, shared, controlMarker),
			),
		)
		const started = await Promise.all([...writers, ...searchers])
		shared.facts.startedWriters = started
			.slice(0, spec.writers)
			.filter(Boolean).length
		shared.facts.startedSearchers = started
			.slice(spec.writers)
			.filter(Boolean).length
		const remaining = start + F_DURATION_MS - ctx.clock.mono()
		if (shared.abort.reason === undefined && remaining > 0) {
			await ctx.clock.sleep(remaining)
		}
		shared.facts.elapsedMs = ctx.clock.mono() - start
		if (shared.abort.reason !== undefined) {
			shared.facts.aborted = shared.abort.reason
			return shared.facts
		}
		const count = await verifyCount(ctx, scope, shared.facts.writes.acked + 1)
		const sample = await verifySample(ctx, scope, shared.acked)
		shared.facts.verification = {
			statusTrusted: count.trusted,
			...(count.count !== undefined ? { eventsCount: count.count } : {}),
			sampled: sample.sampled,
			sampledFound: sample.found,
			sampledUnverified: sample.unverified,
		}
	} catch (error) {
		shared.facts.aborted = abortReason(error)
	}
	return shared.facts
}
