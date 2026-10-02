import type { MemoryResultDerivation, MemoryResultRole } from "./types.js"

/**
 * RET-09: provenance derivation helpers.
 *
 * Search mappers historically dropped authorship entirely, which forced
 * downstream consumers (context bundle evidence labels, exact-evidence
 * gating) to guess from irrelevant signals like "confidence is absent" or
 * "a locator exists". These helpers resolve a derivation from the signals
 * each lane actually preserves:
 *
 *   - conversation chunks: the turn `role` (new chunks carry it as a field;
 *     legacy chunks encode it as a `Role:` text prefix written by
 *     renderEventChunkText)
 *   - evidence chunks: the polymorphic `source` discriminator
 *     (session-evidence = verbatim user turns, userfact-evidence =
 *     normalized facts extracted from user turns)
 *   - transcript-file chunks (`source: "sessions"`): full mixed-role
 *     transcripts — no single author, so "derived"
 *   - KB chunks (`source: "kb"|"memory"`): verbatim spans of ingested
 *     external documents — "reference"
 *
 * Unknown/legacy rows resolve to "derived" (conservative default): absent
 * provenance must never read as user-authored (the exact defect RET-09
 * filed against isExplicitEvidence's absent-confidence⇒explicit arm).
 */

const ROLE_PREFIXES: Array<{ prefix: string; role: MemoryResultRole }> = [
	{ prefix: "User: ", role: "user" },
	{ prefix: "Assistant: ", role: "assistant" },
	{ prefix: "System: ", role: "system" },
	{ prefix: "Tool: ", role: "tool" },
]

const KNOWN_ROLES = new Set<MemoryResultRole>([
	"user",
	"assistant",
	"system",
	"tool",
])

export function parseResultRole(value: unknown): MemoryResultRole | undefined {
	return typeof value === "string" && KNOWN_ROLES.has(value as MemoryResultRole)
		? (value as MemoryResultRole)
		: undefined
}

/**
 * Legacy recovery path: renderEventChunkText prefixes every conversation
 * chunk with `Role: ` (mongodb-events.ts), so the author is recoverable
 * from the text even for chunks written before the `role` field existed.
 */
export function recoverRoleFromTextPrefix(
	text: unknown,
): MemoryResultRole | undefined {
	if (typeof text !== "string") return undefined
	for (const { prefix, role } of ROLE_PREFIXES) {
		if (text.startsWith(prefix)) return role
	}
	return undefined
}

export function derivationFromRole(
	role: MemoryResultRole,
): MemoryResultDerivation {
	return role === "user" ? "user" : "agent"
}

export function isUserDerivation(
	derivation: MemoryResultDerivation | undefined,
): boolean {
	return derivation === "user" || derivation === "user-extracted"
}

/**
 * Can a hit on this span be quoted as an exact support line? Only spans
 * that are verbatim by construction qualify: user-authored turns,
 * user-extracted facts (normalized but traceable to user statements), and
 * reference document spans. Agent text is a paraphrase/summary by
 * construction and must never be presented as an exact quote.
 */
export function isExactCapableDerivation(
	derivation: MemoryResultDerivation | undefined,
): boolean {
	return (
		derivation === "user" ||
		derivation === "user-extracted" ||
		derivation === "reference"
	)
}

/**
 * Resolve provenance for a chunk-shaped document (any lane whose documents
 * carry `source` / `text`, optionally `role`). Role beats source when both
 * exist (the role field is authoritative for conversation chunks); the
 * text prefix is the fallback for legacy conversation chunks written
 * before the role field existed.
 */
export function resolveChunkProvenance(doc: {
	source?: unknown
	role?: unknown
	text?: unknown
}): {
	role: MemoryResultRole | undefined
	derivation: MemoryResultDerivation
} {
	const source =
		typeof doc.source === "string" ? (doc.source as string).trim() : ""

	// 1. Authoritative role field (new conversation chunks, raw events).
	const role = parseResultRole(doc.role)
	if (role) {
		return { role, derivation: derivationFromRole(role) }
	}

	// 2. Polymorphic source discriminators (evidence + transcript + KB docs).
	if (source === "session-evidence") {
		// Verbatim concatenation of a session's user turns.
		return { role: undefined, derivation: "user" }
	}
	if (source === "userfact-evidence" || source === "preference-evidence") {
		// Normalized facts extracted FROM user turns — user-attributed but
		// not verbatim.
		return { role: undefined, derivation: "user-extracted" }
	}
	if (source === "qa-evidence") {
		// Q/A pairs distilled from conversations — agent-shaped summary.
		return { role: undefined, derivation: "derived" }
	}
	if (source === "sessions") {
		// Full transcript files (mixed user/assistant/tool records).
		return { role: undefined, derivation: "derived" }
	}
	if (source === "kb" || source === "memory") {
		return { role: undefined, derivation: "reference" }
	}

	// 3. Legacy conversation chunks: recover the role from the text prefix
	//    renderEventChunkText writes.
	const recovered = recoverRoleFromTextPrefix(doc.text)
	if (recovered) {
		return { role: recovered, derivation: derivationFromRole(recovered) }
	}

	// 4. Unknown/legacy rows with no preserved authorship.
	return { role: undefined, derivation: "derived" }
}
