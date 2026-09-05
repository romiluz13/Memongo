import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
	buildJudgedAnswerCases,
	buildUnavailableE2eQaEnvelope,
	mergeLongMemEvalAnswerQuality,
	runBenchmarkJudgedAnswers,
	type BenchmarkJudgedAnswerMaterial,
} from "./benchmark-answer-quality.js"
import type {
	MemoryBenchmarkEvaluatorIdentity,
	MemoryBenchmarkOfficialMetrics,
} from "../../packages/memory-engine/src/types.js"

const evaluatorIdentity: MemoryBenchmarkEvaluatorIdentity = {
	suite: "longmemeval",
	sourceRepository: "xiaowu0162/LongMemEval",
	sourceCommit: "test-commit",
	evaluatorPath: "src/retrieval/eval_utils.py",
	evaluatorBlob: "test-blob",
	aggregationEntrypoint: "src/retrieval/run_retrieval.py",
	cutoffs: [5, 10],
	eligibilityPolicy: "exclude-abstention-and-no-user-answer-target",
	candidateProjection: "native-source-attribution-flattened",
	comparability: "canonical",
}

describe("buildUnavailableE2eQaEnvelope", () => {
	it("produces an all-null envelope that states its reason instead of zeroing", () => {
		const envelope = buildUnavailableE2eQaEnvelope({
			reason: "no enrichment provider configured",
			eligibleCases: 7,
		})
		expect(envelope).toEqual({
			answerModel: null,
			judge: null,
			judgeVersion: null,
			accuracy: null,
			latencyMs: null,
			judgeFalsePositiveRate: null,
			cases: { eligible: 7, attempted: 0, completed: 0, failed: 0 },
			attempts: { answerGeneration: 0, answerJudge: 0, decoyJudge: 0 },
			caseResults: [],
			unavailableReason: "no enrichment provider configured",
		})
	})
})

describe("buildJudgedAnswerCases", () => {
	it("excludes non-abstention cases without a gold answer", () => {
		const material = new Map<string, BenchmarkJudgedAnswerMaterial>([
			[
				"case-1",
				{
					caseId: "case-1",
					question: "what is the project deadline?",
					goldAnswer: "August 21",
					abstention: false,
					contextPassages: ["deadline is August 21"],
				},
			],
			[
				"case-2",
				{
					caseId: "case-2",
					question: "what is the office wifi password?",
					goldAnswer: "  ",
					abstention: false,
					contextPassages: ["irrelevant"],
				},
			],
		])
		const { cases, excludedNoGold } = buildJudgedAnswerCases(material)
		expect(excludedNoGold).toBe(1)
		expect(cases.map((entry) => entry.caseId)).toEqual(["case-1"])
	})

	it("keeps abstention cases and upstream failures", () => {
		const material = new Map<string, BenchmarkJudgedAnswerMaterial>([
			[
				"case-1",
				{
					caseId: "case-1",
					question: "what is the office wifi password?",
					goldAnswer: "",
					abstention: true,
					contextPassages: [],
				},
			],
			[
				"case-2",
				{
					caseId: "case-2",
					question: "what happened?",
					goldAnswer: "something",
					abstention: false,
					contextPassages: [],
					upstreamFailure: "search timed out",
				},
			],
		])
		const { cases } = buildJudgedAnswerCases(material)
		expect(cases).toHaveLength(2)
		expect(cases[0]?.abstention).toBe(true)
		expect(cases[1]?.upstreamFailure).toBe("search timed out")
	})
})

