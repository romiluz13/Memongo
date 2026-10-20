import { evaluateRouteHealth } from "./health.ts"
import {
	type evaluateProbeG,
	G_ROUTES,
	type GRead,
	type GRouteId,
	type GSequenceFacts,
} from "./probe-g-model.ts"

export type GItem = {
	value: string
	revision: number
	state: "active" | "invalidated"
	validTo?: string
	key?: string
}

const HANDLE = { agentId: "a", scope: "workspace", scopeRef: "w", id: "x" }

function lifecycleItem(item: GItem) {
	const key = item.key ?? "k"
	return {
		family: "structured",
		handle: {
			...HANDLE,
			family: "structured",
			revision: item.revision,
			state: item.state,
			...(item.validTo ? { validTo: item.validTo } : {}),
			structured: { type: "fact", key },
		},
		data: { type: "fact", key, value: item.value },
	}
}

const COMPLETE = { status: "complete", lanes: [] }

export function routeBody(
	route: GRouteId,
	shown: GItem[],
	history: { current: GItem; revisions: GItem[] } | undefined = undefined,
): unknown {
	switch (route) {
		case "lifecycleGet":
			return lifecycleItem(shown[0] as GItem)
		case "lifecycleHistory":
			return history
				? [
						{ historyKind: "current", ...lifecycleItem(history.current) },
						...history.revisions.map((item) => ({
							historyKind: "revision",
							...lifecycleItem(item),
						})),
					]
				: []
		case "searchDetailed":
			return {
				results: shown.map((item) => ({
					snippet: item.value,
					state: item.state,
					...(item.validTo ? { validTo: item.validTo } : {}),
				})),
				metadata: { outcomeStatus: "complete", laneOutcomes: [] },
			}
		case "search":
			return {
				results: shown.map((item) => ({ snippet: item.value })),
				outcomes: COMPLETE,
			}
		case "readFile": {
			const item = shown[0]
			return {
				text: item
					? [
							"type: fact",
							"key: k",
							`value: ${item.value}`,
							`revision: ${item.revision}`,
							`state: ${item.state}`,
							item.validTo ? `validTo: ${item.validTo}` : null,
						]
							.filter((line) => line !== null)
							.join("\n")
					: "",
			}
		}
		case "profile":
			return {
				agentId: "a",
				preferences: [],
				decisions: [],
				facts: shown.map((item) => ({ key: "k", value: item.value })),
				todos: [],
			}
		case "hydrateActiveSlate":
			return {
				items: shown.map((item) => ({
					summary: item.value,
					state: item.state,
				})),
				metadata: { truncated: false, partial: false },
			}
		case "state":
			return {
				profile: routeBody("profile", shown),
				blocks: { blocks: [], totalTokenBudget: 1, totalActualTokens: 0 },
				bundle: routeBody("buildContextBundle", shown),
			}
		case "buildDiscoveryProjection":
			return {
				sections: [
					{
						evidence: shown.map((item) => ({
							title: "t",
							summary: item.value,
						})),
					},
				],
				metadata: { partial: false },
			}
		case "buildContextBundle":
			return {
				rendered: shown.map((item) => item.value).join(" "),
				sections: [
					{
						kind: "query-evidence",
						items: shown.map((item) => ({
							summary: item.value,
							trust: {
								contradiction:
									item.state === "invalidated" ? "invalidated" : "none",
							},
						})),
						partial: false,
						truncated: false,
					},
				],
				metadata: {
					partial: false,
					truncated: false,
					sectionsIncluded: ["query-evidence"],
					outcomeStatus: "complete",
					laneOutcomes: [],
				},
			}
	}
}

export function makeRead(
	route: GRouteId,
	phase: GRead["phase"],
	body: unknown,
	at = 1_000,
): GRead {
	const observation = { kind: "response" as const, route, body }
	return {
		route,
		phase,
		at,
		observation,
		health: evaluateRouteHealth(route, observation, {
			sections: route === "buildContextBundle" ? ["query-evidence"] : undefined,
		}),
		request: { route },
	}
}

export const OLD_MARKER = "zqold7f3a"
export const NEW_MARKER = "zqnew7f3a"
export const ROUTES = Object.keys(G_ROUTES) as GRouteId[]
export const PRE_AT = 1_000
export const POST_AT = 5_000
export const PAST = new Date(2_000).toISOString()

export const oldItem: GItem = {
	value: `The launch codename is ${OLD_MARKER}`,
	revision: 1,
	state: "active",
}
export const newItem: GItem = {
	value: `The launch codename is ${NEW_MARKER}`,
	revision: 2,
	state: "active",
}
export const invalidated: GItem = {
	...oldItem,
	revision: 2,
	state: "invalidated",
	validTo: PAST,
}

function preReads(): GRead[] {
	return ROUTES.map((route) =>
		makeRead(
			route,
			"pre",
			routeBody(route, [oldItem], { current: oldItem, revisions: [] }),
			PRE_AT,
		),
	)
}

export function updateSequence(): GSequenceFacts {
	const reads = [
		...preReads(),
		...ROUTES.map((route) =>
			makeRead(
				route,
				"post",
				routeBody(route, [newItem], { current: newItem, revisions: [oldItem] }),
				POST_AT,
			),
		),
	]
	return {
		sequence: "update",
		oldMarker: OLD_MARKER,
		newMarker: NEW_MARKER,
		ack: { ok: true },
		reads,
	}
}

export function deleteSequence(): GSequenceFacts {
	const gone = ROUTES.map((route) => {
		const body =
			route === "lifecycleGet" || route === "readFile"
				? routeBody(route, [invalidated])
				: route === "lifecycleHistory"
					? routeBody(route, [], { current: invalidated, revisions: [oldItem] })
					: routeBody(route, [])
		return makeRead(route, "post", body, POST_AT)
	})
	return {
		sequence: "delete",
		oldMarker: OLD_MARKER,
		ack: { ok: true },
		reads: [...preReads(), ...gone],
	}
}

export function withPost(
	facts: GSequenceFacts,
	route: GRouteId,
	body: unknown,
): GSequenceFacts {
	return {
		...facts,
		reads: facts.reads.map((read) =>
			read.route === route && read.phase === "post"
				? makeRead(route, "post", body, POST_AT)
				: read,
		),
	}
}

export function withPre(
	facts: GSequenceFacts,
	route: GRouteId,
	body: unknown,
): GSequenceFacts {
	return {
		...facts,
		reads: facts.reads.map((read) =>
			read.route === route && read.phase === "pre"
				? makeRead(route, "pre", body, PRE_AT)
				: read,
		),
	}
}

export function caseOf(
	result: ReturnType<typeof evaluateProbeG>,
	sequence: string,
	route: string,
) {
	const found = result.cases.find(
		(item) => item.caseId === `G/${sequence}/${route}`,
	)
	if (!found) throw new Error(`missing G/${sequence}/${route}`)
	return found
}
