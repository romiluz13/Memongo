import {
	abortReason,
	API_READ,
	API_WRITE,
	asRecord,
	countedObserve,
	type ProbeContext,
} from "./context.ts"
import { evaluateRouteHealth } from "./health.ts"
import { MAX_POLLS, pollUntil, type Scope, stamped } from "./kit.ts"
import { findMarkers } from "./markers.ts"
import {
	D_DETAILED_RANGE,
	D_EVENTS,
	D_GAPS,
	D_QUERIES,
	type DQuery,
	type DQueryRead,
	evaluateProbeD,
	PROBE_D_RULE,
	PROBE_D_VERSION,
} from "./probe-d-model.ts"
import type { GRead } from "./probe-g-model.ts"
import type { ProbeRunResult } from "./types.ts"

const DETAILED_QUERY = "dated archive log entry"
const SETTLED_LABELS = ["E1", "E3", "E5"]

export function planProbeD(): { "api-read": number; "api-write": number } {
	return {
		"api-read": D_QUERIES.length + MAX_POLLS + 1,
		"api-write": D_EVENTS.length,
	}
}

async function recallRead(
	ctx: ProbeContext,
	scope: Scope,
	query: DQuery,
): Promise<DQueryRead> {
	const request = { ...query.request, ...scope }
	const observation = await countedObserve(
		ctx,
		API_READ,
		"recallConversation",
		() => ctx.api.recallConversation(request),
	)
	return {
		queryId: query.id,
		observation,
		health: evaluateRouteHealth("recallConversation", observation),
		request,
	}
}

function asQueryRead(read: GRead, queryId: string): DQueryRead {
	return {
		queryId,
		observation: read.observation,
		health: read.health,
		request: read.request,
	}
}

export async function runProbeD(ctx: ProbeContext): Promise<ProbeRunResult> {
	const scope: Scope = {
		agentId: ctx.agentId(),
		scope: "workspace",
		scopeRef: ctx.token("probe-d-"),
	}
	const markers: Record<string, string> = {}
	const labels = new Map<string, string>()
	const acknowledged: string[] = []
	const notes: string[] = []
	const reads: DQueryRead[] = []
	let detailed:
		| { read: DQueryRead; control: DQueryRead; markers: Record<string, string> }
		| undefined
	try {
		for (const item of D_EVENTS) {
			markers[item.label] = ctx.token("zqd")
			const written = await countedObserve(ctx, API_WRITE, "writeEvent", () =>
				ctx.api.writeEvent({
					role: "user",
					body: `Dated archive log entry ${markers[item.label]}`,
					sessionId: "session-d",
					timestamp: item.timestamp,
					validAt: item.validAt,
					...(item.invalidAt ? { invalidAt: item.invalidAt } : {}),
					customId: ctx.token(`d-${item.label.toLowerCase()}-`),
					...scope,
				}),
			)
			const body =
				written.kind === "response" ? asRecord(written.body) : undefined
			if (body && typeof body.eventId === "string") {
				labels.set(body.eventId, item.label)
				acknowledged.push(item.label)
			} else {
				notes.push(`write-failed:${item.label}`)
			}
		}
		for (const query of D_QUERIES) {
			reads.push(await recallRead(ctx, scope, query))
		}
		const settle = await pollUntil(
			ctx,
			() =>
				stamped(
					ctx,
					"searchDetailed",
					"pre",
					() =>
						ctx.api.searchDetailed({
							query: DETAILED_QUERY,
							limit: 20,
							...scope,
						}),
					{ route: "searchDetailed", query: DETAILED_QUERY, range: "none" },
				),
			(read) => {
				if (!read.health.evaluable) return false
				const found = findMarkers(read.observation, markers)
				return SETTLED_LABELS.every((label) => found.includes(label))
			},
		)
		const ranged = await stamped(
			ctx,
			"searchDetailed",
			"post",
			() =>
				ctx.api.searchDetailed({
					query: DETAILED_QUERY,
					limit: 20,
					timeRange: { ...D_DETAILED_RANGE },
					...scope,
				}),
			{
				route: "searchDetailed",
				query: DETAILED_QUERY,
				range: D_DETAILED_RANGE,
			},
		)
		detailed = {
			read: asQueryRead(ranged, "timeRange"),
			control: asQueryRead(settle.last, "timeRange-control"),
			markers,
		}
	} catch (error) {
		notes.push(abortReason(error))
	}
	const evaluation = evaluateProbeD({
		reads,
		labelOf: (eventId) => labels.get(eventId),
		acknowledged,
		...(detailed ? { detailed } : {}),
	})
	const failed = evaluation.cases.some((item) => item.outcome === "fail")
	return {
		probe: "D",
		run: ctx.run,
		rule: PROBE_D_RULE,
		version: PROBE_D_VERSION,
		outcome:
			evaluation.outcome === "not-run" && !failed
				? "inconclusive"
				: evaluation.outcome,
		reasons: [...notes, ...evaluation.reasons],
		cases: evaluation.cases,
		counts: evaluation.counts,
		extra: { agentId: scope.agentId, coverageGaps: D_GAPS },
	}
}
