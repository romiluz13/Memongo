import { createSubsystemLogger } from "@memongo/lib"
import type { EnrichmentProvider } from "./mongodb-llm-enrichment.js"
import type { BenchmarkE2eQaEnvelope } from "./types.js"

/**
 * End-to-end QA: answer generation + LLM judge (issue #24 / Wave 4).
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

const ANSWER_MAX_TOKENS = 512
const JUDGE_MAX_TOKENS = 512
const MAX_CONTEXT_PASSAGES = 20

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

function stripFences(content: string): string {
	return content.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/i, "")
}

export async function generateAnswer(params: {
	provider: EnrichmentProvider
	model: string
	question: string
	contextPassages: string[]
}): Promise<string> {
	const context = params.contextPassages
		.slice(0, MAX_CONTEXT_PASSAGES)
		.map((p, i) => `[${i + 1}] ${p}`)
		.join("\n")
	const user = [
		`QUESTION: ${params.question}`,
		"<context>",
		context,
		"</context>",
		'Return only {"answer":"..."}.',
	].join("\n")

	try {
		const response = await params.provider.chatCompletion({
			model: params.model,
			messages: [
				{ role: "system", content: ANSWER_SYSTEM_PROMPT },
				{ role: "user", content: user },
			],
			responseFormat: { type: "json_object" },
			maxTokens: ANSWER_MAX_TOKENS,
		})
		const parsed = JSON.parse(stripFences(response.content)) as {
			answer?: unknown
		}
		return typeof parsed.answer === "string" ? parsed.answer.trim() : ""
	} catch (err) {
		log.warn("answer generation failed", {
			error: err instanceof Error ? err.message : String(err),
		})
		return ""
	}
}

export async function judgeAnswer(params: {
	provider: EnrichmentProvider
	model: string
	question: string
	goldAnswer: string
	candidateAnswer: string
}): Promise<{ correct: boolean; rationale: string }> {
	const user = [
		`QUESTION: ${params.question}`,
		`GOLD ANSWER: ${params.goldAnswer}`,
		`CANDIDATE ANSWER: ${params.candidateAnswer}`,
		'Return only {"correct":...,"rationale":"..."}.',
	].join("\n")

	try {
		const response = await params.provider.chatCompletion({
			model: params.model,
			messages: [
				{ role: "system", content: JUDGE_SYSTEM_PROMPT },
				{ role: "user", content: user },
			],
			responseFormat: { type: "json_object" },
			maxTokens: JUDGE_MAX_TOKENS,
		})
		const parsed = JSON.parse(stripFences(response.content)) as {
			correct?: unknown
			rationale?: unknown
		}
		return {
			// An unparseable/ambiguous verdict is never a silent pass.
			correct: parsed.correct === true,
			rationale:
				typeof parsed.rationale === "string" ? parsed.rationale.trim() : "",
		}
	} catch (err) {
		log.warn("answer judging failed", {
			error: err instanceof Error ? err.message : String(err),
		})
		return { correct: false, rationale: "judge-error" }
	}
}

export type E2eQaCase = {
	caseId: string
	question: string
	goldAnswer: string
	contextPassages: string[]
	abstention?: boolean
}

// A wrong answer for the false-positive probe: another case's gold answer (which
// should NOT satisfy this question), or a fixed nonsense fallback when the set
// is too small/homogeneous to borrow one.
function pickDecoy(cases: E2eQaCase[], index: number): string {
	const mine = cases[index].goldAnswer.trim().toLowerCase()
	for (let offset = 1; offset < cases.length; offset++) {
		const other = cases[(index + offset) % cases.length]
		if (other.goldAnswer.trim().toLowerCase() !== mine) {
			return other.goldAnswer
		}
	}
	return "a completely unrelated placeholder answer (7f3a-decoy)"
}

/**
 * Run answer-generation + judging over QA cases and aggregate the envelope.
 * Empty case set yields an all-null envelope (nothing measured).
 */
export async function runE2eQa(params: {
	provider: EnrichmentProvider
	model: string
	cases: E2eQaCase[]
	judgeVersion?: string
}): Promise<BenchmarkE2eQaEnvelope> {
	const { provider, model, cases } = params
	const judgeVersion = params.judgeVersion ?? E2E_QA_JUDGE_VERSION
	if (cases.length === 0) {
		return {
			judge: null,
			judgeVersion: null,
			accuracy: null,
			latencyMs: null,
			judgeFalsePositiveRate: null,
		}
	}

	let correctCount = 0
	let decoyPassCount = 0
	let totalLatency = 0

	for (let i = 0; i < cases.length; i++) {
		const testCase = cases[i]
		const startedAt = Date.now()
		const candidate = await generateAnswer({
			provider,
			model,
			question: testCase.question,
			contextPassages: testCase.contextPassages,
		})
		const verdict = await judgeAnswer({
			provider,
			model,
			question: testCase.question,
			goldAnswer: testCase.goldAnswer,
			candidateAnswer: candidate,
		})
		totalLatency += Date.now() - startedAt
		if (verdict.correct) correctCount += 1

		// Calibration probe: a known-wrong decoy should be judged incorrect.
		const decoyVerdict = await judgeAnswer({
			provider,
			model,
			question: testCase.question,
			goldAnswer: testCase.goldAnswer,
			candidateAnswer: pickDecoy(cases, i),
		})
		if (decoyVerdict.correct) decoyPassCount += 1
	}

	return {
		judge: model,
		judgeVersion,
		accuracy: correctCount / cases.length,
		latencyMs: totalLatency / cases.length,
		judgeFalsePositiveRate: decoyPassCount / cases.length,
	}
}
