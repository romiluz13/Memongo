import type { MemoryScope } from "@memongo/lib"
import type {
	MemoryResultTrust,
	MemorySearchClassification,
	MemorySearchRequest,
	MemorySearchResult,
	MemorySearchTrustConfidence,
	MemorySearchTrustContradiction,
	MemorySearchTrustExactness,
	MemorySearchTrustFreshness,
	MemorySearchTrustProvenance,
	MemorySearchTrustScopeMatch,
	MemorySearchTrustSummary,
} from "./types.js"

function clamp(value: number, min = 0, max = 1): number {
	return Math.min(max, Math.max(min, value))
}

function roundScore(value: number): number {
	return Number(clamp(value).toFixed(6))
}

function normalizeRetrievalScore(value: number): number {
	if (!Number.isFinite(value) || value <= 0) {
		return 0
	}
	if (value <= 1) {
		return value
	}
	return 1 - Math.exp(-value)
}

function collectSourceEventIds(result: MemorySearchResult): string[] {
	if (
		Array.isArray(result.sourceEventIds) &&
		result.sourceEventIds.length > 0
	) {
		return result.sourceEventIds
	}
	const provenanceSourceEventIds =
		result.provenance &&
		typeof result.provenance === "object" &&
		Array.isArray(
			(result.provenance as { sourceEventIds?: unknown }).sourceEventIds,
		)
			? (result.provenance as { sourceEventIds: unknown[] }).sourceEventIds
					.filter((value): value is string => typeof value === "string")
					.map((value) => value.trim())
					.filter(Boolean)
			: []
	return provenanceSourceEventIds
}

function resolveExactness(result: MemorySearchResult): {
	label: MemorySearchTrustExactness
	score: number
} {
	if (result.canonicalId?.trim()) {
		return { label: "exact-id", score: 1 }
	}
	if (result.path.trim()) {
		return { label: "exact-locator", score: 0.9 }
	}
	return { label: "approximate", score: 0.25 }
}

function resolveContradiction(result: MemorySearchResult): {
	label: MemorySearchTrustContradiction
	score: number
} {
	if (result.state === "invalidated") {
		return { label: "invalidated", score: 0 }
	}
	if (result.state === "conflicted") {
		return { label: "conflicted", score: 0.25 }
	}
	return { label: "none", score: 1 }
}

function resolveScopeMatch(params: {
	result: MemorySearchResult
	scope?: MemoryScope
	scopeRef?: string
	sessionKey?: string
}): { label: MemorySearchTrustScopeMatch; score: number } {
	if (params.sessionKey && params.result.sessionId === params.sessionKey) {
		return { label: "exact", score: 1 }
	}
	if (params.scopeRef && params.result.scopeRef) {
		if (params.scopeRef === params.result.scopeRef) {
			return { label: "exact", score: 1 }
		}
		return { label: "mismatch", score: 0.15 }
	}
	if (params.scope && params.result.scope) {
		if (params.scope === params.result.scope) {
			return { label: "partial", score: 0.8 }
		}
		return { label: "mismatch", score: 0.15 }
	}
	return { label: "unknown", score: 0.6 }
}

function resolveProvenance(result: MemorySearchResult): {
	label: MemorySearchTrustProvenance
	score: number
} {
	const sourceEventIds = collectSourceEventIds(result)
	if (sourceEventIds.length >= 2) {
		return { label: "dense", score: 1 }
	}
	if (sourceEventIds.length === 1) {
		return { label: "partial", score: 0.85 }
	}
	if (result.provenance && typeof result.provenance === "object") {
		return { label: "sparse", score: 0.65 }
	}
	if (result.path.startsWith("events/") || result.path.startsWith("episode:")) {
		return { label: "partial", score: 0.8 }
	}
	return { label: "none", score: 0.4 }
}

