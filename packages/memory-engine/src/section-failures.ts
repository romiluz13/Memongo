/**
 * M2 T8 (#117): typed per-section failures for the composed read surfaces
 * (discovery projections, the active slate, the context bundle, context
 * expansion). A section that fails is one bounded enum row on the response,
 * never `null` plus a boolean. When every planned section failed the whole
 * call throws the representative typed error (R3), so a total failure is
 * never an empty success. Rows and log fields carry enum values and the
 * numeric driver code only; no query, document or provider text.
 */
import type { SubsystemLogger } from "@memongo/lib"
import { settledFailureMeta } from "./query-diagnostics.js"
import {
	SearchBudgetDeniedError,
	SearchLaneError,
	toTypedSearchError,
	type SearchBudgetReason,
	type SearchFailureReason,
	type SearchLane,
	type SearchLaneOutcome,
	type SearchStage,
} from "./search-outcomes.js"

export type SectionFailure = {
	section: string
	stage: SearchStage
	outcome: "failed" | "budget-denied"
	reason: SearchFailureReason | SearchBudgetReason
}

export type SettledSection<T> =
	| { ok: true; value: T }
	| { ok: false; value: undefined }

type TypedSectionError = SearchLaneError | SearchBudgetDeniedError

const UNAVAILABLE_REASONS: ReadonlySet<string> = new Set([
	"lane-unavailable",
	"index-missing",
	"index-not-ready",
	"query-timeout",
	"dependency-unavailable",
])

export function sectionFailureFromError(
	section: string,
	fallbackStage: SearchStage,
	err: unknown,
	lane?: SearchLane,
): { failure: SectionFailure; error: TypedSectionError } {
	const error = toTypedSearchError(err, fallbackStage, lane)
	if (error instanceof SearchBudgetDeniedError) {
		return {
			error,
			failure: {
				section,
				stage: error.stage,
				outcome: "budget-denied",
				reason: error.reason,
			},
		}
	}
	return {
		error,
		failure: {
			section,
			stage: error.stage,
			outcome: "failed",
			reason: error.reason,
		},
	}
}

// Defect (query-error, internal-error) outranks retryable unavailability,
// which outranks a budget denial: the same order the HTTP mapping applies to
// failed search outcomes, so the one error a total failure throws maps to the
// status its rows would have produced.
function severity(error: TypedSectionError): number {
	if (error instanceof SearchBudgetDeniedError) return 0
	return UNAVAILABLE_REASONS.has(error.reason) ? 1 : 2
}

export function representativeSectionError(
	errors: readonly TypedSectionError[],
): TypedSectionError | undefined {
	let chosen: TypedSectionError | undefined
	for (const error of errors) {
		if (!chosen || severity(error) > severity(chosen)) {
			chosen = error
		}
	}
	return chosen
}

type SettleOptions = {
	lane?: SearchLane
	label?: string
	/** Section does not read the query: its log line carries no query digest. */
	queryless?: boolean
}

export class SectionFailureCollector {
	private readonly entries: Array<{ order: number; failure: SectionFailure }> =
		[]
	private readonly errors: TypedSectionError[] = []
	private plannedCount = 0
	private readonly failedSections = new Set<string>()

	constructor(
		private readonly context: {
			log: SubsystemLogger
			operation: string
			query?: string
		},
	) {}

	/**
	 * Failure rows in the order their sections were planned, not the order
	 * they happened to fail, so concurrent sections report deterministically.
	 */
	get failures(): SectionFailure[] {
		return this.entries
			.map((entry, index) => ({ ...entry, index }))
			.sort(
				(left, right) => left.order - right.order || left.index - right.index,
			)
			.map((entry) => entry.failure)
	}

	/** Run one planned section; a failure becomes a typed row and a log line. */
	async settle<T>(
		section: string,
		stage: SearchStage,
		fn: () => Promise<T>,
		options: SettleOptions = {},
	): Promise<SettledSection<T>> {
		const order = this.plan()
		try {
			return { ok: true, value: await fn() }
		} catch (error) {
			this.fail(section, stage, error, { ...options, order })
			return { ok: false, value: undefined }
		}
	}

	/** Count a planned section whose work runs outside `settle`. */
	plan(): number {
		this.plannedCount += 1
		return this.plannedCount
	}

