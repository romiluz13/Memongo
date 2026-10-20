import { tallyHealth } from "./health.ts"
import { bodyContains, containsMarker } from "./markers.ts"
import type { GRead } from "./probe-g-model.ts"
import { historical, isRecord, labelled, textField, viewOf } from "./rows.ts"
import type { CaseResult, Observation, Outcome } from "./types.ts"
import { aggregateRun } from "./verdict.ts"

export const PROBE_C_VERSION = "C-2"

export const PROBE_C_RULE =
	"A search route passes only when a pre-read of the same route retrieved the old value and, for a supersession, the replacement, and, after a confirmed mutation, the response was healthy and the new value is eligible with the old value absent or labelled historical, or both eligible with the new one ranking strictly above the old one. It fails, whatever the health of the response, when the old value is eligible and ranks at or above the new one, or when the old value is served and the new one is missing after the update settled. Both absent, a missing new value, an unsettled asynchronous update, a quarantined or rejected mutation, a missing control and an unhealthy or unassessable response are inconclusive. The lifecycle case passes when the record shows a revision advanced past its pre-read revision with the old value kept in history for an update, or the old record invalidated with a link to the replacement, an advanced revision and the old value kept in history for a supersession. A missing baseline revision is inconclusive. Automatic correction by a later event is reported as a capability observation and never gates the verdict."

export type CSequenceFacts = {
	sequence: "update" | "supersede"
	oldMarker: string
	newMarker: string
	newKey?: string
	ack: { ok: boolean; reason?: string }
	settled: boolean
	reads: GRead[]
}

export type ProbeCEvaluation = {
	outcome: Outcome
	reasons: string[]
	cases: CaseResult[]
	counts: ReturnType<typeof tallyHealth>
}

const SEQUENCES = ["update", "supersede"] as const
const PARTS = ["search", "searchDetailed", "lifecycle"] as const

export function requiredCaseIdsC(): string[] {
	return SEQUENCES.flatMap((sequence) =>
		PARTS.map((part) => `C/${sequence}/${part}`),
	)
}

function find(
	facts: CSequenceFacts,
	route: GRead["route"],
	phase: GRead["phase"],
): GRead | undefined {
	return facts.reads.find(
		(read) => read.route === route && read.phase === phase,
	)
}

function bodyOf(observation: Observation): unknown {
	return observation.kind === "response" ? observation.body : undefined
}

function inconclusive(caseId: string, reason: string): CaseResult {
	return { caseId, outcome: "inconclusive", reason, controlEligible: false }
}

function failCase(
	caseId: string,
	predicate: string,
	read: GRead,
	detail?: Record<string, unknown>,
	controlEligible = true,
): CaseResult {
	return {
		caseId,
		outcome: "fail",
		predicate,
		reason: predicate,
		controlEligible,
		...(detail ? { detail } : {}),
		evidence: { request: read.request, response: read.observation },
	}
}

function passCase(
	caseId: string,
	detail?: Record<string, unknown>,
): CaseResult {
	return {
		caseId,
		outcome: "pass",
		controlEligible: true,
		...(detail ? { detail } : {}),
	}
}

function preconditionFailure(
	facts: CSequenceFacts,
	route: "search" | "searchDetailed",
): string | undefined {
	const pre = find(facts, route, "pre")
	if (!pre) return "precondition:not-run"
	if (
		!pre.health.evaluable ||
		!containsMarker(pre.observation, facts.oldMarker)
	) {
		return "precondition:old-not-retrievable"
	}
	if (
		facts.sequence === "supersede" &&
		!containsMarker(pre.observation, facts.newMarker)
	) {
		return "precondition:new-not-ready"
	}
	return undefined
}

function results(read: GRead): unknown[] {
	const body = bodyOf(read.observation)
	return isRecord(body) && Array.isArray(body.results) ? body.results : []
}

