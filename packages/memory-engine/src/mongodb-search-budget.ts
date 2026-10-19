import { AsyncLocalStorage } from "node:async_hooks"
import { createSubsystemLogger } from "@memongo/lib"
import {
	type IndexHealthStats,
	type RequestIndexHealth,
	activeIndexHealth,
} from "./mongodb-index-health.js"
import {
	SearchBudgetDeniedError,
	type SearchBudgetReason,
	type SearchStage,
} from "./search-outcomes.js"

const log = createSubsystemLogger("memory:mongodb:search-budget")

// ---------------------------------------------------------------------------
// Per-search cost budget (fix-plan-2026-08-03 P3.2)
//
// One sparse query on an empty corpus used to fire 30+ aggregations and 4-6
// paid server-side embeddings (a mongoSearch tier ladder, procedural
// backstops, a recursive hybrid backstop and a legacy re-run; the ladder and
// the re-run no longer exist). Cost was inverse to data presence — cold
// tenants burned the most.
//
// This module is the per-request ledger that caps that storm: the request
// boundary opens one budget and every $vectorSearch stage build (an autoEmbed
// embedding) and every aggregation in the search path consumes from it.
// #101: exhaustion is a typed budget denial (SearchBudgetDeniedError), never
// an empty result, so a denied lane can never read as zero hits or trigger a
// weaker tier.
//
// The budget travels via AsyncLocalStorage so the lanes (which run
// concurrently inside searchV2) share one ledger without threading a param
// through every search helper signature. The recursive hybrid backstop
// re-enters searchV2 inside the same context and therefore consumes the
// SAME budget instead of opening a fresh one.
//
// #101 decision 18: required lanes reserve their estimated cost before any
// optional work starts, and run inside their reservation; optional work can
// only spend the unreserved remainder. Every charge is atomic over its
// aggregation/embed pair. The ledger also remembers completed retrievals so
// an equivalent one later in the same request is reused instead of re-spent.
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
	/**
	 * #101 decision 18: these counts are the engine's charged query work
	 * (attempts, warmup retries included), not provider billing.
	 */
	accounting: "engine-query-work"
	/** Aggregations consumed by the search so far. */
	aggregations: number
	/** Server-side embeddings consumed by the search so far. */
	embeds: number
	/** The share of the counts above spent on warmup retries. */
	retries: { aggregations: number; embeds: number }
	/** Retrievals skipped because an equivalent one already completed. */
	equivalentSkips: number
	/** True when consumption hit either limit during the search. */
	exhausted: boolean
	/**
	 * M2 decision 8: the request's index-status metadata reads, reported apart
	 * from the retrieval work above. Metadata checks never consume an
	 * aggregation or an embed. Absent when the request ran outside an
	 * index-health scope.
	 */
	indexHealth?: IndexHealthStats
}

/** #101 decision 18: one attempt's charges, consumed together or not at all. */
export type SearchWorkCost = {
	aggregations: number
	embeds: number
}

export type SearchBudgetReservation = {
	tryConsumeAggregation(): boolean
	tryConsumeEmbed(): boolean
	/** #101 decision 18: consume a paired charge from the reservation, all or nothing. */
	tryConsumeWork(cost: SearchWorkCost): boolean
	release(): void
}

/** One request's ledger, opened at the request boundary and run in repeatedly. */
export type SearchBudgetLedger = {
	run<T>(fn: () => Promise<T>): Promise<T>
	snapshot(): SearchBudgetSnapshot
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
	retryAggregations: number
	retryEmbeds: number
	equivalentSkips: number
	exhausted: boolean
	/** RET-16: absolute deadline (Date.now() + maxWallMs) when the limit is set. */
	deadlineAt?: number
	/**
	 * Whether the request already holds its admission token. searchDetailed
	 * admits at its boundary; search() opens the ledger before searchV2
	 * admits on it.
	 */
	admitted: boolean
	/** Decision 18: completed retrievals of this request, by equivalence key. */
	completed: Map<string, readonly unknown[]>
	/** M2 decision 8: the request's index-health snapshot, when one is open. */
	health?: RequestIndexHealth
}

type ReservationState = {
	budget?: ActiveSearchBudget
	remainingAggregations: number
	remainingEmbeds: number
	released: boolean
}

