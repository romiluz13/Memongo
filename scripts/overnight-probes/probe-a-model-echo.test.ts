import { describe, expect, it } from "vitest"
import { buildCleanRecords, FIXTURE_MARKERS } from "./probe-a-fixtures.ts"
import {
	caseOf,
	evaluate,
	replace,
	SEARCH_SELF_AGENT,
	SEARCH_SELF_CONTROL,
	searchBody,
} from "./probe-a-testkit.ts"

const SEARCH_SELF = {
	rowId: "search",
	phase: "pre-erase",
	reader: "self",
} as const

const echoing = (marker: string) => ({
	metadata: {
		passes: [{ pass: 1, query: `look for ${marker}`, resultCount: 0 }],
		queriesTried: [`look for ${marker}`],
	},
	query: `look for ${marker}`,
})

describe("evaluateProbeA echoed query fields are not returned content", () => {
	it("does not call a foreign marker a leak when only an echoed query carries it", () => {
		const records = replace(
			buildCleanRecords(),
			SEARCH_SELF,
			searchBody([FIXTURE_MARKERS.self], echoing(FIXTURE_MARKERS.agent)),
		)
		const result = evaluate(records)
		expect(caseOf(result, SEARCH_SELF_AGENT).outcome).toBe("pass")
		expect(result.outcome).toBe("pass")
	})

	it("does not count an echoed query as the own-marker control", () => {
		const records = replace(
			buildCleanRecords(),
			SEARCH_SELF,
			searchBody([], echoing(FIXTURE_MARKERS.self)),
		)
		const control = caseOf(evaluate(records), SEARCH_SELF_CONTROL)
		expect(control.outcome).toBe("inconclusive")
		expect(control.reason).toBe("own-marker-absent")
	})
})
