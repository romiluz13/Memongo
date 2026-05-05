import { createSubsystemLogger } from "@memongo/lib"

const log = createSubsystemLogger("memory:mongodb:entity-extractor")

// ---------------------------------------------------------------------------
// Stop words (canonical source — mongodb-graph.ts re-exports this set)
// ---------------------------------------------------------------------------

export const STOP_WORDS = new Set([
	"the",
	"a",
	"an",
	"is",
	"are",
	"was",
	"were",
	"be",
	"been",
	"being",
	"have",
	"has",
	"had",
	"do",
	"does",
	"did",
	"will",
	"would",
	"could",
	"should",
	"may",
	"might",
	"can",
	"shall",
	"must",
	"need",
	"not",
	"and",
	"or",
	"but",
	"if",
	"then",
	"else",
	"when",
	"where",
	"how",
	"what",
	"which",
	"who",
	"whom",
	"this",
	"that",
	"these",
	"those",
	"it",
	"its",
	"i",
	"me",
	"my",
	"we",
	"our",
	"you",
	"your",
	"he",
	"she",
	"him",
	"her",
	"they",
	"them",
	"their",
])

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ExtractedEntity = {
	name: string
	type: string // string (not EntityType) to allow LLM-extracted extended types
	confidence?: number
	extractionMethod: "regex" | "llm"
}

export type EntityExtractionContext = {
	agentId: string
	scope: string
	scopeRef: string
	existingEntityNames?: string[]
	role?: string
}

export interface EntityExtractor {
	extract(
		content: string,
		context?: EntityExtractionContext,
	): Promise<ExtractedEntity[]>
}

// ---------------------------------------------------------------------------
// Ambiguous person names — common English words that are also first names
// ---------------------------------------------------------------------------

export const AMBIGUOUS_PERSON_NAMES = new Set([
	"grace",
	"will",
	"may",
	"mark",
	"bill",
	"frank",
	"grant",
	"joy",
	"hope",
	"faith",
	"hunter",
	"mason",
	"chase",
	"wade",
	"reed",
	"sage",
	"penny",
	"ruby",
	"violet",
	"iris",
	"dawn",
	"summer",
	"august",
	"miles",
	"pierce",
	"sterling",
	"chance",
])

/**
 * Check if a name is in the ambiguous person names set (case-insensitive).
 */
export function isAmbiguousPersonName(name: string): boolean {
	return AMBIGUOUS_PERSON_NAMES.has(name.toLowerCase())
}

// ---------------------------------------------------------------------------
// Regex patterns (canonical copies from mongodb-graph.ts lines 867-871)
// ---------------------------------------------------------------------------

const MENTION_REGEX = /@(\w{3,})/g
const TAG_REGEX = /#(\w{3,})/g
const URL_REGEX = /https?:\/\/[^\s)]+/g
const FILE_PATH_REGEX = /(?:^|\s)((?:[\w.-]+\/)+[\w.-]+\.\w+)/g
const QUOTED_NAME_REGEX = /"([^"]{3,})"/g
const DATE_REGEX =
	/\b(\d{4}-\d{2}-\d{2}|\w+ \d{1,2},? \d{4}|\d{1,2}\/\d{1,2}\/\d{4})\b/g

// ---------------------------------------------------------------------------
// RegexEntityExtractor
// ---------------------------------------------------------------------------

