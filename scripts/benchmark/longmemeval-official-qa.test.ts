import { describe, expect, it } from "vitest"
import {
	OFFICIAL_LONGMEMEVAL_QA_JUDGE_MODEL,
	OFFICIAL_LONGMEMEVAL_QA_JUDGE_VERSION,
	OFFICIAL_LONGMEMEVAL_S_CASE_COUNT,
	OFFICIAL_QA_QUESTION_TYPE_ORDER,
	OfficialLongMemEvalQaError,
	buildOfficialAnscheckPrompt,
	computeOfficialLongMemEvalQaMetrics,
	isOfficialAbstentionQuestion,
	runOfficialLongMemEvalQaJudging,
	validateOfficialLongMemEvalFullCoverage,
	type OfficialQaPrediction,
	type OfficialQaReference,
} from "./longmemeval-official-qa.js"
import type { EnrichmentProvider } from "../../packages/memory-engine/src/mongodb-llm-enrichment.js"

type RecordedJudgeCall = {
	model: string
	messages: Array<{ role: string; content: string }>
	responseFormat?: { type: "json_object" }
	maxTokens?: number
	temperature?: number
}

function createStubJudgeProvider(responses: string[]) {
	const calls: RecordedJudgeCall[] = []
	let next = 0
	const provider: EnrichmentProvider = {
		name: "stub-judge",
		chatCompletion: async (params) => {
			calls.push(params)
			const content = responses[Math.min(next, responses.length - 1)]
			next += 1
			return { content }
		},
	}
	return { calls, provider }
}

function buildReferences(count: number): OfficialQaReference[] {
	return Array.from({ length: count }, (_, index) => ({
		questionId: `q${index + 1}`,
		question: `Question ${index + 1}`,
		answer: `Answer ${index + 1}`,
		questionType:
			OFFICIAL_QA_QUESTION_TYPE_ORDER[
				index % OFFICIAL_QA_QUESTION_TYPE_ORDER.length
			],
	}))
}

function buildPredictions(
	references: OfficialQaReference[],
): OfficialQaPrediction[] {
	return references.map((reference) => ({
		questionId: reference.questionId,
		hypothesis: `Hypothesis ${reference.questionId}`,
	}))
}

