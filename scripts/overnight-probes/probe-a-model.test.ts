import { describe, expect, it } from "vitest"
import {
	buildCleanRecords,
	FIXTURE_MARKERS,
	healthyBody,
} from "./probe-a-fixtures.ts"
import {
	isConfirmedErase,
	PROBE_A_RULE,
	PROBE_A_VERSION,
} from "./probe-a-model.ts"
import {
	caseOf,
	evaluate,
	replace,
	SEARCH_SELF_AGENT,
	SEARCH_SELF_CONTROL,
	searchBody,
	UNCONFIRMED,
	without,
} from "./probe-a-testkit.ts"
import { READ_ROWS, requiredCaseIds } from "./route-matrix.ts"

describe("evaluateProbeA clean runs", () => {
	it("passes with every required case executed and passed", () => {
		const result = evaluate(buildCleanRecords())
		expect(result.outcome).toBe("pass")
		expect(result.cases.every((item) => item.outcome === "pass")).toBe(true)
		const ids = new Set(result.cases.map((item) => item.caseId))
		for (const required of requiredCaseIds())
			expect(ids.has(required)).toBe(true)
	})

	it("reports every declared gap with its reason and does not count any as a pass", () => {
		const result = evaluate(buildCleanRecords())
		expect(result.gaps).toEqual(
			["discovery:contradiction-report", "searchKB"].map((rowId) => ({
				rowId,
				reason: READ_ROWS.find((row) => row.id === rowId)?.gapReason,
			})),
		)
		for (const rowId of ["searchKB", "contradiction-report"]) {
			expect(result.cases.some((item) => item.caseId.includes(rowId))).toBe(
				false,
			)
		}
	})

	it("counts attempted, completed, healthy and evaluable reads", () => {
		const result = evaluate(buildCleanRecords())
		expect(result.counts.attempted).toBeGreaterThan(50)
		expect(result.counts.evaluable).toBe(result.counts.attempted)
	})

	it("exports a stable printed rule and version", () => {
		expect(PROBE_A_RULE).toMatch(/anywhere in the returned content/)
		expect(PROBE_A_RULE).toMatch(/only echo the request/)
		expect(PROBE_A_RULE).toMatch(/inconclusive/)
		expect(PROBE_A_VERSION).toBe("A-2")
	})
})

