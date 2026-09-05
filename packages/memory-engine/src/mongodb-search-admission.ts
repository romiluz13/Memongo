import { createSubsystemLogger } from "@memongo/lib"

const log = createSubsystemLogger("memory:mongodb:search-admission")

// ---------------------------------------------------------------------------
// Process-level search admission control (WS-11 change 1, 09-report R5/U1)
//
// The per-request search budget (mongodb-search-budget.ts) caps the cost of
// ONE search (aggregations + server-side embeds) but nothing bounds how many
// searches a process admits: a burst of distinct uncached queries burns
// embedding RPM/TPM account-wide (Atlas automated embedding limits are
// project-scoped, so one caller's burst throttles every tenant) and the only
// observable outcome was "empty results" — indistinguishable from a healthy
// empty corpus (U1).
//
// This module is the process-level token bucket that fills that gap. One
// token = one admitted read that burns server-side autoEmbed inputs. The
// envelope covers every read-side embed spender:
//   - searchV2 (top-level entries only: the recursive hybrid backstop
//     re-enters searchV2 inside an active budget and shares the parent's
//     admission, so it never double-charges),
//   - recallConversation's hybrid/semantic stages (one token per querying
//     call covers both — at most two embeds),
//   - the direct searchKB vector lane (denial drops to the text lane),
//   - the opt-in legacySearch re-run (its own token, or it does not run).
// Exhaustion DENIES the request with a retry hint instead of running it
// degraded — each surface turns that denial into a distinct throttled
// outcome (change 2), never an empty-success.
//
// Sizing: defaults admit 20 requests/sec sustained with a 240-request
// instantaneous burst — far above normal interactive traffic, low enough
// that a runaway agent loop or a 500-query fan-out trips it. Deployments on
// a metered tier set MEMONGO_SEARCH_ADMISSION_RPM to their provider's
// request-per-minute budget (each admitted search may still spend up to
// maxEmbeds server-side embeddings — size the RPM so burst x expected embeds
// stays under the embedding tier). MEMONGO_SEARCH_ADMISSION_RPM=0 disables
// admission entirely (documented escape for dedicated/unmetered tiers where
// the provider bound is enforced elsewhere).
//
// Write-side automated embedding (chunk ingestion) is NOT gated here: it is
// bounded by the per-agent writeQueue depth cap (WS-11 change 4) and Atlas
// applies its own write-pipeline backpressure; this bucket owns the read
// path where a burst is invisible to the caller.
// ---------------------------------------------------------------------------

export type SearchAdmissionLimits = {
	/** Sustained admissions per minute (the bucket refill rate). */
	requestsPerMinute: number
	/** Bucket capacity: maximum admissions in an instantaneous burst. */
	burst: number
	/** False when admission is disabled (MEMONGO_SEARCH_ADMISSION_RPM=0). */
	enabled: boolean
}

export type SearchAdmissionDecision =
	| { ok: true }
	| { ok: false; retryAfterMs: number }

export const DEFAULT_SEARCH_ADMISSION_RPM = 1200
export const DEFAULT_SEARCH_ADMISSION_BURST = 240

/**
 * Resolve admission limits from the environment (per call, like telemetry
 * sampling, so operators can retune without a restart). Invalid values fall
 * back to the defaults; an explicit RPM of 0 disables admission.
 */
export function resolveSearchAdmissionLimits(
	env: {
		MEMONGO_SEARCH_ADMISSION_RPM?: string
		MEMONGO_SEARCH_ADMISSION_BURST?: string
	} = process.env,
): SearchAdmissionLimits {
	const rpmRaw = env.MEMONGO_SEARCH_ADMISSION_RPM?.trim()
	if (rpmRaw !== undefined && rpmRaw !== "") {
		const parsed = Number(rpmRaw)
		if (Number.isFinite(parsed) && parsed >= 0) {
			if (parsed === 0) {
				return { requestsPerMinute: 0, burst: 0, enabled: false }
			}
			return {
				requestsPerMinute: Math.floor(parsed),
				burst: resolveBurst(env, Math.floor(parsed)),
				enabled: true,
			}
		}
	}
	return {
		requestsPerMinute: DEFAULT_SEARCH_ADMISSION_RPM,
		burst: resolveBurst(env, DEFAULT_SEARCH_ADMISSION_BURST),
		enabled: true,
	}
}

function resolveBurst(
	env: { MEMONGO_SEARCH_ADMISSION_BURST?: string },
	fallback: number,
): number {
	const raw = env.MEMONGO_SEARCH_ADMISSION_BURST?.trim()
	if (raw !== undefined && raw !== "") {
		const parsed = Number(raw)
		if (Number.isFinite(parsed) && parsed >= 1) {
			return Math.floor(parsed)
		}
	}
	return fallback
}

type BucketState = {
	tokens: number
	lastRefillAt: number
	/** Monotone count of denied admissions since process start. */
	throttled: number
}

// Module-level singleton: the bucket is PROCESS-scoped by design — every
// manager instance in the process shares one admission budget because the
// provider limits it protects are process/account-scoped, not per-agent.
let state: BucketState = {
	tokens: DEFAULT_SEARCH_ADMISSION_BURST,
	lastRefillAt: Date.now(),
	throttled: 0,
}

/**
 * Try to admit one search request. Refills lazily from the elapsed time
 * since the last read (no timers), consumes one token on success, and
 * returns a retry hint on denial. `now` is injectable for tests.
 */
export function tryConsumeSearchAdmission(
	now: number = Date.now(),
): SearchAdmissionDecision {
	const limits = resolveSearchAdmissionLimits()
	if (!limits.enabled) {
		return { ok: true }
	}
	const elapsedMs = now - state.lastRefillAt
	const refillPerMs = limits.requestsPerMinute / 60_000
	const refilled = Math.min(
		limits.burst,
		state.tokens + Math.max(0, elapsedMs) * refillPerMs,
	)
	if (refilled >= 1) {
		state = {
			tokens: refilled - 1,
			lastRefillAt: now,
			throttled: state.throttled,
		}
		return { ok: true }
	}
	state = {
		tokens: refilled,
		lastRefillAt: now,
		throttled: state.throttled + 1,
	}
	const tokensNeeded = 1 - refilled
	const retryAfterMs = Math.max(1, Math.ceil(tokensNeeded / refillPerMs))
	return { ok: false, retryAfterMs }
}

/** Observable bucket state (depth + denial count) for status surfaces/tests. */
export function getSearchAdmissionSnapshot(now: number = Date.now()): {
	limits: SearchAdmissionLimits
	tokens: number
	throttled: number
} {
	const limits = resolveSearchAdmissionLimits()
	if (!limits.enabled) {
		return {
			limits,
			tokens: Number.POSITIVE_INFINITY,
			throttled: state.throttled,
		}
	}
	const elapsedMs = now - state.lastRefillAt
	const refillPerMs = limits.requestsPerMinute / 60_000
	const tokens = Math.min(
		limits.burst,
		state.tokens + Math.max(0, elapsedMs) * refillPerMs,
	)
	return { limits, tokens, throttled: state.throttled }
}

/** Reset the singleton bucket (test seam; refill clock restarts at `now`). */
export function resetSearchAdmissionForTests(now: number = Date.now()): void {
	state = {
		tokens: resolveSearchAdmissionLimits().burst,
		lastRefillAt: now,
		throttled: 0,
	}
	log.debug("search admission bucket reset")
}
