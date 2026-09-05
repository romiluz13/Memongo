/**
 * C-039: LLM-judged answer accuracy for the LongMemEval benchmark contract.
 *
 * The official LongMemEval protocol scores answer quality (J score) on top of
 * retrieval; until now the contract measured retrieval only, so published
 * numbers were not comparable to the official protocol. This module:
 *
 *   1. Harvests pass-0 retrieval results (top snippets per evaluation case)
 *      into QA cases for the shared answer+judge harness (`runE2eQa`).
 *   2. Runs the harness with the enrichment provider and records its LLM
 *      calls into the run-scoped cost accounting.
 *   3. Merges the measured envelope into `officialMetrics.longMemEval`
 *      (`answerQuality`) so the published envelope carries the answer half.
 *
 * Unavailable accuracy is never silently zeroed: the envelope carries null
 * metrics plus an `unavailableReason`, and the release gate fails with that
 * reason. A number only exists when it was actually measured.
 */

import { createSubsystemLogger } from "@memongo/lib"
import { resolveEnrichmentProvider } from "../../packages/memory-engine/src/mongodb-llm-enrichment.js"
import type { BenchmarkRunAccounting } from "./benchmark-parity-envelope.js"
import type { E2eQaCase } from "../mongodb-e2e-qa.js"
import { runE2eQa } from "../mongodb-e2e-qa.js"
import type {
	BenchmarkE2eQaEnvelope,
	MemoryBenchmarkDatasetKind,
	MemoryBenchmarkOfficialMetrics,
} from "../../packages/memory-engine/src/types.js"

const log = createSubsystemLogger("benchmark:answer-quality")

/**
 * QA material captured per evaluation case during the pass-0 retrieval loop.
 * `contextPassages` are the snippets of the pass-0 search results; the gold
 * answer and abstention flag come from the dataset's evaluation metadata.
 */
export type BenchmarkJudgedAnswerMaterial = {
	caseId: string
	question: string
	goldAnswer: string
	abstention: boolean
	contextPassages: string[]
	upstreamFailure?: string
}

/** All-null envelope with the reason accuracy was not measured. */
export function buildUnavailableE2eQaEnvelope(params: {
	reason: string
	eligibleCases: number
}): BenchmarkE2eQaEnvelope {
	return {
		answerModel: null,
		judge: null,
		judgeVersion: null,
		accuracy: null,
		latencyMs: null,
		judgeFalsePositiveRate: null,
		cases: {
			eligible: params.eligibleCases,
			attempted: 0,
			completed: 0,
			failed: 0,
		},
		attempts: { answerGeneration: 0, answerJudge: 0, decoyJudge: 0 },
		caseResults: [],
		unavailableReason: params.reason,
	}
}

/**
 * Project the QA envelope into `officialMetrics.longMemEval.answerQuality`.
 * Pure: returns the input unchanged when there is nothing to merge (no
 * LongMemEval metrics or no envelope), so legacy and loCoMo runs pass
 * through untouched.
 */
export function mergeLongMemEvalAnswerQuality(params: {
	officialMetrics?: MemoryBenchmarkOfficialMetrics
	e2eQa?: BenchmarkE2eQaEnvelope
}): MemoryBenchmarkOfficialMetrics | undefined {
	const { officialMetrics, e2eQa } = params
	if (!officialMetrics?.longMemEval || !e2eQa) {
		return officialMetrics
	}
	return {
		...officialMetrics,
		longMemEval: {
			...officialMetrics.longMemEval,
			answerQuality: {
				answerModel: e2eQa.answerModel,
				judge: e2eQa.judge,
				judgeVersion: e2eQa.judgeVersion,
				accuracy: e2eQa.accuracy,
				judgeFalsePositiveRate: e2eQa.judgeFalsePositiveRate,
				eligibleCases: e2eQa.cases.eligible,
				completedCases: e2eQa.cases.completed,
				...(e2eQa.unavailableReason
					? { unavailableReason: e2eQa.unavailableReason }
					: {}),
			},
		},
	}
}

/**
 * Turn captured material into QA cases. Non-abstention cases without a gold
 * answer have no measurable target (the judge needs a fact to grade against)
 * and are excluded rather than graded against an empty string.
 */
