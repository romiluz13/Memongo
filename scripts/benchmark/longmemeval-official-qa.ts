import type { EnrichmentProvider } from "../../packages/memory-engine/src/mongodb-llm-enrichment.js"

/**
 * Official LongMemEval QA judging, transcribed from the pinned upstream
 * evaluator:
 *
 *   xiaowu0162/LongMemEval@9e0b455f4ef0e2ab8f2e582289761153549043fc
 *   - src/evaluation/evaluate_qa.py: prompt templates, judge call, label
 *     parsing, abstention routing.
 *   - src/evaluation/print_qa_metrics.py: per-type / task-averaged / overall /
 *     abstention aggregation.
 *
 * Protocol details that change model behavior, kept byte-exact:
 * - One user message per case; no system prompt; no response format.
 * - temperature 0 and max_tokens 10 on every judge call.
 * - The official script pins `n: 1`; the OpenAI-compatible transport omits
 *   `n` (documented spec default 1) and reads `choices[0]` only, so the judge
 *   behavior is identical.
 * - label = 'yes' substring in content.strip().lower(): "yes", "YES", "yes."
 *   and even "eyes" are correct; anything without "yes" (including empty or
 *   unparseable output) is incorrect. There is no third state.
 * - Abstention is `'_abs' in question_id` (substring, not suffix).
 *
 * Deviations from the official scripts, both deliberate:
 * - The official evaluator silently skips hypothesis IDs missing from the
 *   reference data; this module refuses them (and duplicate predictions,
 *   unknown question types, and non-pinned judge models) before any judge
 *   call, so a partial run can never masquerade as a judged full set and no
 *   spend happens on a run that will be discarded.
 * - print_qa_metrics.py averages all six per-type means (an empty type would
 *   poison the average with NaN). This module averages only the types present
 *   and reports null for absent types, so partial/incremental corpora score
 *   without claiming full-set coverage; on the full 500-case set all six
 *   types are present and the numbers are identical. Full-set coverage is
 *   validated separately by validateOfficialLongMemEvalFullCoverage.
 */

export const OFFICIAL_LONGMEMEVAL_QA_JUDGE_MODEL = "gpt-4o-2024-08-06"
export const OFFICIAL_LONGMEMEVAL_QA_JUDGE_VERSION =
	"official-evaluate_qa@9e0b455f4ef0e2ab8f2e582289761153549043fc"
export const OFFICIAL_LONGMEMEVAL_S_CASE_COUNT = 500

export const OFFICIAL_QA_QUESTION_TYPE_ORDER = [
	"single-session-user",
	"single-session-preference",
	"single-session-assistant",
	"multi-session",
	"temporal-reasoning",
	"knowledge-update",
] as const

export type OfficialLongMemEvalQuestionType =
	(typeof OFFICIAL_QA_QUESTION_TYPE_ORDER)[number]

const OFFICIAL_QA_QUESTION_TYPES = new Set<string>(
	OFFICIAL_QA_QUESTION_TYPE_ORDER,
)

const TEMPLATE_GENERIC_TASK =
	"I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response is equivalent to the correct answer or contains all the intermediate steps to get the correct answer, you should also answer yes. If the response only contains a subset of the information required by the answer, answer no. \n\nQuestion: {}\n\nCorrect Answer: {}\n\nModel Response: {}\n\nIs the model response correct? Answer yes or no only."

const TEMPLATE_TEMPORAL_REASONING =
	"I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response is equivalent to the correct answer or contains all the intermediate steps to get the correct answer, you should also answer yes. If the response only contains a subset of the information required by the answer, answer no. In addition, do not penalize off-by-one errors for the number of days. If the question asks for the number of days/weeks/months, etc., and the model makes off-by-one errors (e.g., predicting 19 days when the answer is 18), the model's response is still correct. \n\nQuestion: {}\n\nCorrect Answer: {}\n\nModel Response: {}\n\nIs the model response correct? Answer yes or no only."

const TEMPLATE_KNOWLEDGE_UPDATE =
	"I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response contains some previous information along with an updated answer, the response should be considered as correct as long as the updated answer is the required answer.\n\nQuestion: {}\n\nCorrect Answer: {}\n\nModel Response: {}\n\nIs the model response correct? Answer yes or no only."

const TEMPLATE_SINGLE_SESSION_PREFERENCE =
	"I will give you a question, a rubric for desired personalized response, and a response from a model. Please answer yes if the response satisfies the desired response. Otherwise, answer no. The model does not need to reflect all the points in the rubric. The response is correct as long as it recalls and utilizes the user's personal information correctly.\n\nQuestion: {}\n\nRubric: {}\n\nModel Response: {}\n\nIs the model response correct? Answer yes or no only."

const TEMPLATE_ABSTENTION =
	"I will give you an unanswerable question, an explanation, and a response from a model. Please answer yes if the model correctly identifies the question as unanswerable. The model could say that the information is incomplete, or some other information is given but the asked information is not.\n\nQuestion: {}\n\nExplanation: {}\n\nModel Response: {}\n\nDoes the model correctly identify the question as unanswerable? Answer yes or no only."

