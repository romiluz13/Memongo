import { evaluateRouteHealth, type RouteId } from "./health.ts"
import {
	ERASED_ROLES,
	isTargeted,
	pairApplies,
	READ_ROWS,
	type TenantRole,
	TENANT_ROLES,
} from "./route-matrix.ts"
import type { ReadRecord } from "./probe-a-model.ts"
import type { Observation } from "./types.ts"

export const FIXTURE_MARKERS: Record<TenantRole, string> = {
	self: "MARKSELFx7f3a1",
	scope: "MARKSCOPEx7f3a1",
	ref: "MARKREFx7f3a1",
	agent: "MARKAGENTx7f3a1",
}

const COMPLETE = { status: "complete", lanes: [] }

function snippets(shown: string[]) {
	return shown.map((marker) => ({
		snippet: `The project Alpha codeword is ${marker}`,
	}))
}

export function healthyBody(route: RouteId, shown: string[]): unknown {
	const rows = snippets(shown)
	switch (route) {
		case "search":
		case "searchKB":
			return { results: rows, outcomes: COMPLETE }
		case "searchDetailed":
			return {
				results: rows,
				metadata: { outcomeStatus: "complete", laneOutcomes: [] },
			}
		case "recallConversation":
			return {
				results: shown.map((marker) => ({
					citation: { preview: `codeword ${marker}` },
				})),
				metadata: { totalMatched: shown.length },
			}
		case "readFile":
			return {
				text: shown.length > 0 ? `value: ${shown[0]}` : "",
				path: "structured:fact:k",
			}
		case "lifecycleGet":
			return {
				family: "structured",
				handle: {},
				data: { value: `codeword ${shown[0]}` },
			}
		case "lifecycleHistory":
			return [
				{ historyKind: "current", data: { value: `codeword ${shown[0]}` } },
			]
		case "profile":
			return {
				agentId: "a",
				preferences: [],
				decisions: [],
				facts: shown.map((marker) => ({ key: "k", value: marker })),
				todos: [],
			}
		case "hydrateActiveSlate":
			return {
				items: shown.map((marker) => ({ summary: marker })),
				metadata: { truncated: false, partial: false },
			}
		case "state":
			return {
				profile: healthyBody("profile", shown),
				blocks: { blocks: [], totalTokenBudget: 1, totalActualTokens: 0 },
				bundle: healthyBody("buildContextBundle", shown),
			}
		case "buildDiscoveryProjection":
			return {
				sections: [{ evidence: shown.map((marker) => ({ summary: marker })) }],
				metadata: { partial: false },
			}
		case "buildContextBundle":
			return {
				rendered: shown.join(" "),
				sections: [],
				metadata: {
					partial: false,
					truncated: false,
					sectionsIncluded: ["query-evidence"],
					outcomeStatus: "complete",
					laneOutcomes: [],
				},
			}
		case "relevanceExplain":
			return {
				health: "ok",
				results: shown.map((marker) => ({ text: marker })),
			}
		case "traceChain":
			return {
				nodes: shown.map((marker) => ({ type: "event", body: marker })),
				chainComplete: true,
			}
		case "scanNovelty":
			return { events: shown.map((marker) => ({ body: marker })) }
	}
}

export function makeRecord(
	rowId: string,
	phase: ReadRecord["phase"],
	reader: TenantRole,
	foreign: TenantRole | undefined,
	observation: Observation,
	routeOverride?: RouteId,
): ReadRecord {
	const row = READ_ROWS.find((r) => r.id === rowId)
	if (!row) throw new Error(`no row ${rowId}`)
	return {
		rowId,
		phase,
		reader,
		...(foreign ? { foreign } : {}),
		observation,
		health: evaluateRouteHealth(routeOverride ?? row.route, observation),
		request: { rowId, reader, ...(foreign ? { foreign } : {}) },
	}
}

function observe(
	rowId: string,
	shown: string[],
	targetedDenied: boolean,
): Observation {
	const row = READ_ROWS.find((r) => r.id === rowId)
	if (!row) throw new Error(`no row ${rowId}`)
	if (
		targetedDenied &&
		(row.route === "lifecycleGet" || row.route === "lifecycleHistory")
	) {
		return {
			kind: "http-error",
			route: row.route,
			status: 404,
			code: "NOT_FOUND",
		}
	}
	return {
		kind: "response",
		route: row.route,
		body: healthyBody(row.route, shown),
	}
}

export function buildCleanRecords(
	markers: Record<TenantRole, string> = FIXTURE_MARKERS,
): ReadRecord[] {
	const records: ReadRecord[] = []
	for (const row of READ_ROWS) {
		if (row.coverage !== "covered") continue
		for (const reader of TENANT_ROLES) {
			if (!isTargeted(row.id)) {
				records.push(
					makeRecord(
						row.id,
						"pre-erase",
						reader,
						undefined,
						observe(row.id, [markers[reader]], false),
					),
				)
				continue
			}
			records.push(
				makeRecord(
					row.id,
					"pre-erase",
					reader,
					undefined,
					observe(row.id, [markers[reader]], false),
				),
			)
			for (const foreign of TENANT_ROLES) {
				if (!pairApplies(row, reader, foreign)) continue
				records.push(
					makeRecord(
						row.id,
						"pre-erase",
						reader,
						foreign,
						observe(row.id, [], true),
					),
				)
			}
		}
		for (const erased of ERASED_ROLES) {
			records.push(
				makeRecord(
					row.id,
					"post-erase",
					erased,
					undefined,
					observe(row.id, [], true),
				),
			)
		}
		records.push(
			makeRecord(
				row.id,
				"post-erase",
				"agent",
				undefined,
				observe(row.id, [markers.agent], false),
			),
		)
	}
	return records
}
