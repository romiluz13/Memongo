import { createSubsystemLogger } from "@memongo/lib"
import {
	JEV_SCORE_MAX,
	JEV_SCORE_MIN,
	JevRerankError,
	type JevUsageInfo,
	buildRequestBody,
	parseResponseBody,
} from "./mongodb-jev-protocol.js"
import { withRemoteHttpResponse } from "./remote-http.js"

const log = createSubsystemLogger("memory:mongodb:jev-reranker")

// ---------------------------------------------------------------------------
// Jev (TypeSafe System One) relevance-scoring adapter — ISOLATED slice.
//
// Plan: .orchestrator/JEV-INTEGRATION-PLAN.md step 1. This module is NOT
// wired into the search path: nothing outside its colocated test may import
// it at this stage. It scores caller-supplied candidate snippets with ONE
// pinned-model POST and returns scores in input order; it never accepts
// model-selected memory IDs and never reorders.
//
// Contract anchors (vendor docs, accessed 2026-09-18):
// - POST https://api.typesafe.ai/v1/systemone, Bearer auth (docs.typesafe.ai/api.md)
// - Score criteria = ordered array of >=2 level descriptions; answer carries
//   score (probability-weighted, may land between levels), legend,
//   probabilities (per-level floats summing to 1), confidence (diagnostic
//   only — never thresholded here).
// - Pinned model jev-1.13.0; aliases are never sent (models.md).
//
// Known parser limit: the native JSON parser keeps the LAST property when a
// JSON object contains duplicate keys. No custom JSON parser is shipped;
// exact key-SET validation detects wrong answer sets, but a response
// containing the same answer key twice resolves last-property-wins. Accepted
// limit, recorded here and reviewed by the lead.
//
// Deadline accounting: one Date.now() clock. The stage budget is the
// caller's remaining budget clamped to JEV_STAGE_CAP_MS, measured from
// function entry (serialization time consumes it); the 250ms floor is
// re-checked immediately before dispatch. A single timer aborts the request
// AND settles the race, so DNS-guard stalls, connects, and slow bodies all
// return by the deadline. A guarded fetch wrapper refuses post-deadline
// dispatch even when an injected fetch ignores the abort signal. Any
// continuation settling after the deadline (success, HTTP error, or invalid
// body) is inert: exactly one terminal outcome/event per call.
// ---------------------------------------------------------------------------

export {
	JEV_MODEL_ID,
	JEV_RELEVANCE_LEVELS,
	JevRerankError,
	type JevUsageInfo,
} from "./mongodb-jev-protocol.js"

export const JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone"
export const JEV_MAX_CANDIDATES = 20
export const JEV_MAX_REQUEST_BYTES = 24 * 1024
export const JEV_MAX_RESPONSE_BYTES = 64 * 1024
export const JEV_MIN_REMAINING_MS = 250
export const JEV_STAGE_CAP_MS = 2000

export type JevSkipReason =
	| "no-api-key"
	| "no-candidates"
	| "empty-candidate"
	| "too-many-candidates"
	| "request-too-large"
	| "budget-exhausted"

export type JevFailCategory =
	| "transport"
	| "ssrf-blocked"
	| "redirect-refused"
	| "http-error"
	| "response-too-large"
	| "invalid-json"
	| "invalid-response"
	| "deadline-exceeded"

export type JevRerankOutcome =
	| {
			status: "ok"
			/** Normalized [0,1] scores in INPUT candidate order (score/4). */
			scores: number[]
			/** Raw provider scores in [0,4], input order. */
			rawScores: number[]
			/** Per-question confidence, diagnostics only — never thresholded. */
			confidences: number[]
			/** Provider usage; "unknown" when absent/zero/invalid (never free). */
			usage: JevUsageInfo
			latencyMs: number
	  }
	| { status: "skipped"; reason: JevSkipReason; latencyMs: number }
	| {
			status: "failed"
			/** Sanitized category only — never provider body/query/snippet text. */
			category: JevFailCategory
			httpStatus?: number
			usage: JevUsageInfo
			latencyMs: number
	  }

export type JevRerankParams = {
	query: string
	/** Ordered candidate snippets; output scores align by index. */
	candidates: string[]
	/** Explicit server-side credential. Empty skips; env is never read here. */
	apiKey: string
	/**
	 * Remaining caller budget in ms (single Date.now() clock domain),
	 * measured from function entry. Non-finite values never dispatch.
	 */
	remainingMs: number
	/**
	 * Strict mode: real failures emit one sanitized failure event, then
	 * throw JevRerankError. Skips stay skipped outcomes and never throw.
	 */
	strict?: boolean
	/** Optional observer; its errors are logged (fixed text) and inert. */
	onEvent?: (outcome: JevRerankOutcome) => void
	/** Test seam: injected transport. */
	fetchFn?: typeof globalThis.fetch
	/** Test seam: injected DNS guard. */
	verifyPublicHostname?: (hostname: string) => Promise<void>
}

