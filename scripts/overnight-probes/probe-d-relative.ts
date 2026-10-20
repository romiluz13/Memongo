import {
	D_AS_OF,
	D_EVENTS,
	type DQueryRead,
	eligibleLabels,
} from "./probe-d-fixture.ts"
import { isRecord } from "./rows.ts"
import type { CaseResult } from "./types.ts"

export const D_RELATIVE_BASE_QUERY = "Dated archive log entry"
export const D_RELATIVE_MIN_GAP_MS = 3_600_000

export type DRelative = {
	id: string
	phrase: string
	origin: string
	scaleDays: number
}

export const D_RELATIVE: readonly DRelative[] = [
	{
		id: "yesterday",
		phrase: "yesterday",
		origin: "2026-03-19T00:00:00.000Z",
		scaleDays: 1,
	},
	{
		id: "today",
		phrase: "today",
		origin: "2026-03-20T00:00:00.000Z",
		scaleDays: 1,
	},
	{
		id: "this-week",
		phrase: "this week",
		origin: "2026-03-16T00:00:00.000Z",
		scaleDays: 3,
	},
	{
		id: "last-week",
		phrase: "last week",
		origin: "2026-03-09T00:00:00.000Z",
		scaleDays: 3,
	},
	{
		id: "this-month",
		phrase: "this month",
		origin: "2026-03-01T00:00:00.000Z",
		scaleDays: 15,
	},
	{
		id: "last-month",
		phrase: "last month",
		origin: "2026-02-01T00:00:00.000Z",
		scaleDays: 15,
	},
]

const NOT_RESOLVED =
	"the engine's temporal extractor does not resolve this family against asOf, so no engine contract exists to assert"

export const D_RELATIVE_UNSUPPORTED: readonly {
	id: string
	example: string
	reason: string
}[] = [
	{
		id: "day-offset",
		example: "three days ago",
		reason: `day offsets such as three days ago: ${NOT_RESOLVED}`,
	},
	{
		id: "weekday",
		example: "last Friday",
		reason: `weekday names such as last Friday: ${NOT_RESOLVED}`,
	},
	{
		id: "relative-year",
		example: "last year",
		reason: `relative years such as last year: ${NOT_RESOLVED}`,
	},
]

export function relativeCaseIds(): string[] {
	return [...D_RELATIVE, ...D_RELATIVE_UNSUPPORTED].map(
		(item) => `D/relative/${item.id}`,
	)
}

export type DRelativeInput = {
	control: DQueryRead
	reads: readonly DQueryRead[]
	labelOf: (eventId: string) => string | undefined
	acknowledged: readonly string[]
}

type Ranks =
	| { ok: true; ranks: Map<string, number> }
	| { ok: false; reason: string }

function resultRows(read: DQueryRead): unknown[] | undefined {
	if (read.observation.kind !== "response") return undefined
	const body = read.observation.body
	return isRecord(body) && Array.isArray(body.results)
		? body.results
		: undefined
}

export function relativeLabels(
	read: DQueryRead,
	labelOf: DRelativeInput["labelOf"],
): string[] {
	const labels: string[] = []
	for (const row of resultRows(read) ?? []) {
		const citation = isRecord(row) ? row.citation : undefined
		const label =
			isRecord(citation) && typeof citation.eventId === "string"
				? labelOf(citation.eventId)
				: undefined
		if (label !== undefined) labels.push(label)
	}
	return labels
}

function textRank(row: unknown): number | undefined {
	const details =
		isRecord(row) && isRecord(row.scoreDetails)
			? row.scoreDetails.details
			: undefined
	if (!Array.isArray(details)) return undefined
	const lane = details.find(
		(entry) => isRecord(entry) && entry.inputPipelineName === "text",
	)
	const rank = isRecord(lane) ? lane.rank : undefined
	return typeof rank === "number" && Number.isFinite(rank) ? rank : undefined
}

