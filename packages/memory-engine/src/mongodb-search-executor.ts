import type { RetrievalPath } from "./mongodb-retrieval-planner.js"
import {
	classifyRetrievalQuery,
	resolveTimeRangePreset,
} from "./mongodb-retrieval-planner.js"
import { resolveScopeRef } from "./mongodb-scope.js"
import { sortObject } from "./search-utils.js"
import {
	annotateResultsWithTrust,
	rerankResultsByTrust,
	shouldAbstainForLowTrust,
	summarizeTrust,
} from "./mongodb-trust.js"
import type { MemorySearchResult } from "./types.js"
import type {
	EvidenceCoverage,
	MemorySearchClassification,
	MemorySearchMetadata,
	MemorySearchMode,
	MemorySearchPass,
	MemorySearchRequest,
	MemorySearchResponse,
	MemorySearchSourcePreference,
	ResolvedSearchConfig,
	RejectedResultSummary,
	SearchConfig,
	SearchRecipe,
} from "./types.js"

export type MemorySearchExecutorTimeRange = {
	start: Date
	end: Date
}

export type MemorySearchExecutorRequest = MemorySearchRequest & {
	searchMode: MemorySearchMode
	maxPasses: number
	sourcePreference: MemorySearchSourcePreference[]
}

export type MemorySearchExecutorPlanPass = {
	pass: number
	query: string
	reason: string
	variant:
		| "original"
		| "rewrite"
		| "family-expansion"
		| "decomposition"
		| "breadth"
		| "recovery"
		| "constraint-retry"
	preferredPaths?: RetrievalPath[]
	kind?: "breadth" | "current-state" | "temporal-freshness" | "exact-evidence"
}

function defaultSourcePreference(): MemorySearchSourcePreference[] {
	return [
		"conversation",
		"structured",
		"procedural",
		"reference",
		"episodic",
		"graph",
	]
}

function recipeDefaults(recipe: SearchRecipe): SearchConfig {
	switch (recipe) {
		case "fast":
			return {
				recipe,
				maxResults: 5,
				searchMode: "direct",
				maxPasses: 1,
				sourcePreference: ["conversation", "structured", "reference"],
				numCandidates: 20,
				fusionMethod: "rankFusion",
				hybridMode: "vector-only",
				allowHybridBackstop: false,
				lexicalPrefilter: "disabled",
			}
		case "hybrid":
			return {
				recipe,
				searchMode: "auto",
				maxPasses: 2,
				numCandidates: 100,
				fusionMethod: "rankFusion",
				hybridMode: "hybrid",
				allowHybridBackstop: true,
				lexicalPrefilter: "disabled",
			}
		case "deep":
			return {
				recipe,
				searchMode: "agentic",
				maxPasses: 3,
				numCandidates: 200,
				fusionMethod: "rankFusion",
				hybridMode: "hybrid",
				allowHybridBackstop: true,
				lexicalPrefilter: "disabled",
			}
		case "temporal":
			return {
				recipe,
				searchMode: "agentic",
				maxPasses: 3,
				timeRange: { preset: "last-30d" },
				sourcePreference: [
					"conversation",
					"episodic",
					"structured",
					"reference",
					"procedural",
					"graph",
				],
				numCandidates: 100,
				fusionMethod: "rankFusion",
				hybridMode: "hybrid",
				allowHybridBackstop: true,
				lexicalPrefilter: "disabled",
			}
		case "chain-of-thought":
			return {
				recipe,
				searchMode: "agentic",
				maxPasses: 4,
				numCandidates: 200,
				fusionMethod: "rankFusion",
				hybridMode: "hybrid",
				allowHybridBackstop: true,
				lexicalPrefilter: "disabled",
			}
	}
}

export function resolveSearchConfig(request: MemorySearchRequest): Omit<
	ResolvedSearchConfig,
	"numCandidates" | "fusionMethod"
> & {
	numCandidates?: number
	fusionMethod?: ResolvedSearchConfig["fusionMethod"]
} {
	const recipe = request.searchConfig?.recipe
	const seeded = recipe ? recipeDefaults(recipe) : {}
	const configured = { ...seeded, ...request.searchConfig }
	return {
		recipe: recipe ?? "custom",
		maxResults: Math.max(
			1,
			Math.trunc(request.maxResults ?? configured.maxResults ?? 10),
		),
		searchMode: request.searchMode ?? configured.searchMode ?? "auto",
		maxPasses: Math.max(
			1,
			Math.min(
				4,
				Math.trunc(
					request.maxPasses ??
						configured.maxPasses ??
						((request.searchMode ?? configured.searchMode ?? "auto") ===
						"direct"
							? 1
							: (request.searchMode ?? configured.searchMode ?? "auto") ===
									"agentic"
								? 3
								: 2),
				),
			),
		),
		sourcePreference:
			request.sourcePreference ??
			configured.sourcePreference ??
			defaultSourcePreference(),
		timeRange: request.timeRange ?? configured.timeRange,
		needExactEvidence:
			request.needExactEvidence ?? configured.needExactEvidence ?? false,
		numCandidates:
			request.searchConfig?.numCandidates ?? configured.numCandidates,
		fusionMethod: request.searchConfig?.fusionMethod ?? configured.fusionMethod,
		hybridMode:
			request.searchConfig?.hybridMode ?? configured.hybridMode ?? "hybrid",
		allowHybridBackstop:
			request.searchConfig?.allowHybridBackstop ??
			configured.allowHybridBackstop ??
			true,
		lexicalPrefilter:
			request.searchConfig?.lexicalPrefilter ??
			configured.lexicalPrefilter ??
			"disabled",
	}
}

