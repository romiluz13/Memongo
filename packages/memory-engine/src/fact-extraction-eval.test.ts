import { describe, expect, it } from "vitest"
import {
	FACT_EXTRACTION_FIXTURE,
	evaluateFactExtractor,
	isFactRecalled,
	scoreFactRecall,
} from "./fact-extraction-eval.js"
import { extractStructuredCandidatesFromEvent } from "./mongodb-derived-memory.js"

describe("isFactRecalled", () => {
	it("recalls a fact when an extracted value covers its significant terms", () => {
		// Expected significant terms: {user, deploys, aws, us-east-1}. The
		// extracted value covers user + aws + us-east-1 (3/4 = 0.75 >= 0.6).
		expect(
			isFactRecalled("User deploys to AWS us-east-1", [
				"prod target is AWS us-east-1 for the user",
			]),
		).toBe(true)
	})

	it("does not recall a fact when coverage is below threshold", () => {
		// Only {user} overlaps → 1/4 = 0.25 < 0.6.
		expect(
			isFactRecalled("User deploys to AWS us-east-1", ["User likes dark mode"]),
		).toBe(false)
	})

	it("does not recall against an empty extraction set", () => {
		expect(isFactRecalled("User prefers concise answers", [])).toBe(false)
	})

	it("does not recall when a required discriminator is absent despite high coverage", () => {
		// Covers 4/5 significant terms (user, uses, package, manager) but omits the
		// ground-truth discriminator "pnpm" — must NOT count as recalled.
		expect(
			isFactRecalled(
				"The user uses pnpm as the package manager",
				["the user uses a package manager"],
				{ mustInclude: ["pnpm"] },
			),
		).toBe(false)
	})

	it("recalls only when the discriminator appears in the same covering value", () => {
		expect(
			isFactRecalled(
				"The user uses pnpm as the package manager",
				["the user uses pnpm as the package manager"],
				{ mustInclude: ["pnpm"] },
			),
		).toBe(true)
		// Discriminator present but in a different value than the one with coverage
		// → still not recalled (a fact cannot be assembled from two fragments).
		expect(
			isFactRecalled(
				"The user uses pnpm as the package manager",
				["the user uses a package manager", "pnpm"],
				{ mustInclude: ["pnpm"] },
			),
		).toBe(false)
	})
})

describe("scoreFactRecall", () => {
	it("computes matched / total across expected facts", () => {
		const result = scoreFactRecall(
			["User deploys to AWS us-east-1", "User prefers dark mode"],
			["the user deploys to aws us-east-1 in production"],
		)
		expect(result.total).toBe(2)
		expect(result.matched).toBe(1)
		expect(result.recall).toBeCloseTo(0.5, 5)
	})

	it("is 1 when every expected fact is covered", () => {
		const result = scoreFactRecall(["cat", "dog"], ["a cat sat", "the dog ran"])
		expect(result.recall).toBe(1)
	})

	it("is 0 when there are no expected facts", () => {
		const result = scoreFactRecall([], ["anything"])
		expect(result.recall).toBe(0)
		expect(result.total).toBe(0)
	})
})

describe("evaluateFactExtractor", () => {
	it("scores the regex extractor across the fixture and returns per-case detail", async () => {
		const report = await evaluateFactExtractor({
			cases: FACT_EXTRACTION_FIXTURE,
			// Steel-man the baseline: count every value the regex extractor
			// surfaces (fact/preference/project/...), not just ones it labels
			// "fact", so the comparison is about recovered content, not labels.
			extract: (event) =>
				extractStructuredCandidatesFromEvent(event).map((c) => c.value),
		})

		expect(report.perCase).toHaveLength(FACT_EXTRACTION_FIXTURE.length)
		expect(report.recall).toBeGreaterThanOrEqual(0)
		expect(report.recall).toBeLessThanOrEqual(1)
		// The fixture must contain cases the deterministic regex misses — that is
		// the headroom the LLM arm is meant to close. If regex already scored a
		// perfect recall, the eval could never demonstrate LLM value.
		expect(report.recall).toBeLessThan(1)
	})
})

describe("FACT_EXTRACTION_FIXTURE", () => {
	it("labels each case with self-consistent expected facts", () => {
		expect(FACT_EXTRACTION_FIXTURE.length).toBeGreaterThan(0)
		for (const testCase of FACT_EXTRACTION_FIXTURE) {
			expect(testCase.expectedFacts.length).toBeGreaterThan(0)
			expect(testCase.event.body.length).toBeGreaterThan(0)
			for (const fact of testCase.expectedFacts) {
				expect(fact.text.length).toBeGreaterThan(0)
				// Every declared discriminator must appear in the fact's own text,
				// otherwise the ground-truth label is internally inconsistent.
				for (const term of fact.mustInclude ?? []) {
					expect(fact.text.toLowerCase()).toContain(term.toLowerCase())
				}
			}
		}
	})
})