function textRanks(
	read: DQueryRead,
	labelOf: DRelativeInput["labelOf"],
): Ranks {
	const rows = resultRows(read)
	if (!rows) return { ok: false, reason: "no-results" }
	const body =
		read.observation.kind === "response" ? read.observation.body : null
	const metadata = isRecord(body) ? body.metadata : undefined
	if (!isRecord(metadata) || metadata.searchMethod !== "hybrid") {
		return { ok: false, reason: "not-hybrid" }
	}
	const ranks = new Map<string, number>()
	for (const row of rows) {
		const citation = isRecord(row) ? row.citation : undefined
		const label =
			isRecord(citation) && typeof citation.eventId === "string"
				? labelOf(citation.eventId)
				: undefined
		const rank = textRank(row)
		if (label !== undefined && rank !== undefined) ranks.set(label, rank)
	}
	return ranks.size < 2
		? { ok: false, reason: "fewer-than-two-text-ranks" }
		: { ok: true, ranks }
}

function inconclusive(caseId: string, reason: string): CaseResult {
	return { caseId, outcome: "inconclusive", reason, controlEligible: false }
}

function timestampOf(label: string): number {
	return Date.parse(
		D_EVENTS.find((item) => item.label === label)?.timestamp ?? "",
	)
}

function relativeCase(
	item: DRelative,
	read: DQueryRead,
	input: DRelativeInput,
): CaseResult {
	const caseId = `D/relative/${item.id}`
	if (!read.health.evaluable) {
		return inconclusive(
			caseId,
			`unevaluable:${read.health.issues.join(",") || "no-response"}`,
		)
	}
	if (!input.control.health.evaluable) {
		return inconclusive(caseId, "unevaluable-control")
	}
	const eligible = eligibleLabels(D_AS_OF)
	const absent = eligible.filter((label) => !input.acknowledged.includes(label))
	if (absent.length > 0) {
		return inconclusive(caseId, `fixture-not-acknowledged:${absent.join(",")}`)
	}
	const phrase = textRanks(read, input.labelOf)
	if (!phrase.ok) return inconclusive(caseId, `unassessable:${phrase.reason}`)
	const control = textRanks(input.control, input.labelOf)
	if (!control.ok) {
		return inconclusive(caseId, `unassessable-control:${control.reason}`)
	}
	const origin = Date.parse(item.origin)
	const distance = (label: string) => Math.abs(timestampOf(label) - origin)
	const ranked = eligible.filter((label) => phrase.ranks.has(label))
	const violations: { closer: string; farther: string }[] = []
	let pairs = 0
	let discriminating = 0
	for (const closer of ranked) {
		for (const farther of ranked) {
			if (distance(farther) - distance(closer) < D_RELATIVE_MIN_GAP_MS) continue
			pairs += 1
			if ((phrase.ranks.get(closer) ?? 0) > (phrase.ranks.get(farther) ?? 0)) {
				violations.push({ closer, farther })
			}
			const before = control.ranks.get(closer)
			const after = control.ranks.get(farther)
			if (before !== undefined && after !== undefined && before > after) {
				discriminating += 1
			}
		}
	}
	if (violations.length > 0) {
		return {
			caseId,
			outcome: "fail",
			predicate: "relative-origin-not-applied",
			reason: "relative-origin-not-applied",
			controlEligible: true,
			detail: {
				phrase: item.phrase,
				origin: item.origin,
				pairs,
				violations: violations.slice(0, 5),
			},
			evidence: { request: read.request, response: read.observation },
		}
	}
	if (discriminating === 0)
		return inconclusive(caseId, "no-discriminating-pair")
	return {
		caseId,
		outcome: "pass",
		controlEligible: true,
		detail: { phrase: item.phrase, origin: item.origin, pairs, discriminating },
	}
}

export function relativeCases(input: DRelativeInput | undefined): CaseResult[] {
	const cases: CaseResult[] = []
	if (input) {
		for (const item of D_RELATIVE) {
			const read = input.reads.find(
				(candidate) => candidate.queryId === `relative/${item.id}`,
			)
			if (read) cases.push(relativeCase(item, read, input))
		}
	}
	for (const gap of D_RELATIVE_UNSUPPORTED) {
		cases.push({
			...inconclusive(`D/relative/${gap.id}`, `declared-gap:${gap.reason}`),
			detail: { example: gap.example },
		})
	}
	return cases
}