export type OfficialQaPrediction = {
	questionId: string
	hypothesis: string
}

export type OfficialQaReference = {
	questionId: string
	question: string
	answer: string
	questionType: OfficialLongMemEvalQuestionType
}

export type OfficialQaCaseResult = {
	questionId: string
	questionType: OfficialLongMemEvalQuestionType
	abstention: boolean
	label: boolean
}

export type OfficialQaTypeMetric = {
	questionType: OfficialLongMemEvalQuestionType
	accuracy: number | null
	count: number
}

export type OfficialLongMemEvalQaMetrics = {
	judgeModel: string
	judgeVersion: string
	overallAccuracy: number | null
	taskAveragedAccuracy: number | null
	abstentionAccuracy: number | null
	abstentionCount: number
	perType: OfficialQaTypeMetric[]
	caseResults: OfficialQaCaseResult[]
}

export type OfficialLongMemEvalQaErrorCode =
	| "unsupported-question-type"
	| "duplicate-prediction"
	| "unknown-prediction"
	| "duplicate-reference"
	| "judge-model"
	| "coverage"

export class OfficialLongMemEvalQaError extends Error {
	readonly code: OfficialLongMemEvalQaErrorCode

	constructor(message: string, code: OfficialLongMemEvalQaErrorCode) {
		super(message)
		this.name = "OfficialLongMemEvalQaError"
		this.code = code
	}
}

function formatThreeSlots(
	template: string,
	first: string,
	second: string,
	third: string,
): string {
	let filled = ""
	let rest = template
	for (const value of [first, second, third]) {
		const slot = rest.indexOf("{}")
		if (slot === -1) {
			throw new Error("official QA template lost a {} slot")
		}
		filled += rest.slice(0, slot) + value
		rest = rest.slice(slot + 2)
	}
	return filled + rest
}

export function isOfficialAbstentionQuestion(questionId: string): boolean {
	return questionId.includes("_abs")
}

export function buildOfficialAnscheckPrompt(input: {
	questionType: string
	question: string
	goldAnswer: string
	hypothesis: string
	abstention: boolean
}): string {
	if (input.abstention) {
		return formatThreeSlots(
			TEMPLATE_ABSTENTION,
			input.question,
			input.goldAnswer,
			input.hypothesis,
		)
	}
	let template: string
	switch (input.questionType) {
		case "single-session-user":
		case "single-session-assistant":
		case "multi-session":
			template = TEMPLATE_GENERIC_TASK
			break
		case "temporal-reasoning":
			template = TEMPLATE_TEMPORAL_REASONING
			break
		case "knowledge-update":
			template = TEMPLATE_KNOWLEDGE_UPDATE
			break
		case "single-session-preference":
			template = TEMPLATE_SINGLE_SESSION_PREFERENCE
			break
		default:
			throw new OfficialLongMemEvalQaError(
				`question_type not supported by the official evaluator: ${input.questionType}`,
				"unsupported-question-type",
			)
	}
	return formatThreeSlots(
		template,
		input.question,
		input.goldAnswer,
		input.hypothesis,
	)
}

function mean(values: number[]): number {
	return values.reduce((total, value) => total + value, 0) / values.length
}

export function computeOfficialLongMemEvalQaMetrics(
	caseResults: OfficialQaCaseResult[],
): OfficialLongMemEvalQaMetrics {
	const perType = OFFICIAL_QA_QUESTION_TYPE_ORDER.map((questionType) => {
		const labels = caseResults
			.filter((result) => result.questionType === questionType)
			.map((result) => (result.label ? 1 : 0))
		return {
			questionType,
			accuracy: labels.length > 0 ? mean(labels) : null,
			count: labels.length,
		}
	})
	const typeAccuracies = perType
		.map((entry) => entry.accuracy)
		.filter((accuracy): accuracy is number => accuracy !== null)
	const allLabels = caseResults.map((result) => (result.label ? 1 : 0))
	const abstentionLabels = caseResults
		.filter((result) => result.abstention)
		.map((result) => (result.label ? 1 : 0))
	return {
		judgeModel: OFFICIAL_LONGMEMEVAL_QA_JUDGE_MODEL,
		judgeVersion: OFFICIAL_LONGMEMEVAL_QA_JUDGE_VERSION,
		overallAccuracy: allLabels.length > 0 ? mean(allLabels) : null,
		taskAveragedAccuracy:
			typeAccuracies.length > 0 ? mean(typeAccuracies) : null,
		abstentionAccuracy:
			abstentionLabels.length > 0 ? mean(abstentionLabels) : null,
		abstentionCount: abstentionLabels.length,
		perType,
		caseResults,
	}
}

