import { createSubsystemLogger } from "@memongo/lib"
import type {
	EnrichmentChatUsage,
	EnrichmentProvider,
} from "../packages/memory-engine/src/mongodb-llm-enrichment.js"
import type {
	BenchmarkAnswerAttempt,
	BenchmarkCaseContextDiagnostics,
	BenchmarkE2eQaEnvelope,
} from "../packages/memory-engine/src/types.js"
import {
	buildCaseContextDiagnostics,
	describeDiagnosticsFailure,
	type Pass0ContextDiagnostics,
} from "./benchmark/benchmark-context-diagnostics.js"
import type { DatedAnswerPassages } from "./benchmark/dated-answer-context.js"
import {
	buildReaderContext,
	READER_BUDGET_ESTIMATED_TOKENS,
	type ReaderContext,
	type ReaderUnit,
} from "./benchmark/reader-budget.js"
import {
	ANSWER_READER_CONTRACT,
	type AnswerContent,
	type E2eQaCallResult,
	type E2eQaProviderOperation,
	generateAnswer,
	judgeAnswer,
	MAX_CONTEXT_PASSAGES,
	type ProviderCallOutcome,
	V4_READER_CONTRACT,
} from "./mongodb-e2e-qa-calls.js"
import {
	type AnswerCallUsage,
	buildReaderCaseDiagnostics,
	type ReaderBudgetCalibration,
	type ReaderBudgetCaseRecord,
	type ReaderPositionTerciles,
	readerBudgetCalibration,
	readerBudgetCaseRecord,
	readerPositionTerciles,
} from "./mongodb-e2e-qa-reader-budget.js"

export {
	type E2eQaCallResult,
	generateAnswer,
	judgeAnswer,
} from "./mongodb-e2e-qa-calls.js"

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
// custom-v3 changes the answer user content again (budgeted round units in
// official session form).
const E2E_QA_READER_BUDGET_JUDGE_VERSION = "v3"
// custom-v4 changes the answer system prompt and return line (the reader
// contract); the judge request stays identical to custom-v1 to custom-v3.
const E2E_QA_READER_CONTRACT_JUDGE_VERSION = "v4"

/**
 * The QA protocols this harness runs. custom-v2 is custom-v1 with the
 * question date and each passage's date(s) and role in the answer request,
 * passages kept in rank order. custom-v3 admits round units under the
 * reader token budget and renders them as official dated sessions.
 * custom-v4 sends custom-v3's reader content under the v4 reader contract.
 */
export type E2eQaProtocol =
	| "custom-v1"
	| "custom-v2"
	| "custom-v3"
	| "custom-v4"

const CUSTOM_HARNESS_PROTOCOLS: ReadonlySet<string> = new Set<E2eQaProtocol>([
	"custom-v1",
	"custom-v2",
	"custom-v3",
	"custom-v4",
])

/** Protocols this harness answers and judges (not official or custom-judge). */
export function isCustomHarnessProtocol(
	protocol: string | undefined,
): protocol is E2eQaProtocol {
	return protocol !== undefined && CUSTOM_HARNESS_PROTOCOLS.has(protocol)
}

/** Protocols that admit reader units under the reader token budget. */
export function isReaderBudgetProtocol(
	protocol: string | undefined,
): protocol is "custom-v3" | "custom-v4" {
	return protocol === "custom-v3" || protocol === "custom-v4"
}

/** custom-v3 adds the harness-side reader budget records to the envelope. */
export type E2eQaEnvelope = BenchmarkE2eQaEnvelope & {
	readerBudgetCalibration?: ReaderBudgetCalibration
	readerPositionTerciles?: ReaderPositionTerciles
	/** Only with a decoy pool: the probe counts behind judgeFalsePositiveRate. */
	decoyProbes?: { probes: number; passes: number }
}

/** Passage dates and roles render only under custom-v2; the question date under custom-v2 and custom-v3. */
export type E2eQaCase = DatedAnswerPassages & {
	caseId: string
	question: string
	goldAnswer: string
	questionDate?: string
	/** custom-v3 only: every candidate unit, before admission. */
	readerUnits?: ReaderUnit[]
	abstention?: boolean
	upstreamFailure?: string
	diagnostics?: Pass0ContextDiagnostics
	diagnosticsError?: string
}

