import type {
	MemongoScope,
	MemongoStructuredStableHandle,
} from "@memongo/client"
import {
	abortReason,
	API_READ,
	API_WRITE,
	asRecord,
	countedObserve,
	type ProbeContext,
} from "./context.ts"
import { evaluateRouteHealth } from "./health.ts"
import { SETTLE_MAX_MS, SETTLE_STEP_MS } from "./kit.ts"
import { containsMarker } from "./markers.ts"
import {
	evaluateProbeG,
	G_ROUTES,
	type GRead,
	type GRouteId,
	type GSequenceFacts,
	PROBE_G_RULE,
	PROBE_G_VERSION,
} from "./probe-g-model.ts"
import type { ProbeApi } from "./probe-api.ts"
import type { Observation, ProbeRunResult } from "./types.ts"

const BARRIER = { timeoutMs: 10_000 }
const ROUTES = Object.keys(G_ROUTES) as GRouteId[]

type Target = {
	agentId: string
	scope: MemongoScope
	scopeRef: string
	key: string
	query: string
}

type Call = (
	api: ProbeApi,
	target: Target,
	handle: MemongoStructuredStableHandle,
) => Promise<unknown>

function coords(target: Target) {
	return {
		agentId: target.agentId,
		scope: target.scope,
		scopeRef: target.scopeRef,
	}
}

const CALLS: Record<GRouteId, Call> = {
	lifecycleGet: (api, _target, handle) => api.getLifecycleItem({ handle }),
	lifecycleHistory: (api, _target, handle) =>
		api.getLifecycleHistory({ handle, limit: 20 }),
	searchDetailed: (api, target) =>
		api.searchDetailed({ query: target.query, limit: 20, ...coords(target) }),
	readFile: (api, target) =>
		api.readFile({
			relPath: `structured:fact:${target.key}?scope=${target.scope}&scopeRef=${target.scopeRef}`,
			agentId: target.agentId,
		}),
	search: (api, target) =>
		api.search({ query: target.query, limit: 20, ...coords(target) }),
	profile: (api, target) => api.profile(coords(target)),
	hydrateActiveSlate: (api, target) => api.hydrateActiveSlate(coords(target)),
	state: (api, target) => api.state(coords(target)),
	buildDiscoveryProjection: (api, target) =>
		api.buildDiscoveryProjection({
			kind: "topic-brief",
			query: target.query,
			...coords(target),
		}),
	buildContextBundle: (api, target) =>
		api.buildContextBundle({ query: target.query, ...coords(target) }),
}

export function planProbeG(): { "api-read": number; "api-write": number } {
	const polls = SETTLE_MAX_MS / SETTLE_STEP_MS + 1
	return {
		"api-read": 2 * (ROUTES.length * 2 + polls),
		"api-write": 4,
	}
}

function handleFor(
	target: Target,
	id: string,
	revision = 1,
): MemongoStructuredStableHandle {
	return {
		family: "structured",
		id,
		agentId: target.agentId,
		scope: target.scope,
		scopeRef: target.scopeRef,
		revision,
		state: "active",
		structured: { type: "fact", key: target.key },
	}
}

async function readRoute(
	ctx: ProbeContext,
	route: GRouteId,
	phase: GRead["phase"],
	target: Target,
	handle: MemongoStructuredStableHandle,
): Promise<GRead> {
	const at = ctx.clock.now()
	const observation = await countedObserve(ctx, API_READ, route, () =>
		CALLS[route](ctx.api, target, handle),
	)
	return {
		route,
		phase,
		at,
		observation,
		health: evaluateRouteHealth(
			route,
			observation,
			route === "buildContextBundle" ? { sections: ["query-evidence"] } : {},
		),
		request: {
			route,
			phase,
			key: target.key,
			handle: { revision: handle.revision },
		},
	}
}

function liveHandle(
	fallback: MemongoStructuredStableHandle,
	pre: GRead | undefined,
): MemongoStructuredStableHandle {
	if (pre?.observation.kind !== "response") return fallback
	const handle = asRecord(asRecord(pre.observation.body)?.handle)
	return handle && typeof handle.revision === "number"
		? ({ ...fallback, ...handle } as MemongoStructuredStableHandle)
		: fallback
}

async function settle(
	ctx: ProbeContext,
	target: Target,
	done: (observation: Observation) => boolean,
): Promise<{ polls: number; elapsedMs: number; satisfied: boolean }> {
	const start = ctx.clock.now()
	let polls = 0
	for (;;) {
		const observation = await countedObserve(ctx, API_READ, "search", () =>
			CALLS.search(ctx.api, target, handleFor(target, "")),
		)
		polls += 1
		if (done(observation)) {
			return { polls, elapsedMs: ctx.clock.now() - start, satisfied: true }
		}
		if (ctx.clock.now() - start >= SETTLE_MAX_MS) {
			return { polls, elapsedMs: ctx.clock.now() - start, satisfied: false }
		}
		await ctx.clock.sleep(SETTLE_STEP_MS)
	}
}