export function applySearchConfig(
	request: MemorySearchRequest,
): MemorySearchRequest {
	const resolved = resolveSearchConfig(request)
	const requestSearchConfig: SearchConfig = {
		...(resolved.recipe !== "custom" ? { recipe: resolved.recipe } : {}),
		maxResults: resolved.maxResults,
		searchMode: resolved.searchMode,
		maxPasses: resolved.maxPasses,
		sourcePreference: resolved.sourcePreference,
		...(resolved.timeRange ? { timeRange: resolved.timeRange } : {}),
		needExactEvidence: resolved.needExactEvidence,
		...(resolved.numCandidates != null
			? { numCandidates: resolved.numCandidates }
			: {}),
		...(resolved.fusionMethod ? { fusionMethod: resolved.fusionMethod } : {}),
		hybridMode: resolved.hybridMode,
		allowHybridBackstop: resolved.allowHybridBackstop,
		lexicalPrefilter: resolved.lexicalPrefilter,
	}
	return {
		...request,
		maxResults: request.maxResults ?? resolved.maxResults,
		searchMode: request.searchMode ?? resolved.searchMode,
		maxPasses: request.maxPasses ?? resolved.maxPasses,
		sourcePreference: request.sourcePreference ?? resolved.sourcePreference,
		timeRange: request.timeRange ?? resolved.timeRange,
		needExactEvidence: request.needExactEvidence ?? resolved.needExactEvidence,
		searchConfig: requestSearchConfig,
	}
}

function sourcePreferencePaths(
	source: MemorySearchSourcePreference,
): RetrievalPath[] {
	switch (source) {
		case "conversation":
			return ["hybrid", "raw-window"]
		case "reference":
			return ["kb"]
		case "structured":
			return ["active-critical", "structured"]
		case "procedural":
			return ["procedural"]
		case "episodic":
			return ["episodic"]
		case "graph":
			return ["graph"]
	}
}

function selectPassPaths(params: {
	availablePaths: Set<RetrievalPath>
	sourcePreference: MemorySearchSourcePreference[]
	pass: number
	timeRange?: MemorySearchExecutorTimeRange
	preferredPaths?: RetrievalPath[]
}): Set<RetrievalPath> {
	const allowed = new Set(params.availablePaths)
	if (params.timeRange) {
		for (const path of allowed) {
			if (!["raw-window", "hybrid", "episodic"].includes(path)) {
				allowed.delete(path)
			}
		}
	}
	if (params.preferredPaths && params.preferredPaths.length > 0) {
		const hintedAllowed = new Set(
			params.preferredPaths.filter((path) => allowed.has(path)),
		)
		if (hintedAllowed.size > 0) {
			if (params.sourcePreference.length === 0) {
				return hintedAllowed
			}
			const preferredAllowed = new Set(
				params.sourcePreference.flatMap((source) =>
					sourcePreferencePaths(source),
				),
			)
			const scopedHinted = new Set(
				Array.from(hintedAllowed).filter((path) => preferredAllowed.has(path)),
			)
			return scopedHinted.size > 0 ? scopedHinted : hintedAllowed
		}
	}
	if (params.sourcePreference.length === 0) {
		return allowed
	}
	const preferredAllowed = new Set(
		params.sourcePreference.flatMap((source) => sourcePreferencePaths(source)),
	)
	const scopedAllowed = new Set(
		Array.from(allowed).filter((path) => preferredAllowed.has(path)),
	)
	const preferredSource =
		params.sourcePreference[
			Math.min(params.pass - 1, params.sourcePreference.length - 1)
		]
	const preferredPaths = sourcePreferencePaths(preferredSource).filter((path) =>
		scopedAllowed.has(path),
	)
	if (
		preferredPaths.length === 0 ||
		params.pass > params.sourcePreference.length
	) {
		return scopedAllowed
	}
	return new Set(preferredPaths)
}

export function buildMemorySearchRequestSignature(
	request: MemorySearchRequest,
): string {
	return JSON.stringify(
		sortObject({
			query: request.query,
			maxResults: request.maxResults,
			minScore: request.minScore,
			searchMode: request.searchMode,
			sourcePreference: request.sourcePreference,
			timeRange: request.timeRange,
			needExactEvidence: request.needExactEvidence,
			maxPasses: request.maxPasses,
			conversationScope: request.conversationScope,
			structuredScope: request.structuredScope,
			referenceScope: request.referenceScope,
			proceduralScope: request.proceduralScope,
			searchConfig: request.searchConfig,
		}),
	)
}

export function normalizeMemorySearchRequest(
	request: MemorySearchRequest,
): MemorySearchExecutorRequest {
	const configuredRequest = applySearchConfig(request)
	const requestedMode = configuredRequest.searchMode ?? "auto"
	const maxPassDefaults: Record<MemorySearchMode, number> = {
		direct: 1,
		auto: 2,
		agentic: 3,
	}
	const maxPasses = Math.max(
		1,
		Math.min(
			4,
			Math.trunc(configuredRequest.maxPasses ?? maxPassDefaults[requestedMode]),
		),
	)
	return {
		...configuredRequest,
		searchMode: requestedMode,
		maxPasses,
		sourcePreference:
			configuredRequest.sourcePreference ?? defaultSourcePreference(),
	}
}

export function resolveExecutorTimeRange(
	request: MemorySearchRequest,
): MemorySearchExecutorTimeRange | undefined {
	const raw = request.timeRange
	if (!raw) {
		return undefined
	}
	if (raw.preset) {
		return resolveTimeRangePreset(raw.preset)
	}
	const start = raw.start ? new Date(raw.start) : undefined
	const end = raw.end ? new Date(raw.end) : undefined
	if (
		(start && Number.isNaN(start.getTime())) ||
		(end && Number.isNaN(end.getTime())) ||
		!start ||
		!end
	) {
		return undefined
	}
	return { start, end }
}

