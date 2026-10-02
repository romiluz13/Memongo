import { AsyncLocalStorage } from "node:async_hooks"
import { createSubsystemLogger } from "@memongo/lib"

const log = createSubsystemLogger("memory:mongodb:search-budget")

// ---------------------------------------------------------------------------
// Per-search cost budget (fix-plan-2026-08-03 P3.2)
//
// One sparse query on an empty corpus used to fire 30+ aggregations and 4-6
// paid server-side embeddings (the mongoSearch waterfall, procedural
// backstops, a recursive hybrid backstop, then a legacySearch re-run). Cost
// was inverse to data presence — cold tenants burned the most.
//
// This module is the per-request ledger that caps that storm: searchV2 opens
// one budget per request and every $vectorSearch stage build (an autoEmbed
// embedding) and every aggregation in the search path consumes from it.
// Exhaustion degrades a lane to an EMPTY result — never an error — per the
// Appendix C principle "empty ≠ error": an empty answer is valid, and it is
// what stops the escalation machinery from re-firing.
//
// The budget travels via AsyncLocalStorage so the lanes (which run
// concurrently inside searchV2) share one ledger without threading a param
// through every search helper signature. The recursive hybrid backstop
// re-enters searchV2 inside the same context and therefore consumes the
// SAME budget instead of opening a fresh one.
// ---------------------------------------------------------------------------

export type SearchBudgetLimits = {
	/** Maximum aggregation executions allowed for one search request. */
	maxAggregations: number
	/** Maximum server-side query embeddings allowed for one search request. */
	maxEmbeds: number
	/**
	 * RET-16: optional wall-clock ceiling for the whole request, in
	 * milliseconds from the moment the budget opens. The deadline is checked
	 * at consume/reserve time and spans retries AND passes — one request,
	 * one wall. DEFAULT OFF: WS-16 pins the single-pass tail budget, and no
	 * repo decision exists for a multi-pass request wall (a default could
	 * degrade legitimate corrective searches); operators opt in via
	 * searchBudget.maxWallMs.
	 */
	maxWallMs?: number
}

export type SearchBudgetSnapshot = SearchBudgetLimits & {
	/** Aggregations consumed by the search so far. */
	aggregations: number
	/** Server-side embeddings consumed by the search so far. */
	embeds: number
	/** True when consumption hit either limit during the search. */
	exhausted: boolean
}

export type SearchBudgetReservation = {
	tryConsumeAggregation(): boolean
	tryConsumeEmbed(): boolean
	release(): void
}

/**
 * Defaults are storm caps, not lane shapers: a typical search (fused chunks
 * lane + structured + kb + evidence) costs ~4 aggregations and ~3-4 embeds,
 * so these limits only bite when escalation machinery runs away.
 */
export const DEFAULT_SEARCH_BUDGET: SearchBudgetLimits = {
	maxAggregations: 12,
	maxEmbeds: 5,
}

// ---------------------------------------------------------------------------
// User-driven pipeline maxTimeMS (fix-plan-2026-08-03 P3.8)
//
// Benchmark/diagnostic probes already cap server-side execution with
// maxTimeMS, but user-driven $search/$vectorSearch pipelines ran uncapped —
// one pathological aggregation could hold a mongot/mongod worker for the full
// server default. Every user-driven search aggregate now carries this
// ceiling; callers with a narrower deadline can override it explicitly.
// ---------------------------------------------------------------------------

export const DEFAULT_USER_SEARCH_MAX_TIME_MS = 10_000

/**
 * Resolve the maxTimeMS ceiling for user-driven search pipelines.
 * MEMONGO_SEARCH_MAX_TIME_MS overrides the 10s default; invalid or
 * non-positive values fall back to the default.
 */
export function resolveUserSearchMaxTimeMs(
	env: NodeJS.ProcessEnv = process.env,
): number {
	const raw = Number(env.MEMONGO_SEARCH_MAX_TIME_MS)
	return Number.isFinite(raw) && raw > 0
		? Math.floor(raw)
		: DEFAULT_USER_SEARCH_MAX_TIME_MS
}

