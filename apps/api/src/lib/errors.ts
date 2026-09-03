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
 * error — driver messages, hostnames, absolute paths, stack — is logged
 * server-side under the request id; the client body carries only the
 * route's deliberate code and the id reference for correlation.
 *
 * P1.3: genuine dependency-unavailable failures (Mongo network/selection
 * errors, see isDependencyUnavailableError) map to 503 SERVICE_UNAVAILABLE
 * so client retry means something; everything else stays a generic 500.
 */
export function internalError(c: Context, err: unknown, code: string) {
	const requestId = c.get("requestId") ?? "no-request-id"
	console.error(
		JSON.stringify({
			level: "error",
			msg: "request failed",
			requestId,
			code,
			method: c.req.method,
			path: c.req.path,
			error:
				err instanceof Error
					? {
							// C-002: server-side diagnostic detail is redacted at the
							// boundary — driver errors can embed connection strings
							// or credentials in messages and stacks.
							name: err.name,
							message: redactSensitiveText(err.message),
							stack: err.stack ? redactSensitiveText(err.stack) : undefined,
						}
					: redactSensitiveText(String(err)),
		}),
	)
	if (isDependencyUnavailableError(err)) {
		return jsonError(
			c,
			503,
			"SERVICE_UNAVAILABLE",
			`dependency unavailable (request id: ${requestId})`,
		)
	}
	return jsonError(
		c,
		500,
		code,
		`internal server error (request id: ${requestId})`,
	)
}
