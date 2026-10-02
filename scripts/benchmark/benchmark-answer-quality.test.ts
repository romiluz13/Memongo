import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
	buildJudgedAnswerCases,
	buildUnavailableE2eQaEnvelope,
	mergeLongMemEvalAnswerQuality,
	runBenchmarkJudgedAnswers,
	type BenchmarkJudgedAnswerMaterial,
} from "./benchmark-answer-quality.js"
import type { BenchmarkRunAccounting } from "./benchmark-parity-envelope.js"
import { runE2eQa } from "../mongodb-e2e-qa.js"
import type {
	MemoryBenchmarkEvaluatorIdentity,
	MemoryBenchmarkOfficialMetrics,
} from "../../packages/memory-engine/src/types.js"

// The harness is exercised through its own unit suite; here it is stubbed so
// the benchmark-contract layer can be tested without LLM calls.
vi.mock("../mongodb-e2e-qa.js", () => ({ runE2eQa: vi.fn() }))

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

	it("projects the official summary into longMemEval.answerQuality.official (Slice B, additive)", () => {
		const official = {
			protocol: "official-anscheck" as const,
			coverage: "full" as const,
			overallAccuracy: 0.75,
			taskAveragedAccuracy: 0.7,
			abstentionAccuracy: 0.5,
			abstentionCount: 2,
			perType: [
				{ questionType: "single-session-user", accuracy: 0.8, count: 5 },
				{ questionType: "temporal-reasoning", accuracy: 0.6, count: 5 },
			],
			missingQuestionIds: [],
			lostPreCheckpointQuestionIds: [],
			accountingCompleteness: "complete" as const,
			export: { kind: "full" as const, path: "out.jsonl", rows: 10 },
		}
		const merged = mergeLongMemEvalAnswerQuality({
			officialMetrics: baseMetrics,
			e2eQa: {
				answerModel: "answer-model",
				judge: "judge-model",
				judgeVersion: "v1",
				accuracy: 0.75,
				latencyMs: null,
				judgeFalsePositiveRate: 0,
				cases: { eligible: 10, attempted: 10, completed: 10, failed: 0 },
				attempts: { answerGeneration: 10, answerJudge: 10, decoyJudge: 0 },
				caseResults: [],
				official,
			},
		})
		expect(merged?.longMemEval?.answerQuality?.official).toEqual(official)
		// The legacy answerQuality projection still happens alongside.
		expect(merged?.longMemEval?.answerQuality?.accuracy).toBe(0.75)
		// No unreleased `officialQa` sibling on longMemEval: the nested
		// answerQuality.official location is the only projection. (The field is
		// gone from the type, so the sibling check reads through a widening
		// cast on purpose.)
		expect(
			(merged?.longMemEval as { officialQa?: unknown } | undefined)?.officialQa,
		).toBeUndefined()
		expect(baseMetrics.longMemEval?.answerQuality?.official).toBeUndefined()
	})

	it("leaves answerQuality.official absent for envelopes without an official block", () => {
		const merged = mergeLongMemEvalAnswerQuality({
			officialMetrics: baseMetrics,
			e2eQa: {
				answerModel: "answer-model",
				judge: "judge-model",
				judgeVersion: "v1",
				accuracy: 0.5,
				latencyMs: 20,
				judgeFalsePositiveRate: 0,
				cases: { eligible: 2, attempted: 2, completed: 2, failed: 0 },
				attempts: { answerGeneration: 2, answerJudge: 2, decoyJudge: 0 },
				caseResults: [],
			},
		})
		expect(merged?.longMemEval?.answerQuality?.official).toBeUndefined()
		expect(
			(merged?.longMemEval as { officialQa?: unknown } | undefined)?.officialQa,
		).toBeUndefined()
	})

	it("projects a customJudge envelope into longMemEval.answerQuality.customJudge and omits official (custom-judge integration)", () => {
		const customJudge = {
			protocol: "custom-judge-anscheck" as const,
			judgeModel: "gpt-5.6-luna",
			coverage: "full" as const,
			overallAccuracy: 0.75,
			taskAveragedAccuracy: 0.7,
			abstentionAccuracy: 0.5,
			abstentionCount: 2,
			perType: [
				{ questionType: "single-session-user", accuracy: 0.8, count: 5 },
				{ questionType: "temporal-reasoning", accuracy: 0.6, count: 5 },
			],
			missingQuestionIds: [],
			lostPreCheckpointQuestionIds: [],
			accountingCompleteness: "complete" as const,
			export: {
				kind: "full" as const,
				path: "out.custom-judge.jsonl",
				rows: 10,
			},
		}
		const merged = mergeLongMemEvalAnswerQuality({
			officialMetrics: baseMetrics,
			e2eQa: {
				answerModel: "answer-model",
				judge: "gpt-5.6-luna",
				judgeVersion: "v1",
				accuracy: 0.75,
				latencyMs: null,
				judgeFalsePositiveRate: 0,
				cases: { eligible: 10, attempted: 10, completed: 10, failed: 0 },
				attempts: { answerGeneration: 10, answerJudge: 10, decoyJudge: 0 },
				caseResults: [],
				customJudge,
			},
		})
		expect(merged?.longMemEval?.answerQuality?.customJudge).toEqual(customJudge)
		// A custom-judge envelope carries no official summary: the official
		// block must be omitted by construction, never fabricated.
		expect(merged?.longMemEval?.answerQuality?.official).toBeUndefined()
		expect(merged?.longMemEval?.answerQuality?.accuracy).toBe(0.75)
		expect(baseMetrics.longMemEval?.answerQuality?.customJudge).toBeUndefined()
	})
})