describe("mergeLongMemEvalAnswerQuality", () => {
	const baseMetrics: MemoryBenchmarkOfficialMetrics = {
		longMemEval: {
			evaluator: evaluatorIdentity,
			totalCases: 4,
			eligibleCases: 4,
			retrievalCases: 4,
			abstentionCases: 0,
			ineligibleCases: 0,
			projectionFailureCases: 0,
			executionFailureCases: 0,
		},
	}

	it("is a no-op without longMemEval metrics or an envelope", () => {
		expect(
			mergeLongMemEvalAnswerQuality({
				officialMetrics: undefined,
				e2eQa: buildUnavailableE2eQaEnvelope({
					reason: "x",
					eligibleCases: 0,
				}),
			}),
		).toBeUndefined()
		expect(
			mergeLongMemEvalAnswerQuality({ officialMetrics: baseMetrics }),
		).toBe(baseMetrics)
	})

	it("projects the envelope into answerQuality without mutating the input", () => {
		const merged = mergeLongMemEvalAnswerQuality({
			officialMetrics: baseMetrics,
			e2eQa: {
				answerModel: "answer-model",
				judge: "judge-model",
				judgeVersion: "v1",
				accuracy: 0.875,
				latencyMs: 20,
				judgeFalsePositiveRate: 0,
				cases: { eligible: 8, attempted: 8, completed: 8, failed: 0 },
				attempts: { answerGeneration: 8, answerJudge: 8, decoyJudge: 8 },
				caseResults: [],
			},
		})
		expect(merged?.longMemEval?.answerQuality).toEqual({
			answerModel: "answer-model",
			judge: "judge-model",
			judgeVersion: "v1",
			accuracy: 0.875,
			judgeFalsePositiveRate: 0,
			eligibleCases: 8,
			completedCases: 8,
		})
		expect(baseMetrics.longMemEval?.answerQuality).toBeUndefined()
		// untouched sibling fields survive the merge
		expect(merged?.longMemEval?.retrievalCases).toBe(4)
	})

	it("carries unavailableReason when accuracy was not measured", () => {
		const merged = mergeLongMemEvalAnswerQuality({
			officialMetrics: baseMetrics,
			e2eQa: buildUnavailableE2eQaEnvelope({
				reason: "no enrichment provider configured",
				eligibleCases: 4,
			}),
		})
		expect(merged?.longMemEval?.answerQuality?.accuracy).toBeNull()
		expect(merged?.longMemEval?.answerQuality?.unavailableReason).toBe(
			"no enrichment provider configured",
		)
	})
})

describe("runBenchmarkJudgedAnswers", () => {
	const ENV_KEYS = [
		"MEMONGO_ENRICHMENT_API_KEY",
		"MEMONGO_ENRICHMENT_BASE_URL",
		"MEMONGO_ENRICHMENT_MODEL",
	] as const
	const saved: Record<string, string | undefined> = {}

	beforeEach(() => {
		for (const key of ENV_KEYS) {
			saved[key] = process.env[key]
			delete process.env[key]
		}
	})

	afterEach(() => {
		for (const key of ENV_KEYS) {
			if (saved[key] === undefined) {
				delete process.env[key]
			} else {
				process.env[key] = saved[key]
			}
		}
	})

	it("returns undefined for datasets outside the answer-accuracy contract scope", async () => {
		const envelope = await runBenchmarkJudgedAnswers({
			datasetKind: "locomo",
			materialByCaseId: new Map(),
			resumedFromCheckpoint: false,
		})
		expect(envelope).toBeUndefined()
	})

	it("reports unavailable (never zero) when the provider is not configured", async () => {
		const material = new Map<string, BenchmarkJudgedAnswerMaterial>([
			[
				"case-1",
				{
					caseId: "case-1",
					question: "q",
					goldAnswer: "a",
					abstention: false,
					contextPassages: ["p"],
				},
			],
		])
		const envelope = await runBenchmarkJudgedAnswers({
			datasetKind: "longmemeval",
			materialByCaseId: material,
			resumedFromCheckpoint: false,
		})
		expect(envelope?.accuracy).toBeNull()
		expect(envelope?.unavailableReason).toContain(
			"no enrichment provider configured",
		)
	})

	it("reports unavailable for checkpoint-resumed runs (pass-0 passages are not replayable)", async () => {
		const envelope = await runBenchmarkJudgedAnswers({
			datasetKind: "longmemeval",
			materialByCaseId: new Map(),
			resumedFromCheckpoint: true,
		})
		expect(envelope?.accuracy).toBeNull()
		expect(envelope?.unavailableReason).toContain("run resumed from checkpoint")
	})

	it("reports unavailable when no answer-bearing cases were captured", async () => {
		const envelope = await runBenchmarkJudgedAnswers({
			datasetKind: "longmemeval",
			materialByCaseId: new Map(),
			resumedFromCheckpoint: false,
		})
		expect(envelope?.accuracy).toBeNull()
		expect(envelope?.unavailableReason).toContain(
			"no answer-bearing evaluation cases",
		)
	})

	it("reports unavailable when the provider env is partially configured", async () => {
		process.env.MEMONGO_ENRICHMENT_API_KEY = "test-key"
		const material = new Map<string, BenchmarkJudgedAnswerMaterial>([
			[
				"case-1",
				{
					caseId: "case-1",
					question: "q",
					goldAnswer: "a",
					abstention: false,
					contextPassages: ["p"],
				},
			],
		])
		const envelope = await runBenchmarkJudgedAnswers({
			datasetKind: "longmemeval",
			materialByCaseId: material,
			resumedFromCheckpoint: false,
		})
		expect(envelope?.accuracy).toBeNull()
		expect(envelope?.unavailableReason).toContain(
			"enrichment provider misconfigured",
		)
	})
})