function resolveFreshness(
	result: MemorySearchResult,
	now: Date,
): { label: MemorySearchTrustFreshness; score: number } {
	if (
		result.validTo instanceof Date &&
		result.validTo.getTime() < now.getTime()
	) {
		return { label: "stale", score: 0.1 }
	}
	if (
		result.reviewAt instanceof Date &&
		result.reviewAt.getTime() < now.getTime() &&
		result.state === "active"
	) {
		return { label: "aging", score: 0.45 }
	}
	const freshnessAnchor =
		result.lastConfirmedAt instanceof Date
			? result.lastConfirmedAt
			: result.timestamp instanceof Date
				? result.timestamp
				: undefined
	if (!freshnessAnchor) {
		return result.source === "reference"
			? { label: "timeless", score: 0.7 }
			: { label: "unknown", score: 0.5 }
	}
	const ageMs = Math.max(0, now.getTime() - freshnessAnchor.getTime())
	const ageHours = ageMs / (60 * 60 * 1000)
	if (ageHours <= 24) {
		return { label: "fresh", score: 1 }
	}
	if (ageHours <= 24 * 7) {
		return { label: "aging", score: 0.8 }
	}
	if (ageHours <= 24 * 30) {
		return { label: "aging", score: 0.6 }
	}
	return { label: "stale", score: 0.25 }
}

function resolveSourceReliability(result: MemorySearchResult): number {
	if (typeof result.sourceReliability === "number") {
		return clamp(result.sourceReliability)
	}
	switch (result.source) {
		case "conversation":
			return 0.88
		case "structured":
			return 0.84
		case "reference":
			return 0.72
	}
}

function resolveTemporalValidity(
	result: MemorySearchResult,
	now: Date,
): number {
	if (result.state === "invalidated") {
		return 0
	}
	if (
		result.validFrom instanceof Date &&
		result.validFrom.getTime() > now.getTime()
	) {
		return 0.1
	}
	if (
		result.validTo instanceof Date &&
		result.validTo.getTime() < now.getTime()
	) {
		return 0.1
	}
	if (result.state === "conflicted") {
		return 0.35
	}
	return 1
}

function resolveReinforcement(result: MemorySearchResult): number {
	if (typeof result.reinforcementCount !== "number") {
		return 0.5
	}
	return clamp(Math.log2(result.reinforcementCount + 1) / 3)
}

function buildFactors(params: {
	exactness: MemorySearchTrustExactness
	freshness: MemorySearchTrustFreshness
	contradiction: MemorySearchTrustContradiction
	scopeMatch: MemorySearchTrustScopeMatch
	provenance: MemorySearchTrustProvenance
	sourceDiversity: "single" | "multi"
	score: number
	hasConfidence?: boolean
}): string[] {
	const factors: string[] = []
	if (params.exactness === "exact-id") {
		factors.push("exact-id")
	} else if (params.exactness === "exact-locator") {
		factors.push("exact-locator")
	} else {
		factors.push("approximate-evidence")
	}
	if (params.freshness === "fresh") {
		factors.push("fresh")
	} else if (params.freshness === "stale") {
		factors.push("stale")
	}
	if (params.contradiction !== "none") {
		factors.push(`contradiction:${params.contradiction}`)
	}
	if (params.scopeMatch === "exact") {
		factors.push("scope-exact")
	} else if (params.scopeMatch === "mismatch") {
		factors.push("scope-mismatch")
	}
	if (params.provenance === "dense") {
		factors.push("provenance-dense")
	} else if (params.provenance === "none") {
		factors.push("provenance-thin")
	}
	if (params.sourceDiversity === "multi") {
		factors.push("multi-source-set")
	}
	if (params.hasConfidence) {
		factors.push("confidence")
	}
	if (params.score < 0.45) {
		factors.push("low-trust")
	}
	return factors
}

function resolveConfidence(score: number): MemorySearchTrustConfidence {
	if (score >= 0.75) {
		return "high"
	}
	if (score >= 0.5) {
		return "medium"
	}
	return "low"
}

