import {
	type HealthExpectation,
	type RouteHealth,
	tallyHealth,
} from "./health.ts"
import { containsMarker } from "./markers.ts"
import { bodyOf } from "./observe.ts"
import {
	historical,
	isRecord,
	labelled,
	passed,
	rowsContaining,
	textField,
	viewOf,
} from "./rows.ts"
import type {
	CaseResult,
	ContractBasis,
	Observation,
	Outcome,
} from "./types.ts"
import { aggregateRun, inconclusive, passCase } from "./verdict.ts"

export const PROBE_G_VERSION = "G-2"

export const PROBE_G_RULE =
	"After a mutation is confirmed by the lifecycle record, a superseded value fails a route when it is returned as current: on a row without a historical label, anywhere on a current-only route, or as the current history entry. A row is historical only when its state or trust says invalidated or its validTo has passed. A case passes only when the response was healthy, complete and evaluable, a pre-mutation read of the same route surfaced the item, the old value is absent or historical, and for an update the new value is present. A route whose rows carry no currentness field is unassessable, which is inconclusive. The relevanceExplain route runs the same search pipeline for the agent's default identity and is judged like search; its own verdict of degraded, which means no or weak results, does not make a completed search unevaluable, but a run that measured nothing does. Rank and wording are never evidence."

export type GRouteId =
	| "lifecycleGet"
	| "lifecycleHistory"
	| "searchDetailed"
	| "readFile"
	| "search"
	| "profile"
	| "hydrateActiveSlate"
	| "state"
	| "buildDiscoveryProjection"
	| "buildContextBundle"
	| "relevanceExplain"

export type GBasis = "revision" | "history" | "row-state" | "contract"

export const G_ROUTES: Record<GRouteId, { basis: GBasis; note: string }> = {
	lifecycleGet: {
		basis: "revision",
		note: "handle revision, state and validTo on the returned record",
	},
	lifecycleHistory: {
		basis: "history",
		note: "the entry marked current; revision entries are historical",
	},
	searchDetailed: {
		basis: "row-state",
		note: "each row carries state, validTo and trust.contradiction",
	},
	readFile: {
		basis: "row-state",
		note: "the text carries state, revision and validTo lines and does not filter by state",
	},
	search: {
		basis: "contract",
		note: "plain rows carry no state; the structured lane is current-only by engine default (code-derived, not documented)",
	},
	profile: {
		basis: "contract",
		note: "profile reads active, currently valid structured memory (code-derived)",
	},
	hydrateActiveSlate: {
		basis: "contract",
		note: "the slate applies the current-validity guard (code-derived)",
	},
	state: {
		basis: "contract",
		note: "state composes profile, blocks and a context bundle (code-derived)",
	},
	buildDiscoveryProjection: {
		basis: "contract",
		note: "projections read current-only structured memory (code-derived)",
	},
	buildContextBundle: {
		basis: "contract",
		note: "query evidence uses the current-only structured lane (code-derived)",
	},
	relevanceExplain: {
		basis: "contract",
		note: "the explain run executes the search pipeline over the agent's default identity (code-derived)",
	},
}

export const G_GAPS: { route: string; reason: string }[] = [
	{
		route: "traceChain",
		reason:
			"the chain is looked up by fact id, so a historical node is legitimate and the route carries no per-node currentness field",
	},
	{
		route: "recallConversation",
		reason:
			"conversation recall returns events, which have no lifecycle revision to supersede",
	},
	{
		route: "scanNovelty",
		reason:
			"the novelty scan returns events, which have no lifecycle revision to supersede",
	},
	{
		route: "searchKB",
		reason:
			"no knowledge-base write exists in the API, so no value can be superseded there",
	},
]

export function expectationFor(route: GRouteId): HealthExpectation {
	if (route === "buildContextBundle") return { sections: ["query-evidence"] }
	if (route === "relevanceExplain") return { acceptDegradedVerdict: true }
	return {}
}

export type GRead = {
	route: GRouteId
	phase: "pre" | "post"
	at: number
	observation: Observation
	health: RouteHealth
	request: unknown
}

type GSequenceBase = {
	oldMarker: string
	ack: { ok: boolean; reason?: string }
	reads: GRead[]
}

export type GSequenceFacts =
	| (GSequenceBase & { sequence: "update"; newMarker: string })
	| (GSequenceBase & { sequence: "delete"; newMarker?: never })