export class RegexEntityExtractor implements EntityExtractor {
	async extract(content: string): Promise<ExtractedEntity[]> {
		const entities: ExtractedEntity[] = []
		const seen = new Set<string>()

		const addEntity = (name: string, type: string): void => {
			// Apply stop-word filter for non-URL/non-path entities (matches original behavior)
			if (type !== "document" && STOP_WORDS.has(name.toLowerCase())) {
				return
			}
			const key = `${name.toLowerCase()}:${type}`
			if (!seen.has(key)) {
				seen.add(key)
				entities.push({
					name,
					type,
					confidence: 0.5,
					extractionMethod: "regex",
				})
			}
		}

		// 1. @mentions -> person
		for (const match of content.matchAll(MENTION_REGEX)) {
			addEntity(match[1], "person")
		}

		// 2. #tags -> topic
		for (const match of content.matchAll(TAG_REGEX)) {
			addEntity(match[1], "topic")
		}

		// 3. URLs -> document
		for (const match of content.matchAll(URL_REGEX)) {
			addEntity(match[0], "document")
		}

		// 4. File paths -> document
		for (const match of content.matchAll(FILE_PATH_REGEX)) {
			addEntity(match[1], "document")
		}

		// 5. "Quoted names" -> person (min 3 chars, stop-word filtered)
		// 2-signal gate: ambiguous names from quotes alone → downgrade to concept
		for (const match of content.matchAll(QUOTED_NAME_REGEX)) {
			const name = match[1]
			if (
				name &&
				name.trim().length >= 3 &&
				!STOP_WORDS.has(name.toLowerCase().trim())
			) {
				const trimmed = name.trim()
				const isAmbiguous = isAmbiguousPersonName(trimmed)
				const type = isAmbiguous ? "concept" : "person"
				const key = `${trimmed.toLowerCase()}:${type}`
				if (!seen.has(key)) {
					seen.add(key)
					entities.push({
						name: trimmed,
						type,
						confidence: isAmbiguous ? 0.3 : 0.5,
						extractionMethod: "regex",
					})
				}
			}
		}

		// 6. Dates -> concept (Phase 7: temporal grounding)
		for (const match of content.matchAll(DATE_REGEX)) {
			const dateName = match[1].trim()
			if (dateName.length >= 5) {
				const key = `${dateName.toLowerCase()}:concept`
				if (!seen.has(key)) {
					seen.add(key)
					entities.push({
						name: dateName,
						type: "concept",
						confidence: 0.7,
						extractionMethod: "regex",
					})
				}
			}
		}

		return entities
	}
}

// ---------------------------------------------------------------------------
// LLM Entity Extractor
// ---------------------------------------------------------------------------

export type LLMFunction = (prompt: string) => Promise<string>

export class LLMEntityExtractor implements EntityExtractor {
	private llmFn: LLMFunction
	private timeoutMs: number
	private fallback: RegexEntityExtractor

	constructor(llmFn: LLMFunction, timeoutMs = 5000) {
		this.llmFn = llmFn
		this.timeoutMs = timeoutMs
		this.fallback = new RegexEntityExtractor()
	}

	async extract(
		content: string,
		context?: EntityExtractionContext,
	): Promise<ExtractedEntity[]> {
		let timer: ReturnType<typeof setTimeout> | undefined
		try {
			const result = await Promise.race([
				this.extractWithLLM(content, context),
				new Promise<never>((_, reject) => {
					timer = setTimeout(
						() => reject(new Error("LLM extraction timeout")),
						this.timeoutMs,
					)
				}),
			])
			return result
		} catch (err) {
			log.warn("LLM entity extraction failed, falling back to regex", {
				error: err,
			})
			return this.fallback.extract(content)
		} finally {
			if (timer !== undefined) {
				clearTimeout(timer)
			}
		}
	}

	private async extractWithLLM(
		content: string,
		context?: EntityExtractionContext,
	): Promise<ExtractedEntity[]> {
		const role = context?.role
		const prompt =
			role === "assistant"
				? buildAssistantExtractionPrompt(content, context)
				: role === "user"
					? buildUserExtractionPrompt(content, context)
					: context?.role !== undefined
						? buildUserExtractionPrompt(content, context) // unknown roles default to user
						: buildExtractionPrompt(content, context)
		const response = await this.llmFn(prompt)
		return parseExtractionResponse(response)
	}
}

// ---------------------------------------------------------------------------
// Prompt building and response parsing (exported for testing)
// ---------------------------------------------------------------------------

