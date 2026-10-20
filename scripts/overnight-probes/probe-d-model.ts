import { tallyHealth } from "./health.ts"
import { bodyMarkers } from "./markers.ts"
import {
	D_AS_OF,
	D_EVENTS,
	type DQueryRead,
	validAt,
} from "./probe-d-fixture.ts"
import {
	type DRelativeInput,
	relativeCaseIds,
	relativeCases,
} from "./probe-d-relative.ts"
import { isRecord } from "./rows.ts"
import type { CaseResult, Outcome } from "./types.ts"
import { aggregateRun } from "./verdict.ts"

export {
	D_AS_OF,
	D_EVENTS,
	type DEvent,
	type DQueryRead,
} from "./probe-d-fixture.ts"

export const PROBE_D_VERSION = "D-2"
export const D_DEFAULT_LIMIT = 50

export const PROBE_D_RULE =
	"A fixed set of timestamped events with explicit validity is written once. Each query-less recallConversation request is then compared with an expected exact sequence that was derived by hand from the fixture clock: events inside the requested window, recorded no later than the fixed asOf, valid at it, newest first with later writes first on equal timestamps, cut at the limit. A request passes only when it returns that exact sequence with the stored timestamps. It fails on any missing or extra event, a duplicate, a wrong order or a changed timestamp. The window edges, the asOf edges, date-only boundaries in UTC and in three zones including the daylight-saving day, an earlier asOf, a limit and an inverted window are each their own request. An unhealthy or unassessable response and an unacknowledged fixture event make the request inconclusive. Chronology is never judged by a model. The searchDetailed time range is checked for soundness only: no event outside the range may be returned, and the same query without a range must first have returned events outside it and at least one event inside it must be returned with the range. Relative phrases that the engine resolves against asOf (yesterday, today, this week, last week, this month, last month) are checked on a hybrid recall whose query is a fixed filler plus the phrase. The engine applies the phrase as a soft boost in the text lane and not as a filter, so the case compares the text-lane ranks from the score details with each eligible event's distance from the origin that was resolved by hand from the fixture clock, ignoring pairs less than one hour apart. It fails when a closer event ranks below a farther one, and is inconclusive when the unphrased control already orders every pair that way or the lane returns no text-lane ranks. Phrase families the engine does not resolve (day offsets, weekday names, relative years) are declared gaps that stay inconclusive, so the probe cannot pass while they are open. Fused ranking of a querying recall and searchDetailed ordering are declared coverage gaps."

export type DWindow = { start?: string; end?: string }

export type DQuery = {
	id: string
	request: {
		startTime?: string
		endTime?: string
		timezone?: string
		asOf: string
		limit?: number
	}
	window: DWindow
}

const MINUTE_MS = 60_000

export function zonedDayWindow(
	date: string,
	startOffsetMinutes: number,
	endBoundaryOffsetMinutes: number,
): { start: string; end: string } {
	const [year, month, day] = date.split("-").map(Number) as [
		number,
		number,
		number,
	]
	const start = Date.UTC(year, month - 1, day) - startOffsetMinutes * MINUTE_MS
	const end =
		Date.UTC(year, month - 1, day + 1) -
		endBoundaryOffsetMinutes * MINUTE_MS -
		1
	return {
		start: new Date(start).toISOString(),
		end: new Date(end).toISOString(),
	}
}

const LA = "America/Los_Angeles"
const FROM_MARCH = "2026-03-01T00:00:00.000Z"

export const D_QUERIES: readonly DQuery[] = [
	{
		id: "full-window",
		request: { startTime: FROM_MARCH, asOf: D_AS_OF, limit: D_DEFAULT_LIMIT },
		window: { start: FROM_MARCH },
	},
	{
		id: "utc-day",
		request: { startTime: "2026-03-15", endTime: "2026-03-15", asOf: D_AS_OF },
		window: zonedDayWindow("2026-03-15", 0, 0),
	},
	{
		id: "iso-edges",
		request: {
			startTime: "2026-03-15T00:00:00.000Z",
			endTime: "2026-03-15T23:59:59.999Z",
			asOf: D_AS_OF,
		},
		window: {
			start: "2026-03-15T00:00:00.000Z",
			end: "2026-03-15T23:59:59.999Z",
		},
	},
	{
		id: "tz-tokyo",
		request: {
			startTime: "2026-03-20",
			endTime: "2026-03-20",
			timezone: "Asia/Tokyo",
			asOf: D_AS_OF,
		},
		window: zonedDayWindow("2026-03-20", 540, 540),
	},
	{
		id: "tz-kolkata",
		request: {
			startTime: "2026-03-16",
			endTime: "2026-03-16",
			timezone: "Asia/Kolkata",
			asOf: D_AS_OF,
		},
		window: zonedDayWindow("2026-03-16", 330, 330),
	},
	{
		id: "tz-los-angeles",
		request: {
			startTime: "2026-03-14",
			endTime: "2026-03-14",
			timezone: LA,
			asOf: D_AS_OF,
		},
		window: zonedDayWindow("2026-03-14", -420, -420),
	},
	{
		id: "tz-la-dst-day",
		request: {
			startTime: "2026-03-08",
			endTime: "2026-03-08",
			timezone: LA,
			asOf: D_AS_OF,
		},
		window: zonedDayWindow("2026-03-08", -480, -420),
	},
	{
		id: "asof-early",
		request: { startTime: FROM_MARCH, asOf: "2026-03-18T12:00:00.000Z" },
		window: { start: FROM_MARCH },
	},
	{
		id: "limit-3",
		request: { startTime: FROM_MARCH, asOf: D_AS_OF, limit: 3 },
		window: { start: FROM_MARCH },
	},
	{
		id: "inverted-window",
		request: { startTime: "2026-03-16", endTime: "2026-03-15", asOf: D_AS_OF },
		window: {
			start: "2026-03-16T00:00:00.000Z",
			end: "2026-03-15T23:59:59.999Z",
		},
	},
]

