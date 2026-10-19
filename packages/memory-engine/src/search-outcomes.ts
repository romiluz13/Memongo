/**
 * #101 / decision 16: typed, value-free search outcomes. Every lane, tier
 * and phase reports one bounded row; failures and budget denials travel as
 * typed throws whose message is built from enum values only, so no outcome,
 * log reason or error carries query, body or provider text. The original
 * error survives only as `cause` for a bounded server log.
 */

export type SearchLane =
	| "active-critical"
	| "structured"
	| "procedural"
	| "raw-window"
	| "graph"
	| "episodic"
	| "kb"
	| "hybrid"
	| "hybrid:chunks"
	| "hybrid:session_chunks"
	| "hybrid:memory_evidence"
	| "conversation-evidence"
	| "temporal-coverage"
	| "turn-precision"
	| "recall"
	| "backstop:procedural-exact"
	| "backstop:procedural"
	| "backstop:hybrid"
	| "planner"
	| "search"

export type SearchStage =
	| "plan"
	| "request"
	| "lane"
	| "reservation"
	| "filter"
	| "rerun"
	| "vector"
	| "atlas-search"
	| "classic-text"
	| "keyword"
	| "score-fusion"
	| "rank-fusion"
	| "js-merge"
	| "exact-match"
	| "entity-lookup"
	| "graph-expand"
	| "episode-search"
	| "turn-vector"
	| "turn-text"
	| "explain"

export type SearchLaneOutcomeStatus =
	| "ok"
	| "ok-empty"
	| "not-applicable"
	| "failed"
	| "budget-denied"

export type SearchFailureReason =
	| "lane-unavailable"
	| "index-missing"
	| "index-not-ready"
	| "query-timeout"
	| "dependency-unavailable"
	| "query-error"
	| "internal-error"
	| "rerank-unsupported"

export type SearchBudgetReason =
	| "budget-aggregations"
	| "budget-embeds"
	| "budget-deadline"
	| "budget-reservation"

export type SearchNotApplicableReason =
	| "not-planned"
	| "capability-absent"
	| "query-shape"
	| "no-candidates"
	| "mode-disabled"
	| "source-disabled"
	| "empty-query"

export type SearchOutcomeReason =
	| "zero-hits"
	| SearchNotApplicableReason
	| SearchFailureReason
	| SearchBudgetReason

/** One bounded row on the metadata/wire surface (replaces the raw-error shape). */
export type SearchLaneOutcome = {
	lane: SearchLane
	stage: SearchStage
	outcome: SearchLaneOutcomeStatus
	reason?: SearchOutcomeReason
	resultCount?: number
	pass?: number
}

/** A tier row reported by a lane function; the orchestrator adds the lane. */
export type SearchTierOutcome = Omit<SearchLaneOutcome, "lane" | "pass">

export type SearchTierOutcomeSink = (row: SearchTierOutcome) => void

export type SearchOutcomeStatus = "complete" | "partial" | "failed"

export type SearchOutcomeSummary = {
	status: SearchOutcomeStatus
	lanes: SearchLaneOutcome[]
}

export class SearchLaneError extends Error {
	readonly lane?: SearchLane
	readonly stage: SearchStage
	readonly reason: SearchFailureReason

	constructor(params: {
		lane?: SearchLane
		stage: SearchStage
		reason: SearchFailureReason
		cause?: unknown
	}) {
		super(
			`search ${params.lane ?? "lane"} failed at ${params.stage}: ${params.reason}`,
			params.cause === undefined ? undefined : { cause: params.cause },
		)
		this.name = "SearchLaneError"
		this.lane = params.lane
		this.stage = params.stage
		this.reason = params.reason
	}
}

export class SearchLaneUnavailableError extends SearchLaneError {
	constructor(params: { lane?: SearchLane; stage?: SearchStage } = {}) {
		super({
			lane: params.lane,
			stage: params.stage ?? "lane",
			reason: "lane-unavailable",
		})
		this.name = "SearchLaneUnavailableError"
	}
}

export class SearchBudgetDeniedError extends Error {
	readonly lane?: SearchLane
	readonly stage: SearchStage
	readonly reason: SearchBudgetReason

	constructor(params: {
		lane?: SearchLane
		stage: SearchStage
		reason: SearchBudgetReason
	}) {
		super(
			`search ${params.lane ?? "lane"} budget denied at ${params.stage}: ${params.reason}`,
		)
		this.name = "SearchBudgetDeniedError"
		this.lane = params.lane
		this.stage = params.stage
		this.reason = params.reason
	}
}

const DEPENDENCY_UNAVAILABLE_ERROR_NAMES = new Set([
	"MongoNetworkError",
	"MongoNetworkTimeoutError",
	"MongoServerSelectionError",
])