export function buildJudgedAnswerCases(
	materialByCaseId: Map<string, BenchmarkJudgedAnswerMaterial>,
): { cases: E2eQaCase[]; excludedNoGold: number } {
	const cases: E2eQaCase[] = []
	let excludedNoGold = 0
	for (const material of materialByCaseId.values()) {
		if (!material.abstention && material.goldAnswer.trim() === "") {
			excludedNoGold += 1
			continue
		}
		cases.push({
			caseId: material.caseId,
			question: material.question,
			goldAnswer: material.goldAnswer,
			contextPassages: material.contextPassages,
			...(material.abstention ? { abstention: true } : {}),
			...(material.upstreamFailure
				? { upstreamFailure: material.upstreamFailure }
				: {}),
		})
	}
	return { cases, excludedNoGold }
}

/**
 * Run judged answers for a benchmark scenario pass. Returns undefined for
 * datasets without an answer-accuracy contract (scope: LongMemEval), and an
 * all-null envelope — never a fabricated zero — when accuracy cannot be
 * measured (no provider, no material, resumed from checkpoint).
 */
export async function runBenchmarkJudgedAnswers(params: {
	datasetKind?: MemoryBenchmarkDatasetKind | "legacy-query"
	materialByCaseId: Map<string, BenchmarkJudgedAnswerMaterial>
	resumedFromCheckpoint: boolean
	accounting?: BenchmarkRunAccounting
}): Promise<BenchmarkE2eQaEnvelope | undefined> {
	if (params.datasetKind !== "longmemeval") {
		return undefined
	}
	if (params.resumedFromCheckpoint) {
		return buildUnavailableE2eQaEnvelope({
			reason:
				"run resumed from checkpoint: pass-0 retrieval passages are not replayable, so judged answer accuracy was not measured; re-run the full benchmark to publish answer accuracy",
			eligibleCases: params.materialByCaseId.size,
		})
	}
	const { cases, excludedNoGold } = buildJudgedAnswerCases(
		params.materialByCaseId,
	)
	if (excludedNoGold > 0) {
		log.warn("benchmark judged answers: excluded cases without a gold answer", {
			excluded: excludedNoGold,
		})
	}
	if (cases.length === 0) {
		return buildUnavailableE2eQaEnvelope({
			reason:
				"no answer-bearing evaluation cases captured in pass 0, so judged answer accuracy was not measured",
			eligibleCases: 0,
		})
	}
	let provider = null
	try {
		provider = resolveEnrichmentProvider(process.env)
	} catch (error) {
		return buildUnavailableE2eQaEnvelope({
			reason: `enrichment provider misconfigured: ${error instanceof Error ? error.message : String(error)}`,
			eligibleCases: cases.length,
		})
	}
	if (!provider) {
		return buildUnavailableE2eQaEnvelope({
			reason:
				"no enrichment provider configured (set MEMONGO_ENRICHMENT_API_KEY, MEMONGO_ENRICHMENT_BASE_URL, MEMONGO_ENRICHMENT_MODEL): judged answer accuracy not measured",
			eligibleCases: cases.length,
		})
	}
	const model = process.env.MEMONGO_ENRICHMENT_MODEL?.trim() ?? ""
	if (!model) {
		return buildUnavailableE2eQaEnvelope({
			reason:
				"MEMONGO_ENRICHMENT_MODEL is not set, so the answer/judge model is unknown",
			eligibleCases: cases.length,
		})
	}
	log.info("benchmark judged answers: generating and judging", {
		cases: cases.length,
		model,
	})
	const envelope = await runE2eQa({
		provider,
		model,
		cases,
		...(params.accounting
			? {
					onProviderCall: (operation, outcome) => {
						const metadata = { provider: provider?.name, model }
						if (outcome === "attempted") {
							params.accounting?.recordAttempt(operation, metadata)
						} else if (outcome === "succeeded") {
							params.accounting?.recordSuccess(operation, metadata)
						} else {
							params.accounting?.recordFailure(operation, metadata)
						}
					},
				}
			: {}),
	})
	log.info("benchmark judged answers complete", {
		accuracy: envelope.accuracy,
		completed: envelope.cases.completed,
		failed: envelope.cases.failed,
	})
	return envelope
}
