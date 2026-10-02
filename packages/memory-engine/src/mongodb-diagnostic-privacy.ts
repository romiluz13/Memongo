import { createHash } from "node:crypto"

/**
 * RET-21: the single diagnostic query-privacy policy shared by relevance
 * run persistence and recall-trace persistence. Both are DIAGNOSTIC
 * stores — distinct from user-requested durable memory — so one transform
 * here means one policy, applied identically everywhere a query is about
 * to be written for observability.
 */
export type DiagnosticQueryPrivacyMode = "redacted-hash" | "raw" | "none"

export type DiagnosticQueryPrivacy = {
	/** sha256 over the normalized query; present in raw and redacted-hash modes. */
	queryHash?: string
	/** Raw text in "raw" mode; shape-preserving redacted text in "redacted-hash" mode. */
	queryRedacted?: string
}

function normalizeDiagnosticQuery(query: string): string {
	return query.trim().replace(/\s+/g, " ").toLowerCase()
}

export function hashDiagnosticQuery(query: string): string {
	return createHash("sha256")
		.update(normalizeDiagnosticQuery(query))
		.digest("hex")
}

/**
 * Keep shape and spacing while redacting every letter and digit. `\p{L}`
 * and `\p{N}` cover ALL scripts (Hebrew, Arabic, CJK, Devanagari, ...);
 * the previous ASCII-only `[A-Za-z0-9]` class left non-Latin text fully
 * readable in redacted-hash mode — the RET-21 leak.
 */
export function redactDiagnosticQuery(query: string): string {
	return query.replace(/[\p{L}\p{N}]/gu, "x")
}

/**
 * Apply the configured privacy mode to a diagnostic query. Semantics match
 * the relevance-run contract exactly:
 * - "none": no query fields at all (neither hash nor text);
 * - "redacted-hash": sha256 hash + shape-preserving redacted text;
 * - "raw": sha256 hash + the verbatim query.
 */
export function applyDiagnosticQueryPrivacy(
	query: string,
	mode: DiagnosticQueryPrivacyMode,
): DiagnosticQueryPrivacy {
	if (mode === "none") {
		return {}
	}
	const queryHash = hashDiagnosticQuery(query)
	if (mode === "raw") {
		return { queryHash, queryRedacted: query }
	}
	return { queryHash, queryRedacted: redactDiagnosticQuery(query) }
}