describe("evaluateProbeA leaks", () => {
	it("fails a broad row when a foreign marker appears, with a role-based predicate", () => {
		const records = replace(
			buildCleanRecords(),
			{ rowId: "search", phase: "pre-erase", reader: "self" },
			searchBody([FIXTURE_MARKERS.self, FIXTURE_MARKERS.agent]),
		)
		const result = evaluate(records)
		const leak = caseOf(result, SEARCH_SELF_AGENT)
		expect(leak.outcome).toBe("fail")
		expect(leak.predicate).toBe("leak:agent")
		expect(leak.controlEligible).toBe(true)
		expect(leak.evidence?.response).toBeDefined()
		expect(
			caseOf(result, "A/search/reader=self/foreign=scope/pre-erase").outcome,
		).toBe("pass")
		expect(result.outcome).toBe("fail")
	})

	it("finds a marker nested anywhere in the body, not only in snippets", () => {
		const records = replace(
			buildCleanRecords(),
			{ rowId: "search", phase: "pre-erase", reader: "self" },
			searchBody([FIXTURE_MARKERS.self], {
				extra: { nested: [{ deep: { text: `x ${FIXTURE_MARKERS.agent} y` } }] },
			}),
		)
		expect(caseOf(evaluate(records), SEARCH_SELF_AGENT).outcome).toBe("fail")
	})

	it("still fails when the leaking response is also degraded (leak plus degraded)", () => {
		const records = replace(
			buildCleanRecords(),
			{ rowId: "search", phase: "pre-erase", reader: "self" },
			searchBody([FIXTURE_MARKERS.self, FIXTURE_MARKERS.agent], {
				outcomes: {
					status: "partial",
					lanes: [
						{
							lane: "vector",
							stage: "retrieve",
							outcome: "failed",
							reason: "timeout",
						},
					],
				},
			}),
		)
		const result = evaluate(records)
		expect(caseOf(result, SEARCH_SELF_AGENT).outcome).toBe("fail")
		expect(result.outcome).toBe("fail")
	})

	it("fails a leak that has no own-marker control but marks the failure as control-ineligible", () => {
		const records = replace(
			buildCleanRecords(),
			{ rowId: "search", phase: "pre-erase", reader: "self" },
			searchBody([FIXTURE_MARKERS.agent]),
		)
		const result = evaluate(records)
		const leak = caseOf(result, SEARCH_SELF_AGENT)
		expect(leak.outcome).toBe("fail")
		expect(leak.controlEligible).toBe(false)
		expect(caseOf(result, SEARCH_SELF_CONTROL).outcome).toBe("inconclusive")
	})

	it("fails a targeted row when a foreign handle returns the foreign item", () => {
		const records = replace(
			buildCleanRecords(),
			{
				rowId: "lifecycle:get",
				phase: "pre-erase",
				reader: "self",
				foreign: "agent",
			},
			{
				kind: "response",
				route: "lifecycleGet",
				body: healthyBody("lifecycleGet", [FIXTURE_MARKERS.agent]),
			},
		)
		const result = evaluate(records)
		const leak = caseOf(
			result,
			"A/lifecycle:get/reader=self/foreign=agent/pre-erase",
		)
		expect(leak.outcome).toBe("fail")
		expect(leak.predicate).toBe("leak:agent")
	})

	it("fails a readFile locator that returns the foreign text", () => {
		const records = replace(
			buildCleanRecords(),
			{
				rowId: "readFile:structured-locator",
				phase: "pre-erase",
				reader: "self",
				foreign: "agent",
			},
			{
				kind: "response",
				route: "readFile",
				body: { text: `value: ${FIXTURE_MARKERS.agent}` },
			},
		)
		expect(
			caseOf(
				evaluate(records),
				"A/readFile:structured-locator/reader=self/foreign=agent/pre-erase",
			).outcome,
		).toBe("fail")
	})
})

describe("evaluateProbeA unevaluable responses", () => {
	it("is inconclusive, not pass, when a lane failed inside a 200 (partial-200)", () => {
		const records = replace(
			buildCleanRecords(),
			{ rowId: "searchDetailed", phase: "pre-erase", reader: "self" },
			{
				kind: "response",
				route: "searchDetailed",
				body: {
					...(healthyBody("searchDetailed", [FIXTURE_MARKERS.self]) as object),
					metadata: {
						outcomeStatus: "partial",
						laneOutcomes: [
							{
								lane: "vector",
								stage: "retrieve",
								outcome: "failed",
								reason: "timeout",
							},
						],
					},
				},
			},
		)
		const result = evaluate(records)
		const negative = caseOf(
			result,
			"A/searchDetailed/reader=self/foreign=agent/pre-erase",
		)
		expect(negative.outcome).toBe("inconclusive")
		expect(negative.reason).toMatch(/lane-failed:vector/)
		expect(
			caseOf(result, "A/searchDetailed/reader=self/control/pre-erase").outcome,
		).toBe("inconclusive")
		expect(result.outcome).toBe("inconclusive")
	})

	it("is inconclusive when a silent read returned degradation with empty results", () => {
		const records = replace(
			buildCleanRecords(),
			{ rowId: "profile", phase: "pre-erase", reader: "scope" },
			{
				kind: "response",
				route: "profile",
				body: {
					...(healthyBody("profile", []) as object),
					degradation: { kind: "transient" },
				},
			},
		)
		const result = evaluate(records)
		expect(
			caseOf(result, "A/profile/reader=scope/foreign=agent/pre-erase").outcome,
		).toBe("inconclusive")
		expect(result.outcome).toBe("inconclusive")
	})

	it("is inconclusive when the response is truncated", () => {
		const records = replace(
			buildCleanRecords(),
			{ rowId: "recall:filter", phase: "pre-erase", reader: "self" },
			{
				kind: "response",
				route: "recallConversation",
				body: {
					results: [{ citation: { preview: FIXTURE_MARKERS.self } }],
					metadata: { totalMatched: 50 },
				},
			},
		)
		const result = evaluate(records)
		expect(
			caseOf(result, "A/recall:filter/reader=self/foreign=agent/pre-erase")
				.reason,
		).toMatch(/truncated/)
		expect(result.outcome).toBe("inconclusive")
	})

	it("is inconclusive on a transport error and on ERASURE_IN_PROGRESS", () => {
		const transport = evaluate(
			replace(
				buildCleanRecords(),
				{ rowId: "state", phase: "pre-erase", reader: "ref" },
				{ kind: "transport-error", route: "state", message: "ECONNRESET" },
			),
		)
		expect(
			caseOf(transport, "A/state/reader=ref/foreign=agent/pre-erase").outcome,
		).toBe("inconclusive")
		const erasing = evaluate(
			replace(
				buildCleanRecords(),
				{ rowId: "state", phase: "post-erase", reader: "self" },
				{
					kind: "http-error",
					route: "state",
					status: 503,
					code: "ERASURE_IN_PROGRESS",
				},
			),
		)
		const post = caseOf(erasing, "A/state/erased=self/post-erase")
		expect(post.outcome).toBe("inconclusive")
		expect(post.reason).toMatch(/erasure-in-progress/)
	})

	it("is inconclusive when a required read never ran", () => {
		const records = without(buildCleanRecords(), "search", "pre-erase", "self")
		const result = evaluate(records)
		expect(result.outcome).toBe("inconclusive")
		expect(result.reasons.join(" ")).toMatch(/unexecuted required cases/)
		expect(result.reasons.join(" ")).toContain(SEARCH_SELF_AGENT)
	})

	it("is inconclusive when the response echoes a request that carried a marker", () => {
		const records = buildCleanRecords().map((record) =>
			record.rowId === "search" &&
			record.phase === "pre-erase" &&
			record.reader === "self"
				? { ...record, request: { query: `find ${FIXTURE_MARKERS.agent}` } }
				: record,
		)
		const result = evaluate(records)
		const negative = caseOf(result, SEARCH_SELF_AGENT)
		expect(negative.outcome).toBe("inconclusive")
		expect(negative.reason).toMatch(/request-contains-marker/)
	})
})

