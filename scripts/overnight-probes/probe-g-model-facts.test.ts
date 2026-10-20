import { describe, expect, it } from "vitest"
import {
	caseOf,
	NEW_MARKER,
	newItem,
	OLD_MARKER,
	oldItem,
	routeBody,
	updateSequence,
	withPost,
	withPre,
} from "./probe-g-fixtures.ts"
import { evaluateProbeG, type GSequenceFacts } from "./probe-g-model.ts"

describe("G sequence facts", () => {
	it("makes an update without a new marker unrepresentable", () => {
		// @ts-expect-error an update sequence must carry the marker of its new value
		const missing: GSequenceFacts = {
			sequence: "update",
			oldMarker: OLD_MARKER,
			ack: { ok: true },
			reads: [],
		}
		expect(missing.sequence).toBe("update")
	})

	it("does not let a delete sequence carry a new marker", () => {
		// @ts-expect-error a delete has no replacement value to look for
		const extra: GSequenceFacts = {
			sequence: "delete",
			oldMarker: OLD_MARKER,
			newMarker: NEW_MARKER,
			ack: { ok: true },
			reads: [],
		}
		expect(extra.sequence).toBe("delete")
	})
})

describe("G baseline revision", () => {
	const withoutRevision = () => {
		const body = routeBody("lifecycleGet", [oldItem]) as {
			handle: Record<string, unknown>
		}
		return { ...body, handle: { ...body.handle, revision: undefined } }
	}

	it("does not call an update confirmed when the pre-read carried no revision", () => {
		const facts = withPre(updateSequence(), "lifecycleGet", withoutRevision())
		const result = evaluateProbeG([facts])
		for (const route of ["lifecycleGet", "search", "profile"]) {
			const found = caseOf(result, "update", route)
			expect(found.outcome).toBe("inconclusive")
			expect(found.reason).toBe("mutation-unverified")
		}
	})

	it("still fails an update whose post-read shows the old value without a baseline", () => {
		const stale = withPost(
			withPre(updateSequence(), "lifecycleGet", withoutRevision()),
			"lifecycleGet",
			routeBody("lifecycleGet", [oldItem]),
		)
		const found = caseOf(evaluateProbeG([stale]), "update", "lifecycleGet")
		expect(found.outcome).toBe("fail")
	})
})

describe("G echoed query fields are not returned content", () => {
	const echo = (marker: string) => ({
		metadata: {
			outcomeStatus: "complete",
			laneOutcomes: [],
			passes: [{ pass: 1, query: `what was ${marker}`, resultCount: 0 }],
			queriesTried: [`what was ${marker}`],
		},
	})

	it("does not fail searchDetailed when only the echoed pass query carries the old marker", () => {
		const facts = withPost(updateSequence(), "searchDetailed", {
			...echo(OLD_MARKER),
			results: [{ snippet: newItem.value, state: "active" }],
		})
		const result = caseOf(evaluateProbeG([facts]), "update", "searchDetailed")
		expect(result.outcome).toBe("pass")
	})

	it("does not take an echoed query for the new value showing up", () => {
		const facts = withPost(updateSequence(), "search", {
			results: [],
			outcomes: { status: "complete", lanes: [] },
			query: `what is ${NEW_MARKER}`,
		})
		const result = caseOf(evaluateProbeG([facts]), "update", "search")
		expect(result.outcome).toBe("inconclusive")
		expect(result.reason).toBe("new-value-absent")
	})

	it("does not establish a pre-read control from an echoed query", () => {
		const facts = withPre(updateSequence(), "searchDetailed", {
			...echo(OLD_MARKER),
			results: [{ snippet: "unrelated", state: "active" }],
		})
		const result = caseOf(evaluateProbeG([facts]), "update", "searchDetailed")
		expect(result.outcome).toBe("inconclusive")
		expect(result.reason).toBe("control-not-established")
	})
})
