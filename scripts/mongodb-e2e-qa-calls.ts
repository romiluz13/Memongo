import { createSubsystemLogger } from "@memongo/lib"
import type {
	EnrichmentChatUsage,
	EnrichmentProvider,
} from "../packages/memory-engine/src/mongodb-llm-enrichment.js"
import type {
	BenchmarkAnswerAttempt,
	BenchmarkAnswerFinishReason,
	BenchmarkProviderCallStatus,
} from "../packages/memory-engine/src/types.js"
import {
	type DatedAnswerPassages,
	renderDatedPassageLines,
	renderDatedQuestionLine,
} from "./benchmark/dated-answer-context.js"
import {
	type ClassifiedVerdict,
	classifyAnswerResponse,
	classifyJudgeResponse,
	TRANSPORT_FAILURE_ATTEMPT,
} from "./mongodb-e2e-qa-answer-attempt.js"

/** The answer and judge provider calls of the end-to-end QA harness. */

const log = createSubsystemLogger("memory:mongodb:e2e-qa")

// A thinking model's hidden thought tokens count against the output limit, so
// a small cap truncates or empties the answer. Equal for every custom arm.
export const CUSTOM_QA_ANSWER_MAX_TOKENS = 8192
export const CUSTOM_QA_JUDGE_MAX_TOKENS = 8192
export const MAX_CONTEXT_PASSAGES = 20

export type E2eQaProviderOperation =
	| "answer-generation"
	| "answer-judge"
	| "decoy-judge"
export type ProviderCallOutcome = "attempted" | "succeeded" | "failed"
/** Fixed outcome of an ended call; never response or error text. */
export type E2eQaCallResult = {
	status: BenchmarkProviderCallStatus
	finishReason?: BenchmarkAnswerFinishReason
}
type ProviderCallObserver = (
	outcome: ProviderCallOutcome,
	usage?: EnrichmentChatUsage,
	call?: E2eQaCallResult,
) => void

function callResult(
	status: BenchmarkProviderCallStatus,
	finishReason: BenchmarkAnswerFinishReason | undefined,
): E2eQaCallResult {
	return finishReason === undefined ? { status } : { status, finishReason }
}

// Observer errors are swallowed on purpose: a broken observer must never
// fail (or retry) a provider call that actually succeeded or failed.
function recordProviderCall(
	observer: ProviderCallObserver | undefined,
	outcome: ProviderCallOutcome,
	usage?: EnrichmentChatUsage,
	call?: E2eQaCallResult,
): void {
	try {
		observer?.(outcome, usage, call)
	} catch (error) {
		log.warn("E2E QA provider-call observer failed", { error })
	}
}

export const ANSWER_SYSTEM_PROMPT = `You answer the QUESTION using ONLY the provided context passages from a user's memory.
Rules:
- Be concise and factual; answer with just the fact asked for.
- If the context does not contain enough information to answer, return an empty answer string.
- Do not use outside knowledge.
Return JSON only: {"answer":"<concise answer, or empty string>"}`

const JUDGE_SYSTEM_PROMPT = `You are a strict grader for a memory QA benchmark.
Decide whether the CANDIDATE ANSWER correctly answers the QUESTION, using the GOLD ANSWER as ground truth.
Rules:
- Semantic equivalence counts as correct (paraphrases, extra correct detail are fine).
- A wrong fact, a missing required fact, or an unsupported guess is incorrect.
- Judge only against the gold answer; do not invent new criteria.
Return JSON only: {"correct":true|false,"rationale":"<one sentence>"}`

/**
 * What the answer request carries: custom-v1 passages, custom-v2 dated
 * passages (dates and roles index-aligned with `contextPassages`), or the
 * whole custom-v3 user content, sent as is.
 */
export type AnswerContent =
	| { kind: "passages"; contextPassages: string[] }
	| ({ kind: "dated-passages"; questionDate?: string } & DatedAnswerPassages)
	| { kind: "reader"; userContent: string }

/** The custom-v1 and custom-v2 user content: question line and passages. */
function passageUserContent(
	question: string,
	content: Exclude<AnswerContent, { kind: "reader" }>,
): string {
	const passages = content.contextPassages.slice(0, MAX_CONTEXT_PASSAGES)
	const dated = content.kind === "dated-passages"
	const context = dated
		? renderDatedPassageLines(
				content,
				passages.map((_, index) => index),
			).join("\n")
		: passages.map((p, i) => `[${i + 1}] ${p}`).join("\n")
	return [
		dated
			? renderDatedQuestionLine(question, content.questionDate)
			: `QUESTION: ${question}`,
		"<context>",
		context,
		"</context>",
		'Return only {"answer":"..."}.',
	].join("\n")
}