export function computeResultTrust(
	result: MemorySearchResult,
	context: {
		now?: Date
		scope?: MemoryScope
		scopeRef?: string
		sessionKey?: string
		sourceDiversity?: "single" | "multi"
	},
): MemoryResultTrust {
	const now = context.now ?? new Date()
	const exactness = resolveExactness(result)
	const contradiction = resolveContradiction(result)
	const scopeMatch = resolveScopeMatch({
		result,
		scope: context.scope,
		scopeRef: context.scopeRef,
		sessionKey: context.sessionKey,
	})
	const provenance = resolveProvenance(result)
	const freshness = resolveFreshness(result, now)
	const temporalValidity = resolveTemporalValidity(result, now)
	const sourceReliability = resolveSourceReliability(result)
	const reinforcement = resolveReinforcement(result)
	const retrievalScore = normalizeRetrievalScore(result.score)
	const sourceDiversity = context.sourceDiversity ?? "single"
	const diversityScore = sourceDiversity === "multi" ? 1 : 0.65

	// Confidence factor: use memory document's confidence as a weight multiplier
	const hasConfidence =
		typeof result.confidence === "number" && Number.isFinite(result.confidence)
	const confidenceWeight = hasConfidence ? clamp(result.confidence!) : 1

	let score =
		(exactness.score * 0.2 +
			scopeMatch.score * 0.15 +
			provenance.score * 0.15 +
			freshness.score * 0.15 +
			temporalValidity * 0.15 +
			sourceReliability * 0.1 +
			reinforcement * 0.05 +
			retrievalScore * 0.03 +
			diversityScore * 0.02) *
		confidenceWeight

	if (contradiction.label === "invalidated") {
		score = Math.min(score, 0.18)
	} else if (contradiction.label === "conflicted") {
		score = Math.min(score, 0.42)
	}
	if (scopeMatch.label === "mismatch") {
		score = Math.min(score, 0.35)
	}

	const rounded = roundScore(score)
	return {
		score: rounded,
		confidence: resolveConfidence(rounded),
		exactness: exactness.label,
		freshness: freshness.label,
		contradiction: contradiction.label,
		scopeMatch: scopeMatch.label,
		provenance: provenance.label,
		sourceDiversity,
		factors: buildFactors({
			exactness: exactness.label,
			freshness: freshness.label,
			contradiction: contradiction.label,
			scopeMatch: scopeMatch.label,
			provenance: provenance.label,
			sourceDiversity,
			score: rounded,
			hasConfidence,
		}),
	}
}

export function annotateResultsWithTrust(
	results: MemorySearchResult[],
	context: {
		now?: Date
		scope?: MemoryScope
		scopeRef?: string
		sessionKey?: string
	},
): MemorySearchResult[] {
	const sourceDiversity =
		new Set(results.map((result) => result.source)).size > 1
			? "multi"
			: "single"
	return results.map((result) => ({
		...result,
		trust: computeResultTrust(result, {
			...context,
			sourceDiversity,
		}),
	}))
}

export function rerankResultsByTrust(
	results: MemorySearchResult[],
): MemorySearchResult[] {
	if (results.length <= 1) {
		return results
	}

	const scores = results.map((result) => result.score)
	const minScore = Math.min(...scores)
	const maxScore = Math.max(...scores)
	const scoreRange = maxScore - minScore || 1

	return [...results].sort((left, right) => {
		const leftTrust = left.trust?.score ?? 0
		const rightTrust = right.trust?.score ?? 0
		const leftRetrieval = (left.score - minScore) / scoreRange
		const rightRetrieval = (right.score - minScore) / scoreRange
		const leftPenalty =
			left.trust?.contradiction === "invalidated"
				? 0.6
				: left.trust?.contradiction === "conflicted"
					? 0.25
					: left.trust?.freshness === "stale"
						? 0.1
						: 0
		const rightPenalty =
			right.trust?.contradiction === "invalidated"
				? 0.6
				: right.trust?.contradiction === "conflicted"
					? 0.25
					: right.trust?.freshness === "stale"
						? 0.1
						: 0
		const leftCombined = leftRetrieval * 0.55 + leftTrust * 0.45 - leftPenalty
		const rightCombined =
			rightRetrieval * 0.55 + rightTrust * 0.45 - rightPenalty
		if (rightCombined !== leftCombined) {
			return rightCombined - leftCombined
		}
		if (rightTrust !== leftTrust) {
			return rightTrust - leftTrust
		}
		return right.score - left.score
	})
}

