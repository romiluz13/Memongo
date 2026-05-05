import { describe, it, expect, vi, beforeEach } from "vitest"
// The module under test - will not exist yet (RED phase)
import {
	RegexEntityExtractor,
	LLMEntityExtractor,
	buildExtractionPrompt,
	buildUserExtractionPrompt,
	buildAssistantExtractionPrompt,
	parseExtractionResponse,
	AMBIGUOUS_PERSON_NAMES,
	isAmbiguousPersonName,
	type EntityExtractionContext,
} from "./mongodb-entity-extractor.js"

describe("mongodb-entity-extractor", () => {
	describe("RegexEntityExtractor", () => {
		let extractor: RegexEntityExtractor

		beforeEach(() => {
			extractor = new RegexEntityExtractor()
		})

		it("extracts @mentions as person entities", async () => {
			const result = await extractor.extract(
				"Talked to @alice about the project",
			)
			expect(result).toContainEqual(
				expect.objectContaining({
					name: "alice",
					type: "person",
					extractionMethod: "regex",
				}),
			)
		})

		it("extracts #tags as topic entities", async () => {
			const result = await extractor.extract(
				"Working on #frontend #refactor today",
			)
			const topics = result.filter((e) => e.type === "topic")
			expect(topics).toHaveLength(2)
			expect(topics[0].extractionMethod).toBe("regex")
		})

		it("extracts URLs as document entities", async () => {
			const result = await extractor.extract(
				"See https://example.com/docs for details",
			)
			expect(result).toContainEqual(
				expect.objectContaining({
					name: "https://example.com/docs",
					type: "document",
					extractionMethod: "regex",
				}),
			)
		})

		it("extracts file paths as document entities", async () => {
			const result = await extractor.extract(
				"Modified src/memory/mongodb-graph.ts",
			)
			expect(result).toContainEqual(
				expect.objectContaining({
					name: "src/memory/mongodb-graph.ts",
					type: "document",
					extractionMethod: "regex",
				}),
			)
		})

		it("extracts quoted names as person entities", async () => {
			const result = await extractor.extract(
				'Meeting with "John Smith" about the design',
			)
			expect(result).toContainEqual(
				expect.objectContaining({
					name: "John Smith",
					type: "person",
					extractionMethod: "regex",
				}),
			)
		})

		it("deduplicates entities by name+type", async () => {
			const result = await extractor.extract("@alice talked to @alice again")
			const aliceEntities = result.filter(
				(e) => e.name === "alice" && e.type === "person",
			)
			expect(aliceEntities).toHaveLength(1)
		})

		it("returns empty array for content with no matches", async () => {
			const result = await extractor.extract(
				"Just a plain message with nothing",
			)
			expect(result).toHaveLength(0)
		})

		it("sets extractionMethod to regex and confidence to 0.5", async () => {
			const result = await extractor.extract("Check @alice")
			expect(result[0].extractionMethod).toBe("regex")
			expect(result[0].confidence).toBe(0.5)
		})

		it("filters stop words for non-document entities", async () => {
			// "the" is a stop word, should be filtered
			const result = await extractor.extract('"the" is a common word')
			const persons = result.filter((e) => e.type === "person")
			expect(persons).toHaveLength(0)
		})

		it("does not filter stop words for URL entities", async () => {
			const result = await extractor.extract("https://the.example.com/page")
			const docs = result.filter((e) => e.type === "document")
			expect(docs).toHaveLength(1)
		})
	})

	describe("LLMEntityExtractor", () => {
		it("calls LLM function with extraction prompt and parses response", async () => {
			const llmFn = vi.fn().mockResolvedValue(
				JSON.stringify([
					{ name: "MongoDB", type: "system", confidence: 0.9 },
					{ name: "Alice Chen", type: "person", confidence: 0.85 },
				]),
			)
			const extractor = new LLMEntityExtractor(llmFn, 5000)

			const result = await extractor.extract("Alice Chen works with MongoDB")
			expect(llmFn).toHaveBeenCalledOnce()
			expect(result).toHaveLength(2)
			expect(result[0].extractionMethod).toBe("llm")
		})

		it("parses JSON array response correctly", async () => {
			const llmFn = vi
				.fn()
				.mockResolvedValue(
					JSON.stringify([{ name: "GitHub", type: "system", confidence: 0.8 }]),
				)
			const extractor = new LLMEntityExtractor(llmFn, 5000)

			const result = await extractor.extract("Deploy to GitHub")
			expect(result).toContainEqual(
				expect.objectContaining({
					name: "GitHub",
					type: "system",
					confidence: 0.8,
					extractionMethod: "llm",
				}),
			)
		})

		it("falls back to regex on LLM error", async () => {
			const llmFn = vi.fn().mockRejectedValue(new Error("LLM unavailable"))
			const extractor = new LLMEntityExtractor(llmFn, 5000)

			// Content with @mention should be picked up by regex fallback
			const result = await extractor.extract("Talk to @alice about it")
			expect(result).toContainEqual(
				expect.objectContaining({
					name: "alice",
					type: "person",
					extractionMethod: "regex",
				}),
			)
		})

		it("falls back to regex on timeout", async () => {
			const llmFn = vi
				.fn()
				.mockImplementation(
					() =>
						new Promise((resolve) => setTimeout(() => resolve("[]"), 10000)),
				)
			// Very short timeout to trigger quickly
			const extractor = new LLMEntityExtractor(llmFn, 50)

			const result = await extractor.extract("Contact @bob about the issue")
			expect(result).toContainEqual(
				expect.objectContaining({
					name: "bob",
					type: "person",
					extractionMethod: "regex",
				}),
			)
		})

		it("handles markdown-wrapped JSON response", async () => {
			const llmFn = vi
				.fn()
				.mockResolvedValue(
					'```json\n[{"name": "React", "type": "system", "confidence": 0.95}]\n```',
				)
			const extractor = new LLMEntityExtractor(llmFn, 5000)

			const result = await extractor.extract("Building a React app")
			expect(result).toContainEqual(
				expect.objectContaining({
					name: "React",
					type: "system",
					extractionMethod: "llm",
				}),
			)
		})
	})

	describe("parseExtractionResponse", () => {
		it("filters entries with no name or name shorter than 2 chars", () => {
			const result = parseExtractionResponse(
				JSON.stringify([
					{ name: "", type: "person" },
					{ name: "a", type: "person" },
					{ name: "Al", type: "person", confidence: 0.8 },
					{ type: "system" },
				]),
			)
			expect(result).toHaveLength(1)
			expect(result[0].name).toBe("Al")
		})

		it("clamps confidence to [0, 1]", () => {
			const result = parseExtractionResponse(
				JSON.stringify([
					{ name: "Entity1", type: "person", confidence: 1.5 },
					{ name: "Entity2", type: "org", confidence: -0.5 },
				]),
			)
			expect(result[0].confidence).toBe(1)
			expect(result[1].confidence).toBe(0)
		})

		it("returns empty array for unparseable input", () => {
			expect(parseExtractionResponse("not json at all")).toEqual([])
		})

		it("defaults confidence to 0.7 when not provided", () => {
			const result = parseExtractionResponse(
				JSON.stringify([{ name: "TestEntity", type: "concept" }]),
			)
			expect(result[0].confidence).toBe(0.7)
		})

		it("defaults type to custom when not provided", () => {
			const result = parseExtractionResponse(
				JSON.stringify([{ name: "Something", confidence: 0.5 }]),
			)
			expect(result[0].type).toBe("custom")
		})
	})

	describe("buildExtractionPrompt", () => {
		it("includes existing entity names when provided", () => {
			const context: EntityExtractionContext = {
				agentId: "agent-1",
				scope: "agent",
				scopeRef: "agent:agent-1",
				existingEntityNames: ["Alice", "MongoDB"],
			}
			const prompt = buildExtractionPrompt("Some text", context)
			expect(prompt).toContain("Alice")
			expect(prompt).toContain("MongoDB")
			expect(prompt).toContain("Known entities")
		})

		it("omits existing entity hint when none provided", () => {
			const prompt = buildExtractionPrompt("Some text")
			expect(prompt).not.toContain("Known entities")
		})

		it("includes temporal grounding instruction (Phase 7)", () => {
			const prompt = buildExtractionPrompt("met Alice on May 7, 2023")
			expect(prompt).toContain("dates")
			expect(prompt).toContain("times")
		})
	})

	describe("RegexEntityExtractor — temporal grounding (Phase 7)", () => {
		let extractor: RegexEntityExtractor

		beforeEach(() => {
			extractor = new RegexEntityExtractor()
		})

		it("extracts ISO dates as concept entities", async () => {
			const result = await extractor.extract(
				"The meeting was on 2023-05-07 at the office",
			)
			const dateEntities = result.filter(
				(e) => e.name === "2023-05-07" && e.type === "concept",
			)
			expect(dateEntities).toHaveLength(1)
			expect(dateEntities[0].extractionMethod).toBe("regex")
		})

		it("extracts natural dates (Month Day, Year) as concept entities", async () => {
			const result = await extractor.extract(
				"met with Alice on May 7, 2023 for lunch",
			)
			const dateEntities = result.filter(
				(e) => e.type === "concept" && /2023/.test(e.name),
			)
			expect(dateEntities.length).toBeGreaterThanOrEqual(1)
		})

		it("extracts US format dates (M/D/YYYY) as concept entities", async () => {
			const result = await extractor.extract(
				"Deadline is 5/7/2023 for the project",
			)
			const dateEntities = result.filter(
				(e) => e.name === "5/7/2023" && e.type === "concept",
			)
			expect(dateEntities).toHaveLength(1)
		})

		it("does not extract temporal entities when no dates present", async () => {
			const result = await extractor.extract(
				"Just a plain message with no dates",
			)
			const conceptEntities = result.filter((e) => e.type === "concept")
			expect(conceptEntities).toHaveLength(0)
		})
	})

	describe("buildUserExtractionPrompt (Phase 8)", () => {
		it("includes user-specific focus areas", () => {
			const prompt = buildUserExtractionPrompt("I like MongoDB")
			expect(prompt).toContain("USER")
			expect(prompt).toContain("preferences")
		})
	})

	describe("buildAssistantExtractionPrompt (Phase 8)", () => {
		it("includes assistant-specific focus areas", () => {
			const prompt = buildAssistantExtractionPrompt(
				"I used the vector search tool",
			)
			expect(prompt).toContain("ASSISTANT")
			expect(prompt).toContain("Tools")
		})
	})

	describe("LLMEntityExtractor — role-based prompts (Phase 8)", () => {
		it("uses user prompt for role=user", async () => {
			const llmFn = vi.fn().mockResolvedValue(JSON.stringify([]))
			const extractor = new LLMEntityExtractor(llmFn, 5000)

			await extractor.extract("Hello world", {
				agentId: "a1",
				scope: "agent",
				scopeRef: "agent:a1",
				role: "user",
			})

			expect(llmFn).toHaveBeenCalledOnce()
			const prompt = llmFn.mock.calls[0][0] as string
			expect(prompt).toContain("USER")
		})

		it("uses assistant prompt for role=assistant", async () => {
			const llmFn = vi.fn().mockResolvedValue(JSON.stringify([]))
			const extractor = new LLMEntityExtractor(llmFn, 5000)

			await extractor.extract("I used vector search", {
				agentId: "a1",
				scope: "agent",
				scopeRef: "agent:a1",
				role: "assistant",
			})

			expect(llmFn).toHaveBeenCalledOnce()
			const prompt = llmFn.mock.calls[0][0] as string
			expect(prompt).toContain("ASSISTANT")
		})

		it("defaults to user prompt for unknown roles", async () => {
			const llmFn = vi.fn().mockResolvedValue(JSON.stringify([]))
			const extractor = new LLMEntityExtractor(llmFn, 5000)

			await extractor.extract("System message", {
				agentId: "a1",
				scope: "agent",
				scopeRef: "agent:a1",
				role: "system",
			})

			expect(llmFn).toHaveBeenCalledOnce()
			const prompt = llmFn.mock.calls[0][0] as string
			expect(prompt).toContain("USER")
		})

		it("sourceRole validated on entity (Phase 8 — schema)", async () => {
			const llmFn = vi
				.fn()
				.mockResolvedValue(
					JSON.stringify([
						{ name: "MongoDB", type: "system", confidence: 0.9 },
					]),
				)
			const extractor = new LLMEntityExtractor(llmFn, 5000)

			const result = await extractor.extract("MongoDB is great", {
				agentId: "a1",
				scope: "agent",
				scopeRef: "agent:a1",
				role: "user",
			})

			// Entity extraction returns ExtractedEntity, sourceRole is handled at upsert level
			// This test verifies LLM extraction still works with role context
			expect(result).toHaveLength(1)
			expect(result[0].name).toBe("MongoDB")
		})
	})

	describe("AMBIGUOUS_PERSON_NAMES (Phase 3.4)", () => {
		it("exports a Set of common English words that are also names", () => {
			expect(AMBIGUOUS_PERSON_NAMES).toBeInstanceOf(Set)
			expect(AMBIGUOUS_PERSON_NAMES.size).toBeGreaterThan(10)
			expect(AMBIGUOUS_PERSON_NAMES.has("grace")).toBe(true)
			expect(AMBIGUOUS_PERSON_NAMES.has("will")).toBe(true)
			expect(AMBIGUOUS_PERSON_NAMES.has("may")).toBe(true)
			expect(AMBIGUOUS_PERSON_NAMES.has("mark")).toBe(true)
			expect(AMBIGUOUS_PERSON_NAMES.has("bill")).toBe(true)
			expect(AMBIGUOUS_PERSON_NAMES.has("hunter")).toBe(true)
			expect(AMBIGUOUS_PERSON_NAMES.has("chance")).toBe(true)
		})

		it("isAmbiguousPersonName checks case-insensitively", () => {
			expect(isAmbiguousPersonName("Grace")).toBe(true)
			expect(isAmbiguousPersonName("WILL")).toBe(true)
			expect(isAmbiguousPersonName("alice")).toBe(false)
			expect(isAmbiguousPersonName("MongoDB")).toBe(false)
		})

		it("does not contain common proper names that are not English words", () => {
			expect(AMBIGUOUS_PERSON_NAMES.has("alice")).toBe(false)
			expect(AMBIGUOUS_PERSON_NAMES.has("bob")).toBe(false)
			expect(AMBIGUOUS_PERSON_NAMES.has("sarah")).toBe(false)
		})
	})

	describe("2-signal gate for person classification (Phase 3.4)", () => {
		let extractor: RegexEntityExtractor

		beforeEach(() => {
			extractor = new RegexEntityExtractor()
		})

		it("downgrades ambiguous quoted name from regex to concept", async () => {
			// "Grace" as a quoted name with no second signal should become concept
			const result = await extractor.extract(
				'Talked to "Grace" about the project',
			)
			const graceEntity = result.find((e) => e.name.toLowerCase() === "grace")
			expect(graceEntity).toBeDefined()
			expect(graceEntity!.type).toBe("concept")
		})

		it("keeps @mention of ambiguous name as person (strong signal)", async () => {
			// @grace is a strong signal (explicit @mention) - keep as person
			const result = await extractor.extract(
				"Talked to @grace about the project",
			)
			const graceEntity = result.find((e) => e.name.toLowerCase() === "grace")
			expect(graceEntity).toBeDefined()
			expect(graceEntity!.type).toBe("person")
		})

		it("keeps non-ambiguous quoted name as person", async () => {
			const result = await extractor.extract(
				'Meeting with "Sarah Chen" about design',
			)
			const sarahEntity = result.find((e) => e.name === "Sarah Chen")
			expect(sarahEntity).toBeDefined()
			expect(sarahEntity!.type).toBe("person")
		})
	})
})
