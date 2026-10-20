import { FIXTURE_MARKERS, healthyBody, makeRecord } from "./probe-a-fixtures.ts"
import { evaluateProbeA, type ReadRecord } from "./probe-a-model.ts"
import type { Observation } from "./types.ts"

export const CONFIRMED = { confirmed: true } as const
export const UNCONFIRMED = {
	confirmed: false,
	reason: "status:partial",
} as const

export function evaluate(
	records: ReadRecord[],
	erase = CONFIRMED as { confirmed: boolean; reason?: string },
) {
	return evaluateProbeA({ records, markers: FIXTURE_MARKERS, erase })
}

export function replace(
	records: ReadRecord[],
	match: {
		rowId: string
		phase: "pre-erase" | "post-erase"
		reader: ReadRecord["reader"]
		foreign?: ReadRecord["foreign"]
	},
	observation: Observation,
): ReadRecord[] {
	return records.map((record) =>
		record.rowId === match.rowId &&
		record.phase === match.phase &&
		record.reader === match.reader &&
		record.foreign === match.foreign
			? makeRecord(
					match.rowId,
					match.phase,
					match.reader,
					match.foreign,
					observation,
				)
			: record,
	)
}

export function without(
	records: ReadRecord[],
	rowId: string,
	phase: string,
	reader: string,
	foreign?: string,
) {
	return records.filter(
		(r) =>
			!(
				r.rowId === rowId &&
				r.phase === phase &&
				r.reader === reader &&
				r.foreign === foreign
			),
	)
}

export function caseOf(result: ReturnType<typeof evaluate>, caseId: string) {
	const found = result.cases.find((item) => item.caseId === caseId)
	if (!found) throw new Error(`case ${caseId} missing`)
	return found
}

export const SEARCH_SELF_AGENT = "A/search/reader=self/foreign=agent/pre-erase"
export const SEARCH_SELF_CONTROL = "A/search/reader=self/control/pre-erase"

export function searchBody(
	shown: string[],
	overrides: Record<string, unknown> = {},
) {
	return {
		kind: "response" as const,
		route: "search",
		body: { ...(healthyBody("search", shown) as object), ...overrides },
	}
}
