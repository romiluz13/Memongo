import { createSubsystemLogger } from "@memongo/lib"
import type { EpisodeSummarizer } from "./mongodb-episodes.js"

const log = createSubsystemLogger("memory:mongodb:tiered-summary")

/**
 * Build a prompt instructing the LLM to generate 3-tier summaries + topics.
 */
export function buildTieredSummaryPrompt(
	events: Array<{ role: string; body: string; timestamp: Date }>,
): string {
	const eventText = events
		.map((e) => {
			const roleLabel = e.role.charAt(0).toUpperCase() + e.role.slice(1)
			return `[${e.timestamp.toISOString()}] ${roleLabel}: ${e.body}`
		})
		.join("\n")

	return `Analyze the following conversation and produce three levels of summary plus topic tags.

Return a JSON object with these fields:
- "short_term": 1-2 sentences capturing the immediate context and latest action items
- "medium_term": 1 paragraph summarizing the session-level context, key decisions, and outcomes
- "long_term": 2-3 sentences extracting archival knowledge, lasting facts, and reusable insights
- "topics": array of 3-8 topic tags (lowercase, no spaces) for filtering

Rules:
- Each tier should be independently useful
- short_term focuses on "what just happened"
- medium_term focuses on "what this session accomplished"
- long_term focuses on "what should be remembered forever"
- Topics should be specific enough to filter but general enough to group related content

Conversation:
${eventText}

Respond with ONLY the JSON object, no markdown formatting.`
}

/**
 * Parse the LLM response into structured tiered summary fields.
 * Returns null if the response is malformed or missing required fields.
 */
export function parseTieredSummaryResponse(response: string): {
	shortTermSummary: string
	mediumTermSummary: string
	longTermSummary: string
	topics: string[]
} | null {
	try {
		// Strip markdown code block if present
		let jsonStr = response.trim()
		const codeBlockMatch = jsonStr.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/)
		if (codeBlockMatch) {
			jsonStr = codeBlockMatch[1].trim()
		}

		const parsed = JSON.parse(jsonStr)

		const shortTerm = parsed.short_term ?? parsed.shortTermSummary
		const mediumTerm = parsed.medium_term ?? parsed.mediumTermSummary
		const longTerm = parsed.long_term ?? parsed.longTermSummary

		if (
			typeof shortTerm !== "string" ||
			typeof mediumTerm !== "string" ||
			typeof longTerm !== "string"
		) {
			return null
		}

		if (!shortTerm.trim() || !mediumTerm.trim() || !longTerm.trim()) {
			return null
		}

		const topics = Array.isArray(parsed.topics)
			? parsed.topics.filter(
					(t: unknown): t is string =>
						typeof t === "string" && t.trim().length > 0,
				)
			: []

		return {
			shortTermSummary: shortTerm,
			mediumTermSummary: mediumTerm,
			longTermSummary: longTerm,
			topics,
		}
	} catch {
		return null
	}
}

/**
 * Wrap a base EpisodeSummarizer with tiered summary generation.
 * If llmFn is provided, calls it to generate tiered summaries after the base summarizer.
 * If llmFn fails or is absent, returns base summary only (backward compatible).
 */
export function withTieredSummaries(
	baseSummarizer: EpisodeSummarizer,
	llmFn?: (prompt: string) => Promise<string>,
): EpisodeSummarizer {
	return async (events) => {
		const base = await baseSummarizer(events)

		if (!llmFn) {
			return base
		}

		try {
			const prompt = buildTieredSummaryPrompt(events)
			const response = await llmFn(prompt)
			const tiered = parseTieredSummaryResponse(response)

			if (!tiered) {
				log.warn(
					"tiered summary LLM response could not be parsed, using base summary only",
				)
				return base
			}

			return {
				...base,
				shortTermSummary: tiered.shortTermSummary,
				mediumTermSummary: tiered.mediumTermSummary,
				longTermSummary: tiered.longTermSummary,
				topics: tiered.topics,
			}
		} catch (err) {
			log.warn("tiered summary generation failed, using base summary only", {
				error: err,
			})
			return base
		}
	}
}
