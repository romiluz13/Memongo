import { isAbstaining } from "../mongodb-e2e-qa.ts"
import { type RouteHealth, tallyHealth } from "./health.ts"
import { type BFixture, buildBFixture } from "./probe-b-fixtures.ts"
import type { CaseResult, Outcome } from "./types.ts"
import { aggregateRun, inconclusive } from "./verdict.ts"

export const PROBE_B_VERSION = "B-1"

export const PROBE_B_RULE =
	"Facts with unique markers are written, then each question is answered by the unchanged generateAnswer from the passages that search returned for it. A control passes only when its answer contains its unique marker exactly. A never-written case, whose subject or attribute is absent from the whole seeded dataset, passes only when the answer is judged an abstention by the existing isAbstaining rule and the paired control for the same question shape passed. It fails when the answerer returns anything that rule does not call an abstention, or when a control returns an answer without its marker. A provider failure, an unparseable or non-string answer, a degraded or empty retrieval, a marker that search never returned and a case the 60-call bound did not reach are each inconclusive and are never counted as an abstention. No model judges abstention."

export const B_GAPS: readonly { route: string; reason: string }[] = [
	{
		route: "abstention-phrasing",
		reason:
			"isAbstaining recognizes an empty answer and a fixed list of refusal phrasings; a refusal worded differently is reported as an answer and the answer text is kept for review",
	},
	{
		route: "fact-shape",
		reason:
			"One fact shape (an access code for a named vault) with unknown-entity and unknown-attribute questions; multi-hop, temporal and numeric abstention are not covered",
	},
	{
		route: "answer-prompt",
		reason:
			"Only the unchanged answer prompt and the configured answer model are exercised; other models and prompt variants are not",
	},
]

export type BCall = {
	outcome: "answered" | "provider-failure" | "malformed"
	answer: string
}

export type BCaseFacts = {
	caseId: string
	kind: "control" | "never"
	marker?: string
	pairedControl?: string
	retrieval: { health: RouteHealth; markerSeen: boolean }
	calls: BCall[]
	skipped?: "call-cap" | "budget"
	request?: unknown
}

export type ProbeBEvaluation = {
	outcome: Outcome
	reasons: string[]
	cases: CaseResult[]
	counts: ReturnType<typeof tallyHealth>
}

export function classifyAnswerShape(content: string): "answer" | "malformed" {
	let text = content.trim()
	if (text.startsWith("```")) {
		const lineEnd = text.indexOf("\n")
		text = lineEnd === -1 ? "" : text.slice(lineEnd + 1).trim()
		if (text.endsWith("```")) text = text.slice(0, -3).trim()
	}
	try {
		const parsed: unknown = JSON.parse(text)
		return typeof parsed === "object" &&
			parsed !== null &&
			typeof (parsed as { answer?: unknown }).answer === "string"
			? "answer"
			: "malformed"
	} catch {
		return "malformed"
	}
}

export function requiredCaseIdsB(
	fixture: BFixture = buildBFixture((position) => `m${position}`),
): string[] {
	return [
		...fixture.controls.map((control) => control.caseId),
		...fixture.never.map((item) => item.caseId),
	]
}

function gate(facts: BCaseFacts): CaseResult | { call: BCall } {
	if (!facts.retrieval.health.evaluable) {
		return inconclusive(
			facts.caseId,
			`unevaluable:${facts.retrieval.health.issues.join(",") || "no-response"}`,
		)
	}
	if (facts.kind === "control" && !facts.retrieval.markerSeen) {
		return inconclusive(facts.caseId, "retrieval-miss")
	}
	const last = facts.calls[facts.calls.length - 1]
	if (!last) return inconclusive(facts.caseId, facts.skipped ?? "not-called")
	if (last.outcome !== "answered") {
		return inconclusive(facts.caseId, `provider:${last.outcome}`)
	}
	return { call: last }
}

function controlCase(facts: BCaseFacts): CaseResult {
	const verdict = gate(facts)
	if (!("call" in verdict)) return verdict
	const answer = verdict.call.answer
	if (facts.marker !== undefined && answer.includes(facts.marker)) {
		return { caseId: facts.caseId, outcome: "pass", controlEligible: true }
	}
	return {
		caseId: facts.caseId,
		outcome: "fail",
		predicate: "control-missed",
		reason: "control-missed",
		controlEligible: true,
		detail: { answer },
		evidence: { request: facts.request, response: { answer } },
	}
}

function neverCase(
	facts: BCaseFacts,
	controls: ReadonlyMap<string, CaseResult>,
	violations: readonly string[],
): CaseResult {
	if (violations.length > 0) {
		return inconclusive(facts.caseId, "fixture-violation")
	}
	const verdict = gate(facts)
	if (!("call" in verdict)) return verdict
	const answer = verdict.call.answer
	const paired = controls.get(facts.pairedControl ?? "")?.outcome === "pass"
	if (!isAbstaining(answer)) {
		return {
			caseId: facts.caseId,
			outcome: "fail",
			predicate: "answered-never-written",
			reason: "answered-never-written",
			controlEligible: paired,
			detail: { answer },
			evidence: { request: facts.request, response: { answer } },
		}
	}
	if (!paired) return inconclusive(facts.caseId, "paired-control-not-passed")
	return { caseId: facts.caseId, outcome: "pass", controlEligible: true }
}

export function evaluateProbeB(
	facts: readonly BCaseFacts[],
	violations: readonly string[],
): ProbeBEvaluation {
	const controls = new Map<string, CaseResult>()
	const cases: CaseResult[] = []
	for (const item of facts.filter(
		(candidate) => candidate.kind === "control",
	)) {
		const result = controlCase(item)
		controls.set(item.caseId, result)
		cases.push(result)
	}
	for (const item of facts.filter((candidate) => candidate.kind === "never")) {
		cases.push(neverCase(item, controls, violations))
	}
	const verdict = aggregateRun(cases, requiredCaseIdsB())
	return {
		outcome: verdict.outcome,
		reasons: [
			...violations.map((violation) => `fixture-violation: ${violation}`),
			...verdict.reasons,
		],
		cases,
		counts: tallyHealth(facts.map((item) => item.retrieval.health)),
	}
}