describe("buildOfficialAnscheckPrompt", () => {
	it("uses the exact official template for the three generic task types", () => {
		for (const questionType of [
			"single-session-user",
			"single-session-assistant",
			"multi-session",
		] as const) {
			const prompt = buildOfficialAnscheckPrompt({
				questionType,
				question: "What bike did I buy?",
				goldAnswer: "Trek FX 2",
				hypothesis: "You bought a Trek FX 2.",
				abstention: false,
			})
			expect(prompt).toBe(
				"I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response is equivalent to the correct answer or contains all the intermediate steps to get the correct answer, you should also answer yes. If the response only contains a subset of the information required by the answer, answer no. \n\nQuestion: What bike did I buy?\n\nCorrect Answer: Trek FX 2\n\nModel Response: You bought a Trek FX 2.\n\nIs the model response correct? Answer yes or no only.",
			)
		}
	})

	it("uses the exact official temporal-reasoning template (with the off-by-one clause and trailing space)", () => {
		const prompt = buildOfficialAnscheckPrompt({
			questionType: "temporal-reasoning",
			question: "How many days until my trip?",
			goldAnswer: "18",
			hypothesis: "19 days",
			abstention: false,
		})
		expect(prompt).toBe(
			"I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response is equivalent to the correct answer or contains all the intermediate steps to get the correct answer, you should also answer yes. If the response only contains a subset of the information required by the answer, answer no. In addition, do not penalize off-by-one errors for the number of days. If the question asks for the number of days/weeks/months, etc., and the model makes off-by-one errors (e.g., predicting 19 days when the answer is 18), the model's response is still correct. \n\nQuestion: How many days until my trip?\n\nCorrect Answer: 18\n\nModel Response: 19 days\n\nIs the model response correct? Answer yes or no only.",
		)
	})

	it("uses the exact official knowledge-update template", () => {
		const prompt = buildOfficialAnscheckPrompt({
			questionType: "knowledge-update",
			question: "What medication is my dad taking?",
			goldAnswer: "Metformin",
			hypothesis: "He used to take insulin but now takes metformin.",
			abstention: false,
		})
		expect(prompt).toBe(
			"I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response contains some previous information along with an updated answer, the response should be considered as correct as long as the updated answer is the required answer.\n\nQuestion: What medication is my dad taking?\n\nCorrect Answer: Metformin\n\nModel Response: He used to take insulin but now takes metformin.\n\nIs the model response correct? Answer yes or no only.",
		)
	})

	it("uses the exact official single-session-preference template (rubric wording)", () => {
		const prompt = buildOfficialAnscheckPrompt({
			questionType: "single-session-preference",
			question: "Recommend a restaurant for my anniversary dinner.",
			goldAnswer: "prefers Italian; vegetarian; quiet ambiance",
			hypothesis: "I'd suggest the quiet Italian vegetarian bistro on 5th.",
			abstention: false,
		})
		expect(prompt).toBe(
			"I will give you a question, a rubric for desired personalized response, and a response from a model. Please answer yes if the response satisfies the desired response. Otherwise, answer no. The model does not need to reflect all the points in the rubric. The response is correct as long as it recalls and utilizes the user's personal information correctly.\n\nQuestion: Recommend a restaurant for my anniversary dinner.\n\nRubric: prefers Italian; vegetarian; quiet ambiance\n\nModel Response: I'd suggest the quiet Italian vegetarian bistro on 5th.\n\nIs the model response correct? Answer yes or no only.",
		)
	})

	it("uses the exact official abstention template regardless of question type", () => {
		const prompt = buildOfficialAnscheckPrompt({
			questionType: "multi-session",
			question: "What is my sister's dog's name?",
			goldAnswer: "The user never mentions a sister or her dog.",
			hypothesis: "I don't have that information.",
			abstention: true,
		})
		expect(prompt).toBe(
			"I will give you an unanswerable question, an explanation, and a response from a model. Please answer yes if the model correctly identifies the question as unanswerable. The model could say that the information is incomplete, or some other information is given but the asked information is not.\n\nQuestion: What is my sister's dog's name?\n\nExplanation: The user never mentions a sister or her dog.\n\nModel Response: I don't have that information.\n\nDoes the model correctly identify the question as unanswerable? Answer yes or no only.",
		)
	})

	it("refuses unknown question types instead of falling back to a generic prompt", () => {
		expect(() =>
			buildOfficialAnscheckPrompt({
				questionType: "abstention",
				question: "q",
				goldAnswer: "a",
				hypothesis: "h",
				abstention: false,
			}),
		).toThrowError(OfficialLongMemEvalQaError)
	})

	it("does not let {} inside question text break slot filling", () => {
		const prompt = buildOfficialAnscheckPrompt({
			questionType: "multi-session",
			question: "What does {} mean?",
			goldAnswer: "a",
			hypothesis: "h",
			abstention: false,
		})
		expect(prompt).toBe(
			"I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response is equivalent to the correct answer or contains all the intermediate steps to get the correct answer, you should also answer yes. If the response only contains a subset of the information required by the answer, answer no. \n\nQuestion: What does {} mean?\n\nCorrect Answer: a\n\nModel Response: h\n\nIs the model response correct? Answer yes or no only.",
		)
	})
})

describe("isOfficialAbstentionQuestion", () => {
	it("matches the official '_abs' substring rule, not a suffix rule", () => {
		expect(isOfficialAbstentionQuestion("q1_abs")).toBe(true)
		expect(isOfficialAbstentionQuestion("q1_abs_2")).toBe(true)
		expect(isOfficialAbstentionQuestion("q1_absolute")).toBe(true)
		expect(isOfficialAbstentionQuestion("q1")).toBe(false)
		expect(isOfficialAbstentionQuestion("abs_q1")).toBe(false)
	})
})