export function summarizeTrust(
	results: MemorySearchResult[],
): MemorySearchTrustSummary {
	const trustResults = results
		.map((result) => result.trust)
		.filter((trust): trust is MemoryResultTrust => Boolean(trust))
	if (trustResults.length === 0) {
		return {
			topScore: null,
			topConfidence: null,
			averageScore: null,
			distribution: { high: 0, medium: 0, low: 0 },
			contradictionCount: 0,
			staleCount: 0,
			exactCount: 0,
			sourceDiversity: "none",
		}
	}
	const totalScore = trustResults.reduce((sum, trust) => sum + trust.score, 0)
	const top = trustResults[0]
	return {
		topScore: roundScore(top.score),
		topConfidence: top.confidence,
		averageScore: roundScore(totalScore / trustResults.length),
		distribution: trustResults.reduce(
			(acc, trust) => {
				acc[trust.confidence] += 1
				return acc
			},
			{ high: 0, medium: 0, low: 0 } as Record<
				MemorySearchTrustConfidence,
				number
			>,
		),
		contradictionCount: trustResults.filter(
			(trust) => trust.contradiction !== "none",
		).length,
		staleCount: trustResults.filter((trust) => trust.freshness === "stale")
			.length,
		exactCount: trustResults.filter(
			(trust) =>
				trust.exactness === "exact-id" || trust.exactness === "exact-locator",
		).length,
		sourceDiversity: top.sourceDiversity,
	}
}

// ---------------------------------------------------------------------------
// Importance Decay
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000

/**
 * Time-weighted importance decay using exponential half-life.
 * importance=1.0 at t=0 decays to ~0.5 at t=halfLife, ~0.25 at t=2*halfLife.
 *
 * @param importance - raw importance (0-1), defaults to 0.5 if missing
 * @param createdAt - creation timestamp
 * @param now - current time (injectable for testing)
 * @param recencyHalfLifeDays - half-life in days (default 7)
 */
export function computeImportanceDecay(
	importance: number | undefined,
	createdAt: Date | undefined,
	now: Date = new Date(),
	recencyHalfLifeDays: number = 7,
	temporalScope?: string,
): number {
	const raw =
		typeof importance === "number" && Number.isFinite(importance)
			? clamp(importance)
			: 0.5
	// Permanent and ongoing memories NEVER decay — preferences, facts, etc.
	if (temporalScope === "permanent" || temporalScope === "ongoing") {
		return raw
	}
	if (!(createdAt instanceof Date)) {
		return raw
	}
	const daysSinceCreation = Math.max(
		0,
		(now.getTime() - createdAt.getTime()) / DAY_MS,
	)
	return clamp(raw * 0.5 ** (daysSinceCreation / recencyHalfLifeDays))
}

export function shouldAbstainForLowTrust(params: {
	results: MemorySearchResult[]
	classification: MemorySearchClassification
	request: Pick<MemorySearchRequest, "query" | "needExactEvidence">
}): string | null {
	if (params.results.length === 0) {
		return null
	}
	const summary = summarizeTrust(params.results)
	const hasUsableResult =
		summary.distribution.high > 0 || summary.distribution.medium > 0
	if (hasUsableResult) {
		return null
	}
	const strictQuery =
		params.request.needExactEvidence === true ||
		params.classification === "direct" ||
		params.classification === "scoped"
	if (!strictQuery) {
		return null
	}
	return "All surviving results were low-trust after applying the active constraints."
}