export function classifyExecutorSearch(
	request: MemorySearchRequest,
): MemorySearchClassification {
	return classifyRetrievalQuery({
		query: request.query,
		hasTimeRange: Boolean(request.timeRange),
		hasScopes: Boolean(
			request.scope ||
				request.scopeRef ||
				request.conversationScope ||
				request.structuredScope ||
				request.referenceScope ||
				request.proceduralScope,
		),
	})
}

export function buildExecutorPasses(
	request: MemorySearchExecutorRequest,
	_classification: MemorySearchClassification,
): MemorySearchExecutorPlanPass[] {
	return [
		{
			pass: 1,
			query: request.query,
			reason: "original query",
			variant: "original",
		},
	]
}

function queryNeedsCurrentState(query: string): boolean {
	return /\b(right now|currently|status|situation|blocker|blocked|owns?|owner|depends?|active)\b/i.test(
		query,
	)
}

function filterPreferredPaths(
	preferred: RetrievalPath[],
	availablePaths: Set<RetrievalPath>,
	executedPaths: Set<RetrievalPath>,
): RetrievalPath[] {
	const eligible = preferred.filter((path) => availablePaths.has(path))
	const untried = eligible.filter((path) => !executedPaths.has(path))
	return untried.length > 0 ? untried : eligible
}

export function planFollowUpPass(params: {
	request: MemorySearchExecutorRequest
	classification: MemorySearchClassification
	availablePaths: Set<RetrievalPath>
	executedPaths: Set<RetrievalPath>
	acceptedResults: MemorySearchResult[]
	evidenceCoverage: EvidenceCoverage
	timeRange?: MemorySearchExecutorTimeRange
	trustSummary: NonNullable<MemorySearchMetadata["trustSummary"]>
	seenKinds: Set<string>
}): MemorySearchExecutorPlanPass | null {
	const allowAgentic =
		params.request.searchMode === "agentic" ||
		(params.request.searchMode === "auto" && params.classification !== "direct")
	if (!allowAgentic) {
		return null
	}

	const lowTrustOnly =
		params.trustSummary.distribution.high === 0 &&
		params.trustSummary.distribution.medium === 0 &&
		params.trustSummary.distribution.low > 0
	const hasStaleOrContradicted =
		params.trustSummary.staleCount > 0 ||
		params.trustSummary.contradictionCount > 0
	const targetCount = Math.min(params.request.maxResults ?? 10, 3)

	if (
		!params.seenKinds.has("current-state") &&
		(hasStaleOrContradicted || lowTrustOnly) &&
		queryNeedsCurrentState(params.request.query)
	) {
		const preferredPaths = filterPreferredPaths(
			["active-critical", "raw-window", "structured", "graph", "procedural"],
			params.availablePaths,
			params.executedPaths,
		)
		if (preferredPaths.length > 0) {
			return {
				pass: 0,
				query: params.request.query,
				reason: "current-state recovery follow-up",
				variant: "recovery",
				preferredPaths,
				kind: "current-state",
			}
		}
	}

	if (
		!params.seenKinds.has("temporal-freshness") &&
		params.timeRange &&
		(params.evidenceCoverage === "none" ||
			params.trustSummary.staleCount > 0 ||
			params.acceptedResults.length === 0)
	) {
		const preferredPaths = filterPreferredPaths(
			["raw-window", "episodic", "hybrid", "structured"],
			params.availablePaths,
			params.executedPaths,
		)
		if (preferredPaths.length > 0) {
			return {
				pass: 0,
				query: params.request.query,
				reason: "temporal freshness follow-up",
				variant: "recovery",
				preferredPaths,
				kind: "temporal-freshness",
			}
		}
	}

	if (
		!params.seenKinds.has("exact-evidence") &&
		params.request.needExactEvidence &&
		(params.evidenceCoverage === "none" ||
			params.evidenceCoverage === "indirect")
	) {
		const preferredPaths = filterPreferredPaths(
			["raw-window", "structured", "procedural", "graph", "hybrid"],
			params.availablePaths,
			params.executedPaths,
		)
		if (preferredPaths.length > 0) {
			return {
				pass: 0,
				query: params.request.query,
				reason: "exact-evidence follow-up",
				variant: "constraint-retry",
				preferredPaths,
				kind: "exact-evidence",
			}
		}
	}

	if (
		!params.seenKinds.has("breadth") &&
		(params.classification === "family" ||
			params.classification === "comparison" ||
			params.classification === "multi-hop") &&
		params.acceptedResults.length < targetCount
	) {
		const preferredByClass: Record<
			"family" | "comparison" | "multi-hop",
			RetrievalPath[]
		> = {
			family: ["kb", "procedural", "structured", "hybrid", "graph", "episodic"],
			comparison: ["structured", "kb", "procedural", "hybrid", "graph"],
			"multi-hop": ["graph", "episodic", "raw-window", "hybrid", "structured"],
		}
		const preferredPaths = filterPreferredPaths(
			preferredByClass[params.classification],
			params.availablePaths,
			params.executedPaths,
		)
		if (preferredPaths.length > 0) {
			return {
				pass: 0,
				query: params.request.query,
				reason: "breadth follow-up",
				variant: "breadth",
				preferredPaths,
				kind: "breadth",
			}
		}
	}

	return null
}

export function resultHasExactEvidence(result: MemorySearchResult): boolean {
	if (result.canonicalId?.trim()) {
		return true
	}
	if (result.path.trim()) {
		return true
	}
	return false
}