export async function generateAnswer(params: {
	provider: EnrichmentProvider
	model: string
	question: string
	content: AnswerContent
	onFailure?: (error: Error) => void
	onAttempt?: (attempt: BenchmarkAnswerAttempt) => void
	onProviderCall?: ProviderCallObserver
}): Promise<string> {
	const user =
		params.content.kind === "reader"
			? params.content.userContent
			: passageUserContent(params.question, params.content)

	recordProviderCall(params.onProviderCall, "attempted")
	let response: Awaited<ReturnType<EnrichmentProvider["chatCompletion"]>>
	try {
		response = await params.provider.chatCompletion({
			model: params.model,
			messages: [
				{ role: "system", content: ANSWER_SYSTEM_PROMPT },
				{ role: "user", content: user },
			],
			responseFormat: { type: "json_object" },
			maxTokens: CUSTOM_QA_ANSWER_MAX_TOKENS,
		})
	} catch {
		recordProviderCall(params.onProviderCall, "failed", undefined, {
			status: TRANSPORT_FAILURE_ATTEMPT.status,
		})
		return answerFailure(params, { ...TRANSPORT_FAILURE_ATTEMPT })
	}
	// The transport succeeded: record success with any usage it reported and
	// the fixed classification, so a malformed response neither loses billed
	// usage nor double-counts as a transport failure.
	const { attempt, answer } = classifyAnswerResponse(response)
	recordProviderCall(
		params.onProviderCall,
		"succeeded",
		response.usage,
		callResult(attempt.status, attempt.finishReason),
	)
	if (answer === undefined) return answerFailure(params, attempt)
	params.onAttempt?.(attempt)
	return answer
}

// Only the fixed status is reported: provider error text and parser messages
// can quote the response body.
function answerFailure(
	params: {
		onFailure?: (error: Error) => void
		onAttempt?: (attempt: BenchmarkAnswerAttempt) => void
	},
	attempt: BenchmarkAnswerAttempt,
): string {
	params.onAttempt?.(attempt)
	params.onFailure?.(new Error(attempt.status))
	log.warn("answer generation failed", {
		status: attempt.status,
		...(attempt.shape ? { shape: attempt.shape } : {}),
		...(attempt.finishReason ? { finishReason: attempt.finishReason } : {}),
	})
	return ""
}

export async function judgeAnswer(params: {
	provider: EnrichmentProvider
	model: string
	question: string
	goldAnswer: string
	candidateAnswer: string
	onFailure?: (error: Error) => void
	onProviderCall?: ProviderCallObserver
}): Promise<{ correct: boolean; rationale: string }> {
	const user = [
		`QUESTION: ${params.question}`,
		`GOLD ANSWER: ${params.goldAnswer}`,
		`CANDIDATE ANSWER: ${params.candidateAnswer}`,
		'Return only {"correct":...,"rationale":"..."}.',
	].join("\n")

	recordProviderCall(params.onProviderCall, "attempted")
	let response: Awaited<ReturnType<EnrichmentProvider["chatCompletion"]>>
	try {
		response = await params.provider.chatCompletion({
			model: params.model,
			messages: [
				{ role: "system", content: JUDGE_SYSTEM_PROMPT },
				{ role: "user", content: user },
			],
			responseFormat: { type: "json_object" },
			maxTokens: CUSTOM_QA_JUDGE_MAX_TOKENS,
		})
	} catch {
		recordProviderCall(params.onProviderCall, "failed", undefined, {
			status: "transport-failure",
		})
		return judgeFailure(params, { status: "transport-failure" })
	}
	// Transport success is recorded with its usage and fixed classification,
	// so an unparseable verdict keeps billed usage and is not re-counted as a
	// transport failure; it degrades to INCORRECT below, never a silent pass.
	const judged = classifyJudgeResponse(response)
	recordProviderCall(
		params.onProviderCall,
		"succeeded",
		response.usage,
		callResult(judged.status, judged.evidence?.finishReason),
	)
	return judged.verdict ?? judgeFailure(params, judged)
}

// Only the fixed status is reported: provider error text and parser messages
// can quote the response body.
function judgeFailure(
	params: { onFailure?: (error: Error) => void },
	judged: ClassifiedVerdict,
): { correct: boolean; rationale: string } {
	params.onFailure?.(new Error(judged.status))
	log.warn("answer judging failed", {
		status: judged.status,
		...(judged.evidence?.shape ? { shape: judged.evidence.shape } : {}),
		...(judged.evidence?.finishReason
			? { finishReason: judged.evidence.finishReason }
			: {}),
	})
	return { correct: false, rationale: "judge-error" }
}
