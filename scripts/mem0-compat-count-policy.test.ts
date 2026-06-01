import { describe, expect, it } from "vitest"
import {
	buildActionEvidenceResults,
	buildCountEvidenceResults,
	buildPreferenceEvidenceResults,
	classifyMem0CompatCountKind,
	hasCountIntent,
	type BridgeSearchResult,
} from "./mem0-compat-count-policy.js"

function result(snippet: string, date = "2023-05-30"): BridgeSearchResult {
	return {
		snippet,
		timestamp: new Date(`${date}T00:00:00.000Z`),
		score: 0.5,
	}
}

function bulletCount(memory: string): number {
	return (memory.match(/\b\d+\./g) ?? []).length
}

describe("mem0 compat count policy", () => {
	it("classifies broad quantitative queries without treating every number as an item count", () => {
		expect(hasCountIntent("How much did I spend on shipping?")).toBe(true)
		expect(
			classifyMem0CompatCountKind(
				"How many days ago did I watch the Super Bowl?",
			),
		).toBe("duration")
		expect(classifyMem0CompatCountKind("How much cashback did I earn?")).toBe(
			"money-or-percent",
		)
		expect(
			classifyMem0CompatCountKind(
				"How many things do I still need to pick up?",
			),
		).toBe("pending-action")
		expect(
			classifyMem0CompatCountKind("How many times did I bake something?"),
		).toBe("repeated-action")
	})

	it("does not inject derived count evidence for duration or money questions", () => {
		expect(
			buildCountEvidenceResults(
				"How many days ago did I watch the Super Bowl?",
				[result("I watched the Super Bowl today.")],
			),
		).toEqual([])
		expect(
			buildCountEvidenceResults("How much cashback did I earn?", [
				result("I earned $12 cashback."),
			]),
		).toEqual([])
	})

	it("turns progress-total questions into total evidence, not countable bullets", () => {
		const [evidence] = buildCountEvidenceResults(
			"How many projects have I completed since starting painting classes?",
			[
				result("I've completed 4 projects since starting painting classes."),
				result(
					"By the way, I just finished my 5th project since starting painting classes.",
				),
				result(
					"I'm looking for some inspiration for my next painting project.",
				),
			],
		)

		expect(evidence?.id).toContain("derived-current-total-evidence")
		expect(evidence?.memory).toContain("stated total 5")
		expect(evidence?.memory).toContain("do not count the bullets")
		expect(evidence?.memory).not.toContain("derived countable evidence")
	})

	it("keeps jewelry acquisition evidence user-owned and object-specific", () => {
		const [evidence] = buildCountEvidenceResults(
			"How many pieces of jewelry did I acquire in the last two months?",
			[
				result(
					"I got my engagement ring a month ago, and it is still a bit too loose.",
				),
				result(
					"I just got a new pair of earrings last weekend at a flea market.",
				),
				result(
					"Can you help me clean my jewelry? By the way, I got a new silver necklace with a small pendant on the 15th of last month.",
				),
				result(
					"My siblings got some other amazing pieces, like a vintage sewing machine.",
				),
				result("I renewed my registration online about a month ago."),
			],
		)

		expect(evidence?.memory).toContain("engagement ring")
		expect(evidence?.memory).toContain("earrings")
		expect(evidence?.memory).toContain("silver necklace")
		expect(evidence?.memory).not.toContain("siblings")
		expect(evidence?.memory).not.toContain("registration")
		expect(bulletCount(evidence?.memory ?? "")).toBe(3)
	})

	it("keeps repeated baking evidence completed and avoids broad made-pie distractors", () => {
		const [evidence] = buildCountEvidenceResults(
			"How many times did I bake something in the past two weeks?",
			[
				result("I just baked a chocolate cake for my sister's birthday party."),
				result("I used the oven to bake a batch of cookies last Thursday."),
				result(
					"I recently tried out a new bread recipe using sourdough starter on Tuesday.",
				),
				result(
					"Also, I'm curious - how did you find the experience of baking a cake compared to baking bread?",
				),
				result("I made a delicious whole wheat baguette last Saturday."),
				result(
					"I made the apple pie in my cast iron skillet and it turned out amazing.",
				),
				result("Do you have recommendations for whole wheat bread recipes?"),
			],
		)

		expect(evidence?.memory).toContain("chocolate cake")
		expect(evidence?.memory).toContain("cookies")
		expect(evidence?.memory).toContain("sourdough bread")
		expect(evidence?.memory).toContain("whole wheat baguette")
		expect(evidence?.memory).not.toContain("apple pie")
		expect(evidence?.memory).not.toContain("recommendations")
		expect(bulletCount(evidence?.memory ?? "")).toBe(4)
	})

	it("keeps pending action checklist separate from countable evidence", () => {
		const actionEvidence = buildActionEvidenceResults(
			"How many things do I still need to pick up or return?",
			[
				result("I still need to pick up the dry cleaning for my suit."),
				result("I need to return my library books."),
			],
		)
		const countEvidence = buildCountEvidenceResults(
			"How many things do I still need to pick up or return?",
			[result("I still need to pick up the dry cleaning for my suit.")],
		)

		expect(actionEvidence[0]?.id).toContain("derived-action-checklist")
		expect(actionEvidence[0]?.memory).toContain(
			"computed pending-action count: 2",
		)
		expect(countEvidence).toEqual([])
	})
})

describe("mem0 compat preference evidence policy", () => {
	it("promotes source-backed user context for advice questions", () => {
		const [evidence] = buildPreferenceEvidenceResults(
			"I've been having trouble with the battery life on my phone lately. Any tips?",
			[
				result(
					"I'm looking for some advice on the best way to organize my tech accessories, like my new portable power bank and wireless charging pad, when I'm traveling.",
					"2023-05-27",
				),
				result(
					"Assistant: Here are some generic battery-saving tips for your phone.",
					"2023-05-27",
				),
			],
		)

		expect(evidence?.memory).toContain("derived preference/context evidence")
		expect(evidence?.memory).toContain("portable power bank")
		expect(evidence?.memory).toContain("wireless charging pad")
		expect(evidence?.memory).not.toContain("generic battery-saving tips")
	})

	it("does not create preference evidence for ordinary factual lookup", () => {
		expect(
			buildPreferenceEvidenceResults("When did I watch the Super Bowl?", [
				result("I watched the Super Bowl 17 days ago."),
			]),
		).toEqual([])
	})
})