describe("runOfficialLongMemEvalQaJudging", () => {
	const reference: OfficialQaReference = {
		questionId: "q1",
		question: "What bike did I buy?",
		answer: "Trek FX 2",
		questionType: "multi-session",
	}

	it("issues the official judge call: one user message, temperature 0, maxTokens 10, no responseFormat", async () => {
		const { calls, provider } = createStubJudgeProvider(["yes"])

		const metrics = await runOfficialLongMemEvalQaJudging({
			judgeProvider: provider,
			judgeModel: OFFICIAL_LONGMEMEVAL_QA_JUDGE_MODEL,
			predictions: [
				{ questionId: "q1", hypothesis: "You bought a Trek FX 2." },
			],
			references: [reference],
		})

		expect(calls).toHaveLength(1)
		expect(calls[0].model).toBe("gpt-4o-2024-08-06")
		expect(calls[0].messages).toEqual([
			{
				role: "user",
				content:
					"I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response is equivalent to the correct answer or contains all the intermediate steps to get the correct answer, you should also answer yes. If the response only contains a subset of the information required by the answer, answer no. \n\nQuestion: What bike did I buy?\n\nCorrect Answer: Trek FX 2\n\nModel Response: You bought a Trek FX 2.\n\nIs the model response correct? Answer yes or no only.",
			},
		])
		expect(calls[0].responseFormat).toBeUndefined()
		expect(calls[0].maxTokens).toBe(10)
		expect(calls[0].temperature).toBe(0)

		expect(metrics.judgeModel).toBe(OFFICIAL_LONGMEMEVAL_QA_JUDGE_MODEL)
		expect(metrics.judgeVersion).toBe(OFFICIAL_LONGMEMEVAL_QA_JUDGE_VERSION)
		expect(metrics.caseResults).toEqual([
			{
				questionId: "q1",
				questionType: "multi-session",
				abstention: false,
				label: true,
			},
		])
	})

	it("parses labels with the official 'yes' substring rule on stripped lowercase content", async () => {
		const contents = [
			"yes",
			"YES",
			"yes.",
			" Yes\n",
			"no",
			"The response is wrong.",
			"",
			"eyes",
			"maybe",
		]
		const references = contents.map((_, index) => ({
			questionId: `q${index + 1}`,
			question: `Question ${index + 1}`,
			answer: `Answer ${index + 1}`,
			questionType: "multi-session" as const,
		}))
		const predictions = references.map((entry) => ({
			questionId: entry.questionId,
			hypothesis: "hypothesis",
		}))
		const { provider } = createStubJudgeProvider(contents)

		const metrics = await runOfficialLongMemEvalQaJudging({
			judgeProvider: provider,
			judgeModel: OFFICIAL_LONGMEMEVAL_QA_JUDGE_MODEL,
			predictions,
			references,
		})

		expect(metrics.caseResults.map((result) => result.label)).toEqual([
			true,
			true,
			true,
			true,
			false,
			false,
			false,
			true,
			false,
		])
	})

	it("routes abstention cases by the '_abs' substring rule", async () => {
		const references: OfficialQaReference[] = [
			{
				questionId: "q1_abs_2",
				question: "What is my sister's dog's name?",
				answer: "Not mentioned anywhere.",
				questionType: "single-session-user",
			},
			{
				questionId: "q2",
				question: "What bike did I buy?",
				answer: "Trek FX 2",
				questionType: "single-session-user",
			},
		]
		const { calls, provider } = createStubJudgeProvider(["yes", "yes"])

		const metrics = await runOfficialLongMemEvalQaJudging({
			judgeProvider: provider,
			judgeModel: OFFICIAL_LONGMEMEVAL_QA_JUDGE_MODEL,
			predictions: [
				{ questionId: "q1_abs_2", hypothesis: "I don't know." },
				{ questionId: "q2", hypothesis: "A Trek FX 2." },
			],
			references,
		})

		expect(calls[0].messages[0].content).toContain(
			"Does the model correctly identify the question as unanswerable?",
		)
		expect(calls[0].messages[0].content).toContain(
			"Explanation: Not mentioned anywhere.",
		)
		expect(calls[1].messages[0].content).toContain(
			"Is the model response correct?",
		)
		expect(metrics.caseResults.map((result) => result.abstention)).toEqual([
			true,
			false,
		])
	})

	it("refuses before any judge call on an unknown reference question type", async () => {
		const { calls, provider } = createStubJudgeProvider(["yes"])

		await expect(
			runOfficialLongMemEvalQaJudging({
				judgeProvider: provider,
				judgeModel: OFFICIAL_LONGMEMEVAL_QA_JUDGE_MODEL,
				predictions: [{ questionId: "q1", hypothesis: "h" }],
				references: [{ ...reference, questionType: "abstention" as never }],
			}),
		).rejects.toThrowError(OfficialLongMemEvalQaError)
		expect(calls).toHaveLength(0)
	})

	it("refuses before any judge call on a prediction without a reference entry", async () => {
		const { calls, provider } = createStubJudgeProvider(["yes"])

		await expect(
			runOfficialLongMemEvalQaJudging({
				judgeProvider: provider,
				judgeModel: OFFICIAL_LONGMEMEVAL_QA_JUDGE_MODEL,
				predictions: [{ questionId: "missing", hypothesis: "h" }],
				references: [reference],
			}),
		).rejects.toThrowError(OfficialLongMemEvalQaError)
		expect(calls).toHaveLength(0)
	})

	it("refuses before any judge call on duplicate predictions", async () => {
		const { calls, provider } = createStubJudgeProvider(["yes"])

		await expect(
			runOfficialLongMemEvalQaJudging({
				judgeProvider: provider,
				judgeModel: OFFICIAL_LONGMEMEVAL_QA_JUDGE_MODEL,
				predictions: [
					{ questionId: "q1", hypothesis: "a" },
					{ questionId: "q1", hypothesis: "b" },
				],
				references: [reference],
			}),
		).rejects.toThrowError(OfficialLongMemEvalQaError)
		expect(calls).toHaveLength(0)
	})

	it("refuses before any judge call when the judge model is not the pinned official model", async () => {
		const { calls, provider } = createStubJudgeProvider(["yes"])

		await expect(
			runOfficialLongMemEvalQaJudging({
				judgeProvider: provider,
				judgeModel: "gpt-4o",
				predictions: [{ questionId: "q1", hypothesis: "h" }],
				references: [reference],
			}),
		).rejects.toThrowError(OfficialLongMemEvalQaError)
		expect(calls).toHaveLength(0)
	})

	it("scores partial subsets without claiming full-set coverage", async () => {
		const references = buildReferences(10)
		const { calls, provider } = createStubJudgeProvider(["yes", "no"])

		const metrics = await runOfficialLongMemEvalQaJudging({
			judgeProvider: provider,
			judgeModel: OFFICIAL_LONGMEMEVAL_QA_JUDGE_MODEL,
			predictions: [
				{ questionId: "q1", hypothesis: "h1" },
				{ questionId: "q2", hypothesis: "h2" },
			],
			references,
		})

		expect(calls).toHaveLength(2)
		expect(metrics.overallAccuracy).toBe(0.5)
		expect(metrics.caseResults).toHaveLength(2)
	})
})

