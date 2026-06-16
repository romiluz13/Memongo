import { describe, expect, it } from "vitest"
import {
	auditArtifactCounts,
	auditCountQuestion,
	classifyCountKind,
	countDerivedEvidenceBullets,
	extractDerivedEvidenceNumber,
	extractFirstNumber,
	hasCountStyleQuestion,
} from "./count-policy-audit.js"

describe("count policy audit primitives", () => {
	it("recognizes count-style questions without matching discount substrings", () => {
		expect(hasCountStyleQuestion("How many times did I bake something?")).toBe(
			true,
		)
		expect(hasCountStyleQuestion("What was the discount I got?")).toBe(false)
	})

	it("extracts numeric digits and simple number words", () => {
		expect(extractFirstNumber("4 times")).toBe(4)
		expect(extractFirstNumber("three")).toBe(3)
		expect(extractFirstNumber("No numeric answer")).toBeNull()
	})

	it("classifies repeated action, pending action, duration, and inventory counts", () => {
		expect(classifyCountKind("How many times did I bake something?", "4")).toBe(
			"repeated-action",
		)
		expect(
			classifyCountKind(
				"How many items do I still need to pick up or return?",
				"3",
			),
		).toBe("pending-action")
		expect(classifyCountKind("How many days ago was the webinar?", "17")).toBe(
			"duration",
		)
		expect(classifyCountKind("How many bikes do I own?", "three")).toBe(
			"inventory",
		)
		expect(
			classifyCountKind(
				"How many pieces of jewelry did I acquire in the last two months?",
				"3",
			),
		).toBe("inventory")
	})

	it("flags when answer-session count is not a safe shortcut", () => {
		const audit = auditCountQuestion({
			question_id: "q1",
			question_type: "multi-session",
			question: "How many hours did I spend practicing?",
			answer: "12",
			answer_session_ids: ["s1", "s2"],
		})

		expect(audit?.sessionCountEqualsGold).toBe(false)
		expect(audit?.flags).toContain("answer-session-count-differs-from-gold")
	})
})

describe("artifact count audit", () => {
	it("counts derived evidence bullets", () => {
		expect(
			countDerivedEvidenceBullets(
				"derived countable evidence from retrieved memories: 1. cake 2. cookies 3. pie",
			),
		).toBe(3)
		expect(
			countDerivedEvidenceBullets("ordinary memory: 1. not derived"),
		).toBeNull()
	})

	it("extracts source-stated totals without treating progress bullets as the count", () => {
		expect(
			extractDerivedEvidenceNumber(
				"derived current-total evidence from retrieved memories: use the latest source-stated total. 1. stated total 5: finished my 5th project. 2. stated total 4: completed 4 projects.",
			),
		).toBe(5)
	})

	it("extracts explicit pending-action counts before counting numbered prose", () => {
		expect(
			extractDerivedEvidenceNumber(
				"Derived action checklist from retrieved memories: computed pending-action count: 3. Count the numbered actions separately. 1. separate pending action: pick up boots. 2. separate pending action: return jacket. 3. separate pending action: pick up blazer.",
			),
		).toBe(3)
	})

	it("flags generated and derived evidence count disagreements", () => {
		const question = auditCountQuestion({
			question_id: "88432d0a",
			question_type: "multi-session",
			question: "How many times did I bake something in the past two weeks?",
			answer: 4,
			answer_session_ids: ["a", "b", "c", "d"],
		})
		expect(question).not.toBeNull()
		if (!question) {
			throw new Error("expected audit question")
		}

		const [artifactAudit] = auditArtifactCounts(
			{
				evaluations: [
					{
						question_id: "88432d0a",
						cutoff_results: {
							top_50: {
								generated_answer: "6",
							},
						},
						retrieval: {
							search_results: [
								{
									memory:
										"derived countable evidence from retrieved memories: 1. cake 2. cookies 3. bread 4. pie 5. baguette",
								},
							],
						},
					},
				],
			},
			[question],
			"top_50",
		)

		expect(artifactAudit.artifactFlags).toContain(
			"generated-number-differs-from-gold",
		)
		expect(artifactAudit.artifactFlags).toContain(
			"derived-evidence-count-differs-from-gold",
		)
		expect(artifactAudit.artifactFlags).toContain(
			"generated-number-differs-from-derived-evidence",
		)
	})
})
