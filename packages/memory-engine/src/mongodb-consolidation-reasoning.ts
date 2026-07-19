import { createHash } from "node:crypto"
import { type MemoryScope, createSubsystemLogger } from "@memongo/lib"
import type { EnrichmentProvider } from "./mongodb-llm-enrichment.js"
import type { StructuredMemoryEntry } from "./mongodb-structured-memory.js"

/**
 * LLM reasoning over consolidated memory (issue #31).
 *
 * The consolidator's Deduction and Induction phases were stubs
 * ("no LLM configured, skipping"). These functions turn a set of existing
 * durable fact values into NEW candidate facts:
 *   - deduction: facts that must logically follow from the given facts
 *   - induction: probable generalizations across the given facts
 *
 * Both return raw candidates only; the caller is responsible for scope tagging,
 * dedup, and promotion policy. Every path degrades to an empty result rather
 * than throwing, so a missing/misbehaving LLM never breaks a consolidation run.
 */

const log = createSubsystemLogger("memory:mongodb:consolidation-reasoning")

// A single reasoned fact derived from existing memories.
export type ReasonedFact = {
	value: string
	rationale: string
	sourceValues: string[]
	kind: "deduction" | "induction"
}

// Deduction/induction need at least two facts to relate; a single fact has
// nothing to combine against.
const MIN_FACTS = 2
const MAX_FACTS = 40
// Strict entailment/generalization is heavy reasoning: a reasoning model (e.g.
// DeepSeek) can spend ~5k tokens of chain-of-thought BEFORE emitting the JSON,
// and that budget is consumed first. A small cap truncates mid-reasoning, so the
// response never becomes parseable and every run silently returns []. Budget
// generously — a non-reasoning model stops early and wastes nothing. (measured
// live: 2-fact deduction used ~5k completion tokens end to end.)
const MAX_TOKENS = 8000

const DEDUCTION_SYSTEM_PROMPT = `You are a careful reasoning engine for a long-term memory system.
Given a list of known facts about a user or project, derive ONLY facts that MUST be logically true given the inputs — strict entailment, no speculation.
Rules:
- Do not restate an input fact; only output genuinely new entailed facts.
- If nothing new is strictly entailed, return an empty array.
- Each derived fact must cite the input facts it follows from.
Return JSON: {"facts":[{"value":"<new fact>","rationale":"<why it strictly follows>","from":["<input fact>", ...]}]}`

const INDUCTION_SYSTEM_PROMPT = `You are a careful reasoning engine for a long-term memory system.
Given a list of known facts about a user or project, induce probable GENERALIZATIONS that summarize a pattern across multiple facts.
Rules:
- Only generalize when at least two facts support the pattern.
- Do not restate an input fact; only output new generalizations.
- If no pattern is supported, return an empty array.
- Each generalization must cite the input facts it is based on.
Return JSON: {"facts":[{"value":"<generalization>","rationale":"<supporting pattern>","from":["<input fact>", ...]}]}`

function parseReasonedFacts(
	content: string,
	kind: ReasonedFact["kind"],
): ReasonedFact[] {
	let parsed: unknown
	try {
		// Strip markdown code fences some LLMs wrap around JSON.
		const stripped = content
			.replace(/^```(?:json)?\s*\n?/i, "")
			.replace(/\n?```\s*$/i, "")
		parsed = JSON.parse(stripped)
	} catch {
		log.warn("consolidation reasoning JSON parse failed", {
			kind,
			preview: content.slice(0, 200),
		})
		return []
	}

	if (!parsed || typeof parsed !== "object") return []
	const rawFacts = (parsed as Record<string, unknown>).facts
	if (!Array.isArray(rawFacts)) return []

	const result: ReasonedFact[] = []
	for (const entry of rawFacts) {
		if (!entry || typeof entry !== "object") continue
		const record = entry as Record<string, unknown>
		const value = typeof record.value === "string" ? record.value.trim() : ""
		if (!value) continue
		const rationale =
			typeof record.rationale === "string" ? record.rationale.trim() : ""
		const sourceValues = Array.isArray(record.from)
			? record.from.filter((f): f is string => typeof f === "string")
			: []
		result.push({ value, rationale, sourceValues, kind })
	}
	return result
}

async function reasonOverMemories(params: {
	provider: EnrichmentProvider
	model: string
	facts: string[]
	kind: ReasonedFact["kind"]
	systemPrompt: string
}): Promise<ReasonedFact[]> {
	const facts = params.facts
		.map((f) => f.trim())
		.filter(Boolean)
		.slice(0, MAX_FACTS)
	if (facts.length < MIN_FACTS) {
		return []
	}

	let content: string
	try {
		const response = await params.provider.chatCompletion({
			model: params.model,
			messages: [
				{ role: "system", content: params.systemPrompt },
				{
					role: "user",
					content: `Known facts:\n${facts.map((f) => `- ${f}`).join("\n")}`,
				},
			],
			responseFormat: { type: "json_object" },
			maxTokens: MAX_TOKENS,
		})
		content = response.content
	} catch (err) {
		log.warn("consolidation reasoning LLM call failed", {
			kind: params.kind,
			error: err instanceof Error ? err.message : String(err),
		})
		return []
	}

	return parseReasonedFacts(content, params.kind)
}

export async function deduceFactsFromMemories(params: {
	provider: EnrichmentProvider
	model: string
	facts: string[]
}): Promise<ReasonedFact[]> {
	return reasonOverMemories({
		...params,
		kind: "deduction",
		systemPrompt: DEDUCTION_SYSTEM_PROMPT,
	})
}

export async function induceFactsFromMemories(params: {
	provider: EnrichmentProvider
	model: string
	facts: string[]
}): Promise<ReasonedFact[]> {
	return reasonOverMemories({
		...params,
		kind: "induction",
		systemPrompt: INDUCTION_SYSTEM_PROMPT,
	})
}

// Inferred facts are never as trustworthy as observed ones; start below the
// observed-fact confidence floor so retrieval/scoring can down-weight them.
const INFERRED_CONFIDENCE = 0.5

function shortHash(input: string): string {
	return createHash("sha1").update(input).digest("hex").slice(0, 12)
}

/**
 * Turn a reasoned fact into a structured-memory entry flagged as an
 * unreinforced LLM inference (issue #31). The entry is retrievable but clearly
 * distinguishable from observed facts: origin "llm-inference", low confidence,
 * reinforcementCount 0, and an "inferred" tag. Corroboration by future observed
 * evidence raises its standing through the normal reinforcement path.
 */
export function buildInferredMemoryEntry(params: {
	reasoned: ReasonedFact
	agentId: string
	scope?: MemoryScope
	scopeRef?: string
	runId?: string
}): StructuredMemoryEntry {
	const { reasoned, agentId, scope, scopeRef, runId } = params
	return {
		type: "fact",
		key: `fact-${shortHash(reasoned.value.toLowerCase())}`,
		value: reasoned.value,
		agentId,
		source: "agent",
		confidence: INFERRED_CONFIDENCE,
		reinforcementCount: 0,
		state: "active",
		tags: ["inferred", reasoned.kind],
		provenance: {
			origin: "llm-inference",
			kind: reasoned.kind,
			rationale: reasoned.rationale,
			derivedFrom: reasoned.sourceValues,
			...(runId ? { runId } : {}),
		},
		sourceAgent: { id: agentId, name: "dreamer", ...(runId ? { runId } : {}) },
		...(scope ? { scope } : {}),
		...(scopeRef ? { scopeRef } : {}),
	}
}
