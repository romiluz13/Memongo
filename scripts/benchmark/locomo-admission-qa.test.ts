import { describe, expect, it } from "vitest"
import {
	ZERO_TOTALS,
	qa,
	sample,
	turn,
	useLoCoMoLoader,
} from "./locomo-admission.fixture.js"
import { countBenchmarkRejections } from "./mongodb-benchmark-dataset.js"

// QA-item rows of table 3.4 with OPEN-8, -9, -20 to -25 (resolutions r3).
const { load, loadText } = useLoCoMoLoader()

const atQa = (qaIndex: number, reason: string) => ({
	format: "locomo",
	sampleIndex: 0,
	qaIndex,
	reason,
})

/** One sample whose session holds D1:1 and D1:2; qa[0] stays valid, the item under test is qa[1]. */
async function loadItem(item: unknown) {
	return load([
		sample("s", {
			conversation: {
				session_1: [
					turn("Alice", "D1:1", "first"),
					turn("Bob", "D1:2", "second"),
				],
			},
			qa: [qa(), item],
		}),
	])
}

async function expectQaRejection(item: unknown, reason: string) {
	const dataset = await loadItem(item)
	expect(dataset.adapterDiagnostics?.entries).toEqual([atQa(1, reason)])
	expect(dataset.adapterDiagnostics?.totals).toEqual({
		...ZERO_TOTALS,
		rejectedQaItems: 1,
	})
	expect(
		countBenchmarkRejections(undefined, dataset.adapterDiagnostics),
	).toEqual({ rejectedTurns: 0, rejectedConversations: 1 })
	expect(dataset.evaluations?.map((e) => e.caseId)).toEqual(["s::qa_1"])
}

describe("LoCoMo QA rejections in table row order", () => {
	it.each([
		["not an object", "item", "qa-not-object"],
		["a blank question", qa({ question: "  " }), "qa-invalid-question"],
		["a non-string question", qa({ question: 4 }), "qa-invalid-question"],
		[
			"a string category (OPEN-20 B)",
			qa({ category: "5" }),
			"qa-invalid-category",
		],
		["category 0", qa({ category: 0 }), "qa-invalid-category"],
		["category 6", qa({ category: 6 }), "qa-invalid-category"],
		["a fractional category", qa({ category: 1.5 }), "qa-invalid-category"],
		["a missing category", qa({ category: undefined }), "qa-invalid-category"],
		["a missing gold", qa({ answer: undefined }), "qa-invalid-gold"],
		["a null gold", qa({ answer: null }), "qa-invalid-gold"],
		["a blank gold", qa({ answer: " \t" }), "qa-invalid-gold"],
		["a boolean gold", qa({ answer: true }), "qa-invalid-gold"],
		["an array gold", qa({ answer: ["x"] }), "qa-invalid-gold"],
		["an object gold", qa({ answer: { x: 1 } }), "qa-invalid-gold"],
		[
			"an invalid question and category",
			qa({ question: "", category: "x" }),
			"qa-invalid-question",
		],
		[
			"an invalid category and gold",
			qa({ category: 9, answer: null }),
			"qa-invalid-category",
		],
		[
			"an invalid gold and evidence",
			qa({ answer: null, evidence: "D1:1" }),
			"qa-invalid-gold",
		],
	])("rejects an item with %s", async (_label, item, reason) => {
		await expectQaRejection(item, reason)
	})

	it("rejects a non-finite numeric gold (JSON 1e400)", async () => {
		const dataset = await loadText(
			JSON.stringify([sample("s", { qa: [qa(), qa({ answer: 0 })] })]).replace(
				'"answer":0',
				'"answer":1e400',
			),
		)
		expect(dataset.adapterDiagnostics?.entries).toEqual([
			atQa(1, "qa-invalid-gold"),
		])
	})

	it("keeps a zero numeric gold", async () => {
		const dataset = await loadItem(qa({ answer: 0 }))
		expect(dataset.evaluations?.[1]).toMatchObject({
			answer: "0",
			goldAnswerSourceType: "number",
		})
	})
})

describe("LoCoMo evidence validation and tokenization (OPEN-9 B, OPEN-24 A, OPEN-25)", () => {
	it.each([
		["a string instead of a list", "D1:1"],
		["a null list", null],
		["an object", { D1: 1 }],
		["a non-string entry", ["D1:1", 3]],
		["a null entry", [null]],
		["a blank entry", ["D1:1", "  "]],
		["a separator-only entry", [";;;"]],
		["a spaced separator-only entry", ["; ; ;"]],
		["a valid reference beside a separator-only sibling", ["D1:1", ";;;"]],
	])("rejects evidence that is %s as qa-invalid-evidence", async (_label, evidence) => {
		await expectQaRejection(qa({ evidence }), "qa-invalid-evidence")
	})

	it.each([
		["a missing dialog", ["D9:9"]],
		["one unresolved token among resolved ones", ["D1:1 D9:9"]],
		["a semicolon list with an unresolved token", ["D1:1;D9:9"]],
		["a different case", ["d1:1"]],
	])("rejects %s as qa-evidence-unresolved", async (_label, evidence) => {
		await expectQaRejection(qa({ evidence }), "qa-evidence-unresolved")
	})

	it("drops the release prefix fallback: D1:9 never resolves to a turn D1", async () => {
		const dataset = await load([
			sample("s", {
				conversation: { session_1: [turn("Alice", "D1", "short id")] },
				qa: [qa({ evidence: ["D1"] }), qa({ evidence: ["D1:9"] })],
			}),
		])
		expect(dataset.adapterDiagnostics?.entries).toEqual([
			atQa(1, "qa-evidence-unresolved"),
		])
	})

	it.each([
		["semicolon-separated", ["D1:1; D1:2"]],
		["whitespace-separated", ["D1:1 D1:2"]],
		["mixed, repeated and padded", [" D1:1 ;\tD1:2; ", "D1:1"]],
	])("splits %s references and resolves every token", async (_label, evidence) => {
		const dataset = await loadItem(qa({ evidence }))
		expect(dataset.adapterDiagnostics?.totals).toEqual(ZERO_TOTALS)
		expect(dataset.evaluations?.[1]).toMatchObject({
			expectedDialogIds: ["D1:1", "D1:2"],
			expectedSessionIds: ["s::session_1"],
		})
		expect(dataset.evaluations?.[1]?.metadata?.evidence).toEqual(evidence)
	})
})