export type ProbeGEvaluation = {
	outcome: Outcome
	reasons: string[]
	cases: CaseResult[]
	gaps: { route: string; reason: string }[]
	counts: ReturnType<typeof tallyHealth>
}

type Status = "confirmed" | "not-applied" | "ack-not-visible" | "unverified"

const SEQUENCES = ["update", "delete"] as const
const ROUTE_IDS = Object.keys(G_ROUTES) as GRouteId[]

export function requiredCaseIdsG(): string[] {
	return SEQUENCES.flatMap((sequence) =>
		ROUTE_IDS.map((route) => `G/${sequence}/${route}`),
	)
}

type OldStatus = { present: boolean; current: boolean; unassessable?: string }

function classifyReadFile(text: string, token: string, at: number): OldStatus {
	if (!text.includes(token)) return { present: false, current: false }
	const state = textField(text, "state")
	if (state === undefined) {
		return {
			present: true,
			current: false,
			unassessable: "readFile text has no state line",
		}
	}
	const isHistorical =
		state === "invalidated" || passed(textField(text, "validTo"), at)
	return { present: true, current: !isHistorical }
}

function classifyOld(read: GRead, token: string): OldStatus {
	if (read.observation.kind !== "response") {
		return { present: false, current: false }
	}
	const body = read.observation.body
	if (read.route === "readFile") {
		const text =
			isRecord(body) && typeof body.text === "string" ? body.text : ""
		return classifyReadFile(text, token, read.at)
	}
	const rows = rowsContaining(body, token)
	if (rows.length === 0) return { present: false, current: false }
	const live = rows.filter((row) => !historical(row, read.at))
	if (live.length === 0) return { present: true, current: false }
	if (G_ROUTES[read.route].basis === "row-state") {
		const decidable = live.filter(labelled)
		if (decidable.length > 0) return { present: true, current: true }
		return {
			present: true,
			current: false,
			unassessable: "row without currentness fields",
		}
	}
	return { present: true, current: true }
}

function findRead(
	facts: GSequenceFacts,
	route: GRouteId,
	phase: GRead["phase"],
): GRead | undefined {
	return facts.reads.find(
		(read) => read.route === route && read.phase === phase,
	)
}

function controlOk(facts: GSequenceFacts, route: GRouteId): boolean {
	const pre = findRead(facts, route, "pre")
	return (
		pre?.health.evaluable === true &&
		containsMarker(pre.observation, facts.oldMarker)
	)
}

function mutationStatus(facts: GSequenceFacts): {
	status: Status
	detail: string
} {
	if (!facts.ack.ok) {
		return {
			status: "not-applied",
			detail: facts.ack.reason ?? "mutation call failed",
		}
	}
	const post = findRead(facts, "lifecycleGet", "post")
	const pre = findRead(facts, "lifecycleGet", "pre")
	if (!post?.health.evaluable) {
		return {
			status: "unverified",
			detail: "lifecycle get unavailable after the mutation",
		}
	}
	if (post.health.denied === "not-found" && facts.sequence === "delete") {
		return { status: "confirmed", detail: "record gone" }
	}
	const view = viewOf(bodyOf(post.observation))
	if (!view)
		return { status: "unverified", detail: "lifecycle get body unreadable" }
	const preView = pre ? viewOf(bodyOf(pre.observation)) : undefined
	if (facts.sequence === "delete") {
		if (view.state === "invalidated")
			return { status: "confirmed", detail: "invalidated" }
		if (view.value.includes(facts.oldMarker) && view.state === "active") {
			return { status: "ack-not-visible", detail: "record still active" }
		}
		return { status: "unverified", detail: "state not conclusive" }
	}
	const baseline = preView?.revision
	const advanced =
		baseline !== undefined &&
		view.revision !== undefined &&
		view.revision > baseline
	if (
		view.value.includes(facts.newMarker) &&
		advanced &&
		view.state !== "invalidated"
	) {
		return { status: "confirmed", detail: `revision ${view.revision}` }
	}
	if (view.value.includes(facts.oldMarker)) {
		return { status: "ack-not-visible", detail: "old value still current" }
	}
	return { status: "unverified", detail: "new value or revision not shown" }
}

function evidence(read: GRead) {
	return { request: read.request, response: read.observation }
}