describe("computeOfficialLongMemEvalQaMetrics", () => {
	it("aggregates per type, task-averaged, overall, and abstention like print_qa_metrics.py", () => {
		const caseResults = [
			// single-session-user: 1 of 2
			{
				questionId: "q1",
				questionType: "single-session-user" as const,
				abstention: true,
				label: true,
			},
			{
				questionId: "q2",
				questionType: "single-session-user" as const,
				abstention: false,
				label: false,
			},
			// single-session-preference: 1 of 1
			{
				questionId: "q3",
				questionType: "single-session-preference" as const,
				abstention: false,
				label: true,
			},
			// multi-session: 2 of 3
			{
				questionId: "q4",
				questionType: "multi-session" as const,
				abstention: false,
				label: true,
			},
			{
				questionId: "q5",
				questionType: "multi-session" as const,
				abstention: true,
				label: true,
			},
			{
				questionId: "q6",
				questionType: "multi-session" as const,
				abstention: false,
				label: false,
			},
		]

		const metrics = computeOfficialLongMemEvalQaMetrics(caseResults)

		expect(metrics.perType.map((entry) => entry.questionType)).toEqual(
			OFFICIAL_QA_QUESTION_TYPE_ORDER,
		)
		const byType = new Map(
			metrics.perType.map((entry) => [entry.questionType, entry]),
		)
		expect(byType.get("single-session-user")).toEqual({
			questionType: "single-session-user",
			accuracy: 0.5,
			count: 2,
		})
		expect(byType.get("single-session-preference")).toEqual({
			questionType: "single-session-preference",
			accuracy: 1,
			count: 1,
		})
		expect(byType.get("multi-session")).toEqual({
			questionType: "multi-session",
			accuracy: 2 / 3,
			count: 3,
		})
		expect(byType.get("temporal-reasoning")).toEqual({
			questionType: "temporal-reasoning",
			accuracy: null,
			count: 0,
		})
		expect(byType.get("knowledge-update")).toEqual({
			questionType: "knowledge-update",
			accuracy: null,
			count: 0,
		})
		// Task-averaged = mean of the three present per-type means.
		expect(metrics.taskAveragedAccuracy).toBeCloseTo((0.5 + 1 + 2 / 3) / 3, 12)
		// Overall = global mean over all six cases.
		expect(metrics.overallAccuracy).toBeCloseTo(4 / 6, 12)
		// Abstention = mean over the two '_abs' cases (one yes, one yes).
		expect(metrics.abstentionAccuracy).toBe(1)
		expect(metrics.abstentionCount).toBe(2)
	})

	it("returns null accuracies for an empty corpus instead of zeros", () => {
		const metrics = computeOfficialLongMemEvalQaMetrics([])
		expect(metrics.overallAccuracy).toBeNull()
		expect(metrics.taskAveragedAccuracy).toBeNull()
		expect(metrics.abstentionAccuracy).toBeNull()
		expect(metrics.abstentionCount).toBe(0)
		expect(
			metrics.perType.every(
				(entry) => entry.accuracy === null && entry.count === 0,
			),
		).toBe(true)
	})
})