const budgetStorage = new AsyncLocalStorage<ActiveSearchBudget>()
const reservationStorage = new AsyncLocalStorage<ReservationState>()
const reservationStates = new WeakMap<
	SearchBudgetReservation,
	ReservationState
>()

function toSnapshot(budget: ActiveSearchBudget): SearchBudgetSnapshot {
	return {
		maxAggregations: budget.limits.maxAggregations,
		maxEmbeds: budget.limits.maxEmbeds,
		...(budget.limits.maxWallMs != null
			? { maxWallMs: budget.limits.maxWallMs }
			: {}),
		accounting: "engine-query-work",
		aggregations: budget.aggregations,
		embeds: budget.embeds,
		retries: {
			aggregations: budget.retryAggregations,
			embeds: budget.retryEmbeds,
		},
		equivalentSkips: budget.equivalentSkips,
		exhausted: budget.exhausted,
		...(budget.health ? { indexHealth: budget.health.stats() } : {}),
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
		`per-search budget exhausted (${reason}); remaining lanes are budget-denied`,
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

/** True when the active budget's request already holds its admission token. */
export function isSearchBudgetAdmitted(): boolean {
	return budgetStorage.getStore()?.admitted === true
}

/** Record that the active budget's request now holds its admission token. */
export function markSearchBudgetAdmitted(): void {
	const budget = budgetStorage.getStore()
	if (budget) {
		budget.admitted = true
	}
}

/** Snapshot of the active budget, or undefined outside a budget context. */
export function getSearchBudgetSnapshot(): SearchBudgetSnapshot | undefined {
	const budget = budgetStorage.getStore()
	return budget ? toSnapshot(budget) : undefined
}

/**
 * #101 decision 18: open one request ledger. Every `run` executes inside the
 * same ledger, so a request boundary can run all of its passes against one
 * set of counts.
 */
export function openSearchBudget(
	limits: SearchBudgetLimits,
	options: { admitted?: boolean } = {},
): SearchBudgetLedger {
	const budget: ActiveSearchBudget = {
		limits,
		aggregations: 0,
		embeds: 0,
		reservedAggregations: 0,
		reservedEmbeds: 0,
		retryAggregations: 0,
		retryEmbeds: 0,
		equivalentSkips: 0,
		exhausted: false,
		admitted: options.admitted ?? true,
		completed: new Map(),
		health: activeIndexHealth(),
		// RET-16: the request wall starts when the budget opens; nested
		// re-entries keep the PARENT's deadline.
		...(limits.maxWallMs != null
			? { deadlineAt: Date.now() + limits.maxWallMs }
			: {}),
	}
	return {
		run: (fn) => budgetStorage.run(budget, fn),
		snapshot: () => toSnapshot(budget),
	}
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
	const ledger = openSearchBudget(limits)
	const value = await ledger.run(fn)
	return { value, budget: ledger.snapshot() }
}

function isPastDeadline(budget: ActiveSearchBudget | undefined): boolean {
	return (
		budget?.deadlineAt !== undefined && Date.now() > (budget.deadlineAt ?? 0)
	)
}

function normalizeReservationCount(value: number): number {
	return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
}

function normalizeCost(cost: SearchWorkCost): SearchWorkCost {
	return {
		aggregations: normalizeReservationCount(cost.aggregations),
		embeds: normalizeReservationCount(cost.embeds),
	}
}

/** The share of `cost` the reservation in scope can cover. */
function heldShare(
	held: ReservationState | undefined,
	budget: ActiveSearchBudget,
	cost: SearchWorkCost,
): SearchWorkCost {
	if (!held || held.released || held.budget !== budget) {
		return { aggregations: 0, embeds: 0 }
	}
	return {
		aggregations: Math.min(cost.aggregations, held.remainingAggregations),
		embeds: Math.min(cost.embeds, held.remainingEmbeds),
	}
}

/** Whether the part of `cost` the reservation does not cover fits the pool. */
function poolFits(
	budget: ActiveSearchBudget,
	cost: SearchWorkCost,
	held: SearchWorkCost,
): { aggregations: boolean; embeds: boolean } {
	const restAggregations = cost.aggregations - held.aggregations
	const restEmbeds = cost.embeds - held.embeds
	return {
		aggregations:
			restAggregations === 0 ||
			budget.aggregations + budget.reservedAggregations + restAggregations <=
				budget.limits.maxAggregations,
		embeds:
			restEmbeds === 0 ||
			budget.embeds + budget.reservedEmbeds + restEmbeds <=
				budget.limits.maxEmbeds,
	}
}

/**
 * #101 decision 18: consume a paired charge atomically. Inside a required
 * lane's reservation the charge draws on that reservation first and on the
 * unreserved pool only for the rest; everywhere else it draws on the
 * unreserved pool. Both halves fit, or nothing is charged — a refused embed
 * never leaves its aggregation spent, or the reverse.
 */
export function tryConsumeSearchWork(
	cost: SearchWorkCost,
	options: { retry?: boolean } = {},
): boolean {
	const budget = budgetStorage.getStore()
	// Unbudgeted callers (diagnostics outside any request ledger) are never
	// throttled.
	if (!budget) {
		return true
	}
	// RET-16: the request wall spans retries and passes — once the deadline
	// passes, every further consume is refused.
	if (isPastDeadline(budget)) {
		markExhausted(budget, "wall-clock deadline passed")
		return false
	}
	const normalized = normalizeCost(cost)
	const held = reservationStorage.getStore()
	const share = heldShare(held, budget, normalized)
	const fits = poolFits(budget, normalized, share)
	if (!fits.aggregations || !fits.embeds) {
		markExhausted(
			budget,
			`${fits.embeds ? "aggregations" : "embeds"} hit the limit`,
		)
		return false
	}
	if (held && (share.aggregations > 0 || share.embeds > 0)) {
		held.remainingAggregations -= share.aggregations
		held.remainingEmbeds -= share.embeds
		budget.reservedAggregations -= share.aggregations
		budget.reservedEmbeds -= share.embeds
	}
	budget.aggregations += normalized.aggregations
	budget.embeds += normalized.embeds
	if (options.retry) {
		budget.retryAggregations += normalized.aggregations
		budget.retryEmbeds += normalized.embeds
	}
	return true
}

/**
 * #101: why the active budget refused a paired charge — the deadline when it
 * has passed, else embeds when they do not fit, else aggregations.
 */
export function searchWorkDenialReason(
	cost: SearchWorkCost,
): SearchBudgetReason {
	const budget = budgetStorage.getStore()
	if (!budget) {
		return cost.embeds > 0 ? "budget-embeds" : "budget-aggregations"
	}
	if (isPastDeadline(budget)) {
		return "budget-deadline"
	}
	const normalized = normalizeCost(cost)
	const fits = poolFits(
		budget,
		normalized,
		heldShare(reservationStorage.getStore(), budget, normalized),
	)
	return fits.embeds ? "budget-aggregations" : "budget-embeds"
}

/** #101: consume a paired charge or throw a typed denial; a denial spends nothing. */
export function consumeSearchWorkOrThrow(
	stage: SearchStage,
	cost: SearchWorkCost,
	options: { retry?: boolean } = {},
): void {
	if (!tryConsumeSearchWork(cost, options)) {
		throw new SearchBudgetDeniedError({
			stage,
			reason: searchWorkDenialReason(cost),
		})
	}
}

/**
 * Consume one aggregation from the active budget. Returns false when the
 * budget is exhausted; search callers report that as a typed budget denial
 * (consumeSearchAggregationOrThrow), never as an empty result.
 */
export function tryConsumeSearchAggregation(): boolean {
	return tryConsumeSearchWork({ aggregations: 1, embeds: 0 })
}

/**
 * Consume one server-side query embedding from the active budget. Every
 * autoEmbed $vectorSearch stage embeds the query text server-side, so stage
 * construction is where the cost lands. Returns false when exhausted.
 */
export function tryConsumeSearchEmbed(): boolean {
	return tryConsumeSearchWork({ aggregations: 0, embeds: 1 })
}

/**
 * Give back aggregations charged for work that turned out to share one
 * execution (several prepaid stages inside one pipeline).
 */
export function refundSearchAggregations(count: number): void {
	const budget = budgetStorage.getStore()
	const refund = normalizeReservationCount(count)
	if (budget && refund > 0) {
		budget.aggregations = Math.max(0, budget.aggregations - refund)
	}
}

/**
 * #101: why the active budget refused a consume — the wall-clock deadline
 * when it has passed, otherwise the exhausted resource.
 */
export function searchBudgetDenialReason(
	kind: "aggregations" | "embeds",
): SearchBudgetReason {
	if (isPastDeadline(budgetStorage.getStore())) {
		return "budget-deadline"
	}
	return kind === "aggregations" ? "budget-aggregations" : "budget-embeds"
}

/** #101: consume one aggregation or throw a typed denial (never an empty result). */
export function consumeSearchAggregationOrThrow(stage: SearchStage): void {
	consumeSearchWorkOrThrow(stage, { aggregations: 1, embeds: 0 })
}

/** #101: consume one server-side embed or throw a typed denial. */
export function consumeSearchEmbedOrThrow(stage: SearchStage): void {
	consumeSearchWorkOrThrow(stage, { aggregations: 0, embeds: 1 })
}

/**
 * Atomically reserve aggregation and embed capacity before concurrent work
 * starts. Normal consumers cannot spend reserved capacity. The returned token
 * converts reserved units to consumed units exactly once and releases unused
 * capacity when the owner finishes.
 */
export function tryReserveSearchBudget(
	request: SearchWorkCost,
): SearchBudgetReservation | undefined {
	const requestedAggregations = normalizeReservationCount(request.aggregations)
	const requestedEmbeds = normalizeReservationCount(request.embeds)
	const budget = budgetStorage.getStore()

	// RET-16: reservations past the request wall can never be satisfied.
	if (budget && isPastDeadline(budget)) {
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
				"per-search budget cannot satisfy reservation; the reserved lane is budget-denied",
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

	const state: ReservationState = {
		...(budget ? { budget } : {}),
		remainingAggregations: requestedAggregations,
		remainingEmbeds: requestedEmbeds,
		released: false,
	}

	const consume = (cost: SearchWorkCost): boolean => {
		if (state.released) return false
		if (isPastDeadline(budget)) {
			if (budget) markExhausted(budget, "wall-clock deadline passed")
			return false
		}
		const normalized = normalizeCost(cost)
		if (
			normalized.aggregations > state.remainingAggregations ||
			normalized.embeds > state.remainingEmbeds
		) {
			return false
		}
		state.remainingAggregations -= normalized.aggregations
		state.remainingEmbeds -= normalized.embeds
		if (budget) {
			budget.reservedAggregations -= normalized.aggregations
			budget.reservedEmbeds -= normalized.embeds
			budget.aggregations += normalized.aggregations
			budget.embeds += normalized.embeds
		}
		return true
	}

	const reservation: SearchBudgetReservation = {
		tryConsumeAggregation: () => consume({ aggregations: 1, embeds: 0 }),
		tryConsumeEmbed: () => consume({ aggregations: 0, embeds: 1 }),
		tryConsumeWork: consume,
		release: () => {
			if (state.released) return
			state.released = true
			if (budget) {
				budget.reservedAggregations -= state.remainingAggregations
				budget.reservedEmbeds -= state.remainingEmbeds
			}
			state.remainingAggregations = 0
			state.remainingEmbeds = 0
		},
	}
	reservationStates.set(reservation, state)
	return reservation
}

/**
 * #101 decision 18: run a required lane inside its reservation. Every charge
 * the lane makes draws on the reservation first; the unused rest is released
 * when the lane settles.
 */
export async function runWithSearchReservation<T>(
	reservation: SearchBudgetReservation,
	fn: () => Promise<T>,
): Promise<T> {
	const state = reservationStates.get(reservation)
	try {
		return state ? await reservationStorage.run(state, fn) : await fn()
	} finally {
		reservation.release()
	}
}

/** Copies of an equivalent completed retrieval of this request, if any. */
export function findCompletedSearchRetrieval<T>(
	key: string,
): readonly T[] | undefined {
	const budget = budgetStorage.getStore()
	const results = budget?.completed.get(key) as readonly T[] | undefined
	if (budget && results) {
		budget.equivalentSkips += 1
	}
	return results
}

/** Remember a successful retrieval so an equivalent one is not re-spent. */
export function recordCompletedSearchRetrieval<T>(
	key: string,
	results: readonly T[],
): void {
	budgetStorage.getStore()?.completed.set(key, results)
}