	/** Record the failure of a planned section as a typed row and a log line. */
	fail(
		section: string,
		stage: SearchStage,
		error: unknown,
		options: SettleOptions & { order?: number } = {},
	): void {
		const typed = sectionFailureFromError(section, stage, error, options.lane)
		this.entries.push({
			order: options.order ?? this.plannedCount,
			failure: typed.failure,
		})
		this.failedSections.add(section)
		this.errors.push(typed.error)
		// The typed wrapper keeps the driver error as `cause`; the numeric code
		// lives there.
		const source =
			typed.error instanceof SearchLaneError && typed.error.cause !== undefined
				? typed.error.cause
				: error
		this.context.log.warn(
			`${this.context.operation}: ${options.label ?? section} query failed`,
			{
				...settledFailureMeta(
					source,
					options.queryless ? undefined : this.context.query,
				),
				stage: typed.failure.stage,
				reason: typed.failure.reason,
			},
		)
	}

	/**
	 * Record a failure that arrived as a row (a lane outcome) rather than a
	 * throw. The row's section counts as failed.
	 */
	failRow(row: SectionFailure): void {
		this.entries.push({ order: this.plannedCount, failure: row })
		this.failedSections.add(row.section)
		this.errors.push(errorFromSectionFailure(row))
	}

	/**
	 * Adopt rows a nested builder already reported. The section they describe
	 * degraded but produced a result, so it does not count as failed.
	 */
	adopt(rows: readonly SectionFailure[]): void {
		for (const failure of rows) {
			this.entries.push({ order: this.plannedCount, failure })
		}
	}

	get allFailed(): boolean {
		return (
			this.plannedCount > 0 && this.failedSections.size >= this.plannedCount
		)
	}

	/** R3: every planned section failed, so the call fails typed. */
	throwIfAllFailed(): void {
		if (!this.allFailed) {
			return
		}
		const error = representativeSectionError(this.errors)
		if (error) {
			throw error
		}
	}
}

function errorFromSectionFailure(row: SectionFailure): TypedSectionError {
	return row.outcome === "budget-denied"
		? new SearchBudgetDeniedError({
				stage: row.stage,
				reason: row.reason as SearchBudgetReason,
			})
		: new SearchLaneError({
				stage: row.stage,
				reason: row.reason as SearchFailureReason,
			})
}

/** Prefix nested rows so a parent response can carry a child's failures. */
export function nestSectionFailures(
	parent: string,
	failures: readonly SectionFailure[],
): SectionFailure[] {
	return failures.map((row) => ({
		...row,
		section: `${parent}:${row.section}`,
	}))
}

/**
 * The failure rows a search result's lane outcomes imply for one section:
 * one row when the call failed or every lane failed, plus a budget-denied row
 * when admission control throttled it. Lane rows themselves stay on the
 * result (X-09); this is only the section-level verdict.
 */
export function sectionFailuresFromLaneOutcomes(params: {
	section: string
	laneOutcomes?: readonly SearchLaneOutcome[]
	outcomeStatus?: "complete" | "partial" | "failed"
	throttled?: { retryAfterMs: number }
}): SectionFailure[] {
	if (params.throttled) {
		return [
			{
				section: params.section,
				stage: "request",
				outcome: "budget-denied",
				reason: "budget-reservation",
			},
		]
	}
	const failed = (params.laneOutcomes ?? []).filter(
		(row) =>
			row.stage !== "explain" &&
			(row.outcome === "failed" || row.outcome === "budget-denied"),
	)
	if (failed.length === 0) {
		return params.outcomeStatus === "failed"
			? [
					{
						section: params.section,
						stage: "request",
						outcome: "failed",
						reason: "internal-error",
					},
				]
			: []
	}
	return failed.map((row) => ({
		section: params.section,
		stage: row.stage,
		outcome: row.outcome === "budget-denied" ? "budget-denied" : "failed",
		reason: (row.reason ??
			(row.outcome === "budget-denied"
				? "budget-reservation"
				: "internal-error")) as SectionFailure["reason"],
	}))
}

const bestEffortFailures = new Map<string, number>()

/**
 * A declared best-effort side write: its failure never fails the read that
 * triggered it, but it is counted and logged with enums only, so the loss is
 * observable instead of swallowed.
 */
export function noteBestEffortFailure(
	log: SubsystemLogger,
	label: string,
	error: unknown,
): void {
	bestEffortFailures.set(label, (bestEffortFailures.get(label) ?? 0) + 1)
	log.warn(`${label}: best-effort write failed`, settledFailureMeta(error))
}

export function bestEffortFailureCount(label: string): number {
	return bestEffortFailures.get(label) ?? 0
}

export function resetBestEffortFailureCounts(): void {
	bestEffortFailures.clear()
}
