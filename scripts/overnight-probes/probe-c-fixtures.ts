import type { evaluateProbeC, CSequenceFacts } from "./probe-c-model.ts"
import { type GItem, makeRead, routeBody } from "./probe-g-fixtures.ts"
import type { GRead } from "./probe-g-model.ts"

export const OLD = "zqcold9"
export const NEW = "zqcnew9"
export const NEW_KEY = "capital-codename-new"
export const PAST = new Date(2_000).toISOString()
export const AT = 5_000

export const oldItem: GItem = {
	value: `The capital codename is ${OLD}`,
	revision: 1,
	state: "active",
}
export const newItem: GItem = {
	value: `The capital codename is ${NEW}`,
	revision: 2,
	state: "active",
}
export const freshNew: GItem = { ...newItem, revision: 1 }
export const invalidatedOld: GItem = {
	...oldItem,
	revision: 2,
	state: "invalidated",
	validTo: PAST,
}

export function read(
	route: GRead["route"],
	phase: GRead["phase"],
	body: unknown,
): GRead {
	return makeRead(route, phase, body, phase === "pre" ? 1_000 : AT)
}

export function updateFacts(
	overrides: Partial<CSequenceFacts> = {},
): CSequenceFacts {
	return {
		sequence: "update",
		oldMarker: OLD,
		newMarker: NEW,
		ack: { ok: true },
		settled: true,
		reads: [
			read("search", "pre", routeBody("search", [oldItem])),
			read("searchDetailed", "pre", routeBody("searchDetailed", [oldItem])),
			read("lifecycleGet", "pre", routeBody("lifecycleGet", [oldItem])),
			read("search", "post", routeBody("search", [newItem])),
			read("searchDetailed", "post", routeBody("searchDetailed", [newItem])),
			read("lifecycleGet", "post", routeBody("lifecycleGet", [newItem])),
			read(
				"lifecycleHistory",
				"post",
				routeBody("lifecycleHistory", [], {
					current: newItem,
					revisions: [oldItem],
				}),
			),
		],
		...overrides,
	}
}

export const invalidatedText = [
	"type: fact",
	"key: capital-codename-old",
	`value: ${oldItem.value}`,
	"revision: 2",
	"state: invalidated",
	`validTo: ${PAST}`,
	`invalidatedBy: ${JSON.stringify({ type: "fact", key: NEW_KEY, reason: "superseded" })}`,
].join("\n")

export function supersedeFacts(
	overrides: Partial<CSequenceFacts> = {},
): CSequenceFacts {
	return {
		sequence: "supersede",
		oldMarker: OLD,
		newMarker: NEW,
		newKey: NEW_KEY,
		ack: { ok: true },
		settled: true,
		reads: [
			read("search", "pre", routeBody("search", [oldItem, freshNew])),
			read(
				"searchDetailed",
				"pre",
				routeBody("searchDetailed", [oldItem, freshNew]),
			),
			read("lifecycleGet", "pre", routeBody("lifecycleGet", [oldItem])),
			read("search", "post", routeBody("search", [freshNew])),
			read("searchDetailed", "post", routeBody("searchDetailed", [freshNew])),
			read("readFile", "post", { text: invalidatedText }),
			read("lifecycleGet", "post", routeBody("lifecycleGet", [invalidatedOld])),
			read(
				"lifecycleHistory",
				"post",
				routeBody("lifecycleHistory", [], {
					current: invalidatedOld,
					revisions: [oldItem],
				}),
			),
		],
		...overrides,
	}
}

export function withRead(
	facts: CSequenceFacts,
	replacement: GRead,
): CSequenceFacts {
	return {
		...facts,
		reads: facts.reads.map((item) =>
			item.route === replacement.route && item.phase === replacement.phase
				? replacement
				: item,
		),
	}
}

export function withoutRead(
	facts: CSequenceFacts,
	route: GRead["route"],
	phase: GRead["phase"],
): CSequenceFacts {
	return {
		...facts,
		reads: facts.reads.filter(
			(item) => !(item.route === route && item.phase === phase),
		),
	}
}

export function caseOf(result: ReturnType<typeof evaluateProbeC>, id: string) {
	const found = result.cases.find((item) => item.caseId === id)
	if (!found) throw new Error(`missing ${id}`)
	return found
}

export const partialOutcomes = {
	status: "partial",
	lanes: [
		{ lane: "vector", stage: "x", outcome: "failed", reason: "query-timeout" },
	],
}
