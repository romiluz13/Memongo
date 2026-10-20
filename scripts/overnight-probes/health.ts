import type { Observation } from "./types.ts"

export type RouteId =
	| "search"
	| "searchDetailed"
	| "searchKB"
	| "recallConversation"
	| "readFile"
	| "lifecycleGet"
	| "lifecycleHistory"
	| "profile"
	| "hydrateActiveSlate"
	| "state"
	| "buildDiscoveryProjection"
	| "buildContextBundle"
	| "relevanceExplain"
	| "traceChain"
	| "scanNovelty"

export type RouteHealth = {
	route: RouteId
	completed: boolean
	healthy: boolean
	evaluable: boolean
	denied?: "not-found" | "forbidden"
	issues: string[]
}

export type HealthExpectation = {
	sections?: string[]
	acceptDegradedVerdict?: boolean
}

type Json = Record<string, unknown>

const DENIAL_ROUTES: ReadonlySet<RouteId> = new Set([
	"lifecycleGet",
	"lifecycleHistory",
])

function isRecord(value: unknown): value is Json {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

function asRows(value: unknown): Json[] {
	return Array.isArray(value) ? value.filter(isRecord) : []
}

function laneIssues(rows: Json[], prefix: string): string[] {
	const issues: string[] = []
	for (const row of rows) {
		if (row.stage === "explain") continue
		if (row.outcome === "failed" || row.outcome === "budget-denied") {
			issues.push(
				`${prefix}${String(row.outcome)}:${String(row.lane)}/${String(row.stage)}:${String(row.reason ?? "unspecified")}`,
			)
		}
	}
	return issues
}

function failureIssues(failures: unknown): string[] {
	return asRows(failures).map((row) => {
		const outcome = row.outcome === undefined ? "" : `-${String(row.outcome)}`
		const stage = row.stage === undefined ? "" : `/${String(row.stage)}`
		return `section${outcome}:${String(row.section)}${stage}:${String(row.reason ?? "unspecified")}`
	})
}

function degradationIssue(body: Json): string[] {
	const degradation = body.degradation
	if (degradation === undefined) return []
	const kind = isRecord(degradation)
		? String(degradation.kind ?? "unknown")
		: "unknown"
	return [`degraded:${kind}`]
}

function outcomesIssues(outcomes: unknown): string[] {
	if (!isRecord(outcomes)) return ["malformed:outcomes"]
	const issues: string[] = []
	if (outcomes.status !== "complete") {
		issues.push(`outcomes:${String(outcomes.status)}`)
	}
	if (outcomes.lanes !== undefined && !Array.isArray(outcomes.lanes)) {
		issues.push("malformed:outcome-lanes")
	}
	issues.push(...laneIssues(asRows(outcomes.lanes), "lane-"))
	return issues
}

function searchChecks(body: Json): string[] {
	const issues: string[] = []
	if (!Array.isArray(body.results)) issues.push("missing:results")
	if (body.outcomes === undefined) issues.push("outcomes-not-reported")
	else issues.push(...outcomesIssues(body.outcomes))
	return issues
}

function detailedChecks(body: Json): string[] {
	const issues: string[] = []
	if (!Array.isArray(body.results)) issues.push("missing:results")
	if (!isRecord(body.metadata)) return [...issues, "missing:metadata"]
	const meta = body.metadata
	if (meta.outcomeStatus !== undefined && meta.outcomeStatus !== "complete") {
		issues.push(`outcomes:${String(meta.outcomeStatus)}`)
	}
	issues.push(...laneIssues(asRows(meta.laneOutcomes), "lane-"))
	if (meta.throttled !== undefined) issues.push("throttled")
	return issues
}

function recallChecks(body: Json): { issues: string[]; truncated: boolean } {
	const issues: string[] = []
	if (!Array.isArray(body.results)) issues.push("missing:results")
	if (!isRecord(body.metadata))
		return { issues: [...issues, "missing:metadata"], truncated: false }
	const total = body.metadata.totalMatched
	const returned = Array.isArray(body.results) ? body.results.length : 0
	return {
		issues,
		truncated: typeof total === "number" && total > returned,
	}
}

function sectionedChecks(meta: unknown): {
	issues: string[]
	truncated: boolean
} {
	if (!isRecord(meta)) return { issues: ["missing:metadata"], truncated: false }
	const issues: string[] = []
	if (meta.partial === true) issues.push("partial")
	issues.push(...failureIssues(meta.failures))
	if (meta.outcomeStatus !== undefined && meta.outcomeStatus !== "complete") {
		issues.push(`outcomes:${String(meta.outcomeStatus)}`)
	}
	issues.push(...laneIssues(asRows(meta.laneOutcomes), "lane-"))
	if (meta.throttled !== undefined) issues.push("throttled")
	return { issues, truncated: meta.truncated === true }
}

function bundleChecks(
	body: Json,
	expected: readonly string[] | undefined,
): { issues: string[]; truncated: boolean } {
	const base = sectionedChecks(body.metadata)
	const issues = [...base.issues]
	let truncated = base.truncated
	for (const section of asRows(body.sections)) {
		if (section.partial === true)
			issues.push(`section-partial:${String(section.kind)}`)
		if (section.truncated === true) truncated = true
	}
	if (expected && isRecord(body.metadata)) {
		const included = new Set(
			Array.isArray(body.metadata.sectionsIncluded)
				? body.metadata.sectionsIncluded.map(String)
				: [],
		)
		const failed = new Set(
			asRows(body.metadata.failures).map(
				(row) => String(row.section).split(":")[0],
			),
		)
		for (const kind of expected) {
			if (!included.has(kind) && !failed.has(kind)) {
				issues.push(`missing-section:${kind}`)
			}
		}
	}
	return { issues, truncated }
}

function traceChainIssues(body: Json): string[] {
	if (!Array.isArray(body.nodes)) return ["missing:nodes"]
	const issues: string[] = []
	if (body.chainComplete !== true) issues.push("partial:chain-incomplete")
	if (body.maxDepthReached === true) issues.push("partial:max-depth")
	if (asRows(body.nodes).some((node) => node.type === "gap")) {
		issues.push("partial:gap-node")
	}
	return issues
}

function profileChecks(body: Json): string[] {
	return ["preferences", "decisions", "facts", "todos"]
		.filter((field) => !Array.isArray(body[field]))
		.map((field) => `missing-section:${field}`)
}

function stateChecks(body: Json): { issues: string[]; truncated: boolean } {
	const issues: string[] = []
	let truncated = false
	if (body.partial === true) issues.push("partial")
	const failed = new Set<string>()
	for (const row of asRows(body.failures)) {
		failed.add(String(row.section))
		issues.push(
			`section-failed:${String(row.section)}:${String(row.reason ?? "unspecified")}`,
		)
	}
	for (const section of ["profile", "blocks", "bundle"] as const) {
		if (body[section] === undefined && !failed.has(section)) {
			issues.push(`missing-section:${section}`)
		}
	}
	if (isRecord(body.profile)) {
		issues.push(
			...profileChecks(body.profile).map((issue) => `profile:${issue}`),
		)
	}
	if (isRecord(body.bundle)) {
		const nested = bundleChecks(body.bundle, undefined)
		issues.push(...nested.issues.map((issue) => `bundle:${issue}`))
		truncated = nested.truncated
	}
	return { issues, truncated }
}

function finish(
	route: RouteId,
	issues: string[],
	truncated: boolean,
	extra: Partial<RouteHealth> = {},
): RouteHealth {
	const informational = new Set(["outcomes-not-reported"])
	const blocking = issues.filter((issue) => !informational.has(issue))
	const allIssues = truncated ? [...issues, "truncated"] : issues
	const healthy = blocking.length === 0
	return {
		route,
		completed: true,
		healthy,
		evaluable: healthy && !truncated,
		issues: allIssues,
		...extra,
	}
}

function failed(route: RouteId, issues: string[]): RouteHealth {
	return { route, completed: false, healthy: false, evaluable: false, issues }
}

export function evaluateRouteHealth(
	route: RouteId,
	observation: Observation,
	expectation: HealthExpectation = {},
): RouteHealth {
	if (observation.kind === "transport-error") {
		return failed(route, ["transport-error"])
	}
	if (observation.kind === "http-error") {
		if (DENIAL_ROUTES.has(route) && observation.status === 404) {
			return finish(route, [], false, { denied: "not-found" })
		}
		if (DENIAL_ROUTES.has(route) && observation.status === 403) {
			return finish(route, [], false, { denied: "forbidden" })
		}
		const issues = [`http-${observation.status}`]
		if (observation.code) issues.push(`code:${observation.code}`)
		if (observation.code === "ERASURE_IN_PROGRESS")
			issues.push("erasure-in-progress")
		return failed(route, issues)
	}
	const body = observation.body
	if (route === "lifecycleHistory") {
		return Array.isArray(body)
			? finish(route, [], false)
			: finish(route, ["malformed-body"], false)
	}
	if (!isRecord(body)) return finish(route, ["malformed-body"], false)
	const issues = degradationIssue(body)
	let truncated = false
	switch (route) {
		case "search":
		case "searchKB":
			issues.push(...searchChecks(body))
			break
		case "searchDetailed":
			issues.push(...detailedChecks(body))
			break
		case "recallConversation": {
			const recall = recallChecks(body)
			issues.push(...recall.issues)
			truncated = recall.truncated
			break
		}
		case "hydrateActiveSlate": {
			const slate = sectionedChecks(body.metadata)
			if (!Array.isArray(body.items)) issues.push("missing:items")
			issues.push(...slate.issues)
			truncated = slate.truncated
			break
		}
		case "buildDiscoveryProjection": {
			const discovery = sectionedChecks(body.metadata)
			if (!Array.isArray(body.sections)) issues.push("missing:sections")
			issues.push(...discovery.issues)
			truncated = discovery.truncated
			break
		}
		case "buildContextBundle": {
			const bundle = bundleChecks(body, expectation.sections)
			issues.push(...bundle.issues)
			truncated = bundle.truncated
			break
		}
		case "state": {
			const state = stateChecks(body)
			issues.push(...state.issues)
			truncated = state.truncated
			break
		}
		case "profile":
			issues.push(...profileChecks(body))
			break
		case "readFile": {
			if (typeof body.error === "string") issues.push("file-error")
			if (body.disabled === true) issues.push("file-disabled")
			if (issues.length === 0 && body.text === "") {
				return finish(route, [], false, { denied: "not-found" })
			}
			break
		}
		case "relevanceExplain": {
			const usable =
				body.health === "ok" ||
				(expectation.acceptDegradedVerdict === true &&
					body.health === "degraded")
			if (!usable) issues.push(`health:${String(body.health)}`)
			if (!Array.isArray(body.results)) issues.push("missing:results")
			if (body.outcomes !== undefined) {
				issues.push(...outcomesIssues(body.outcomes))
			}
			break
		}
		case "scanNovelty":
			if (!Array.isArray(body.events)) issues.push("missing:events")
			break
		case "traceChain":
			issues.push(...traceChainIssues(body))
			break
		default:
			break
	}
	return finish(route, issues, truncated)
}

export function tallyHealth(list: readonly RouteHealth[]): {
	attempted: number
	completed: number
	healthy: number
	evaluable: number
} {
	return {
		attempted: list.length,
		completed: list.filter((h) => h.completed).length,
		healthy: list.filter((h) => h.healthy).length,
		evaluable: list.filter((h) => h.evaluable).length,
	}
}