function caseDiagnostics(
	testCase: E2eQaCase,
	reader: ReaderContext | undefined,
): BenchmarkCaseContextDiagnostics {
	if (testCase.diagnosticsError !== undefined) {
		return { diagnosticsError: testCase.diagnosticsError }
	}
	if (!testCase.diagnostics) return {}
	try {
		if (reader) {
			return buildReaderCaseDiagnostics(
				testCase.readerUnits as ReaderUnit[],
				testCase.diagnostics,
				reader,
			)
		}
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

/** A decoy source: another case's question and gold answer. */
export type E2eQaDecoyCandidate = Pick<
	E2eQaCase,
	"caseId" | "question" | "goldAnswer"
>

// A KNOWN-WRONG answer for the false-positive probe: the gold answer from a case
// with BOTH a different question and a different gold, so it should not satisfy
// this question. Returns null when no such decoy exists (e.g. a single case or a
// homogeneous set) — the FP metric is then reported as "not measured" (null)
// rather than a falsely-reassuring 0 obtained from nonsense the judge trivially
// rejects.
function pickDecoy(
	cases: readonly E2eQaDecoyCandidate[],
	index: number,
): string | null {
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
	/**
	 * Decoys come from this pool instead of `cases`, so judging one question
	 * at a time probes the decoy a whole-run batch would. Every case must be
	 * in it.
	 */
	decoyPool?: readonly E2eQaDecoyCandidate[]
	onProviderCall?: (
		operation: E2eQaProviderOperation,
		outcome: ProviderCallOutcome,
		usage?: EnrichmentChatUsage,
		call?: E2eQaCallResult,
	) => void
}): Promise<E2eQaEnvelope> {
	const { provider, model, cases } = params
	const decoyPool = params.decoyPool ?? cases
	const decoyIndex = (testCase: E2eQaCase, index: number) =>
		params.decoyPool
			? params.decoyPool.findIndex((entry) => entry.caseId === testCase.caseId)
			: index
	const outsidePool = cases.find(
		(testCase, index) => decoyIndex(testCase, index) < 0,
	)
	if (outsidePool) {
		throw new Error(`case ${outsidePool.caseId} is not in the decoy pool`)
	}
	const answerModel = params.answerModel ?? model
	const judgeModel = params.judgeModel ?? model
	const dated = params.protocol === "custom-v2"
	const budgeted = isReaderBudgetProtocol(params.protocol)
	const contract =
		params.protocol === "custom-v4"
			? V4_READER_CONTRACT
			: ANSWER_READER_CONTRACT
	const judgeVersion =
		params.judgeVersion ??
		(params.protocol === "custom-v4"
			? E2E_QA_READER_CONTRACT_JUDGE_VERSION
			: budgeted
				? E2E_QA_READER_BUDGET_JUDGE_VERSION
				: dated
					? E2E_QA_DATED_JUDGE_VERSION
					: E2E_QA_JUDGE_VERSION)
	if (budgeted) {
		const bare = cases.find(
			(testCase) => !testCase.upstreamFailure && !testCase.readerUnits,
		)
		if (bare) {
			throw new Error(
				`${params.protocol} case ${bare.caseId} has no reader units`,
			)
		}
	}
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

	let decoyProbes = 0
	let decoyPasses = 0
	let answerGenerationAttempts = 0
	let answerJudgeAttempts = 0
	let decoyJudgeAttempts = 0
	const caseResults: BenchmarkE2eQaEnvelope["caseResults"] = []

	for (let i = 0; i < cases.length; i++) {
		const testCase = cases[i]
		const startedAt = Date.now()
		if (testCase.upstreamFailure) {
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
		const reader = budgeted
			? buildReaderContext({
					units: testCase.readerUnits as ReaderUnit[],
					question: testCase.question,
					questionDate: testCase.questionDate,
					budget: READER_BUDGET_ESTIMATED_TOKENS,
					returnLine: contract.returnLine,
				})
			: undefined
		const answerUsage: AnswerCallUsage = { inputTokens: null }
		const content: AnswerContent = reader
			? { kind: "reader", userContent: reader.userContent }
			: dated
				? {
						kind: "dated-passages",
						questionDate: testCase.questionDate,
						contextPassages: testCase.contextPassages,
						passageDates: testCase.passageDates,
						passageRoles: testCase.passageRoles,
					}
				: { kind: "passages", contextPassages: testCase.contextPassages }
		const candidate = await generateAnswer({
			provider,
			model: answerModel,
			question: testCase.question,
			content,
			contract,
			onProviderCall: (outcome, usage, call) => {
				if (outcome !== "attempted") {
					answerUsage.inputTokens = usage ? usage.inputTokens : null
				}
				params.onProviderCall?.("answer-generation", outcome, usage, call)
			},
			onAttempt: (attempt) => {
				answerAttempt = attempt
			},
			onFailure: (error) => {
				caseError = `answer-generation: ${error.message}`
			},
		})

		const diagnostics = caseDiagnostics(testCase, reader)
		const readerBudget = reader
			? readerBudgetCaseRecord(reader, answerUsage, diagnostics)
			: undefined
		const budgetRecord = readerBudget ? { readerBudget } : {}

		if (testCase.abstention) {
			// Correct behavior for an abstention case is to decline, not to match a
			// gold fact — grade by refusal. No decoy probe (there is no wrong fact
			// to plant against a "no answer" gold).
			const correct = !caseError && isAbstaining(candidate)
			const latencyMs = Date.now() - startedAt
			caseResults.push({
				caseId: testCase.caseId,
				candidateAnswer: candidate,
				correct,
				abstention: true,
				latencyMs,
				...(caseError ? { error: caseError } : {}),
				...(answerAttempt ? { answerAttempt } : {}),
				...diagnostics,
				...budgetRecord,
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
		}

		// Calibration probe: a genuinely-wrong decoy should be judged incorrect.
		// Only run it when a viable decoy exists, so the FP rate reflects real
		// probes rather than trivially-rejected nonsense.
		const decoy = pickDecoy(decoyPool, decoyIndex(testCase, i))
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
		caseResults.push({
			caseId: testCase.caseId,
			candidateAnswer: candidate,
			correct,
			abstention: false,
			latencyMs,
			...(caseError ? { error: caseError } : {}),
			...(answerAttempt ? { answerAttempt } : {}),
			...diagnostics,
			...budgetRecord,
		})
	}

	const measured = measureE2eQaCases({
		caseResults,
		decoyProbes: { probes: decoyProbes, passes: decoyPasses },
		protocol: params.protocol,
	})
	const envelope: E2eQaEnvelope = {
		answerModel,
		judge: judgeModel,
		judgeVersion,
		// Failures remain attempted and deflate accuracy. The empty set returned
		// above retains explicit unavailable semantics.
		accuracy: measured.accuracy,
		latencyMs: measured.latencyMs,
		judgeFalsePositiveRate: measured.judgeFalsePositiveRate,
		cases: measured.cases,
		attempts: {
			answerGeneration: answerGenerationAttempts,
			answerJudge: answerJudgeAttempts,
			decoyJudge: decoyJudgeAttempts,
		},
		caseResults,
		...(params.decoyPool
			? { decoyProbes: { probes: decoyProbes, passes: decoyPasses } }
			: {}),
		...measured.reader,
	}
	return envelope
}

/**
 * What an envelope reports about a set of judged case results: accuracy and
 * mean latency over every case (a failure stays attempted and deflates
 * accuracy), the decoy false-positive rate, case counts and, under
 * custom-v3, the reader budget records.
 */
export function measureE2eQaCases(params: {
	caseResults: BenchmarkE2eQaEnvelope["caseResults"]
	decoyProbes: { probes: number; passes: number }
	protocol: E2eQaProtocol | undefined
}): Pick<
	E2eQaEnvelope,
	"accuracy" | "latencyMs" | "judgeFalsePositiveRate" | "cases"
> & {
	reader: Pick<
		E2eQaEnvelope,
		"readerBudgetCalibration" | "readerPositionTerciles"
	>
} {
	const { caseResults, decoyProbes } = params
	const total = caseResults.length
	const failed = caseResults.filter((result) => result.error).length
	return {
		accuracy:
			total > 0
				? caseResults.filter((result) => result.correct).length / total
				: null,
		latencyMs:
			total > 0
				? caseResults.reduce((sum, result) => sum + result.latencyMs, 0) / total
				: null,
		// Null (not 0) when no viable decoy could be constructed — an unmeasured
		// probe must not read as a perfectly-calibrated judge.
		judgeFalsePositiveRate:
			decoyProbes.probes > 0 ? decoyProbes.passes / decoyProbes.probes : null,
		cases: {
			eligible: total,
			attempted: total,
			completed: total - failed,
			failed,
		},
		reader: isReaderBudgetProtocol(params.protocol)
			? {
					readerBudgetCalibration: readerBudgetCalibration(
						caseResults.flatMap((result) =>
							result.readerBudget
								? [result.readerBudget as ReaderBudgetCaseRecord]
								: [],
						),
						READER_BUDGET_ESTIMATED_TOKENS,
					),
					readerPositionTerciles: readerPositionTerciles(caseResults),
				}
			: {},
	}
}