function unknownUsage(): JevUsageInfo {
	return { status: "unknown", reason: "absent" }
}

function emit(params: JevRerankParams, outcome: JevRerankOutcome): void {
	if (params.onEvent) {
		try {
			params.onEvent(outcome)
		} catch {
			// Observer faults are diagnostics-only: fixed log text, never the
			// observer's error message (it may capture query/credential text).
			log.warn("jev rerank observer failed")
		}
	}
	if (outcome.status === "failed") {
		// Counts/categories only — no query, snippet, body, or credential text.
		log.warn("jev rerank call failed", {
			category: outcome.category,
			...(outcome.httpStatus !== undefined
				? { httpStatus: outcome.httpStatus }
				: {}),
			latencyMs: outcome.latencyMs,
		})
	}
}

function failOutcome(
	category: JevFailCategory,
	startedAt: number,
	httpStatus?: number,
): JevRerankOutcome {
	return {
		status: "failed",
		category,
		...(httpStatus !== undefined ? { httpStatus } : {}),
		usage: unknownUsage(),
		latencyMs: Date.now() - startedAt,
	}
}

/** Emits exactly one terminal failure event; strict mode then throws. */
function fail(
	params: JevRerankParams,
	category: JevFailCategory,
	startedAt: number,
	httpStatus?: number,
): JevRerankOutcome {
	const outcome = failOutcome(category, startedAt, httpStatus)
	emit(params, outcome)
	if (params.strict) {
		const error = new JevRerankError(category)
		error.emitted = true
		throw error
	}
	return outcome
}

/** Skips are never strict-mode throws: they return the skipped outcome. */
function skip(
	params: JevRerankParams,
	reason: JevSkipReason,
	startedAt: number,
): JevRerankOutcome {
	const outcome: JevRerankOutcome = {
		status: "skipped",
		reason,
		latencyMs: Date.now() - startedAt,
	}
	emit(params, outcome)
	return outcome
}

async function readBoundedBody(
	response: Response,
	signal: AbortSignal,
): Promise<string> {
	if (!response.body) {
		const text = await response.text()
		if (new TextEncoder().encode(text).length > JEV_MAX_RESPONSE_BYTES) {
			throw new JevRerankError("response-too-large")
		}
		return text
	}
	const reader = response.body.getReader()
	// Abort (deadline) must cancel and release the reader so an ignored-abort
	// stream cannot leave a hanging read behind.
	const onAbort = () => {
		void reader.cancel().catch(() => {})
	}
	signal.addEventListener("abort", onAbort, { once: true })
	try {
		const chunks: Uint8Array[] = []
		let total = 0
		for (;;) {
			const { done, value } = await reader.read()
			if (done) break
			if (value) {
				total += value.byteLength
				if (total > JEV_MAX_RESPONSE_BYTES) {
					throw new JevRerankError("response-too-large")
				}
				chunks.push(value)
			}
		}
		const merged = new Uint8Array(total)
		let offset = 0
		for (const chunk of chunks) {
			merged.set(chunk, offset)
			offset += chunk.byteLength
		}
		return new TextDecoder().decode(merged)
	} finally {
		signal.removeEventListener("abort", onAbort)
		void reader.cancel().catch(() => {})
		reader.releaseLock()
	}
}

/**
 * Score candidates with ONE pinned-model POST. Zero retries; the whole stage
 * (prep, DNS guard, connect, body, validation) is bounded end-to-end by the
 * remaining caller budget capped at JEV_STAGE_CAP_MS. Exactly one terminal
 * outcome/event per call; any post-deadline continuation is inert. Normal
 * mode never throws and never reorders: failure outcomes carry no scores,
 * so the caller keeps the exact original input order and scores. Strict
 * mode emits one sanitized failure event, then throws JevRerankError.
 */