describe("evaluateProbeA controls", () => {
	it("makes negatives inconclusive when the reader's own marker is absent from a healthy response", () => {
		const records = replace(
			buildCleanRecords(),
			{ rowId: "search", phase: "pre-erase", reader: "self" },
			searchBody([]),
		)
		const result = evaluate(records)
		const control = caseOf(result, SEARCH_SELF_CONTROL)
		expect(control.outcome).toBe("inconclusive")
		expect(control.reason).toMatch(/own-marker-absent/)
		const negative = caseOf(result, SEARCH_SELF_AGENT)
		expect(negative.outcome).toBe("inconclusive")
		expect(negative.reason).toMatch(/control-not-established/)
		expect(negative.controlEligible).toBe(false)
	})

	it("treats a denied targeted response as a pass only when the owner's control succeeded", () => {
		const clean = evaluate(buildCleanRecords())
		expect(
			caseOf(clean, "A/lifecycle:get/reader=self/foreign=agent/pre-erase")
				.outcome,
		).toBe("pass")
		const records = replace(
			buildCleanRecords(),
			{ rowId: "lifecycle:get", phase: "pre-erase", reader: "self" },
			{
				kind: "http-error",
				route: "lifecycleGet",
				status: 404,
				code: "NOT_FOUND",
			},
		)
		const broken = evaluate(records)
		expect(
			caseOf(broken, "A/lifecycle:get/reader=self/foreign=agent/pre-erase")
				.outcome,
		).toBe("inconclusive")
	})

	it("treats a 500 on a targeted row as inconclusive rather than a denial", () => {
		const records = replace(
			buildCleanRecords(),
			{
				rowId: "lifecycle:history",
				phase: "pre-erase",
				reader: "self",
				foreign: "agent",
			},
			{ kind: "http-error", route: "lifecycleHistory", status: 500 },
		)
		expect(
			caseOf(
				evaluate(records),
				"A/lifecycle:history/reader=self/foreign=agent/pre-erase",
			).outcome,
		).toBe("inconclusive")
	})
})