export const D_DETAILED_RANGE = {
	start: "2026-03-15T00:00:00.000Z",
	end: "2026-03-15T23:59:59.999Z",
} as const

export const D_GAPS: readonly { route: string; reason: string }[] = [
	{
		route: "recall-with-query",
		reason:
			"A querying recall uses the non-deterministic hybrid lane; its fused ranking and ordering are not asserted, only the text-lane rank under a relative phrase",
	},
	{
		route: "searchDetailed-ordering",
		reason:
			"searchDetailed ranks by relevance, so only time-range soundness is checked",
	},
]

function windowOf(
	event: (typeof D_EVENTS)[number],
	window: DWindow,
	asOf: number,
): boolean {
	const at = Date.parse(event.timestamp)
	const start =
		window.start === undefined ? -Infinity : Date.parse(window.start)
	const requestedEnd = window.end === undefined ? asOf : Date.parse(window.end)
	return at >= start && at <= Math.min(requestedEnd, asOf)
}

export function expectedLabels(query: DQuery): string[] {
	const asOf = Date.parse(query.request.asOf)
	return D_EVENTS.map((item, index) => ({ item, index }))
		.filter(
			({ item }) => windowOf(item, query.window, asOf) && validAt(item, asOf),
		)
		.sort(
			(left, right) =>
				Date.parse(right.item.timestamp) - Date.parse(left.item.timestamp) ||
				right.index - left.index,
		)
		.slice(0, query.request.limit ?? D_DEFAULT_LIMIT)
		.map(({ item }) => item.label)
}

export function requiredCaseIdsD(): string[] {
	return [
		...D_QUERIES.map((query) => `D/recall/${query.id}`),
		"D/searchDetailed/timeRange",
		...relativeCaseIds(),
	]
}

export type ProbeDInput = {
	reads: readonly DQueryRead[]
	labelOf: (eventId: string) => string | undefined
	acknowledged: readonly string[]
	detailed?: {
		read: DQueryRead
		control: DQueryRead
		markers: Readonly<Record<string, string>>
	}
	relative?: Omit<DRelativeInput, "labelOf" | "acknowledged">
}

export type ProbeDEvaluation = {
	outcome: Outcome
	reasons: string[]
	cases: CaseResult[]
	counts: ReturnType<typeof tallyHealth>
}

type Returned = { label: string; timestamp?: string }

const STORED = new Map(D_EVENTS.map((item) => [item.label, item.timestamp]))

function inconclusive(caseId: string, reason: string): CaseResult {
	return { caseId, outcome: "inconclusive", reason, controlEligible: false }
}

function unevaluable(caseId: string, read: DQueryRead): CaseResult {
	return inconclusive(
		caseId,
		`unevaluable:${read.health.issues.join(",") || "no-response"}`,
	)
}

function failCase(
	caseId: string,
	predicate: string,
	read: DQueryRead,
	detail: Record<string, unknown>,
): CaseResult {
	return {
		caseId,
		outcome: "fail",
		predicate,
		reason: predicate,
		controlEligible: false,
		detail,
		evidence: { request: read.request, response: read.observation },
	}
}

function returnedRows(
	read: DQueryRead,
	labelOf: ProbeDInput["labelOf"],
): Returned[] | undefined {
	if (read.observation.kind !== "response") return undefined
	const body = read.observation.body
	const rows = isRecord(body) && Array.isArray(body.results) ? body.results : []
	const out: Returned[] = []
	for (const row of rows) {
		const citation = isRecord(row) ? row.citation : undefined
		if (!isRecord(citation) || typeof citation.eventId !== "string") {
			return undefined
		}
		out.push({
			label: labelOf(citation.eventId) ?? "unknown",
			...(typeof citation.timestamp === "string"
				? { timestamp: citation.timestamp }
				: {}),
		})
	}
	return out
}