describe("validateOfficialLongMemEvalFullCoverage", () => {
	it("accepts exactly 500 unique references with a prediction for every one", () => {
		const references = buildReferences(OFFICIAL_LONGMEMEVAL_S_CASE_COUNT)
		const predictions = buildPredictions(references)
		expect(() =>
			validateOfficialLongMemEvalFullCoverage({ predictions, references }),
		).not.toThrow()
	})

	it("rejects a short reference set", () => {
		const references = buildReferences(OFFICIAL_LONGMEMEVAL_S_CASE_COUNT - 1)
		const predictions = buildPredictions(references)
		expect(() =>
			validateOfficialLongMemEvalFullCoverage({ predictions, references }),
		).toThrowError(OfficialLongMemEvalQaError)
	})

	it("rejects duplicate reference IDs", () => {
		const references = [
			...buildReferences(OFFICIAL_LONGMEMEVAL_S_CASE_COUNT - 1),
			buildReferences(OFFICIAL_LONGMEMEVAL_S_CASE_COUNT - 1)[0],
		]
		const predictions = buildPredictions(
			buildReferences(OFFICIAL_LONGMEMEVAL_S_CASE_COUNT - 1),
		)
		expect(() =>
			validateOfficialLongMemEvalFullCoverage({ predictions, references }),
		).toThrowError(OfficialLongMemEvalQaError)
	})

	it("rejects a missing prediction", () => {
		const references = buildReferences(OFFICIAL_LONGMEMEVAL_S_CASE_COUNT)
		const predictions = buildPredictions(references).slice(0, -1)
		expect(() =>
			validateOfficialLongMemEvalFullCoverage({ predictions, references }),
		).toThrowError(OfficialLongMemEvalQaError)
	})

	it("rejects duplicate predictions even when every reference is covered", () => {
		const references = buildReferences(OFFICIAL_LONGMEMEVAL_S_CASE_COUNT)
		// 501 entries: every reference predicted, plus a duplicate of q1. The
		// Set-based check collapses the duplicate, so this must be tested by
		// count, not by set membership alone.
		const predictions = [
			...buildPredictions(references),
			{
				questionId: references[0].questionId,
				hypothesis: "duplicate hypothesis",
			},
		]
		let thrown: unknown
		try {
			validateOfficialLongMemEvalFullCoverage({ predictions, references })
		} catch (error) {
			thrown = error
		}
		expect(thrown).toBeInstanceOf(OfficialLongMemEvalQaError)
		expect((thrown as OfficialLongMemEvalQaError).code).toBe(
			"duplicate-prediction",
		)
		expect((thrown as OfficialLongMemEvalQaError).message).toContain(
			"unique predictions",
		)
	})

	it("rejects predictions for unknown question ids absent from the references", () => {
		const references = buildReferences(OFFICIAL_LONGMEMEVAL_S_CASE_COUNT)
		// 501 entries: every reference predicted, plus a ghost id. Only missing
		// references were tested, so extra unknown ids slipped through.
		const predictions = [
			...buildPredictions(references),
			{ questionId: "ghost-id", hypothesis: "ghost hypothesis" },
		]
		let thrown: unknown
		try {
			validateOfficialLongMemEvalFullCoverage({ predictions, references })
		} catch (error) {
			thrown = error
		}
		expect(thrown).toBeInstanceOf(OfficialLongMemEvalQaError)
		expect((thrown as OfficialLongMemEvalQaError).code).toBe(
			"unknown-prediction",
		)
		expect((thrown as OfficialLongMemEvalQaError).message).toContain("ghost-id")
	})

	it("requires exact count and set equality, not just reference coverage", () => {
		const references = buildReferences(OFFICIAL_LONGMEMEVAL_S_CASE_COUNT)
		// 500 entries with 499 unique ids: q1 duplicated, q500 dropped. The
		// missing check alone catches the drop; exact equality must also name
		// the duplicate so the failure is diagnosable.
		const predictions = buildPredictions(references).slice(0, -1).concat({
			questionId: references[0].questionId,
			hypothesis: "duplicate hypothesis",
		})
		expect(predictions).toHaveLength(OFFICIAL_LONGMEMEVAL_S_CASE_COUNT)
		expect(() =>
			validateOfficialLongMemEvalFullCoverage({ predictions, references }),
		).toThrowError(OfficialLongMemEvalQaError)
	})
})
