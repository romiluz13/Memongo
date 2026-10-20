import { evaluateRouteHealth } from "./health.ts"
import type { GRead, GRouteId } from "./probe-g-model.ts"

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