type Spec = {
	sequence: "update" | "delete"
	oldMarker: string
	newMarker?: string
	oldValue: string
	newValue?: string
	query: string
	keyPrefix: string
}

function specs(ctx: ProbeContext): Spec[] {
	const oldA = ctx.token("zqold")
	const newA = ctx.token("zqnew")
	const oldB = ctx.token("zqgone")
	return [
		{
			sequence: "update",
			oldMarker: oldA,
			newMarker: newA,
			oldValue: `The launch codename is ${oldA}`,
			newValue: `The launch codename is ${newA}`,
			query: "What is the launch codename?",
			keyPrefix: "launch-codename-",
		},
		{
			sequence: "delete",
			oldMarker: oldB,
			oldValue: `The vault access code is ${oldB}`,
			query: "What is the vault access code?",
			keyPrefix: "vault-access-code-",
		},
	]
}

async function runSequence(
	ctx: ProbeContext,
	spec: Spec,
	base: { agentId: string; scope: MemongoScope; scopeRef: string },
	notes: string[],
	settleLog: Record<string, unknown>,
): Promise<GSequenceFacts | undefined> {
	const target: Target = {
		...base,
		key: ctx.token(spec.keyPrefix),
		query: spec.query,
	}
	const written = await countedObserve(ctx, API_WRITE, "writeStructured", () =>
		ctx.api.writeStructured({
			agentId: target.agentId,
			searchBarrier: BARRIER,
			entry: {
				type: "fact",
				key: target.key,
				value: spec.oldValue,
				salience: "critical",
				source: "user",
				scope: target.scope,
				scopeRef: target.scopeRef,
			},
		}),
	)
	const body = written.kind === "response" ? asRecord(written.body) : undefined
	if (!body || typeof body.id !== "string" || body.quarantined === true) {
		notes.push(`seed-failed:${spec.sequence}:${written.kind}`)
		return undefined
	}
	const reads: GRead[] = []
	const seedHandle = handleFor(target, body.id)
	const firstGet = await readRoute(
		ctx,
		"lifecycleGet",
		"pre",
		target,
		seedHandle,
	)
	reads.push(firstGet)
	const handle = liveHandle(seedHandle, firstGet)
	for (const route of ROUTES) {
		if (route === "lifecycleGet") continue
		reads.push(await readRoute(ctx, route, "pre", target, handle))
	}
	const mutation = await countedObserve(
		ctx,
		API_WRITE,
		`${spec.sequence}Lifecycle`,
		() =>
			spec.sequence === "update"
				? ctx.api.updateLifecycleItem({
						handle,
						patch: { value: spec.newValue ?? "" },
					})
				: ctx.api.deleteLifecycleItem({
						handle,
						invalidatedBy: { reason: "probe-g-revocation" },
					}),
	)
	const ack =
		mutation.kind === "response" &&
		asRecord(mutation.body)?.quarantined !== true
			? { ok: true }
			: {
					ok: false,
					reason:
						mutation.kind === "http-error"
							? `http-${mutation.status}`
							: mutation.kind === "response"
								? "quarantined"
								: "transport-error",
				}
	if (ack.ok) {
		reads.push(await readRoute(ctx, "lifecycleGet", "post", target, handle))
		const update = spec.sequence === "update"
		settleLog[spec.sequence] = await settle(ctx, target, (observation) =>
			update
				? containsMarker(observation, spec.newMarker ?? "")
				: evaluateRouteHealth("search", observation).evaluable &&
					!containsMarker(observation, spec.oldMarker),
		)
		for (const route of ROUTES) {
			if (route === "lifecycleGet") continue
			reads.push(await readRoute(ctx, route, "post", target, handle))
		}
	}
	return {
		sequence: spec.sequence,
		oldMarker: spec.oldMarker,
		...(spec.newMarker ? { newMarker: spec.newMarker } : {}),
		ack,
		reads,
	}
}

export async function runProbeG(ctx: ProbeContext): Promise<ProbeRunResult> {
	const base = {
		agentId: ctx.agentId(),
		scope: "workspace" as MemongoScope,
		scopeRef: ctx.token("probe-g-"),
	}
	const facts: GSequenceFacts[] = []
	const notes: string[] = []
	const settleLog: Record<string, unknown> = {}
	try {
		for (const spec of specs(ctx)) {
			const result = await runSequence(ctx, spec, base, notes, settleLog)
			if (result) facts.push(result)
		}
	} catch (error) {
		notes.push(abortReason(error))
	}
	const evaluation = evaluateProbeG(facts)
	const failed = evaluation.cases.some((item) => item.outcome === "fail")
	const outcome =
		evaluation.outcome === "not-run" && !failed
			? "inconclusive"
			: evaluation.outcome
	return {
		probe: "G",
		run: ctx.run,
		rule: PROBE_G_RULE,
		version: PROBE_G_VERSION,
		outcome,
		reasons: [...notes, ...evaluation.reasons],
		cases: evaluation.cases,
		counts: evaluation.counts,
		extra: {
			gaps: evaluation.gaps,
			bases: G_ROUTES,
			settle: settleLog,
			agentId: base.agentId,
		},
	}
}