describe("evaluateProbeA post-erase", () => {
	it("fails when an erased tenant's marker survives a confirmed-complete erase", () => {
		const records = replace(
			buildCleanRecords(),
			{ rowId: "search", phase: "post-erase", reader: "self" },
			searchBody([FIXTURE_MARKERS.self]),
		)
		const result = evaluate(records)
		const survived = caseOf(result, "A/search/erased=self/post-erase")
		expect(survived.outcome).toBe("fail")
		expect(survived.predicate).toBe("erased-present:self")
		expect(survived.controlEligible).toBe(true)
	})

	it("does not fail on a surviving marker when the erase was not confirmed complete", () => {
		const records = replace(
			buildCleanRecords(),
			{ rowId: "search", phase: "post-erase", reader: "self" },
			searchBody([FIXTURE_MARKERS.self]),
		)
		const result = evaluate(records, UNCONFIRMED)
		const survived = caseOf(result, "A/search/erased=self/post-erase")
		expect(survived.outcome).toBe("inconclusive")
		expect(survived.reason).toMatch(/erase-not-confirmed/)
		expect(survived.detail).toMatchObject({ markerPresent: true })
		expect(result.outcome).toBe("inconclusive")
	})

	it("is inconclusive on every post-erase case when the erase is unconfirmed, even with no marker", () => {
		const result = evaluate(buildCleanRecords(), UNCONFIRMED)
		expect(result.outcome).toBe("inconclusive")
		expect(caseOf(result, "A/search/erased=ref/post-erase").outcome).toBe(
			"inconclusive",
		)
		expect(caseOf(result, SEARCH_SELF_AGENT).outcome).toBe("pass")
	})

	it("is inconclusive when the untouched agent's marker disappeared from the same route", () => {
		const records = replace(
			buildCleanRecords(),
			{ rowId: "search", phase: "post-erase", reader: "agent" },
			searchBody([]),
		)
		const result = evaluate(records)
		expect(
			caseOf(result, "A/search/untouched=agent/control/post-erase").outcome,
		).toBe("inconclusive")
		const erased = caseOf(result, "A/search/erased=self/post-erase")
		expect(erased.outcome).toBe("inconclusive")
		expect(erased.reason).toMatch(/control-not-established/)
	})

	it("fails a targeted row that still resolves an erased handle", () => {
		const records = replace(
			buildCleanRecords(),
			{ rowId: "lifecycle:get", phase: "post-erase", reader: "scope" },
			{
				kind: "response",
				route: "lifecycleGet",
				body: healthyBody("lifecycleGet", [FIXTURE_MARKERS.scope]),
			},
		)
		const survived = caseOf(
			evaluate(records),
			"A/lifecycle:get/erased=scope/post-erase",
		)
		expect(survived.outcome).toBe("fail")
		expect(survived.predicate).toBe("erased-present:scope")
	})
})

describe("isConfirmedErase", () => {
	const complete = {
		agentId: "probe-1",
		status: "complete",
		receipts: [
			{ collection: "events", deleted: 4 },
			{ collection: "structured", deleted: 3 },
		],
		gateState: "open",
		completedAt: "2026-01-01T00:00:00.000Z",
	}

	it("accepts a complete erase of the expected agent that deleted documents", () => {
		expect(isConfirmedErase(complete, "probe-1")).toEqual({ confirmed: true })
	})

	it.each([
		["partial status", { ...complete, status: "partial" }],
		["audit error", { ...complete, auditError: "write failed" }],
		["ownership lost", { ...complete, ownershipLost: true }],
		["finalize indeterminate", { ...complete, finalizeIndeterminate: true }],
		[
			"receipt error",
			{
				...complete,
				receipts: [{ collection: "events", deleted: 0, error: "boom" }],
			},
		],
		["gate not open", { ...complete, gateState: "erasing" }],
		["wrong agent", { ...complete, agentId: "probe-2" }],
		[
			"nothing deleted",
			{ ...complete, receipts: [{ collection: "events", deleted: 0 }] },
		],
		["no receipts", { ...complete, receipts: [] }],
		["not an object", "complete"],
	])("rejects %s", (_name, response) => {
		const verdict = isConfirmedErase(response, "probe-1")
		expect(verdict.confirmed).toBe(false)
		expect(verdict.reason?.length ?? 0).toBeGreaterThan(3)
	})
})