export function buildExtractionPrompt(
	content: string,
	context?: EntityExtractionContext,
): string {
	const existingHint = context?.existingEntityNames?.length
		? `\nKnown entities in this context: ${context.existingEntityNames.join(", ")}`
		: ""

	return `Extract named entities from the following text. Return a JSON array of objects with "name", "type", and "confidence" fields.

Valid types: person, org, project, topic, feature, issue, document, location, system, concept

Rules:
- Only extract entities explicitly mentioned in the text
- Do not invent entities that are not present
- When extracting facts, ALWAYS include dates/times if mentioned in the text
  Example: "met with Alice on May 7, 2023" should extract "Alice" AND "May 7, 2023" as entities
- Extract dates as type "concept" with name as the date string
- Confidence should be 0.0-1.0 based on how certain you are
- Normalize names (capitalize properly, no leading/trailing whitespace)
${existingHint}

Text:
${content}

Response (JSON array only):`
}

// ---------------------------------------------------------------------------
// Role-based extraction prompts (Phase 8)
// ---------------------------------------------------------------------------

export function buildUserExtractionPrompt(
	content: string,
	context?: EntityExtractionContext,
): string {
	const existingHint = context?.existingEntityNames?.length
		? `\nKnown entities in this context: ${context.existingEntityNames.join(", ")}`
		: ""

	return `Extract entities from the following USER message. Focus on:
- People the user mentions (type: person)
- User preferences and interests (type: concept)
- Projects or tools the user references (type: project)
- Locations (type: location)
- Organizations (type: org)
- When extracting facts, ALWAYS include dates/times if mentioned in the text

Return a JSON array of objects with "name", "type", and "confidence" fields.

Valid types: person, org, project, topic, feature, issue, document, location, system, concept

Rules:
- Only extract entities explicitly mentioned in the text
- Do not invent entities that are not present
- Confidence should be 0.0-1.0 based on how certain you are
- Normalize names (capitalize properly, no leading/trailing whitespace)
${existingHint}

Text:
${content}

Response (JSON array only):`
}

export function buildAssistantExtractionPrompt(
	content: string,
	context?: EntityExtractionContext,
): string {
	const existingHint = context?.existingEntityNames?.length
		? `\nKnown entities in this context: ${context.existingEntityNames.join(", ")}`
		: ""

	return `Extract entities from the following ASSISTANT response. Focus on:
- Tools or capabilities mentioned (type: system)
- Technical concepts discussed (type: concept)
- Projects being worked on (type: project)
- People referenced (type: person)
- When extracting facts, ALWAYS include dates/times if mentioned in the text

Return a JSON array of objects with "name", "type", and "confidence" fields.

Valid types: person, org, project, topic, feature, issue, document, location, system, concept

Rules:
- Only extract entities explicitly mentioned in the text
- Do not invent entities that are not present
- Confidence should be 0.0-1.0 based on how certain you are
- Normalize names (capitalize properly, no leading/trailing whitespace)
${existingHint}

Text:
${content}

Response (JSON array only):`
}

export function parseExtractionResponse(response: string): ExtractedEntity[] {
	try {
		// Find JSON array in response (may be wrapped in markdown code block)
		const jsonMatch = response.match(/\[[\s\S]*\]/)
		if (!jsonMatch) {
			return []
		}

		const parsed = JSON.parse(jsonMatch[0]) as Array<{
			name?: string
			type?: string
			confidence?: number
		}>

		if (!Array.isArray(parsed)) {
			return []
		}

		return parsed
			.filter(
				(
					e,
				): e is typeof e & {
					name: string
				} => typeof e.name === "string" && e.name.trim().length >= 2,
			)
			.map((e) => ({
				name: e.name.trim(),
				type: e.type ?? "custom",
				confidence:
					typeof e.confidence === "number"
						? Math.min(1, Math.max(0, e.confidence))
						: 0.7,
				extractionMethod: "llm" as const,
			}))
	} catch {
		log.warn("failed to parse LLM extraction response")
		return []
	}
}
