import { redactSensitiveText } from "@memongo/lib"
import type { Context } from "hono"
import type { ContentfulStatusCode } from "hono/utils/http-status"

/**
 * M2 review D3: what a failed operation had already committed. `commitState`
 * is `none` (the operation knows none of its data writes committed; a
 * consolidation run's own run-record row is not counted), `committed`
 * (known committed effects, listed in `commit`) or `unknown` (an uncertain
 * commit outcome; `commit` lists only what is known to be committed). A body
 * without the field makes no claim at all.
 */
export type CommitStateWire = "none" | "committed" | "unknown"

export type CommitDetailWire =
	| {
			operation: "sync"
			fileSync: { filesFailed: number; enumerationComplete: boolean }
			kbImport?: {
				documentsProcessed: number
				chunksCreated: number
				skipped: number
			}
	  }
	| {
			operation: "consolidate"
			runId: string
			eventsProcessed: number
			factsPromoted: number
			factsInferred: number
			factsMerged: number
			factsPruned: number
	  }

export type CommitFields = {
	commitState: CommitStateWire
	commit?: CommitDetailWire
}

export type ApiErrorBody = {
	error: {
		code: string
		message: string
	} & Partial<CommitFields>
}

export function apiErrorJson(
	code: string,
	message: string,
	commit?: CommitFields,
): ApiErrorBody {
	// C-002: the envelope is the last boundary before the wire — callers
	// pass route-authored messages, but any path that forwards upstream or
	// driver text must not be able to smuggle credentials out. Redaction
	// here is a no-op for ordinary route messages and stars only
	// credential-shaped content.
	return {
		error: { code, message: redactSensitiveText(message), ...(commit ?? {}) },
	}
}

export function jsonError(
	c: Context,
	status: ContentfulStatusCode,
	code: string,
	message: string,
	commit?: CommitFields,
) {
	return c.json(apiErrorJson(code, message, commit), status)
}

const COMMIT_STATES: ReadonlySet<string> = new Set([
	"none",
	"committed",
	"unknown",
])

const RUN_ID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function commitCount(value: unknown): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
		? value
		: undefined
}

// A descriptor read: a getter or proxy trap on an engine error can neither
// run code here nor replace the original failure.
function ownValue(source: unknown, key: string): unknown {
	try {
		if (source && typeof source === "object") {
			return Object.getOwnPropertyDescriptor(source, key)?.value
		}
	} catch {
		// A proxy descriptor trap must not replace the original failure.
	}
	return undefined
}

function counts<K extends string>(
	source: unknown,
	keys: readonly K[],
): Record<K, number> | undefined {
	const out = {} as Record<K, number>
	for (const key of keys) {
		const value = commitCount(ownValue(source, key))
		if (value === undefined) return undefined
		out[key] = value
	}
	return out
}

/**
 * Rebuild the commit detail from the documented fields only: an extra field
 * is ignored, and a malformed value or an unrecognized operation drops the
 * whole detail, so nothing but enums, counts and a run id reaches the client.
 */
function boundCommitDetail(value: unknown): CommitDetailWire | undefined {
	const operation = ownValue(value, "operation")
	if (operation === "consolidate") {
		const runId = ownValue(value, "runId")
		const work = counts(value, [
			"eventsProcessed",
			"factsPromoted",
			"factsInferred",
			"factsMerged",
			"factsPruned",
		] as const)
		if (typeof runId !== "string" || !RUN_ID_PATTERN.test(runId) || !work) {
			return undefined
		}
		return { operation, runId, ...work }
	}
	if (operation === "sync") {
		const fileSync = ownValue(value, "fileSync")
		const filesFailed = commitCount(ownValue(fileSync, "filesFailed"))
		const enumerationComplete = ownValue(fileSync, "enumerationComplete")
		if (filesFailed === undefined || typeof enumerationComplete !== "boolean") {
			return undefined
		}
		const kbImportRaw = ownValue(value, "kbImport")
		if (kbImportRaw === undefined) {
			return { operation, fileSync: { filesFailed, enumerationComplete } }
		}
		const kbImport = counts(kbImportRaw, [
			"documentsProcessed",
			"chunksCreated",
			"skipped",
		] as const)
		if (!kbImport) return undefined
		return {
			operation,
			fileSync: { filesFailed, enumerationComplete },
			kbImport,
		}
	}
	return undefined
}

/**
 * The commit state an engine error carries (`commitState`, optionally with a
 * `commit` detail), bounded for the wire. An error with no recognized state
 * returns undefined and the body makes no commit claim; an unrecognized or
 * malformed detail is dropped and the state alone is kept.
 */
export function commitFieldsFromError(err: unknown): CommitFields | undefined {
	const state = ownValue(err, "commitState")
	if (typeof state !== "string" || !COMMIT_STATES.has(state)) {
		return undefined
	}
	const commit = boundCommitDetail(ownValue(err, "commit"))
	return {
		commitState: state as CommitStateWire,
		...(commit ? { commit } : {}),
	}
}

/**
 * Dependency-unavailable classifier (P1.3). Only the MongoDB driver's clear
 * network-layer failure names map to 503 — these mean the database is
 * unreachable, so a retry has a real chance of succeeding. Message matching
 * was deliberately rejected as too fuzzy (driver messages vary by version
 * and locale); a generic 500 must never become retriable noise, so anything
 * outside this closed set stays a 500.
 */