function searchResultIdentity(result: MemorySearchResult): string {
	return (
		result.canonicalId ?? `${result.path}:${result.startLine}:${result.endLine}`
	)
}

const QUERY_STOPWORDS = new Set([
	"what",
	"when",
	"where",
	"which",
	"who",
	"whom",
	"whose",
	"why",
	"how",
	"is",
	"are",
	"was",
	"were",
	"do",
	"does",
	"did",
	"the",
	"a",
	"an",
	"this",
	"that",
	"these",
	"those",
	"in",
	"on",
	"for",
	"with",
	"to",
	"from",
	"of",
	"my",
	"our",
	"your",
	"current",
	"exactly",
	"please",
	"thread",
])

function extractExactEvidenceAnchors(query: string): string[] {
	const anchors = new Set<string>()
	for (const match of query.matchAll(/"([^"]+)"|'([^']+)'/g)) {
		const phrase = (match[1] ?? match[2] ?? "").trim()
		if (phrase.length >= 3) {
			anchors.add(phrase.toLowerCase())
		}
	}
	for (const match of query.matchAll(
		/\b(?:[A-Z][A-Za-z0-9-]*)(?:\s+[A-Z][A-Za-z0-9-]*)*/g,
	)) {
		const phrase = match[0]?.trim()
		if (!phrase) {
			continue
		}
		const normalizedPhrase = phrase.toLowerCase()
		if (!QUERY_STOPWORDS.has(normalizedPhrase)) {
			anchors.add(normalizedPhrase)
		}
		for (const token of phrase.split(/\s+/)) {
			const normalizedToken = token.trim().toLowerCase()
			if (
				normalizedToken.length >= 3 &&
				!QUERY_STOPWORDS.has(normalizedToken)
			) {
				anchors.add(normalizedToken)
			}
		}
	}
	return Array.from(anchors)
}

function resultMatchesExactEvidenceAnchor(
	result: MemorySearchResult,
	anchors: string[],
): boolean {
	if (anchors.length === 0) {
		return true
	}
	const haystack = [
		result.snippet,
		result.path,
		result.filePath,
		result.canonicalId,
		result.citation,
	]
		.filter(
			(value): value is string => typeof value === "string" && value.length > 0,
		)
		.join(" ")
		.toLowerCase()
	return anchors.some((anchor) => {
		const escaped = anchor.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
		const matcher = new RegExp(`\\b${escaped.replace(/\s+/g, "\\s+")}\\b`, "i")
		return matcher.test(haystack)
	})
}

export function computeEvidenceCoverage(
	results: MemorySearchResult[],
): EvidenceCoverage {
	if (results.length === 0) {
		return "none"
	}
	const exactCount = results.filter(resultHasExactEvidence).length
	if (exactCount === results.length) {
		return "direct"
	}
	if (exactCount > 0) {
		return "partial"
	}
	return "indirect"
}

export function applyHardConstraintRejections(params: {
	results: MemorySearchResult[]
	request: MemorySearchRequest
	timeRange?: MemorySearchExecutorTimeRange
}): { accepted: MemorySearchResult[]; rejected: RejectedResultSummary[] } {
	const accepted: MemorySearchResult[] = []
	const rejected: RejectedResultSummary[] = []
	const expectedConversationScopeRef = params.request.conversationScope
		?.sessionKey
		? resolveScopeRef({
				scope: "session",
				agentId: "__search__",
				sessionId: params.request.conversationScope.sessionKey,
			})
		: undefined
	const exactEvidenceAnchors =
		params.request.needExactEvidence && params.request.query.trim()
			? extractExactEvidenceAnchors(params.request.query)
			: []

	for (const result of params.results) {
		if (params.timeRange) {
			if (!(result.timestamp instanceof Date)) {
				rejected.push({
					canonicalId: result.canonicalId,
					path: result.path,
					source: result.source,
					reason: "missing timestamp for requested time range",
				})
				continue
			}
			const ts = result.timestamp.getTime()
			if (
				ts < params.timeRange.start.getTime() ||
				ts > params.timeRange.end.getTime()
			) {
				rejected.push({
					canonicalId: result.canonicalId,
					path: result.path,
					source: result.source,
					reason: "outside requested time range",
				})
				continue
			}
		}
		if (params.request.needExactEvidence && !resultHasExactEvidence(result)) {
			rejected.push({
				canonicalId: result.canonicalId,
				path: result.path,
				source: result.source,
				reason: "missing exact evidence locator",
			})
			continue
		}
		if (expectedConversationScopeRef) {
			const matchesSession =
				result.sessionId === params.request.conversationScope?.sessionKey ||
				(result.scope === "session" &&
					result.scopeRef === expectedConversationScopeRef)
			if (!matchesSession) {
				rejected.push({
					canonicalId: result.canonicalId,
					path: result.path,
					source: result.source,
					reason: "outside requested conversation scope",
				})
				continue
			}
		}
		if (
			params.request.needExactEvidence &&
			exactEvidenceAnchors.length > 0 &&
			!resultMatchesExactEvidenceAnchor(result, exactEvidenceAnchors)
		) {
			rejected.push({
				canonicalId: result.canonicalId,
				path: result.path,
				source: result.source,
				reason: "missing requested entity/value anchor",
			})
			continue
		}
		accepted.push(result)
	}

	return { accepted, rejected }
}

export function canUseLegacyFallback(request: MemorySearchRequest): boolean {
	return !(
		request.needExactEvidence ||
		request.timeRange ||
		request.conversationScope ||
		request.structuredScope ||
		request.referenceScope ||
		request.proceduralScope
	)
}

