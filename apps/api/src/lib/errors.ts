import { redactSensitiveText } from "@memongo/lib"
import type { Context } from "hono"
import type { ContentfulStatusCode } from "hono/utils/http-status"

export type ApiErrorBody = {
	error: {
		code: string
		message: string
	}
}

export function apiErrorJson(code: string, message: string): ApiErrorBody {
	// C-002: the envelope is the last boundary before the wire — callers
	// pass route-authored messages, but any path that forwards upstream or
	// driver text must not be able to smuggle credentials out. Redaction
	// here is a no-op for ordinary route messages and stars only
	// credential-shaped content.
	return { error: { code, message: redactSensitiveText(message) } }
}

export function jsonError(
	c: Context,
	status: ContentfulStatusCode,
	code: string,
	message: string,
) {
	return c.json(apiErrorJson(code, message), status)
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
	let errorCode: unknown
	let commitState: unknown
	try {
		if (err && typeof err === "object") {
			errorCode = Object.getOwnPropertyDescriptor(err, "code")?.value
			commitState = Object.getOwnPropertyDescriptor(err, "commitState")?.value
		}
	} catch {
		// A proxy descriptor trap must not replace the original failure.
	}
	// #101: a search-barrier write whose commit outcome is unknown says so;
	// the body claims neither committed nor searchable.
	const respond = (
		status: 500 | 503,
		responseCode: string,
		message: string,
	) => {
		const body = apiErrorJson(responseCode, message)
		return commitState === "unknown"
			? c.json(
					{ error: { ...body.error, commitState: "unknown" as const } },
					status,
				)
			: c.json(body, status)
	}
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

function commitCount(value: unknown): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
		? value
		: undefined
}

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
	const committed =
		documents !== undefined && chunks !== undefined
			? `the import committed ${documents} documents and ${chunks} chunks${skipped === undefined ? "" : ` (${skipped} skipped)`}; `
			: ""
	return jsonError(
		c,
		500,
		"KB_REFRESH_FAILED",
		`KB refresh failed${reason ? ` (${reason})` : ""}: ${committed}the refresh marker was not advanced, so the next sync retries (request id: ${requestId})`,
	)
}