const DEPENDENCY_UNAVAILABLE_ERROR_NAMES = new Set([
	"MongoNetworkError",
	"MongoNetworkTimeoutError",
	"MongoServerSelectionError",
])

export function isDependencyUnavailableError(err: unknown): boolean {
	let current: unknown = err
	// The driver often wraps the network error in a cause chain — walk it,
	// bounded so a cyclic cause cannot loop forever.
	for (let depth = 0; depth < 4 && current instanceof Error; depth += 1) {
		if (DEPENDENCY_UNAVAILABLE_ERROR_NAMES.has(current.name)) {
			return true
		}
		const cause: unknown = (current as { cause?: unknown }).cause
		if (!cause || cause === current) {
			break
		}
		current = cause
	}
	return false
}

/**
 * P0.8 safe error envelope (official Hono pattern: deliberate codes stay on
 * the route, unexpected failures go through one central mapper). The raw
 * error is represented by an optional numeric code under the request id;
 * messages, stacks and arbitrary properties are omitted. The client body
 * carries only the route's deliberate code and the id reference for correlation.
 *
 * P1.3: genuine dependency-unavailable failures (Mongo network/selection
 * errors, see isDependencyUnavailableError) map to 503 SERVICE_UNAVAILABLE
 * so client retry means something; everything else stays a generic 500.
 */
export function internalError(c: Context, err: unknown, code: string) {
	// M2 T13: a read that lacks the full tenant identity is the caller's
	// request, not a server fault; the engine error carries a fixed message
	// naming the operation and the missing parts.
	if (err instanceof Error && err.name === "TenantIdentityRequiredError") {
		return jsonError(c, 400, "TENANT_IDENTITY_REQUIRED", err.message)
	}
	const requestId = c.get("requestId") ?? "no-request-id"
	const errorCode = ownValue(err, "code")
	// #101 and M2 review D3: an operation that committed work, or whose commit
	// outcome is unknown, says so on the error body; an uncertain outcome
	// claims neither a commit nor a rollback.
	const commit = commitFieldsFromError(err)
	const respond = (status: 500 | 503, responseCode: string, message: string) =>
		c.json(apiErrorJson(responseCode, message, commit), status)
	console.error(
		JSON.stringify({
			level: "error",
			msg: "request failed",
			requestId,
			code,
			method: c.req.method,
			path: c.req.path,
			error:
				typeof errorCode === "number" && Number.isFinite(errorCode)
					? { code: errorCode }
					: {},
		}),
	)
	if (isDependencyUnavailableError(err)) {
		return respond(
			503,
			"SERVICE_UNAVAILABLE",
			`dependency unavailable (request id: ${requestId})`,
		)
	}
	return respond(500, code, `internal server error (request id: ${requestId})`)
}

const KB_REFRESH_REASONS: ReadonlySet<string> = new Set([
	"import-rejected",
	"import-errors",
	"marker-write-failed",
])

/**
 * M2 review R7/R8: a sync whose KB auto-refresh did not complete. The engine
 * throws `KBRefreshError` (matched by name, as the other engine errors are,
 * because the class does not cross every bridge boundary reliably). The body
 * is a route-authored message built from the enum reason and the import's
 * commit counts only: the error's message, cause and sampled import errors
 * stay in the engine log and never reach the client. Any other error returns
 * undefined so the caller keeps its generic envelope.
 */
export function kbRefreshFailureResponse(c: Context, err: unknown) {
	if (!(err instanceof Error) || err.name !== "KBRefreshError") {
		return undefined
	}
	const typed = err as Error & {
		reason?: unknown
		documentsProcessed?: unknown
		chunksCreated?: unknown
		skipped?: unknown
	}
	const reason =
		typeof typed.reason === "string" && KB_REFRESH_REASONS.has(typed.reason)
			? typed.reason
			: undefined
	const documents = commitCount(typed.documentsProcessed)
	const chunks = commitCount(typed.chunksCreated)
	const skipped = commitCount(typed.skipped)
	const requestId = c.get("requestId") ?? "no-request-id"
	console.error(
		JSON.stringify({
			level: "error",
			msg: "kb refresh failed",
			requestId,
			code: "KB_REFRESH_FAILED",
			method: c.req.method,
			path: c.req.path,
			...(reason ? { reason } : {}),
		}),
	)
	// M2 review D3: the file-sync phase is named as committed only when the
	// engine reported it; the import's counts only when the import produced
	// them.
	const commit = commitFieldsFromError(err)
	const fileSync =
		commit?.commit?.operation === "sync" ? "the file sync committed; " : ""
	const imported =
		documents !== undefined && chunks !== undefined
			? `the import committed ${documents} documents and ${chunks} chunks${skipped === undefined ? "" : ` (${skipped} skipped)`}; `
			: ""
	return jsonError(
		c,
		500,
		"KB_REFRESH_FAILED",
		`KB refresh failed${reason ? ` (${reason})` : ""}: ${fileSync}${imported}the refresh marker was not advanced, so the next sync retries (request id: ${requestId})`,
		commit,
	)
}