export function requestHasHardConstraints(
	request: MemorySearchRequest,
): boolean {
	return !canUseLegacyFallback(request)
}

export function buildConstraintSummaries(
	request: MemorySearchRequest,
): string[] {
	const applied: string[] = []
	if (request.timeRange) {
		if (request.timeRange.preset) {
			applied.push(`timeRange:${request.timeRange.preset}`)
		} else if (request.timeRange.start && request.timeRange.end) {
			applied.push(
				`timeRange:${request.timeRange.start}..${request.timeRange.end}`,
			)
		}
	}
	if (request.needExactEvidence) {
		applied.push("needExactEvidence")
	}
	if (request.conversationScope?.sessionKey) {
		applied.push(
			`conversationScope.sessionKey:${request.conversationScope.sessionKey}`,
		)
	}
	if (request.structuredScope?.type) {
		applied.push(`structuredScope.type:${request.structuredScope.type}`)
	}
	if (request.referenceScope?.category) {
		applied.push(`referenceScope.category:${request.referenceScope.category}`)
	}
	if (request.referenceScope?.source) {
		applied.push(`referenceScope.source:${request.referenceScope.source}`)
	}
	if (request.proceduralScope?.state) {
		applied.push(`proceduralScope.state:${request.proceduralScope.state}`)
	}
	return applied
}

export function mergeMetadata(params: {
	request: MemorySearchExecutorRequest
	classification: MemorySearchClassification
	passes: Array<
		MemorySearchPass & {
			metadata: Pick<
				MemorySearchMetadata,
				| "pathsExecuted"
				| "resultsByPath"
				| "queryRewritten"
				| "reranked"
				| "plan"
			>
		}
	>
	resultsRejected: RejectedResultSummary[]
	results: MemorySearchResult[]
	noDirectEvidenceReason?: string
	constraintRelaxations?: Array<{ constraint: string; action: string }>
	mmrApplied?: boolean
	mmrLambda?: number
	trustSummary?: MemorySearchMetadata["trustSummary"]
}): MemorySearchMetadata {
	const pathsExecuted = Array.from(
		new Set(params.passes.flatMap((pass) => pass.metadata.pathsExecuted)),
	)
	const resultsByPath = params.passes.reduce<Record<string, number>>(
		(acc, pass) => {
			for (const [path, count] of Object.entries(pass.metadata.resultsByPath)) {
				acc[path] = (acc[path] ?? 0) + count
			}
			return acc
		},
		{},
	)
	return {
		mode: params.request.searchMode,
		classification: params.classification,
		sourceOrder: params.request.sourcePreference,
		...(params.request.searchConfig
			? {
					resolvedSearchConfig: params.request
						.searchConfig as ResolvedSearchConfig,
				}
			: {}),
		passes: params.passes.map(({ metadata: _metadata, ...pass }) => pass),
		queriesTried: params.passes.map((pass) => pass.query),
		constraintsApplied: buildConstraintSummaries(params.request),
		resultsRejected: params.resultsRejected,
		evidenceCoverage: computeEvidenceCoverage(params.results),
		pathsExecuted,
		resultsByPath,
		queryRewritten: params.passes.some((pass) => pass.metadata.queryRewritten),
		reranked: params.passes.some((pass) => pass.metadata.reranked),
		...(params.noDirectEvidenceReason
			? { noDirectEvidenceReason: params.noDirectEvidenceReason }
			: {}),
		...(params.constraintRelaxations?.length
			? { constraintRelaxations: params.constraintRelaxations }
			: {}),
		...(params.mmrApplied != null ? { mmrApplied: params.mmrApplied } : {}),
		...(params.mmrLambda != null ? { mmrLambda: params.mmrLambda } : {}),
		...(params.trustSummary ? { trustSummary: params.trustSummary } : {}),
		...(params.request.returnPlan && params.passes[0]?.metadata.plan
			? { plan: params.passes[0].metadata.plan }
			: {}),
	}
}

export function buildNoDirectEvidenceResponse(params: {
	request: MemorySearchExecutorRequest
	classification: MemorySearchClassification
	passes: Array<
		MemorySearchPass & {
			metadata: Pick<
				MemorySearchMetadata,
				| "pathsExecuted"
				| "resultsByPath"
				| "queryRewritten"
				| "reranked"
				| "plan"
			>
		}
	>
	resultsRejected: RejectedResultSummary[]
	reason: string
	trustSummary?: MemorySearchMetadata["trustSummary"]
}): MemorySearchResponse {
	return {
		results: [],
		metadata: mergeMetadata({
			request: params.request,
			classification: params.classification,
			passes: params.passes,
			resultsRejected: params.resultsRejected,
			results: [],
			noDirectEvidenceReason: params.reason,
			trustSummary: params.trustSummary,
		}),
	}
}

// ---------------------------------------------------------------------------
// CRAG-style corrective retrieval analysis (pure function, no LLM)
// ---------------------------------------------------------------------------