function rowFor(read: GRead, marker: string) {
	const list = results(read)
	const index = list.findIndex((row) => bodyContains(row, marker))
	const row = index === -1 ? undefined : list[index]
	return { index, row: isRecord(row) ? row : undefined }
}

function searchCase(
	facts: CSequenceFacts,
	route: "search" | "searchDetailed",
): CaseResult | undefined {
	const caseId = `C/${facts.sequence}/${route}`
	const post = find(facts, route, "post")
	if (!post) return undefined
	if (!facts.ack.ok) return inconclusive(caseId, "mutation-not-applied")
	const oldHit = rowFor(post, facts.oldMarker)
	const newHit = rowFor(post, facts.newMarker)
	const eligible = (hit: typeof oldHit) =>
		hit.row !== undefined && !historical(hit.row, post.at)
	const oldEligible = eligible(oldHit)
	const newEligible = eligible(newHit)
	const unlabelled = [oldHit, newHit].some(
		(hit) => hit.row !== undefined && !labelled(hit.row),
	)
	if (route === "searchDetailed" && unlabelled) {
		return inconclusive(caseId, "unassessable:row without currentness fields")
	}
	const failure = preconditionFailure(facts, route)
	const controlled = failure === undefined
	if (oldEligible && newEligible && newHit.index >= oldHit.index) {
		return failCase(
			caseId,
			"old-ranked-at-or-above-new",
			post,
			{ newRank: newHit.index, oldRank: oldHit.index },
			controlled,
		)
	}
	if (oldEligible && !newEligible && facts.settled) {
		return failCase(
			caseId,
			"old-served-new-missing",
			post,
			undefined,
			controlled,
		)
	}
	if (failure) return inconclusive(caseId, failure)
	if (!post.health.evaluable) {
		return inconclusive(
			caseId,
			`unevaluable:${post.health.issues.join(",") || "no-response"}`,
		)
	}
	if (oldEligible && newEligible) {
		return passCase(caseId, { newRank: newHit.index, oldRank: oldHit.index })
	}
	if (newEligible)
		return passCase(caseId, { oldPresent: oldHit.row !== undefined })
	if (oldEligible) return inconclusive(caseId, "async-update-unobserved")
	return inconclusive(caseId, "both-absent")
}

function updateLifecycle(facts: CSequenceFacts, caseId: string): CaseResult {
	const get = find(facts, "lifecycleGet", "post")
	const pre = find(facts, "lifecycleGet", "pre")
	if (!get?.health.evaluable)
		return inconclusive(caseId, "unverified:lifecycle-get")
	const view = viewOf(bodyOf(get.observation))
	const preView = pre ? viewOf(bodyOf(pre.observation)) : undefined
	if (!view) return inconclusive(caseId, "unverified:lifecycle-get-body")
	if (view.value.includes(facts.oldMarker)) {
		return failCase(caseId, "update-not-visible", get)
	}
	const baseline = preView?.revision
	if (baseline === undefined) {
		return inconclusive(caseId, "unverified:baseline-revision-missing")
	}
	const advanced = view.revision !== undefined && view.revision > baseline
	if (!view.value.includes(facts.newMarker) || !advanced) {
		return inconclusive(caseId, "unverified:new-revision-not-shown")
	}
	const history = find(facts, "lifecycleHistory", "post")
	if (!history?.health.evaluable)
		return inconclusive(caseId, "unverified:history")
	const entries = historyEntries(history)
	const currentWithNew = entries.some(
		(entry) =>
			isHistoryKind(entry, "current") &&
			viewOf(entry)?.value.includes(facts.newMarker),
	)
	if (!currentWithNew) return inconclusive(caseId, "unverified:history-current")
	if (!keepsOldRevision(entries, facts.oldMarker)) {
		return failCase(caseId, "history-missing-old-revision", history)
	}
	return passCase(caseId, { revision: view.revision })
}

function historyEntries(history: GRead): unknown[] {
	const body = bodyOf(history.observation)
	return Array.isArray(body) ? body : []
}

