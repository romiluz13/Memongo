import { createHash, timingSafeEqual } from "node:crypto"

/**
 * Constant-time bearer comparison. Using `===` would short-circuit on the
 * first mismatched byte and leak the token prefix via response timing.
 * Hash both inputs before `timingSafeEqual` so different raw lengths do not
 * bypass the constant-time comparison. Empty bearers are always rejected so
 * the caller never matches by accident.
 *
 * WS-01: moved from apps/api/src/app.ts so every surface that checks caller
 * credentials (API auth middleware, MCP HTTP transport) shares one
 * comparison instead of the transport growing a second, weaker one.
 */
export function timingSafeBearerEquals(a: string, b: string): boolean {
	if (!a || !b) {
		return false
	}
	const aDigest = createHash("sha256").update(a, "utf8").digest()
	const bDigest = createHash("sha256").update(b, "utf8").digest()
	return timingSafeEqual(aDigest, bDigest) && a.length === b.length
}