export async function runOfficialLongMemEvalQaJudging(input: {
	judgeProvider: Pick<EnrichmentProvider, "chatCompletion">
	judgeModel: string
	predictions: OfficialQaPrediction[]
	references: OfficialQaReference[]
}): Promise<OfficialLongMemEvalQaMetrics> {
	if (input.judgeModel !== OFFICIAL_LONGMEMEVAL_QA_JUDGE_MODEL) {
		throw new OfficialLongMemEvalQaError(
			`official LongMemEval QA judging requires judge model ${OFFICIAL_LONGMEMEVAL_QA_JUDGE_MODEL}, got ${input.judgeModel}`,
			"judge-model",
		)
	}

	const referenceById = new Map<string, OfficialQaReference>()
	for (const reference of input.references) {
		if (referenceById.has(reference.questionId)) {
			throw new OfficialLongMemEvalQaError(
				`duplicate reference entry for question_id ${reference.questionId}`,
				"duplicate-reference",
			)
		}
		referenceById.set(reference.questionId, reference)
	}
	const predictedIds = new Set<string>()
	for (const prediction of input.predictions) {
		if (predictedIds.has(prediction.questionId)) {
			throw new OfficialLongMemEvalQaError(
				`duplicate prediction for question_id ${prediction.questionId}`,
				"duplicate-prediction",
			)
		}
		predictedIds.add(prediction.questionId)
		if (!referenceById.has(prediction.questionId)) {
			throw new OfficialLongMemEvalQaError(
				`prediction for ${prediction.questionId} has no reference entry; the official evaluator would silently skip it`,
				"unknown-prediction",
			)
		}
	}
	for (const reference of input.references) {
		if (!OFFICIAL_QA_QUESTION_TYPES.has(reference.questionType)) {
			throw new OfficialLongMemEvalQaError(
				`question_type not supported by the official evaluator: ${reference.questionType} (question_id ${reference.questionId})`,
				"unsupported-question-type",
			)
		}
	}

	const caseResults: OfficialQaCaseResult[] = []
	for (const prediction of input.predictions) {
		const reference = referenceById.get(prediction.questionId)
		if (!reference) {
			throw new OfficialLongMemEvalQaError(
				`prediction for ${prediction.questionId} has no reference entry`,
				"unknown-prediction",
			)
		}
		const abstention = isOfficialAbstentionQuestion(reference.questionId)
		const prompt = buildOfficialAnscheckPrompt({
			questionType: reference.questionType,
			question: reference.question,
			goldAnswer: reference.answer,
			hypothesis: prediction.hypothesis,
			abstention,
		})
		const completion = await input.judgeProvider.chatCompletion({
			model: OFFICIAL_LONGMEMEVAL_QA_JUDGE_MODEL,
			messages: [{ role: "user", content: prompt }],
			maxTokens: 10,
			temperature: 0,
		})
		const label = completion.content.trim().toLowerCase().includes("yes")
		caseResults.push({
			questionId: reference.questionId,
			questionType: reference.questionType,
			abstention,
			label,
		})
	}
	return computeOfficialLongMemEvalQaMetrics(caseResults)
}

export function validateOfficialLongMemEvalFullCoverage(input: {
	predictions: OfficialQaPrediction[]
	references: OfficialQaReference[]
}): void {
	const referenceIds = input.references.map((reference) => reference.questionId)
	const uniqueIds = new Set(referenceIds)
	if (
		referenceIds.length !== OFFICIAL_LONGMEMEVAL_S_CASE_COUNT ||
		uniqueIds.size !== OFFICIAL_LONGMEMEVAL_S_CASE_COUNT
	) {
		throw new OfficialLongMemEvalQaError(
			`full-set coverage requires exactly ${OFFICIAL_LONGMEMEVAL_S_CASE_COUNT} unique reference question_ids, got ${referenceIds.length} entries (${uniqueIds.size} unique)`,
			"coverage",
		)
	}
	const predictedIds = input.predictions.map(
		(prediction) => prediction.questionId,
	)
	const uniquePredictedIds = new Set(predictedIds)
	if (predictedIds.length !== uniquePredictedIds.size) {
		throw new OfficialLongMemEvalQaError(
			`full-set coverage requires unique predictions; got ${predictedIds.length} prediction entries (${uniquePredictedIds.size} unique)`,
			"duplicate-prediction",
		)
	}
	const unknown = predictedIds.filter((id) => !uniqueIds.has(id))
	if (unknown.length > 0) {
		throw new OfficialLongMemEvalQaError(
			`full-set coverage found predictions for question ids absent from the reference set; ${unknown.length} unknown (first: ${unknown[0]})`,
			"unknown-prediction",
		)
	}
	const missing = referenceIds.filter((id) => !uniquePredictedIds.has(id))
	if (missing.length > 0) {
		throw new OfficialLongMemEvalQaError(
			`full-set coverage requires a prediction for every reference question; ${missing.length} missing (first: ${missing[0]})`,
			"coverage",
		)
	}
	if (predictedIds.length !== OFFICIAL_LONGMEMEVAL_S_CASE_COUNT) {
		throw new OfficialLongMemEvalQaError(
			`full-set coverage requires exactly ${OFFICIAL_LONGMEMEVAL_S_CASE_COUNT} predictions matching the reference ids, got ${predictedIds.length}`,
			"coverage",
		)
	}
}
