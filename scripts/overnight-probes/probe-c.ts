import type { MemongoStructuredStableHandle } from "@memongo/client"
import {
	abortReason,
	API_WRITE,
	asRecord,
	countedObserve,
	type ProbeContext,
} from "./context.ts"
import {
	MAX_POLLS,
	pollUntil,
	resolveLiveHandle,
	type Scope,
	stamped,
} from "./kit.ts"
import { bodyContains, containsMarker } from "./markers.ts"
import {
	type CSequenceFacts,
	evaluateProbeC,
	PROBE_C_RULE,
	PROBE_C_VERSION,
} from "./probe-c-model.ts"
import type { GRead } from "./probe-g-model.ts"
import type { ProbeRunResult } from "./types.ts"

const BARRIER = { timeoutMs: 10_000 }

function handleFor(
	scope: Scope,
	key: string,
	id: string,
): MemongoStructuredStableHandle {
	return {
		family: "structured",
		id,
		agentId: scope.agentId,
		scope: scope.scope,
		scopeRef: scope.scopeRef,
		revision: 1,
		state: "active",
		structured: { type: "fact", key },
	}
}

export function planProbeC(): { "api-read": number; "api-write": number } {
	const updateReads = 1 + MAX_POLLS + 1 + 1 + MAX_POLLS + 2
	const supersedeReads = MAX_POLLS + 1 + MAX_POLLS + 2
	const automaticReads = MAX_POLLS + 2
	return {
		"api-read": updateReads + supersedeReads + automaticReads,
		"api-write": 7,
	}
}

function searchRead(
	ctx: ProbeContext,
	scope: Scope,
	query: string,
	phase: GRead["phase"],
	route: "search" | "searchDetailed" = "search",
): Promise<GRead> {
	return stamped(
		ctx,
		route,
		phase,
		() =>
			route === "search"
				? ctx.api.search({ query, limit: 20, ...scope })
				: ctx.api.searchDetailed({ query, limit: 20, ...scope }),
		{ route, phase, query },
	)
}

async function seedFact(
	ctx: ProbeContext,
	scope: Scope,
	key: string,
	value: string,
): Promise<string | undefined> {
	const written = await countedObserve(ctx, API_WRITE, "writeStructured", () =>
		ctx.api.writeStructured({
			agentId: scope.agentId,
			searchBarrier: BARRIER,
			entry: {
				type: "fact",
				key,
				value,
				salience: "critical",
				source: "user",
				scope: scope.scope,
				scopeRef: scope.scopeRef,
			},
		}),
	)
	const body = written.kind === "response" ? asRecord(written.body) : undefined
	return body && typeof body.id === "string" && body.quarantined !== true
		? body.id
		: undefined
}

function ackOf(
	observation: Awaited<ReturnType<typeof countedObserve>>,
): CSequenceFacts["ack"] {
	if (observation.kind === "response") {
		return asRecord(observation.body)?.quarantined === true
			? { ok: false, reason: "quarantined" }
			: { ok: true }
	}
	return {
		ok: false,
		reason:
			observation.kind === "http-error"
				? `http-${observation.status}`
				: "transport-error",
	}
}

async function runUpdate(
	ctx: ProbeContext,
	scope: Scope,
	notes: string[],
): Promise<CSequenceFacts | undefined> {
	const oldMarker = ctx.token("zqcold")
	const newMarker = ctx.token("zqcnew")
	const key = ctx.token("launch-pad-codename-")
	const query = "What is the launch pad codename?"
	const id = await seedFact(
		ctx,
		scope,
		key,
		`The launch pad codename is ${oldMarker}`,
	)
	if (!id) {
		notes.push("seed-failed:update")
		return undefined
	}
	const seedHandle = handleFor(scope, key, id)
	const firstGet = await stamped(
		ctx,
		"lifecycleGet",
		"pre",
		() => ctx.api.getLifecycleItem({ handle: seedHandle }),
		{ route: "lifecycleGet", phase: "pre" },
	)
	const reads: GRead[] = [firstGet]
	const live = resolveLiveHandle(seedHandle, firstGet)
	if (!live.ok) {
		notes.push(`handle-invalid:update:${live.reason}`)
		return undefined
	}
	const handle = live.handle
	const pre = await pollUntil(
		ctx,
		() => searchRead(ctx, scope, query, "pre"),
		(read) =>
			read.health.evaluable && containsMarker(read.observation, oldMarker),
	)
	reads.push(pre.last)
	const mutation = await countedObserve(ctx, API_WRITE, "updateLifecycle", () =>
		ctx.api.updateLifecycleItem({
			handle,
			patch: { value: `The launch pad codename is ${newMarker}` },
		}),
	)
	const ack = ackOf(mutation)
	let settled = false
	if (ack.ok) {
		reads.push(
			await stamped(
				ctx,
				"lifecycleGet",
				"post",
				() => ctx.api.getLifecycleItem({ handle }),
				{ route: "lifecycleGet", phase: "post" },
			),
			await stamped(
				ctx,
				"lifecycleHistory",
				"post",
				() => ctx.api.getLifecycleHistory({ handle, limit: 20 }),
				{ route: "lifecycleHistory", phase: "post" },
			),
		)
		const settle = await pollUntil(
			ctx,
			() => searchRead(ctx, scope, query, "post"),
			(read) =>
				read.health.evaluable && containsMarker(read.observation, newMarker),
		)
		settled = settle.satisfied
		reads.push(
			settle.last,
			await searchRead(ctx, scope, query, "post", "searchDetailed"),
		)
	}
	return {
		sequence: "update",
		oldMarker,
		newMarker,
		ack,
		settled,
		reads,
	}
}