function isHistoryKind(entry: unknown, kind: "current" | "revision"): boolean {
	return isRecord(entry) && entry.historyKind === kind
}

function keepsOldRevision(entries: readonly unknown[], oldMarker: string) {
	return entries.some(
		(entry) =>
			isHistoryKind(entry, "revision") &&
			viewOf(entry)?.value.includes(oldMarker),
	)
}

function supersedeLifecycle(facts: CSequenceFacts, caseId: string): CaseResult {
	const file = find(facts, "readFile", "post")
	if (!file?.health.evaluable)
		return inconclusive(caseId, "unverified:read-file")
	if (file.health.denied)
		return inconclusive(caseId, "unverified:old-record-not-found")
	const body = bodyOf(file.observation)
	const text = isRecord(body) && typeof body.text === "string" ? body.text : ""
	const state = textField(text, "state")
	if (state === undefined)
		return inconclusive(caseId, "unverified:no-state-line")
	if (state !== "invalidated") return failCase(caseId, "old-still-active", file)
	const link = textField(text, "invalidatedBy") ?? ""
	if (!facts.newKey || !link.includes(facts.newKey)) {
		return failCase(caseId, "supersession-link-missing", file)
	}
	const get = find(facts, "lifecycleGet", "post")
	if (!get?.health.evaluable)
		return inconclusive(caseId, "unverified:lifecycle-get")
	const view = viewOf(bodyOf(get.observation))
	if (!view) return inconclusive(caseId, "unverified:lifecycle-get-body")
	if (view.state !== "invalidated")
		return failCase(caseId, "old-still-active", get)
	const pre = find(facts, "lifecycleGet", "pre")
	const baseline = pre ? viewOf(bodyOf(pre.observation))?.revision : undefined
	if (baseline === undefined) {
		return inconclusive(caseId, "unverified:baseline-revision-missing")
	}
	if (view.revision === undefined || view.revision <= baseline) {
		return inconclusive(caseId, "unverified:revision-not-advanced")
	}
	const history = find(facts, "lifecycleHistory", "post")
	if (!history?.health.evaluable)
		return inconclusive(caseId, "unverified:history")
	const entries = historyEntries(history)
	const currentInvalidated = entries.some(
		(entry) =>
			isHistoryKind(entry, "current") && viewOf(entry)?.state === "invalidated",
	)
	if (!currentInvalidated) {
		return inconclusive(caseId, "unverified:history-current")
	}
	if (!keepsOldRevision(entries, facts.oldMarker)) {
		return failCase(caseId, "history-missing-old-revision", history)
	}
	return passCase(caseId, { revision: view.revision, linked: true })
}

function lifecycleCase(facts: CSequenceFacts): CaseResult | undefined {
	const caseId = `C/${facts.sequence}/lifecycle`
	const needed = facts.sequence === "update" ? "lifecycleGet" : "readFile"
	if (!find(facts, needed, "post")) return undefined
	if (!facts.ack.ok) return inconclusive(caseId, "mutation-not-applied")
	return facts.sequence === "update"
		? updateLifecycle(facts, caseId)
		: supersedeLifecycle(facts, caseId)
}

export function evaluateProbeC(
	sequences: readonly CSequenceFacts[],
): ProbeCEvaluation {
	const cases: CaseResult[] = []
	for (const facts of sequences) {
		for (const route of ["search", "searchDetailed"] as const) {
			const result = searchCase(facts, route)
			if (result) cases.push(result)
		}
		const lifecycle = lifecycleCase(facts)
		if (lifecycle) cases.push(lifecycle)
	}
	const verdict = aggregateRun(cases, requiredCaseIdsC())
	return {
		outcome: verdict.outcome,
		reasons: verdict.reasons,
		cases,
		counts: tallyHealth(
			sequences.flatMap((facts) => facts.reads.map((read) => read.health)),
		),
	}
}