export async function scoreCandidatesWithJev(
	params: JevRerankParams,
): Promise<JevRerankOutcome> {
	const startedAt = Date.now()
	if (!params.apiKey) return skip(params, "no-api-key", startedAt)
	if (params.candidates.length === 0) {
		return skip(params, "no-candidates", startedAt)
	}
	if (params.candidates.length > JEV_MAX_CANDIDATES) {
		return skip(params, "too-many-candidates", startedAt)
	}
	// Never silently drop or truncate a candidate: empty input skips the stage.
	if (params.candidates.some((c) => c.trim().length === 0)) {
		return skip(params, "empty-candidate", startedAt)
	}
	// Non-finite budgets never dispatch (NaN would slip past every compare).
	if (!Number.isFinite(params.remainingMs)) {
		return skip(params, "budget-exhausted", startedAt)
	}
	const deadlineAt = startedAt + Math.min(params.remainingMs, JEV_STAGE_CAP_MS)
	if (deadlineAt - startedAt < JEV_MIN_REMAINING_MS) {
		return skip(params, "budget-exhausted", startedAt)
	}
	// Serialization consumes the same budget; re-check the floor immediately
	// before dispatch so slow prep cannot hand fetch a dead window.
	const body = buildRequestBody(params.query, params.candidates)
	if (new TextEncoder().encode(body).length > JEV_MAX_REQUEST_BYTES) {
		return skip(params, "request-too-large", startedAt)
	}
	const dispatchRemainingMs = deadlineAt - Date.now()
	if (dispatchRemainingMs < JEV_MIN_REMAINING_MS) {
		return skip(params, "budget-exhausted", startedAt)
	}

	const controller = new AbortController()
	let settled = false
	let rejectDeadline!: (error: Error) => void
	const deadlineRejection = new Promise<never>((_resolve, reject) => {
		rejectDeadline = reject
	})
	const timer = setTimeout(() => {
		controller.abort()
		rejectDeadline(new JevRerankError("deadline-exceeded"))
	}, dispatchRemainingMs)

	// Refuse dispatch once the deadline passed (e.g. a slow DNS guard
	// resolving late), even if an injected fetch ignores the abort signal.
	const guardedFetch: typeof globalThis.fetch = (url, init) => {
		if (settled || Date.now() >= deadlineAt) {
			return Promise.reject(new JevRerankError("deadline-exceeded"))
		}
		return (params.fetchFn ?? globalThis.fetch)(url, init)
	}

	try {
		const work = withRemoteHttpResponse({
			url: JEV_ENDPOINT,
			init: {
				method: "POST",
				headers: {
					"content-type": "application/json",
					authorization: `Bearer ${params.apiKey}`,
				},
				body,
				signal: controller.signal,
			},
			fetchFn: guardedFetch,
			...(params.verifyPublicHostname
				? { verifyPublicHostname: params.verifyPublicHostname }
				: {}),
			auditContext: "jev-rerank",
			onResponse: async (response) => {
				// Late success OR late error/status/invalid body: all inert.
				// Throwing here settles `work` as the race loser (swallowed);
				// the single terminal event already came from the race.
				if (settled || Date.now() > deadlineAt) {
					throw new JevRerankError("deadline-exceeded")
				}
				if (!response.ok) {
					return fail(params, "http-error", startedAt, response.status)
				}
				const text = await readBoundedBody(response, controller.signal)
				if (settled || Date.now() > deadlineAt) {
					throw new JevRerankError("deadline-exceeded")
				}
				const parsed = parseResponseBody(text, params.candidates.length)
				if (settled || Date.now() > deadlineAt) {
					throw new JevRerankError("deadline-exceeded")
				}
				const outcome: JevRerankOutcome = {
					status: "ok",
					scores: parsed.rawScores.map(
						(s) => s / (JEV_SCORE_MAX - JEV_SCORE_MIN),
					),
					rawScores: parsed.rawScores,
					confidences: parsed.confidences,
					usage: parsed.usage,
					latencyMs: Date.now() - startedAt,
				}
				emit(params, outcome)
				return outcome
			},
		})
		// The loser of the race (late fetch/parse continuation, or a deadline
		// rejection arriving after success) settles inert and unobserved.
		work.catch(() => {})
		return await Promise.race([work, deadlineRejection])
	} catch (error) {
		if (error instanceof JevRerankError) {
			const category = error.category as JevFailCategory
			if (!error.emitted) {
				emit(params, failOutcome(category, startedAt))
			}
			if (params.strict) {
				error.emitted = true
				throw error
			}
			return failOutcome(category, startedAt)
		}
		const message = error instanceof Error ? error.message : String(error)
		if (message.includes("refused redirect")) {
			return fail(params, "redirect-refused", startedAt)
		}
		if (message.includes("SSRF guard")) {
			return fail(params, "ssrf-blocked", startedAt)
		}
		return fail(params, "transport", startedAt)
	} finally {
		settled = true
		clearTimeout(timer)
	}
}
