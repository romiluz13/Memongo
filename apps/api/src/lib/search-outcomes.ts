import type {
	SearchLaneOutcome,
	SearchOutcomeSummary,
} from "@memongo/memory-bridge"
import type { Context } from "hono"
import { apiErrorJson, internalError, jsonError } from "./errors.js"

/**
 * #101 / decision 16, resolution R3: the one HTTP mapping of a search call's
 * outcome summary, shared by /v1/search, /v1/search-kb and
 * /v1/search-detailed. `complete` and `partial` are 200. A `failed` call is
 * 503 SEARCH_LANES_UNAVAILABLE when every failure is a retryable
 * unavailability, 503 SEARCH_BUDGET_EXHAUSTED when every failure is a budget
 * denial, and otherwise 500 SEARCH_LANES_FAILED (500 > unavailable > budget).
 * Explain rows are diagnostics and never change the status (R4).
 */
export type SearchFailureCode =
	| "SEARCH_LANES_UNAVAILABLE"
	| "SEARCH_BUDGET_EXHAUSTED"
	| "SEARCH_LANES_FAILED"

export type SearchHttpMapping =
	| { status: 200 }
	| { status: 500 | 503; code: SearchFailureCode }

const UNAVAILABLE_REASONS: ReadonlySet<string> = new Set([
	"lane-unavailable",
	"index-missing",
	"index-not-ready",
	"index-stale",
	"index-unavailable",
	"query-timeout",
	"dependency-unavailable",
])

const FAILURE_REASONS: ReadonlySet<string> = new Set([
	...UNAVAILABLE_REASONS,
	"query-error",
	"internal-error",
])

const BUDGET_REASONS: ReadonlySet<string> = new Set([
	"budget-aggregations",
	"budget-embeds",
	"budget-deadline",
	"budget-reservation",
])

export function mapSearchOutcomes(
	outcomes: SearchOutcomeSummary | undefined,
): SearchHttpMapping {
	if (outcomes?.status !== "failed") {
		return { status: 200 }
	}
	const failures = outcomes.lanes.filter(
		(row) =>
			row.stage !== "explain" &&
			(row.outcome === "failed" || row.outcome === "budget-denied"),
	)
	const defect = failures.some(
		(row) =>
			row.outcome === "failed" &&
			(row.reason === undefined || !UNAVAILABLE_REASONS.has(row.reason)),
	)
	if (defect || failures.length === 0) {
		return { status: 500, code: "SEARCH_LANES_FAILED" }
	}
	if (failures.some((row) => row.outcome === "failed")) {
		return { status: 503, code: "SEARCH_LANES_UNAVAILABLE" }
	}
	return { status: 503, code: "SEARCH_BUDGET_EXHAUSTED" }
}

/**
 * A2: the wire row is the bounded enum row only. Any other field an engine
 * row might carry (a raw provider message, query text) is dropped here, the
 * last boundary before the client.
 */
export function boundSearchOutcomeRows(
	rows: readonly SearchLaneOutcome[],
): SearchLaneOutcome[] {
	return rows.map((row) => ({
		lane: row.lane,
		stage: row.stage,
		outcome: row.outcome,
		...(typeof row.reason === "string" ? { reason: row.reason } : {}),
		...(typeof row.resultCount === "number"
			? { resultCount: row.resultCount }
			: {}),
		...(typeof row.pass === "number" ? { pass: row.pass } : {}),
	}))
}

export function boundSearchOutcomes(
	outcomes: SearchOutcomeSummary,
): SearchOutcomeSummary {
	return {
		status: outcomes.status,
		lanes: boundSearchOutcomeRows(outcomes.lanes),
	}
}

/**
 * Strict mode and the M5 rethrow: the engine throws SearchLaneError,
 * SearchLaneUnavailableError or SearchBudgetDeniedError. They are recognized
 * structurally (class name plus typed enum fields) and become the one failing
 * row. The message and cause are never read.
 */
export function searchOutcomesFromError(
	err: unknown,
): SearchOutcomeSummary | undefined {
	if (!(err instanceof Error)) {
		return undefined
	}
	const typed = err as Error & {
		lane?: unknown
		stage?: unknown
		reason?: unknown
	}
	if (typeof typed.stage !== "string" || typeof typed.reason !== "string") {
		return undefined
	}
	let outcome: "failed" | "budget-denied"
	if (
		(err.name === "SearchLaneError" ||
			err.name === "SearchLaneUnavailableError") &&
		FAILURE_REASONS.has(typed.reason)
	) {
		outcome = "failed"
	} else if (
		err.name === "SearchBudgetDeniedError" &&
		BUDGET_REASONS.has(typed.reason)
	) {
		outcome = "budget-denied"
	} else {
		return undefined
	}
	return {
		status: "failed",
		lanes: [
			{
				lane: (typeof typed.lane === "string"
					? typed.lane
					: "search") as SearchLaneOutcome["lane"],
				stage: typed.stage as SearchLaneOutcome["stage"],
				outcome,
				reason: typed.reason as SearchLaneOutcome["reason"],
			},
		],
	}
}

/**
 * The non-2xx body for a failed search: a route-authored constant message
 * and the bounded outcome rows. Logged with enum values only.
 */
export function searchFailureResponse(
	c: Context,
	mapping: Exclude<SearchHttpMapping, { status: 200 }>,
	outcomes: SearchOutcomeSummary,
) {
	const requestId = c.get("requestId") ?? "no-request-id"
	console.error(
		JSON.stringify({
			level: "error",
			msg: "search failed",
			requestId,
			code: mapping.code,
			method: c.req.method,
			path: c.req.path,
		}),
	)
	return c.json(
		{
			...apiErrorJson(mapping.code, `search failed (request id: ${requestId})`),
			outcomes: boundSearchOutcomes({ ...outcomes, status: "failed" }),
		},
		mapping.status,
	)
}

export const RERANK_UNSUPPORTED_MESSAGE =
	"rerank is not supported: native $rerank (Atlas only) is not implemented yet"

function isRerankUnsupportedError(err: unknown): boolean {
	return (
		err instanceof Error &&
		err.name === "SearchLaneError" &&
		(err as Error & { reason?: unknown }).reason === "rerank-unsupported"
	)
}

/**
 * The catch-block mapping: a typed search failure goes through the same
 * table; any other error keeps the generic internal error envelope. A rerank
 * demand is the caller's request, not a lane failure: 400 RERANK_UNSUPPORTED.
 */
export function searchErrorResponse(
	c: Context,
	err: unknown,
	fallbackCode: string,
) {
	if (isRerankUnsupportedError(err)) {
		return jsonError(c, 400, "RERANK_UNSUPPORTED", RERANK_UNSUPPORTED_MESSAGE)
	}
	const outcomes = searchOutcomesFromError(err)
	const mapping = mapSearchOutcomes(outcomes)
	if (!outcomes || mapping.status === 200) {
		return internalError(c, err, fallbackCode)
	}
	return searchFailureResponse(c, mapping, outcomes)
}
