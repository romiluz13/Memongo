import { describe, it, expect, beforeEach } from "vitest"
import {
	RegexEntityExtractor,
	AMBIGUOUS_PERSON_NAMES,
	isAmbiguousPersonName,
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