async function runSupersede(
	ctx: ProbeContext,
	scope: Scope,
	notes: string[],
): Promise<CSequenceFacts | undefined> {
	const oldMarker = ctx.token("zqcold")
	const newMarker = ctx.token("zqcnew")
	const oldKey = ctx.token("harbor-beacon-old-")
	const newKey = ctx.token("harbor-beacon-new-")
	const query = "What is the harbor beacon codename?"
	const oldId = await seedFact(
		ctx,
		scope,
		oldKey,
		`The harbor beacon codename is ${oldMarker}`,
	)
	const newId = await seedFact(
		ctx,
		scope,
		newKey,
		`The harbor beacon codename is ${newMarker}`,
	)
	if (!oldId || !newId) {
		notes.push("seed-failed:supersede")
		return undefined
	}
	const handle = handleFor(scope, oldKey, oldId)
	const pre = await pollUntil(
		ctx,
		() => searchRead(ctx, scope, query, "pre"),
		(read) =>
			read.health.evaluable &&
			containsMarker(read.observation, oldMarker) &&
			containsMarker(read.observation, newMarker),
	)
	const reads: GRead[] = [pre.last]
	const mutation = await countedObserve(ctx, API_WRITE, "deleteLifecycle", () =>
		ctx.api.deleteLifecycleItem({
			handle,
			invalidatedBy: {
				type: "fact",
				key: newKey,
				id: newId,
				reason: "superseded",
			},
		}),
	)
	const ack = ackOf(mutation)
	let settled = false
	if (ack.ok) {
		reads.push(
			await stamped(
				ctx,
				"readFile",
				"post",
				() =>
					ctx.api.readFile({
						relPath: `structured:fact:${oldKey}?scope=${scope.scope}&scopeRef=${scope.scopeRef}`,
						agentId: scope.agentId,
					}),
				{ route: "readFile", phase: "post", key: oldKey },
			),
		)
		const settle = await pollUntil(
			ctx,
			() => searchRead(ctx, scope, query, "post"),
			(read) =>
				read.health.evaluable && !containsMarker(read.observation, oldMarker),
		)
		settled = settle.satisfied
		reads.push(
			settle.last,
			await searchRead(ctx, scope, query, "post", "searchDetailed"),
		)
	}
	return {
		sequence: "supersede",
		oldMarker,
		newMarker,
		newKey,
		ack,
		settled,
		reads,
	}
}

async function observeAutomaticCorrection(
	ctx: ProbeContext,
	scope: Scope,
): Promise<Record<string, unknown>> {
	const oldMarker = ctx.token("zqaold")
	const newMarker = ctx.token("zqanew")
	const query = "What is the favorite beverage?"
	const write = (body: string, timestamp: string) =>
		countedObserve(ctx, API_WRITE, "writeEvent", () =>
			ctx.api.writeEvent({
				role: "user",
				body,
				timestamp,
				customId: ctx.token("auto-"),
				searchBarrier: BARRIER,
				...scope,
			}),
		)
	const older = await write(
		`My favorite beverage is ${oldMarker}`,
		new Date(ctx.clock.now() - 60_000).toISOString(),
	)
	const newer = await write(
		`Correction: my favorite beverage is actually ${newMarker}`,
		new Date(ctx.clock.now()).toISOString(),
	)
	if (older.kind !== "response" || newer.kind !== "response") {
		return { observed: false, reason: "event write failed" }
	}
	const settle = await pollUntil(
		ctx,
		() => searchRead(ctx, scope, query, "post"),
		(read) =>
			read.health.evaluable && containsMarker(read.observation, newMarker),
	)
	const detailed = await searchRead(ctx, scope, query, "post", "searchDetailed")
	const rank = (read: GRead, marker: string) => {
		const body = asRecord(
			read.observation.kind === "response" ? read.observation.body : undefined,
		)
		const list = Array.isArray(body?.results) ? body.results : []
		return list.findIndex((row) => bodyContains(row, marker))
	}
	return {
		observed: true,
		kind: "capability observation, not part of the verdict",
		healthy: settle.last.health.evaluable,
		newVisible: settle.satisfied,
		search: {
			newRank: rank(settle.last, newMarker),
			oldRank: rank(settle.last, oldMarker),
		},
		searchDetailed: {
			healthy: detailed.health.evaluable,
			newRank: rank(detailed, newMarker),
			oldRank: rank(detailed, oldMarker),
		},
	}
}

export async function runProbeC(ctx: ProbeContext): Promise<ProbeRunResult> {
	const scope: Scope = {
		agentId: ctx.agentId(),
		scope: "workspace",
		scopeRef: ctx.token("probe-c-"),
	}
	const facts: CSequenceFacts[] = []
	const notes: string[] = []
	let automatic: Record<string, unknown> = {
		observed: false,
		reason: "not-reached",
	}
	try {
		for (const run of [runUpdate, runSupersede]) {
			const sequence = await run(ctx, scope, notes)
			if (sequence) facts.push(sequence)
		}
		automatic = await observeAutomaticCorrection(ctx, scope)
	} catch (error) {
		notes.push(abortReason(error))
	}
	const evaluation = evaluateProbeC(facts)
	const failed = evaluation.cases.some((item) => item.outcome === "fail")
	const outcome =
		evaluation.outcome === "not-run" && !failed
			? "inconclusive"
			: evaluation.outcome
	return {
		probe: "C",
		run: ctx.run,
		rule: PROBE_C_RULE,
		version: PROBE_C_VERSION,
		outcome,
		reasons: [...notes, ...evaluation.reasons],
		cases: evaluation.cases,
		counts: evaluation.counts,
		extra: { automaticCorrection: automatic, agentId: scope.agentId },
	}
}