type ActiveSearchBudget = {
	limits: SearchBudgetLimits
	aggregations: number
	embeds: number
	reservedAggregations: number
	reservedEmbeds: number
	exhausted: boolean
	/** RET-16: absolute deadline (Date.now() + maxWallMs) when the limit is set. */
	deadlineAt?: number
}

const budgetStorage = new AsyncLocalStorage<ActiveSearchBudget>()

function toSnapshot(budget: ActiveSearchBudget): SearchBudgetSnapshot {
	return {
		maxAggregations: budget.limits.maxAggregations,
		maxEmbeds: budget.limits.maxEmbeds,
		...(budget.limits.maxWallMs != null
			? { maxWallMs: budget.limits.maxWallMs }
			: {}),
		aggregations: budget.aggregations,
		embeds: budget.embeds,
		exhausted: budget.exhausted,
	}
}

/** Flip the exhausted flag once, with one warn line per exhaustion reason. */
function markExhausted(
	budget: ActiveSearchBudget,
	reason: string,
	extra?: Record<string, unknown>,
): void {
	if (budget.exhausted) {
		return
	}
	budget.exhausted = true
	log.warn(
		`per-search budget exhausted (${reason}); degrading remaining lanes to empty results`,
		{ ...toSnapshot(budget), ...extra },
	)
}

/** Resolve optional config overrides over the defaults. */
export function resolveSearchBudgetLimits(
	overrides?: Partial<SearchBudgetLimits>,
): SearchBudgetLimits {
	const resolve = (value: unknown, fallback: number): number =>
		typeof value === "number" && Number.isFinite(value) && value > 0
			? Math.floor(value)
			: fallback
	const maxWallMs =
		typeof overrides?.maxWallMs === "number" &&
		Number.isFinite(overrides.maxWallMs) &&
		overrides.maxWallMs > 0
			? Math.floor(overrides.maxWallMs)
			: undefined
	return {
		maxAggregations: resolve(
			overrides?.maxAggregations,
			DEFAULT_SEARCH_BUDGET.maxAggregations,
		),
		maxEmbeds: resolve(overrides?.maxEmbeds, DEFAULT_SEARCH_BUDGET.maxEmbeds),
		// RET-16: absent/invalid stays OFF (mechanism default; see the type
		// doc) — resolveSearchBudgetLimits never invents a wall.
		...(maxWallMs !== undefined ? { maxWallMs } : {}),
	}
}

/** True when the current async context carries an active budget. */
export function hasActiveSearchBudget(): boolean {
	return budgetStorage.getStore() !== undefined
}

/** Snapshot of the active budget, or undefined outside a budget context. */
export function getSearchBudgetSnapshot(): SearchBudgetSnapshot | undefined {
	const budget = budgetStorage.getStore()
	return budget ? toSnapshot(budget) : undefined
}

/**
 * Run `fn` under a search budget. When a budget is already active (the
 * recursive hybrid backstop re-entering searchV2), `fn` shares it instead of
 * opening a nested one — the returned snapshot reflects the shared ledger.
 */
export async function runWithSearchBudget<T>(
	limits: SearchBudgetLimits,
	fn: () => Promise<T>,
): Promise<{ value: T; budget: SearchBudgetSnapshot }> {
	const existing = budgetStorage.getStore()
	if (existing) {
		const value = await fn()
		return { value, budget: toSnapshot(existing) }
	}
	const budget: ActiveSearchBudget = {
		limits,
		aggregations: 0,
		embeds: 0,
		reservedAggregations: 0,
		reservedEmbeds: 0,
		exhausted: false,
		// RET-16: the request wall starts when the budget opens; the share
		// branch above keeps the PARENT's deadline for nested re-entries.
		...(limits.maxWallMs != null
			? { deadlineAt: Date.now() + limits.maxWallMs }
			: {}),
	}
	const value = await budgetStorage.run(budget, fn)
	return { value, budget: toSnapshot(budget) }
}

