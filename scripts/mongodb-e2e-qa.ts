import { createSubsystemLogger } from "@memongo/lib"
import type {
	EnrichmentChatUsage,
	EnrichmentProvider,
} from "../packages/memory-engine/src/mongodb-llm-enrichment.js"
import type {
	BenchmarkAnswerAttempt,
	BenchmarkAnswerFinishReason,
	BenchmarkProviderCallStatus,
	BenchmarkCaseContextDiagnostics,
	BenchmarkE2eQaEnvelope,
	MemoryResultRole,
} from "../packages/memory-engine/src/types.js"
import {
	buildCaseContextDiagnostics,
	describeDiagnosticsFailure,
	type Pass0ContextDiagnostics,
} from "./benchmark/benchmark-context-diagnostics.js"
import {
	renderDatedPassageLines,
	renderDatedQuestionLine,
} from "./benchmark/dated-answer-context.js"
import {
	type ClassifiedVerdict,
	classifyAnswerResponse,
	classifyJudgeResponse,
	TRANSPORT_FAILURE_ATTEMPT,
} from "./mongodb-e2e-qa-answer-attempt.js"

/**
 * End-to-end QA: answer generation + LLM judge (issue #24 / Wave 4).
 *
 * P4.1: moved out of the shipped engine (`packages/memory-engine/src/`) into
 * `scripts/` — this is dev-only benchmark calibration machinery, not production
 * code. The production manager no longer calls it; `scripts/run-benchmark.ts`
 * is the canonical entry point for benchmark runs.
 *
 * The benchmark harness measured retrieval recall only; `e2eQa` — the answer
 * accuracy every memory leaderboard actually reports (LoCoMo methodology) — was
 * a permanently-null envelope with no producer. This module fills it: for each
 * QA case it generates an answer from the retrieved context, then an LLM judge
 * scores it against the gold answer.
 *
 * Honesty guardrails:
 *  - An unparseable judge response counts as INCORRECT, never a silent pass.
 *  - A decoy probe judges a known-WRONG answer for every case; the rate at which
 *    the judge passes those decoys is reported as `judgeFalsePositiveRate`, so a
 *    lenient judge inflating accuracy is visible rather than hidden.
 */

const log = createSubsystemLogger("memory:mongodb:e2e-qa")

// Bump when the answer/judge prompts change so runs remain comparable.
export const E2E_QA_JUDGE_VERSION = "v1"
// custom-v2 changes only the answer user content (question and passage
// dates, passage roles); it is recorded under its own version.
const E2E_QA_DATED_JUDGE_VERSION = "v2"

/**
 * The QA protocols this harness runs. custom-v2 is custom-v1 with the
 * question date and each passage's date(s) and role in the answer request,
 * passages kept in rank order.
 */
export type E2eQaProtocol = "custom-v1" | "custom-v2"

const ANSWER_MAX_TOKENS = 512
const JUDGE_MAX_TOKENS = 512
const MAX_CONTEXT_PASSAGES = 20

type E2eQaProviderOperation =
	| "answer-generation"
	| "answer-judge"
	| "decoy-judge"
type ProviderCallOutcome = "attempted" | "succeeded" | "failed"
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

