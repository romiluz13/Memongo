import { createHash } from "node:crypto"
import type { MemoryScope } from "@memongo/lib"
import { resolveScopeIdentity } from "./mongodb-scope.js"

// ---------------------------------------------------------------------------
// B4: canonical idempotency fingerprint
// ---------------------------------------------------------------------------
//
// Standalone module (not mongodb-events.ts) because eleven manager test
// suites replace ./mongodb-events.js with a fixed-shape vi.mock factory;
// the manager write seam imports this function, and a missing export would
// break every one of those mocks at import time. This module's only runtime
// dependency is the pure scope-identity rule, so it is never mocked.

/** Every immutable persisted input of one logical event write. */
export type IdempotencyFingerprintInput = {
	role: "user" | "assistant" | "system" | "tool"
	body: string
	sessionId?: string
	scope?: MemoryScope
	scopeRef?: string
	timestamp?: Date
	validAt?: Date
	invalidAt?: Date
	metadata?: Record<string, unknown>
	expiresAt?: Date
}

/** Explicit dates canonicalize to their ISO instant; omitted stays null. */
function fingerprintDate(value: Date | undefined): string | null {
	if (!(value instanceof Date)) {
		return null
	}
	return Number.isNaN(value.getTime()) ? "invalid" : value.toISOString()
}

/**
 * Recursively key-sorted JSON normalization. Dates become ISO strings (BSON
 * and request-side Dates compare by instant); undefined/function/symbol
 * values drop (JSON.stringify semantics); bigint stringifies. Omitted
 * metadata is equivalent to {} (the persisted default).
 */
function canonicalizeFingerprintValue(value: unknown): unknown {
	if (value instanceof Date) {
		return Number.isNaN(value.getTime()) ? "invalid" : value.toISOString()
	}
	if (Array.isArray(value)) {
		return value.map(canonicalizeFingerprintValue)
	}
	if (value && typeof value === "object") {
		const sorted: Record<string, unknown> = {}
		for (const key of Object.keys(value).sort()) {
			const entry = canonicalizeFingerprintValue(
				(value as Record<string, unknown>)[key],
			)
			if (entry !== undefined) {
				sorted[key] = entry
			}
		}
		return sorted
	}
	if (typeof value === "bigint") {
		return value.toString()
	}
	if (typeof value === "function" || typeof value === "symbol") {
		return undefined
	}
	return value
}

/**
 * B4: one canonical fingerprint over EVERY immutable persisted input —
 * role, body, session, scope, timestamp, validAt, invalidAt, metadata,
 * expiresAt. The previous five-field compare let a key reuse with a changed
 * timestamp/metadata/expiry replay silently (a lost write the caller
 * believes landed).
 *
 * Canonicalization rules:
 * - scope/scopeRef resolve with the SAME rule the write uses (P2.3), so an
 *   implicit session write and the equivalent explicit one fingerprint equal;
 *   W06: the caller passes the manager's workspaceDir so a workspace-scope
 *   write fingerprints the SAME hashed workspace partition the write lands
 *   in (and a search reads from), not the workspace:<agentId> fallback;
 * - dates compare by ISO instant, and an omitted field is DISTINCT from any
 *   explicit value. In particular, accepting the TTL default (omitted
 *   expiresAt) never collides with a pinned expiry, and a TTL-defaulted
 *   write still replays against its own retry — comparing the resolved
 *   (time-dependent) value would false-conflict;
 * - metadata compares with recursively sorted keys; omitted ≡ {}.
 *
 * Returns the SHA-256 hex of the canonical JSON so the stored field stays
 * fixed-size regardless of body/metadata length. The single and batch write
 * paths share this function; both persist it alongside the idempotency key.
 */
export function computeIdempotencyFingerprint(
	event: IdempotencyFingerprintInput,
	agentId: string,
	defaultScope?: MemoryScope,
	workspaceDir?: string,
): string {
	const { scope, scopeRef } = resolveScopeIdentity({
		scope: event.scope,
		scopeRef: event.scopeRef,
		agentId,
		sessionId: event.sessionId,
		...(defaultScope ? { defaultScope } : {}),
		...(workspaceDir ? { workspaceDir } : {}),
	})
	const canonical = JSON.stringify({
		role: event.role,
		body: event.body,
		sessionId: event.sessionId?.trim() || null,
		scope,
		scopeRef,
		timestamp: fingerprintDate(event.timestamp),
		validAt: fingerprintDate(event.validAt),
		invalidAt: fingerprintDate(event.invalidAt),
		metadata: canonicalizeFingerprintValue(event.metadata ?? {}),
		expiresAt: fingerprintDate(event.expiresAt),
	})
	return createHash("sha256").update(canonical).digest("hex")
}