function recallCase(
	query: DQuery,
	read: DQueryRead,
	input: ProbeDInput,
): CaseResult {
	const caseId = `D/recall/${query.id}`
	const expected = expectedLabels(query)
	if (!read.health.evaluable) return unevaluable(caseId, read)
	const absent = expected.filter((label) => !input.acknowledged.includes(label))
	if (absent.length > 0) {
		return inconclusive(caseId, `fixture-not-acknowledged:${absent.join(",")}`)
	}
	const rows = returnedRows(read, input.labelOf)
	if (!rows) return inconclusive(caseId, "unassessable:result without citation")
	const labels = rows.map((row) => row.label)
	const missing = expected.filter((label) => !labels.includes(label))
	const extra = [
		...new Set(labels.filter((label) => !expected.includes(label))),
	]
	const detail = { expected, returned: labels }
	if (missing.length > 0 || extra.length > 0) {
		return failCase(caseId, "set-mismatch", read, { ...detail, missing, extra })
	}
	if (new Set(labels).size !== labels.length) {
		return failCase(caseId, "duplicate-result", read, detail)
	}
	if (labels.some((label, index) => label !== expected[index])) {
		const byTime = labels.every(
			(label, index) =>
				index === 0 ||
				Date.parse(STORED.get(labels[index - 1] ?? "") ?? "") >=
					Date.parse(STORED.get(label) ?? ""),
		)
		return failCase(
			caseId,
			byTime ? "tie-order-mismatch" : "order-mismatch",
			read,
			detail,
		)
	}
	const changed: string[] = []
	for (const row of rows) {
		if (
			row.timestamp === undefined ||
			Number.isNaN(Date.parse(row.timestamp))
		) {
			return inconclusive(caseId, "unassessable:citation timestamp")
		}
		if (Date.parse(row.timestamp) !== Date.parse(STORED.get(row.label) ?? "")) {
			changed.push(row.label)
		}
	}
	if (changed.length > 0) {
		return failCase(caseId, "timestamp-mismatch", read, { ...detail, changed })
	}
	return { caseId, outcome: "pass", controlEligible: false, detail }
}

function detailedCase(input: NonNullable<ProbeDInput["detailed"]>): CaseResult {
	const caseId = "D/searchDetailed/timeRange"
	const { read, control, markers } = input
	if (!read.health.evaluable) return unevaluable(caseId, read)
	const start = Date.parse(D_DETAILED_RANGE.start)
	const end = Date.parse(D_DETAILED_RANGE.end)
	const inside = D_EVENTS.filter((item) => {
		const at = Date.parse(item.timestamp)
		return at >= start && at <= end
	}).map((item) => item.label)
	const bodyOf = (candidate: DQueryRead) =>
		candidate.observation.kind === "response"
			? candidate.observation.body
			: undefined
	const found = bodyMarkers(bodyOf(read), markers)
	const outside = found.filter((label) => !inside.includes(label))
	const controlOutside = control.health.evaluable
		? bodyMarkers(bodyOf(control), markers).filter(
				(label) => !inside.includes(label),
			)
		: []
	if (outside.length > 0) {
		return {
			...failCase(caseId, "out-of-window-returned", read, { outside }),
			controlEligible: controlOutside.length > 0,
		}
	}
	if (controlOutside.length === 0) {
		return inconclusive(caseId, "no-out-of-window-control")
	}
	if (!found.some((label) => inside.includes(label))) {
		return inconclusive(caseId, "no-in-window-control")
	}
	return {
		caseId,
		outcome: "pass",
		controlEligible: true,
		detail: { inside: found },
	}
}

export function evaluateProbeD(input: ProbeDInput): ProbeDEvaluation {
	const cases: CaseResult[] = []
	for (const query of D_QUERIES) {
		const read = input.reads.find((item) => item.queryId === query.id)
		if (read) cases.push(recallCase(query, read, input))
	}
	const control = cases.find((item) => item.caseId === "D/recall/full-window")
	const controlPassed = control?.outcome === "pass"
	const graded = cases.map((item) =>
		item.outcome === "inconclusive"
			? item
			: {
					...item,
					controlEligible: item === control || controlPassed,
				},
	)
	if (input.detailed) graded.push(detailedCase(input.detailed))
	graded.push(
		...relativeCases(
			input.relative && {
				...input.relative,
				labelOf: input.labelOf,
				acknowledged: input.acknowledged,
			},
		),
	)
	const tagged = graded.map(
		(item): CaseResult => ({ ...item, contractBasis: "code-derived" }),
	)
	const verdict = aggregateRun(tagged, requiredCaseIdsD())
	return {
		outcome: verdict.outcome,
		reasons: verdict.reasons,
		cases: tagged,
		counts: tallyHealth([
			...input.reads.map((read) => read.health),
			...(input.detailed
				? [input.detailed.control.health, input.detailed.read.health]
				: []),
			...(input.relative
				? [
						input.relative.control.health,
						...input.relative.reads.map((read) => read.health),
					]
				: []),
		]),
	}
}
