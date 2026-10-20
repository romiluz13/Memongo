import { tallyHealth } from "./health.ts"
import { containsMarker } from "./markers.ts"
import type { GRead } from "./probe-g-model.ts"
import { historical, isRecord, labelled, textField, viewOf } from "./rows.ts"
import type { CaseResult, Observation, Outcome } from "./types.ts"
import { aggregateRun } from "./verdict.ts"

export const PROBE_C_VERSION = "C-1"

export const PROBE_C_RULE =
	"Before judging, the old value must have been retrievable and, for a supersession, the replacement must have been searchable. After a confirmed mutation, a search route passes when the new value is eligible and either the old value is absent or labelled historical, or both are eligible and the new one ranks strictly above the old one. It fails when the old value is eligible and ranks at or above the new one, or when the old value is served and the new one is missing after the update settled. Both absent, a missing new value, an unsettled asynchronous update, a quarantined or rejected mutation and an unhealthy or unassessable response are inconclusive. The lifecycle case passes when the record shows the new revision with the old value kept in history for an update, or the old record invalidated with a link to the replacement for a supersession. Automatic correction by a later event is reported as a capability observation and never gates the verdict."

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
): CaseResult {
	return {
		caseId,
		outcome: "fail",
		predicate,
		reason: predicate,
		controlEligible: true,
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

function preconditionFailure(facts: CSequenceFacts): string | undefined {
	const pre = find(facts, "search", "pre")
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
	const index = list.findIndex((row) => containsMarker(row, marker))
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
	const failure = preconditionFailure(facts)
	if (failure) return inconclusive(caseId, failure)
	const oldHit = rowFor(post, facts.oldMarker)
	const newHit = rowFor(post, facts.newMarker)
	const eligible = (hit: typeof oldHit) =>
		hit.row !== undefined && !historical(hit.row, post.at)
	const oldEligible = eligible(oldHit)
	const newEligible = eligible(newHit)
	const unlabelled = [oldHit, newHit].some(
		(hit) => hit.row !== undefined && !labelled(hit.row),
	)
	if (!post.health.evaluable) {
		return inconclusive(
			caseId,
			`unevaluable:${post.health.issues.join(",") || "no-response"}`,
		)
	}
	if (route === "searchDetailed" && unlabelled) {
		return inconclusive(caseId, "unassessable:row without currentness fields")
	}
	if (oldEligible && newEligible) {
		return newHit.index < oldHit.index
			? passCase(caseId, { newRank: newHit.index, oldRank: oldHit.index })
			: failCase(caseId, "old-ranked-at-or-above-new", post, {
					newRank: newHit.index,
					oldRank: oldHit.index,
				})
	}
	if (newEligible)
		return passCase(caseId, { oldPresent: oldHit.row !== undefined })
	if (oldEligible) {
		return facts.settled
			? failCase(caseId, "old-served-new-missing", post)
			: inconclusive(caseId, "async-update-unobserved")
	}
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
	const advanced =
		view.revision !== undefined && view.revision > (preView?.revision ?? 0)
	if (!view.value.includes(facts.newMarker) || !advanced) {
		return inconclusive(caseId, "unverified:new-revision-not-shown")
	}
	const history = find(facts, "lifecycleHistory", "post")
	if (!history?.health.evaluable)
		return inconclusive(caseId, "unverified:history")
	const entries = Array.isArray(bodyOf(history.observation))
		? (bodyOf(history.observation) as unknown[])
		: []
	const revisionWithOld = entries.some(
		(entry) =>
			isRecord(entry) &&
			entry.historyKind === "revision" &&
			viewOf(entry)?.value.includes(facts.oldMarker),
	)
	const currentWithNew = entries.some(
		(entry) =>
			isRecord(entry) &&
			entry.historyKind === "current" &&
			viewOf(entry)?.value.includes(facts.newMarker),
	)
	if (!currentWithNew) return inconclusive(caseId, "unverified:history-current")
	if (!revisionWithOld) {
		return failCase(caseId, "history-missing-old-revision", history)
	}
	return passCase(caseId, { revision: view.revision })
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
	return passCase(caseId, { linked: true })
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