function failCase(
	caseId: string,
	route: GRouteId,
	read: GRead,
	control: boolean,
): CaseResult {
	return {
		caseId,
		outcome: "fail",
		predicate: `old-as-current:${route}`,
		reason: `old-as-current:${route}`,
		controlEligible: control,
		detail: { issues: read.health.issues, basis: G_ROUTES[route].basis },
		evidence: evidence(read),
	}
}

function lifecycleGetCase(
	caseId: string,
	facts: GSequenceFacts,
	status: Status,
	detail: string,
	post: GRead,
): CaseResult {
	if (status === "confirmed") return passCase(caseId, { confirmation: detail })
	if (status === "ack-not-visible") {
		return failCase(
			caseId,
			"lifecycleGet",
			post,
			controlOk(facts, "lifecycleGet"),
		)
	}
	return inconclusive(caseId, `mutation-${status}`)
}

function historyCase(
	caseId: string,
	facts: GSequenceFacts,
	post: GRead,
): CaseResult {
	const control = controlOk(facts, "lifecycleHistory")
	if (post.health.denied)
		return inconclusive(caseId, "unassessable:history-gone")
	const body = bodyOf(post.observation)
	const entries = Array.isArray(body) ? body : []
	const current = entries.find(
		(entry) => isRecord(entry) && entry.historyKind === "current",
	)
	const view = viewOf(current)
	if (!view) return inconclusive(caseId, "unassessable:no-current-entry")
	const oldCurrent = view.value.includes(facts.oldMarker)
	if (facts.sequence === "update") {
		if (oldCurrent) return failCase(caseId, "lifecycleHistory", post, control)
		if (!control) return inconclusive(caseId, "control-not-established")
		return view.value.includes(facts.newMarker)
			? passCase(caseId)
			: inconclusive(caseId, "new-value-absent")
	}
	const isHistorical =
		view.state === "invalidated" || passed(view.validTo, post.at)
	if (oldCurrent && !isHistorical) {
		return failCase(caseId, "lifecycleHistory", post, control)
	}
	if (!control) return inconclusive(caseId, "control-not-established")
	return isHistorical
		? passCase(caseId)
		: inconclusive(caseId, "unassessable:state-not-shown")
}

function routeCase(
	caseId: string,
	route: GRouteId,
	facts: GSequenceFacts,
	post: GRead,
): CaseResult {
	const old = classifyOld(post, facts.oldMarker)
	const control = controlOk(facts, route)
	if (old.current) return failCase(caseId, route, post, control)
	if (!post.health.evaluable) {
		return inconclusive(
			caseId,
			`unevaluable:${post.health.issues.join(",") || "no-response"}`,
		)
	}
	if (!control) return inconclusive(caseId, "control-not-established")
	if (old.unassessable)
		return inconclusive(caseId, `unassessable:${old.unassessable}`)
	if (
		facts.sequence === "update" &&
		!containsMarker(post.observation, facts.newMarker)
	) {
		return inconclusive(caseId, "new-value-absent")
	}
	return passCase(caseId, { oldPresentAsHistory: old.present })
}

function evaluateSequence(facts: GSequenceFacts): CaseResult[] {
	const { status, detail } = mutationStatus(facts)
	const cases: CaseResult[] = []
	for (const route of ROUTE_IDS) {
		const post = findRead(facts, route, "post")
		if (!post) continue
		const caseId = `G/${facts.sequence}/${route}`
		const contractBasis: ContractBasis =
			G_ROUTES[route].basis === "contract" ? "code-derived" : "documented"
		if (route === "lifecycleGet") {
			cases.push({
				...lifecycleGetCase(caseId, facts, status, detail, post),
				contractBasis,
			})
		} else if (status !== "confirmed") {
			cases.push({
				...inconclusive(caseId, `mutation-${status}`),
				contractBasis,
			})
		} else if (route === "lifecycleHistory") {
			cases.push({ ...historyCase(caseId, facts, post), contractBasis })
		} else {
			cases.push({ ...routeCase(caseId, route, facts, post), contractBasis })
		}
	}
	return cases
}

export function evaluateProbeG(
	sequences: readonly GSequenceFacts[],
): ProbeGEvaluation {
	const cases = sequences.flatMap(evaluateSequence)
	const verdict = aggregateRun(cases, requiredCaseIdsG())
	return {
		outcome: verdict.outcome,
		reasons: verdict.reasons,
		cases,
		gaps: G_GAPS,
		counts: tallyHealth(
			sequences.flatMap((facts) => facts.reads.map((read) => read.health)),
		),
	}
}