export function analyzeCorrectionNeeded(params: {
	evidenceCoverage: EvidenceCoverage
	rejected: RejectedResultSummary[]
	passCount: number
	maxPasses: number
}): { needed: boolean; correction?: string; reason?: string } {
	if (params.passCount >= params.maxPasses) {
		return { needed: false }
	}
	if (
		params.evidenceCoverage !== "none" &&
		params.evidenceCoverage !== "indirect"
	) {
		return { needed: false }
	}
	if (params.rejected.length === 0) {
		return { needed: false }
	}
	const reasonCounts = new Map<string, number>()
	for (const r of params.rejected) {
		reasonCounts.set(r.reason, (reasonCounts.get(r.reason) ?? 0) + 1)
	}
	let dominantReason = ""
	let maxCount = 0
	for (const [reason, count] of reasonCounts) {
		if (count > maxCount) {
			dominantReason = reason
			maxCount = count
		}
	}
	if (dominantReason === "outside requested time range") {
		return {
			needed: true,
			correction: "time-range-widened-2x",
			reason: dominantReason,
		}
	}
	if (dominantReason === "missing exact evidence locator") {
		return {
			needed: true,
			correction: "hybrid-evidence-relaxed",
			reason: dominantReason,
		}
	}
	if (dominantReason === "missing timestamp for requested time range") {
		return {
			needed: true,
			correction: "time-range-widened-2x",
			reason: dominantReason,
		}
	}
	return { needed: false }
}

// ---------------------------------------------------------------------------
// Constraint relaxation fallback (pure function)
// ---------------------------------------------------------------------------

export function identifyRelaxableConstraint(
	rejected: RejectedResultSummary[],
): { constraint: string; action: string } | null {
	if (rejected.length === 0) {
		return null
	}
	const reasonCounts = new Map<string, number>()
	for (const r of rejected) {
		reasonCounts.set(r.reason, (reasonCounts.get(r.reason) ?? 0) + 1)
	}
	let dominantReason = ""
	let maxCount = 0
	for (const [reason, count] of reasonCounts) {
		if (count > maxCount) {
			dominantReason = reason
			maxCount = count
		}
	}
	if (
		dominantReason === "outside requested time range" ||
		dominantReason === "missing timestamp for requested time range"
	) {
		return { constraint: "timeRange", action: "removed-time-range" }
	}
	if (dominantReason === "missing exact evidence locator") {
		return {
			constraint: "needExactEvidence",
			action: "disabled-exact-evidence",
		}
	}
	return null
}

// ---------------------------------------------------------------------------
// MMR diversity scoring (pure function, uses Jaccard similarity on snippets)
// ---------------------------------------------------------------------------

function tokenize(text: string): Set<string> {
	return new Set(text.toLowerCase().split(/\s+/).filter(Boolean))
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
	let intersection = 0
	for (const word of a) {
		if (b.has(word)) {
			intersection++
		}
	}
	const union = a.size + b.size - intersection
	return union === 0 ? 0 : intersection / union
}

export function applyMMRReranking(params: {
	results: MemorySearchResult[]
	classification: MemorySearchClassification
}): {
	results: MemorySearchResult[]
	mmrApplied: boolean
	mmrLambda: number
} {
	const lambdaByClassification: Record<MemorySearchClassification, number> = {
		family: 0.3,
		comparison: 0.4,
		direct: 0.7,
		temporal: 0.7,
		scoped: 0.7,
		"multi-hop": 0.7,
	}
	const lambda = lambdaByClassification[params.classification] ?? 0.5

	if (params.results.length < 3) {
		return {
			results: params.results,
			mmrApplied: false,
			mmrLambda: lambda,
		}
	}

	const scores = params.results.map((r) => r.score)
	const minScore = Math.min(...scores)
	const maxScore = Math.max(...scores)
	const scoreRange = maxScore - minScore || 1

	const tokenSets = params.results.map((r) => tokenize(r.snippet))

	const selected: MemorySearchResult[] = [params.results[0]]
	const selectedTokens: Set<string>[] = [tokenSets[0]]
	const remaining = new Set(params.results.slice(1).map((_, i) => i + 1))

	while (remaining.size > 0) {
		let bestIdx = -1
		let bestScore = -Infinity

		for (const idx of remaining) {
			const normalizedRelevance =
				(params.results[idx].score - minScore) / scoreRange
			let maxSimilarity = 0
			for (const selTokens of selectedTokens) {
				const sim = jaccardSimilarity(tokenSets[idx], selTokens)
				if (sim > maxSimilarity) {
					maxSimilarity = sim
				}
			}
			const mmrScore =
				lambda * normalizedRelevance - (1 - lambda) * maxSimilarity
			if (mmrScore > bestScore) {
				bestScore = mmrScore
				bestIdx = idx
			}
		}

		if (bestIdx >= 0) {
			selected.push(params.results[bestIdx])
			selectedTokens.push(tokenSets[bestIdx])
			remaining.delete(bestIdx)
		} else {
			break
		}
	}

	return { results: selected, mmrApplied: true, mmrLambda: lambda }
}