const ANSWER_SYSTEM_PROMPT = `You answer the QUESTION using ONLY the provided context passages from a user's memory.
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

export async function generateAnswer(params: {
	provider: EnrichmentProvider
	model: string
	question: string
	contextPassages: string[]
	/** custom-v2 only: index-aligned with contextPassages. */
	dated?: {
		questionDate?: string
		passageDates?: string[][]
		passageRoles?: Array<MemoryResultRole | undefined>
	}
	onFailure?: (error: Error) => void
	onAttempt?: (attempt: BenchmarkAnswerAttempt) => void
	onProviderCall?: ProviderCallObserver
}): Promise<string> {
	const passages = params.contextPassages.slice(0, MAX_CONTEXT_PASSAGES)
	const context = params.dated
		? renderDatedPassageLines(
				{
					contextPassages: params.contextPassages,
					passageDates: params.dated.passageDates,
					passageRoles: params.dated.passageRoles,
				},
				passages.map((_, index) => index),
			).join("\n")
		: passages.map((p, i) => `[${i + 1}] ${p}`).join("\n")
	const user = [
		params.dated
			? renderDatedQuestionLine(params.question, params.dated.questionDate)
			: `QUESTION: ${params.question}`,
		"<context>",
		context,
		"</context>",
		'Return only {"answer":"..."}.',
	].join("\n")

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
			maxTokens: ANSWER_MAX_TOKENS,
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
			maxTokens: JUDGE_MAX_TOKENS,
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

export type E2eQaCase = {
	caseId: string
	question: string
	goldAnswer: string
	contextPassages: string[]
	/** Index-aligned with contextPassages; rendered only under custom-v2. */
	questionDate?: string
	passageDates?: string[][]
	passageRoles?: Array<MemoryResultRole | undefined>
	abstention?: boolean
	upstreamFailure?: string
	diagnostics?: Pass0ContextDiagnostics
	diagnosticsError?: string
}

function caseDiagnostics(testCase: E2eQaCase): BenchmarkCaseContextDiagnostics {
	if (testCase.diagnosticsError !== undefined) {
		return { diagnosticsError: testCase.diagnosticsError }
	}
	if (!testCase.diagnostics) return {}
	try {
		return buildCaseContextDiagnostics({
			contextPassages: testCase.contextPassages,
			maxPassages: MAX_CONTEXT_PASSAGES,
			diagnostics: testCase.diagnostics,
		})
	} catch (error) {
		const message = describeDiagnosticsFailure(error)
		log.warn("case context diagnostics failed", {
			caseId: testCase.caseId,
			error: message,
		})
		return { diagnosticsError: message }
	}
}

// Common phrasings for "I have no answer" — the correct response to an
// abstention case, graded by refusal rather than fact-match.
export function isAbstaining(answer: string): boolean {
	const a = answer.trim().toLowerCase()
	if (a === "") return true
	return /\b(i don'?t know|no information|not (mentioned|available|specified|stated|in the context)|cannot answer|unknown|unsure|no relevant)\b/.test(
		a,
	)
}

// A KNOWN-WRONG answer for the false-positive probe: the gold answer from a case
// with BOTH a different question and a different gold, so it should not satisfy
// this question. Returns null when no such decoy exists (e.g. a single case or a
// homogeneous set) — the FP metric is then reported as "not measured" (null)
// rather than a falsely-reassuring 0 obtained from nonsense the judge trivially
// rejects.
function pickDecoy(cases: E2eQaCase[], index: number): string | null {
	const mineGold = cases[index].goldAnswer.trim().toLowerCase()
	const mineQuestion = cases[index].question.trim().toLowerCase()
	for (let offset = 1; offset < cases.length; offset++) {
		const other = cases[(index + offset) % cases.length]
		if (
			other.goldAnswer.trim().toLowerCase() !== mineGold &&
			other.question.trim().toLowerCase() !== mineQuestion &&
			other.goldAnswer.trim() !== ""
		) {
			return other.goldAnswer
		}
	}
	return null
}

/**
 * Run answer-generation + judging over QA cases and aggregate the envelope.
 * Empty case set yields an all-null envelope (nothing measured).
 */
export async function runE2eQa(params: {
	provider: EnrichmentProvider
	model: string
	answerModel?: string
	judgeModel?: string
	cases: E2eQaCase[]
	/** Absent runs custom-v1. */
	protocol?: E2eQaProtocol
	judgeVersion?: string
	onProviderCall?: (
		operation: E2eQaProviderOperation,
		outcome: ProviderCallOutcome,
		usage?: EnrichmentChatUsage,
		call?: E2eQaCallResult,
	) => void
}): Promise<BenchmarkE2eQaEnvelope> {
	const { provider, model, cases } = params
	const answerModel = params.answerModel ?? model
	const judgeModel = params.judgeModel ?? model
	const dated = params.protocol === "custom-v2"
	const judgeVersion =
		params.judgeVersion ??
		(dated ? E2E_QA_DATED_JUDGE_VERSION : E2E_QA_JUDGE_VERSION)
	if (cases.length === 0) {
		return {
			answerModel: null,
			judge: null,
			judgeVersion: null,
			accuracy: null,
			latencyMs: null,
			judgeFalsePositiveRate: null,
			cases: { eligible: 0, attempted: 0, completed: 0, failed: 0 },
			attempts: { answerGeneration: 0, answerJudge: 0, decoyJudge: 0 },
			caseResults: [],
		}
	}

	let correctCount = 0
	let decoyProbes = 0
	let decoyPasses = 0
	let totalLatency = 0
	let completedCases = 0
	let failedCases = 0
	let answerGenerationAttempts = 0
	let answerJudgeAttempts = 0
	let decoyJudgeAttempts = 0
	const caseResults: BenchmarkE2eQaEnvelope["caseResults"] = []

	for (let i = 0; i < cases.length; i++) {
		const testCase = cases[i]
		const startedAt = Date.now()
		if (testCase.upstreamFailure) {
			failedCases += 1
			caseResults.push({
				caseId: testCase.caseId,
				candidateAnswer: "",
				correct: false,
				abstention: testCase.abstention === true,
				latencyMs: 0,
				error: `retrieval: ${testCase.upstreamFailure}`,
			})
			continue
		}
		let caseError: string | undefined
		let answerAttempt: BenchmarkAnswerAttempt | undefined
		answerGenerationAttempts += 1
		const candidate = await generateAnswer({
			provider,
			model: answerModel,
			question: testCase.question,
			contextPassages: testCase.contextPassages,
			...(dated
				? {
						dated: {
							questionDate: testCase.questionDate,
							passageDates: testCase.passageDates,
							passageRoles: testCase.passageRoles,
						},
					}
				: {}),
			onProviderCall: (outcome, usage, call) =>
				params.onProviderCall?.("answer-generation", outcome, usage, call),
			onAttempt: (attempt) => {
				answerAttempt = attempt
			},
			onFailure: (error) => {
				caseError = `answer-generation: ${error.message}`
			},
		})

		if (testCase.abstention) {
			// Correct behavior for an abstention case is to decline, not to match a
			// gold fact — grade by refusal. No decoy probe (there is no wrong fact
			// to plant against a "no answer" gold).
			const correct = !caseError && isAbstaining(candidate)
			if (correct) correctCount += 1
			const latencyMs = Date.now() - startedAt
			totalLatency += latencyMs
			if (caseError) failedCases += 1
			else completedCases += 1
			caseResults.push({
				caseId: testCase.caseId,
				candidateAnswer: candidate,
				correct,
				abstention: true,
				latencyMs,
				...(caseError ? { error: caseError } : {}),
				...(answerAttempt ? { answerAttempt } : {}),
				...caseDiagnostics(testCase),
			})
			continue
		}

		let correct = false
		if (!caseError) {
			answerJudgeAttempts += 1
			const verdict = await judgeAnswer({
				provider,
				model: judgeModel,
				question: testCase.question,
				goldAnswer: testCase.goldAnswer,
				candidateAnswer: candidate,
				onProviderCall: (outcome, usage, call) =>
					params.onProviderCall?.("answer-judge", outcome, usage, call),
				onFailure: (error) => {
					caseError = `answer-judge: ${error.message}`
				},
			})
			correct = !caseError && verdict.correct
			if (correct) correctCount += 1
		}

		// Calibration probe: a genuinely-wrong decoy should be judged incorrect.
		// Only run it when a viable decoy exists, so the FP rate reflects real
		// probes rather than trivially-rejected nonsense.
		const decoy = pickDecoy(cases, i)
		if (decoy !== null && !caseError) {
			decoyJudgeAttempts += 1
			const decoyVerdict = await judgeAnswer({
				provider,
				model: judgeModel,
				question: testCase.question,
				goldAnswer: testCase.goldAnswer,
				candidateAnswer: decoy,
				onProviderCall: (outcome, usage, call) =>
					params.onProviderCall?.("decoy-judge", outcome, usage, call),
				onFailure: (error) => {
					caseError = `decoy-judge: ${error.message}`
				},
			})
			if (!caseError) {
				decoyProbes += 1
				if (decoyVerdict.correct) decoyPasses += 1
			}
		}
		const latencyMs = Date.now() - startedAt
		totalLatency += latencyMs
		if (caseError) failedCases += 1
		else completedCases += 1
		caseResults.push({
			caseId: testCase.caseId,
			candidateAnswer: candidate,
			correct,
			abstention: false,
			latencyMs,
			...(caseError ? { error: caseError } : {}),
			...(answerAttempt ? { answerAttempt } : {}),
			...caseDiagnostics(testCase),
		})
	}

	return {
		answerModel,
		judge: judgeModel,
		judgeVersion,
		// Failures remain attempted and deflate accuracy. The empty set returned
		// above retains explicit unavailable semantics.
		accuracy: correctCount / cases.length,
		latencyMs: totalLatency / cases.length,
		// Null (not 0) when no viable decoy could be constructed — an unmeasured
		// probe must not read as a perfectly-calibrated judge.
		judgeFalsePositiveRate: decoyProbes > 0 ? decoyPasses / decoyProbes : null,
		cases: {
			eligible: cases.length,
			attempted: cases.length,
			completed: completedCases,
			failed: failedCases,
		},
		attempts: {
			answerGeneration: answerGenerationAttempts,
			answerJudge: answerJudgeAttempts,
			decoyJudge: decoyJudgeAttempts,
		},
		caseResults,
	}
}