function tryConsume(
	kind: "aggregations" | "embeds",
	limit: (limits: SearchBudgetLimits) => number,
	onCapacityExhausted?: () => void,
): boolean {
	const budget = budgetStorage.getStore()
	// Unbudgeted callers (diagnostics and legacy paths outside searchV2) are
	// never throttled.
	if (!budget) {
		return true
	}
	// RET-16: the request wall spans retries and passes — once the deadline
	// passes, every further consume is refused (empty ≠ error).
	if (budget.deadlineAt !== undefined && Date.now() > budget.deadlineAt) {
		markExhausted(budget, "wall-clock deadline passed")
		return false
	}
	const reserved =
		kind === "aggregations"
			? budget.reservedAggregations
			: budget.reservedEmbeds
	if (budget[kind] + reserved >= limit(budget.limits)) {
		markExhausted(budget, `${kind} hit the limit`)
		onCapacityExhausted?.()
		return false
	}
	budget[kind] += 1
	return true
}

/**
 * Consume one aggregation from the active budget. Returns false when the
 * budget is exhausted — callers must degrade to an empty result (empty ≠
 * error) rather than throw.
 */
export function tryConsumeSearchAggregation(): boolean {
	return tryConsume("aggregations", (limits) => limits.maxAggregations)
}

/**
 * Consume one server-side query embedding from the active budget. Every
 * autoEmbed $vectorSearch stage embeds the query text server-side, so stage
 * construction is where the cost lands. Returns false when exhausted.
 */
export function tryConsumeSearchEmbed(
	onCapacityExhausted?: () => void,
): boolean {
	return tryConsume("embeds", (limits) => limits.maxEmbeds, onCapacityExhausted)
}

function normalizeReservationCount(value: number): number {
	return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
}

/**
 * Atomically reserve aggregation and embed capacity before concurrent work
 * starts. Normal consumers cannot spend reserved capacity. The returned token
 * converts reserved units to consumed units exactly once and releases unused
 * capacity when the owner finishes.
 */
export function tryReserveSearchBudget(request: {
	aggregations: number
	embeds: number
}): SearchBudgetReservation | undefined {
	const requestedAggregations = normalizeReservationCount(request.aggregations)
	const requestedEmbeds = normalizeReservationCount(request.embeds)
	const budget = budgetStorage.getStore()

	// RET-16: reservations past the request wall can never be satisfied.
	if (
		budget &&
		budget.deadlineAt !== undefined &&
		Date.now() > budget.deadlineAt
	) {
		markExhausted(budget, "wall-clock deadline passed")
		return undefined
	}

	if (
		budget &&
		(budget.aggregations + budget.reservedAggregations + requestedAggregations >
			budget.limits.maxAggregations ||
			budget.embeds + budget.reservedEmbeds + requestedEmbeds >
				budget.limits.maxEmbeds)
	) {
		if (!budget.exhausted) {
			budget.exhausted = true
			log.warn(
				"per-search budget cannot satisfy reservation; degrading reserved lane to empty results",
				{
					...toSnapshot(budget),
					requestedAggregations,
					requestedEmbeds,
				},
			)
		}
		return undefined
	}

	if (budget) {
		budget.reservedAggregations += requestedAggregations
		budget.reservedEmbeds += requestedEmbeds
	}

	let remainingAggregations = requestedAggregations
	let remainingEmbeds = requestedEmbeds
	let released = false

	const consume = (kind: "aggregations" | "embeds"): boolean => {
		if (released) return false
		if (budget?.deadlineAt !== undefined && Date.now() > budget.deadlineAt) {
			markExhausted(budget, "wall-clock deadline passed")
			return false
		}
		if (kind === "aggregations") {
			if (remainingAggregations <= 0) return false
			remainingAggregations -= 1
			if (budget) {
				budget.reservedAggregations -= 1
				budget.aggregations += 1
			}
			return true
		}
		if (remainingEmbeds <= 0) return false
		remainingEmbeds -= 1
		if (budget) {
			budget.reservedEmbeds -= 1
			budget.embeds += 1
		}
		return true
	}

	return {
		tryConsumeAggregation: () => consume("aggregations"),
		tryConsumeEmbed: () => consume("embeds"),
		release: () => {
			if (released) return
			released = true
			if (budget) {
				budget.reservedAggregations -= remainingAggregations
				budget.reservedEmbeds -= remainingEmbeds
			}
			remainingAggregations = 0
			remainingEmbeds = 0
		},
	}
}