describe("runBenchmarkJudgedAnswers", () => {
	const ENV_KEYS = [
		"MEMONGO_ENRICHMENT_API_KEY",
		"MEMONGO_ENRICHMENT_BASE_URL",
		"MEMONGO_ENRICHMENT_MODEL",
		"MEMONGO_BENCHMARK_JUDGE_MODEL",
	] as const
	const saved: Record<string, string | undefined> = {}

	const oneAnswerMaterial = () =>
		new Map<string, BenchmarkJudgedAnswerMaterial>([
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

	beforeEach(() => {
		for (const key of ENV_KEYS) {
			saved[key] = process.env[key]
			delete process.env[key]
		}
		vi.mocked(runE2eQa).mockReset()
		// Default stub so tests that (wrongly) reach the harness fail on their
		// policy assertions instead of crashing on an undefined envelope.
		vi.mocked(runE2eQa).mockImplementation(async () =>
			buildUnavailableE2eQaEnvelope({
				reason: "stubbed harness",
				eligibleCases: 0,
			}),
		)
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
			"no benchmark answer provider configured",
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
			"benchmark answer provider misconfigured",
		)
	})

	it("reports unavailable when the required judge model is not configured", async () => {
		process.env.MEMONGO_ENRICHMENT_API_KEY = "test-key"
		process.env.MEMONGO_ENRICHMENT_BASE_URL = "https://bench.example.invalid"
		process.env.MEMONGO_ENRICHMENT_MODEL = "answer-model"
		const envelope = await runBenchmarkJudgedAnswers({
			datasetKind: "longmemeval",
			materialByCaseId: oneAnswerMaterial(),
			resumedFromCheckpoint: false,
		})
		expect(envelope?.accuracy).toBeNull()
		expect(envelope?.unavailableReason).toContain(
			"MEMONGO_BENCHMARK_JUDGE_MODEL",
		)
		// The refusal happens before any QA call is attempted.
		expect(runE2eQa).not.toHaveBeenCalled()
	})

	it("reports unavailable when the judge model equals the answer model", async () => {
		process.env.MEMONGO_ENRICHMENT_API_KEY = "test-key"
		process.env.MEMONGO_ENRICHMENT_BASE_URL = "https://bench.example.invalid"
		process.env.MEMONGO_ENRICHMENT_MODEL = "answer-model"
		process.env.MEMONGO_BENCHMARK_JUDGE_MODEL = "answer-model"
		const envelope = await runBenchmarkJudgedAnswers({
			datasetKind: "longmemeval",
			materialByCaseId: oneAnswerMaterial(),
			resumedFromCheckpoint: false,
		})
		expect(envelope?.accuracy).toBeNull()
		expect(envelope?.unavailableReason).toContain("must differ from")
		expect(runE2eQa).not.toHaveBeenCalled()
	})

	it("runs the QA harness with distinct per-role models and forwards transport usage into the accounting per role", async () => {
		process.env.MEMONGO_ENRICHMENT_API_KEY = "test-key"
		process.env.MEMONGO_ENRICHMENT_BASE_URL = "https://bench.example.invalid"
		process.env.MEMONGO_ENRICHMENT_MODEL = "answer-model"
		process.env.MEMONGO_BENCHMARK_JUDGE_MODEL = "judge-model"
		const recorded: Array<{
			kind: "attempt" | "success" | "failure"
			operation: string
			metadata: Record<string, unknown>
		}> = []
		const accounting = {
			snapshot: () => {
				throw new Error("not used in this test")
			},
			recordAttempt: (operation: string, metadata?: Record<string, unknown>) =>
				recorded.push({
					kind: "attempt",
					operation,
					metadata: { ...metadata },
				}),
			recordSuccess: (operation: string, metadata?: Record<string, unknown>) =>
				recorded.push({
					kind: "success",
					operation,
					metadata: { ...metadata },
				}),
			recordFailure: (operation: string, metadata?: Record<string, unknown>) =>
				recorded.push({
					kind: "failure",
					operation,
					metadata: { ...metadata },
				}),
		} as unknown as BenchmarkRunAccounting
		vi.mocked(runE2eQa).mockImplementationOnce(async (qaParams) => {
			qaParams.onProviderCall?.("answer-generation", "attempted")
			qaParams.onProviderCall?.("answer-generation", "succeeded", {
				inputTokens: 11,
				outputTokens: 7,
			})
			qaParams.onProviderCall?.("answer-judge", "succeeded")
			qaParams.onProviderCall?.("decoy-judge", "failed")
			return buildUnavailableE2eQaEnvelope({
				reason: "stubbed",
				eligibleCases: 1,
			})
		})
		await runBenchmarkJudgedAnswers({
			datasetKind: "longmemeval",
			materialByCaseId: oneAnswerMaterial(),
			resumedFromCheckpoint: false,
			accounting,
		})
		expect(runE2eQa).toHaveBeenCalledTimes(1)
		const qaParams = vi.mocked(runE2eQa).mock.calls[0]?.[0]
		expect(qaParams?.model).toBe("answer-model")
		expect(qaParams?.answerModel).toBe("answer-model")
		expect(qaParams?.judgeModel).toBe("judge-model")
		const providerName = qaParams?.provider.name
		expect(providerName).toBeTruthy()
		expect(recorded).toEqual([
			{
				kind: "attempt",
				operation: "answer-generation",
				metadata: { provider: providerName, model: "answer-model" },
			},
			{
				kind: "success",
				operation: "answer-generation",
				metadata: {
					provider: providerName,
					model: "answer-model",
					inputTokens: 11,
					outputTokens: 7,
				},
			},
			{
				kind: "success",
				operation: "answer-judge",
				metadata: { provider: providerName, model: "judge-model" },
			},
			{
				kind: "failure",
				operation: "decoy-judge",
				metadata: { provider: providerName, model: "judge-model" },
			},
		])
	})
})
