/**
 * Prompt-injection and memory-poisoning classifier.
 *
 * Tier-1 (always on, pattern-based): string-level regex matching against a
 * frozen catalogue of injection-shaped content (role-override attempts,
 * prompt-leak requests, bracketed-role injections). Fast, deterministic, runs
 * synchronously at consolidation write time.
 *
 * Tier-2 (LLM classifier, opt-in): invoked only when a strict mode switch is
 * enabled. Off by default. Future work hooks an LLM call behind the `tier`
 * field; today we return `"pattern"` always.
 *
 * The consolidator pre-write hook routes `"injection-likely"` candidates to
 * the `memory_quarantine` collection with `status: "pending-review"`. Content
 * classified `"safe"` continues to the canonical consolidation pipeline.
 *
 * MongoDB MCP citation: schema design for quarantine collections
 * https://www.mongodb.com/docs/manual/core/schema-validation/
 */

export type InjectionClassification = "safe" | "injection-likely"

export type InjectionPatternEntry = {
	readonly id: string
	readonly pattern: RegExp
	readonly severity: "low" | "medium" | "high"
	readonly description: string
}

/**
 * Frozen catalogue of tier-1 injection patterns. Each entry is matched
 * independently; multiple matches are preserved in the verdict's
 * `matchedPatterns` array for observability. Adding a pattern requires a
 * code review + a regression test; removal of a pattern is a decision-RFC
 * event (never silent).
 */
export const INJECTION_PATTERNS: readonly InjectionPatternEntry[] =
	Object.freeze([
		{
			id: "ignore-previous-instructions",
			pattern:
				/\b(ignore|disregard)\b[^.]{0,40}\b(previous|prior|above|earlier|all)\b[^.]{0,40}\b(instruction|message|prompt|rule|request)s?\b/i,
			severity: "high",
			description:
				"Classic 'ignore previous instructions' style override (Anthropic-flagged).",
		},
		{
			id: "system-prompt-declaration",
			pattern: /\bsystem\s*prompt\s*:/i,
			severity: "high",
			description:
				"Explicit 'system prompt:' leader trying to impersonate system role.",
		},
		{
			id: "bracketed-system-role",
			pattern: /\[\s*\/?\s*(system|assistant|user)\s*\]/i,
			severity: "medium",
			description:
				"Bracketed role-injection tokens (e.g., [SYSTEM]...[/SYSTEM]).",
		},
		{
			id: "angle-system-role",
			pattern: /<\|\s*\/?\s*(system|assistant|user|end)\s*\|>/i,
			severity: "medium",
			description: "Angle-pipe role tokens (e.g., <|system|>, <|end|>).",
		},
		{
			id: "reveal-prompt-request",
			pattern:
				/\b(show|reveal|print|output|display|expose|leak)\b[^.]{0,30}\b(instructions?|prompt|system\s+prompt|rules?|hidden\s+prompt)\b/i,
			severity: "high",
			description: "Direct prompt-leak request.",
		},
		{
			id: "verbatim-instructions-request",
			pattern: /\b(your|the)\s+instructions?\b[^.]{0,30}\bverbatim\b/i,
			severity: "medium",
			description: "Verbatim-instruction exfiltration attempt.",
		},
		{
			id: "act-as-override",
			pattern:
				/\b(act|behave|respond)\s+as\b[^.]{0,40}\b(unfiltered|admin|developer|jailbroken|root|sudo|god)\b/i,
			severity: "high",
			description: "Role-override 'act as unfiltered/admin/etc.' patterns.",
		},
		{
			id: "disregard-above-override",
			pattern: /\bdisregard\s+the\s+above\b/i,
			severity: "high",
			description: "Short-form 'disregard the above' override.",
		},
	])

export type InjectionVerdict = {
	classification: InjectionClassification
	tier: "pattern" | "llm"
	matchedPatterns: string[]
	rawLength: number
}

/**
 * Classify a candidate memory's content for prompt-injection shape.
 *
 * Tier-1 (always on): evaluate every frozen regex in `INJECTION_PATTERNS`.
 * If any pattern matches, classification is `"injection-likely"` and every
 * matched pattern `id` is recorded in `matchedPatterns`.
 *
 * Tier-2 (future, currently stubbed): an LLM classifier gated by a
 * strict-mode switch. This module deliberately does NOT call an LLM today;
 * the `tier` field on the verdict always reads `"pattern"`. When the LLM
 * route is wired, the consolidator pre-write hook passes `{ llm: true }` and
 * this function returns `{ tier: "llm", ... }`.
 *
 * Empty / whitespace-only content is always `"safe"` — pattern matching
 * requires a body.
 */
export function classifyInjection(params: {
	content: string
	// Placeholder for tier-2. Off by default; wiring lands in a follow-on.
	llm?: boolean
}): InjectionVerdict {
	const content = params.content ?? ""
	const trimmed = content.trim()
	if (trimmed.length === 0) {
		return {
			classification: "safe",
			tier: "pattern",
			matchedPatterns: [],
			rawLength: 0,
		}
	}

	const matchedPatterns: string[] = []
	for (const entry of INJECTION_PATTERNS) {
		if (entry.pattern.test(content)) {
			matchedPatterns.push(entry.id)
		}
	}
	return {
		classification: matchedPatterns.length > 0 ? "injection-likely" : "safe",
		tier: "pattern",
		matchedPatterns,
		rawLength: content.length,
	}
}