export async function executeMongoSearchPlan(params: {
	request: MemorySearchRequest
	availablePaths: Set<
		| "active-critical"
		| "structured"
		| "raw-window"
		| "graph"
		| "hybrid"
		| "kb"
		| "episodic"
		| "procedural"
	>
	executePass: (input: {
		pass: number
		query: string
		availablePaths: Set<
			| "active-critical"
			| "structured"
			| "raw-window"
			| "graph"
			| "hybrid"
			| "kb"
			| "episodic"
			| "procedural"
		>
		timeRange?: MemorySearchExecutorTimeRange
	}) => Promise<{
		results: MemorySearchResult[]
		metadata: {
			plan: {
				paths: string[]
				confidence: "high" | "medium" | "low"
				reasoning: string
				constraints?: Record<string, unknown>
			}
			pathsExecuted: string[]
			resultsByPath: Record<string, number>
			reranked?: boolean
			queryRewritten?: boolean
		}
	}>
	trustContext?: {
		now?: Date
		scope?: "session" | "user" | "agent" | "workspace" | "tenant" | "global"
		scopeRef?: string
	}
}): Promise<MemorySearchResponse> {
	const normalized = normalizeMemorySearchRequest(params.request)
	const classification = classifyExecutorSearch(normalized)
	const timeRange = resolveExecutorTimeRange(normalized)
	const passPlans = buildExecutorPasses(normalized, classification)
	const passes: Array<
		MemorySearchPass & {
			metadata: Pick<
				MemorySearchMetadata,
				| "pathsExecuted"
				| "resultsByPath"
				| "queryRewritten"
				| "reranked"
				| "plan"
			>
		}
	> = []
	const allRejected: RejectedResultSummary[] = []
	const acceptedById = new Map<string, MemorySearchResult>()
	const seenFollowUpKinds = new Set<string>()

	for (let passIndex = 0; passIndex < passPlans.length; passIndex++) {
		const passPlan = passPlans[passIndex]
		const passPaths = selectPassPaths({
			availablePaths: params.availablePaths,
			sourcePreference: normalized.sourcePreference,
			pass: passPlan.pass,
			...(timeRange ? { timeRange } : {}),
			...(passPlan.preferredPaths
				? { preferredPaths: passPlan.preferredPaths }
				: {}),
		})
		const executed = await params.executePass({
			pass: passPlan.pass,
			query: passPlan.query,
			availablePaths: passPaths,
			...(timeRange ? { timeRange } : {}),
		})
		const filtered = applyHardConstraintRejections({
			results: executed.results,
			request: normalized,
			...(timeRange ? { timeRange } : {}),
		})
		allRejected.push(...filtered.rejected)
		for (const result of filtered.accepted) {
			acceptedById.set(searchResultIdentity(result), result)
		}
		passes.push({
			pass: passPlan.pass,
			query: passPlan.query,
			reason: passPlan.reason,
			pathsExecuted: executed.metadata.pathsExecuted,
			resultCount: filtered.accepted.length,
			queryRewritten: executed.metadata.queryRewritten === true,
			reranked: executed.metadata.reranked === true,
			metadata: {
				pathsExecuted: executed.metadata.pathsExecuted,
				resultsByPath: executed.metadata.resultsByPath,
				queryRewritten: executed.metadata.queryRewritten === true,
				reranked: executed.metadata.reranked === true,
				plan: {
					paths: executed.metadata.plan.paths,
					confidence: executed.metadata.plan.confidence,
					reasoning: executed.metadata.plan.reasoning,
					...(executed.metadata.plan.constraints
						? { constraints: executed.metadata.plan.constraints }
						: {}),
				},
			},
		})

		const acceptedResults = Array.from(acceptedById.values())
		const trustedPassResults = annotateResultsWithTrust(acceptedResults, {
			now: params.trustContext?.now,
			scope: params.trustContext?.scope,
			scopeRef: params.trustContext?.scopeRef,
			sessionKey: normalized.conversationScope?.sessionKey,
		})
		const evidenceCoverage = computeEvidenceCoverage(acceptedResults)
		const trustSummary = summarizeTrust(trustedPassResults)
		const followUp =
			passPlans.length < normalized.maxPasses
				? planFollowUpPass({
						request: normalized,
						classification,
						availablePaths: params.availablePaths,
						executedPaths: new Set(
							passes.flatMap((pass) => pass.pathsExecuted as RetrievalPath[]),
						),
						acceptedResults,
						evidenceCoverage,
						...(timeRange ? { timeRange } : {}),
						trustSummary,
						seenKinds: seenFollowUpKinds,
					})
				: null
		const shouldStop =
			acceptedResults.length > 0 &&
			(classification === "direct"
				? !normalized.needExactEvidence ||
					evidenceCoverage === "direct" ||
					evidenceCoverage === "partial"
				: classification === "family" || classification === "comparison"
					? acceptedResults.length >= Math.min(normalized.maxResults ?? 10, 3)
					: !normalized.needExactEvidence ||
						evidenceCoverage === "direct" ||
						evidenceCoverage === "partial")
		if (followUp) {
			seenFollowUpKinds.add(followUp.kind ?? followUp.reason)
			passPlans.push({
				...followUp,
				pass: passPlans.length + 1,
			})
			continue
		}
		if (shouldStop) {
			break
		}
	}

	let acceptedResults = Array.from(acceptedById.values())
	let trustedResults = annotateResultsWithTrust(acceptedResults, {
		now: params.trustContext?.now,
		scope: params.trustContext?.scope,
		scopeRef: params.trustContext?.scopeRef,
		sessionKey: normalized.conversationScope?.sessionKey,
	})
	let trustSummary = summarizeTrust(trustedResults)

	// --- CRAG corrective retrieval: if coverage is poor, try a corrective pass ---
	const correction = analyzeCorrectionNeeded({
		evidenceCoverage: computeEvidenceCoverage(acceptedResults),
		rejected: allRejected,
		passCount: passes.length,
		maxPasses: normalized.maxPasses,
	})
	if (correction.needed && correction.correction) {
		let correctiveTimeRange = timeRange
		let correctiveRequest = normalized
		if (correction.correction === "time-range-widened-2x" && timeRange) {
			const duration = timeRange.end.getTime() - timeRange.start.getTime()
			correctiveTimeRange = {
				start: new Date(timeRange.start.getTime() - duration),
				end: new Date(timeRange.end.getTime() + duration),
			}
		}
		if (correction.correction === "hybrid-evidence-relaxed") {
			correctiveRequest = {
				...normalized,
				needExactEvidence: false,
			}
		}
		const correctivePaths =
			correction.correction === "hybrid-evidence-relaxed"
				? new Set(["hybrid" as const, ...params.availablePaths])
				: params.availablePaths
		const corrExec = await params.executePass({
			pass: passes.length + 1,
			query: normalized.query,
			availablePaths: correctivePaths,
			...(correctiveTimeRange ? { timeRange: correctiveTimeRange } : {}),
		})
		const corrFiltered = applyHardConstraintRejections({
			results: corrExec.results,
			request: correctiveRequest,
			...(correctiveTimeRange ? { timeRange: correctiveTimeRange } : {}),
		})
		allRejected.push(...corrFiltered.rejected)
		for (const result of corrFiltered.accepted) {
			acceptedById.set(searchResultIdentity(result), result)
		}
		passes.push({
			pass: passes.length + 1,
			query: normalized.query,
			reason: `corrective: ${correction.correction}`,
			pathsExecuted: corrExec.metadata.pathsExecuted,
			resultCount: corrFiltered.accepted.length,
			queryRewritten: corrExec.metadata.queryRewritten === true,
			reranked: corrExec.metadata.reranked === true,
			correctionApplied: correction.correction,
			metadata: {
				pathsExecuted: corrExec.metadata.pathsExecuted,
				resultsByPath: corrExec.metadata.resultsByPath,
				queryRewritten: corrExec.metadata.queryRewritten === true,
				reranked: corrExec.metadata.reranked === true,
				plan: corrExec.metadata.plan,
			},
		})
		acceptedResults = Array.from(acceptedById.values())
		trustedResults = annotateResultsWithTrust(acceptedResults, {
			now: params.trustContext?.now,
			scope: params.trustContext?.scope,
			scopeRef: params.trustContext?.scopeRef,
			sessionKey: normalized.conversationScope?.sessionKey,
		})
		trustSummary = summarizeTrust(trustedResults)
	}

	// --- Constraint relaxation: if still empty after all passes, relax the dominant constraint ---
	let constraintRelaxations:
		| Array<{ constraint: string; action: string }>
		| undefined
	if (acceptedResults.length === 0 && allRejected.length > 0) {
		const relaxation = identifyRelaxableConstraint(allRejected)
		if (relaxation) {
			let relaxedRequest = normalized
			let relaxedTimeRange = timeRange
			if (relaxation.action === "removed-time-range") {
				relaxedTimeRange = undefined
			}
			if (relaxation.action === "disabled-exact-evidence") {
				relaxedRequest = {
					...normalized,
					needExactEvidence: false,
				}
			}
			const relaxExec = await params.executePass({
				pass: passes.length + 1,
				query: normalized.query,
				availablePaths: params.availablePaths,
				...(relaxedTimeRange ? { timeRange: relaxedTimeRange } : {}),
			})
			const relaxFiltered = applyHardConstraintRejections({
				results: relaxExec.results,
				request: relaxedRequest,
				...(relaxedTimeRange ? { timeRange: relaxedTimeRange } : {}),
			})
			for (const result of relaxFiltered.accepted) {
				acceptedById.set(searchResultIdentity(result), result)
			}
			passes.push({
				pass: passes.length + 1,
				query: normalized.query,
				reason: `relaxation: ${relaxation.action}`,
				pathsExecuted: relaxExec.metadata.pathsExecuted,
				resultCount: relaxFiltered.accepted.length,
				queryRewritten: relaxExec.metadata.queryRewritten === true,
				reranked: relaxExec.metadata.reranked === true,
				correctionApplied: `relaxation:${relaxation.action}`,
				metadata: {
					pathsExecuted: relaxExec.metadata.pathsExecuted,
					resultsByPath: relaxExec.metadata.resultsByPath,
					queryRewritten: relaxExec.metadata.queryRewritten === true,
					reranked: relaxExec.metadata.reranked === true,
					plan: relaxExec.metadata.plan,
				},
			})
			constraintRelaxations = [relaxation]
			acceptedResults = Array.from(acceptedById.values())
			trustedResults = annotateResultsWithTrust(acceptedResults, {
				now: params.trustContext?.now,
				scope: params.trustContext?.scope,
				scopeRef: params.trustContext?.scopeRef,
				sessionKey: normalized.conversationScope?.sessionKey,
			})
			trustSummary = summarizeTrust(trustedResults)
		}
	}

	if (normalized.needExactEvidence && acceptedResults.length === 0) {
		return buildNoDirectEvidenceResponse({
			request: normalized,
			classification,
			passes,
			resultsRejected: allRejected,
			reason: "No exact-evidence results survived the active constraints.",
			trustSummary,
		})
	}

	// --- MMR diversity scoring: reorder results for content diversity ---
	const mmr = applyMMRReranking({
		results: acceptedResults,
		classification,
	})
	const trustedMmrResults = annotateResultsWithTrust(mmr.results, {
		now: params.trustContext?.now,
		scope: params.trustContext?.scope,
		scopeRef: params.trustContext?.scopeRef,
		sessionKey: normalized.conversationScope?.sessionKey,
	})
	const trustRankedResults = rerankResultsByTrust(trustedMmrResults)
	trustSummary = summarizeTrust(trustRankedResults)
	const lowTrustAbstention = shouldAbstainForLowTrust({
		results: trustRankedResults,
		classification,
		request: normalized,
	})
	if (lowTrustAbstention) {
		return buildNoDirectEvidenceResponse({
			request: normalized,
			classification,
			passes,
			resultsRejected: allRejected,
			reason: lowTrustAbstention,
			trustSummary,
		})
	}

	return {
		results: trustRankedResults,
		metadata: mergeMetadata({
			request: normalized,
			classification,
			passes,
			resultsRejected: allRejected,
			results: trustRankedResults,
			constraintRelaxations,
			mmrApplied: mmr.mmrApplied,
			mmrLambda: mmr.mmrLambda,
			trustSummary,
		}),
	}
}