describe("LoCoMo empty evidence on categories 1-4 (OPEN-8 A, 1206 Q4)", () => {
	it.each([
		["an empty list", { evidence: [] }],
		["a missing list", { evidence: undefined }],
	])("keeps the QA and its gold, labeled no-evidence, for %s", async (_label, overrides) => {
		const dataset = await loadItem(qa({ category: 3, answer: 7, ...overrides }))
		expect(dataset.adapterDiagnostics?.totals).toEqual(ZERO_TOTALS)
		expect(dataset.evaluations?.[1]).toMatchObject({
			caseId: "s::qa_2",
			answer: "7",
			goldAnswerSourceType: "number",
			questionType: "category-3",
			abstention: false,
			expectedSessionIds: [],
			expectedDialogIds: [],
			officialRetrieval: {
				evaluator: "locomo-evidence",
				eligible: false,
				expectedSessionIds: [],
				expectedTurnIds: [],
				ineligibleReason: "no-evidence",
			},
		})
	})

	it("adds no retrieval label to an item with resolved evidence", async () => {
		const dataset = await loadItem(qa())
		expect(
			Object.hasOwn(dataset.evaluations?.[1] ?? {}, "officialRetrieval"),
		).toBe(false)
	})
})

describe("LoCoMo category 5 loads as safe abstention (decision 5, OPEN-21 to -23)", () => {
	const category5 = (overrides: Record<string, unknown> = {}) =>
		qa({
			question: "What did Bob say about the zoo?",
			answer: undefined,
			adversarial_answer: "adversarial bait",
			category: 5,
			evidence: ["D1:2"],
			...overrides,
		})

	it("is an abstention with empty targets, labeled abstention, and reference-only answers", async () => {
		const dataset = await loadItem(category5())
		expect(dataset.adapterDiagnostics?.totals).toEqual(ZERO_TOTALS)
		const evaluation = dataset.evaluations?.[1]
		expect(evaluation).toEqual({
			caseId: "s::qa_2",
			query: "What did Bob say about the zoo?",
			expectedSessionIds: [],
			expectedDialogIds: [],
			officialRetrieval: {
				evaluator: "locomo-evidence",
				eligible: false,
				expectedSessionIds: [],
				expectedTurnIds: [],
				ineligibleReason: "abstention",
			},
			questionType: "category-5",
			abstention: true,
			metadata: {
				benchmarkDatasetKind: "locomo",
				locomoCategory: 5,
				evidence: ["D1:2"],
				locomoAdversarialAnswer: "adversarial bait",
			},
		})
		expect(Object.hasOwn(evaluation ?? {}, "answer")).toBe(false)
		expect(Object.hasOwn(evaluation ?? {}, "goldAnswerSourceType")).toBe(false)
	})

	it.each([
		["a string", "reference text"],
		["a number", 12],
		["an object, kept as-is", { odd: true }],
	])("keeps a present answer of %s only as reference metadata", async (_label, answer) => {
		const dataset = await loadItem(category5({ answer }))
		const evaluation = dataset.evaluations?.[1]
		expect(Object.hasOwn(evaluation ?? {}, "answer")).toBe(false)
		expect(evaluation?.metadata?.locomoReferenceAnswer).toEqual(answer)
	})

	it("admits an item with neither answer nor adversarial answer", async () => {
		const dataset = await loadItem(category5({ adversarial_answer: undefined }))
		const metadata = dataset.evaluations?.[1]?.metadata ?? {}
		expect(dataset.evaluations?.[1]?.abstention).toBe(true)
		expect(Object.hasOwn(metadata, "locomoAdversarialAnswer")).toBe(false)
		expect(Object.hasOwn(metadata, "locomoReferenceAnswer")).toBe(false)
	})

	it("admits a legitimately empty evidence list", async () => {
		const dataset = await loadItem(category5({ evidence: [] }))
		expect(dataset.adapterDiagnostics?.totals).toEqual(ZERO_TOTALS)
		expect(dataset.evaluations?.[1]?.officialRetrieval?.ineligibleReason).toBe(
			"abstention",
		)
	})

	it("validates present evidence like categories 1-4: a missing target rejects it once (OPEN-23)", async () => {
		await expectQaRejection(
			category5({ evidence: ["D99:1"] }),
			"qa-evidence-unresolved",
		)
		await expectQaRejection(
			category5({ evidence: [";;;"] }),
			"qa-invalid-evidence",
		)
		await expectQaRejection(
			category5({ evidence: "D1:2" }),
			"qa-invalid-evidence",
		)
	})
})