// R9: a server code may yield a confident reason only after the atlas-local
// e2e suite has observed it. Candidates awaiting that observation: 27
// (IndexNotFound → index-missing) and 50 (MaxTimeMSExpired → query-timeout).
const OBSERVED_SERVER_CODE_REASONS: ReadonlyMap<number, SearchFailureReason> =
	new Map()

/** Reads only the error class name, numeric code and typed fields; never the message. */
export function classifySearchError(err: unknown): SearchFailureReason {
	if (err instanceof SearchLaneError) {
		return err.reason
	}
	let current: unknown = err
	for (let depth = 0; depth < 4 && current instanceof Error; depth += 1) {
		if (DEPENDENCY_UNAVAILABLE_ERROR_NAMES.has(current.name)) {
			return "dependency-unavailable"
		}
		const cause: unknown = (current as { cause?: unknown }).cause
		if (!cause || cause === current) {
			break
		}
		current = cause
	}
	if (err instanceof Error && err.name === "MongoServerError") {
		const code = (err as { code?: unknown }).code
		return (
			(typeof code === "number"
				? OBSERVED_SERVER_CODE_REASONS.get(code)
				: undefined) ?? "query-error"
		)
	}
	return "internal-error"
}

/** Bounded log fields for a failure: enums plus the numeric server code. */
export function searchFailureLogFields(err: unknown): {
	reason: SearchFailureReason | SearchBudgetReason
	code?: number
} {
	if (err instanceof SearchBudgetDeniedError) {
		return { reason: err.reason }
	}
	const cause = err instanceof SearchLaneError ? err.cause : err
	const code = (cause as { code?: unknown } | undefined)?.code
	return {
		reason: classifySearchError(err),
		...(typeof code === "number" ? { code } : {}),
	}
}

/** The failure or denial row for a caught error, at its typed stage when known. */
export function searchFailureRow(
	lane: SearchLane,
	fallbackStage: SearchStage,
	err: unknown,
): SearchLaneOutcome {
	return { lane, ...searchFailureTierRow(fallbackStage, err) }
}

/** The tier-level failure or denial row for a caught error (no lane yet). */
export function searchFailureTierRow(
	fallbackStage: SearchStage,
	err: unknown,
): SearchTierOutcome {
	if (err instanceof SearchBudgetDeniedError) {
		return { stage: err.stage, outcome: "budget-denied", reason: err.reason }
	}
	return {
		stage: err instanceof SearchLaneError ? err.stage : fallbackStage,
		outcome: "failed",
		reason: classifySearchError(err),
	}
}

/** Rethrow-ready typed error for an untyped failure at a known stage. */
export function toTypedSearchError(
	err: unknown,
	stage: SearchStage,
	lane?: SearchLane,
): SearchLaneError | SearchBudgetDeniedError {
	if (
		err instanceof SearchLaneError ||
		err instanceof SearchBudgetDeniedError
	) {
		return err
	}
	return new SearchLaneError({
		lane,
		stage,
		reason: classifySearchError(err),
		cause: err,
	})
}

export function isSearchFailureOutcome(row: SearchLaneOutcome): boolean {
	return row.outcome === "failed" || row.outcome === "budget-denied"
}

/**
 * Matrix section 5: complete when no retrieval row failed or was denied;
 * failed when no required lane succeeded and at least one failed; partial
 * otherwise. Explain rows are diagnostics and never count (R4). Lanes outside
 * `requiredLanes` (backstops, optional phases) can make a request partial,
 * never failed on their own.
 */
export function summarizeSearchOutcomes(
	lanes: SearchLaneOutcome[],
	requiredLanes: Iterable<SearchLane>,
): SearchOutcomeSummary {
	const required = new Set(requiredLanes)
	const retrieval = lanes.filter((row) => row.stage !== "explain")
	if (!retrieval.some(isSearchFailureOutcome)) {
		return { status: "complete", lanes }
	}
	const requiredSucceeded = retrieval.some(
		(row) =>
			required.has(row.lane) &&
			row.stage === "lane" &&
			(row.outcome === "ok" || row.outcome === "ok-empty"),
	)
	const requiredFailed = retrieval.some(
		(row) => required.has(row.lane) && isSearchFailureOutcome(row),
	)
	return {
		status: !requiredSucceeded && requiredFailed ? "failed" : "partial",
		lanes,
	}
}

/**
 * An admission denial ran nothing, so the request itself is the denied lane:
 * a typed budget-denied row and a failed status, never a bare empty answer.
 */
export function throttledSearchOutcomes(): SearchOutcomeSummary {
	return summarizeSearchOutcomes(
		[
			{
				lane: "search",
				stage: "request",
				outcome: "budget-denied",
				reason: "budget-embeds",
			},
		],
		["search"],
	)
}
