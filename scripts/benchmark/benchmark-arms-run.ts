/**
 * Per-arm state of a paired run (see benchmark-arms.ts): each arm's
 * measurement-pass executions, its captured reader material, and the answer
 * and judge outcome of every completed question. A question is answered and
 * judged inside its scenario, before cleanup, so the checkpoint can record
 * its verdicts; a question is complete only when every arm has a verdict.
 */
import type {
	BenchmarkE2eQaEnvelope,
	MemoryBenchmarkScenario,
} from "../../packages/memory-engine/src/types.js"
import {
	type E2eQaDecoyCandidate,
	type E2eQaEnvelope,
	runE2eQa,
} from "../mongodb-e2e-qa.js"
import {
	type ReaderBudgetCaseRecord,
	readerBudgetCalibration,
	readerPositionTerciles,
} from "../mongodb-e2e-qa-reader-budget.js"
import {
	type BenchmarkIngestFailureCounts,
	type BenchmarkJudgedAnswerMaterial,
	type JudgedAnswerSetup,
	buildJudgedAnswerCases,
	describeIngestFailures,
	judgedAnswerCallObserver,
	mergeLongMemEvalAnswerQuality,
} from "./benchmark-answer-quality.js"
import {
	type ArmCaseResult,
	type ArmTokenTotals,
	type PairedArmsReport,
	type TokenTotals,
	armCaseVerdict,
	buildPairedArmsReport,
} from "./benchmark-arms-report.js"
import type { BenchmarkArm } from "./benchmark-arms.js"
import type { BenchmarkRunAccounting } from "./benchmark-parity-envelope.js"
import { attachReaderCutMetrics } from "./benchmark-reader-cut-metrics.js"
import {
	type BenchmarkCaseExecution,
	type BenchmarkSummary,
	buildCaseDiagnostics,
	buildMissLedger,
} from "./mongodb-benchmark-runner.js"
import { READER_BUDGET_ESTIMATED_TOKENS } from "./reader-budget.js"

/** One arm's answer and judge outcome for one scenario. */
export type BenchmarkArmScenarioQa = {
	answerModel: string | null
	judge: string | null
	judgeVersion: string | null
	caseResults: ArmCaseResult[]
	attempts: BenchmarkE2eQaEnvelope["attempts"]
	decoyProbes: { probes: number; passes: number }
	tokens: ArmTokenTotals
}

/** One arm's share of a checkpointed scenario. */
export type BenchmarkCheckpointArm = {
	name: string
	executionsByPass: BenchmarkCaseExecution[][]
	qa: BenchmarkArmScenarioQa
}

export type BenchmarkArmRun = {
	arm: BenchmarkArm
	executionsByPass: BenchmarkCaseExecution[][]
	materialByCaseId: Map<string, BenchmarkJudgedAnswerMaterial>
	qa: BenchmarkArmScenarioQa[]
}

export type BenchmarkArmResult = {
	name: string
	protocol: BenchmarkArm["protocol"]
	sessionTurnRecall: boolean
	configurationHash: string
	/** Pass-0 retrieval metrics and ledgers of this arm's searches. */
	result: Pick<
		BenchmarkSummary,
		| "cases"
		| "scoredCases"
		| "hitRate"
		| "emptyRate"
		| "avgTopScore"
		| "p95LatencyMs"
		| "rAt5"
		| "rAt10"
		| "ndcgAt10"
		| "questionTypeBreakdown"
		| "officialMetrics"
	> & {
		missLedger: ReturnType<typeof buildMissLedger>
		caseDiagnostics: ReturnType<typeof buildCaseDiagnostics>
	}
	e2eQa: E2eQaEnvelope
}

export type PairedArmsRunReport = PairedArmsReport & {
	/** Non-empty when judged questions may lack ingested evidence. */
	ingestFailures: string[]
}

export function createArmRuns(
	arms: readonly BenchmarkArm[],
	measurementPasses: number,
): BenchmarkArmRun[] {
	return arms.map((arm) => ({
		arm,
		executionsByPass: Array.from({ length: measurementPasses }, () => []),
		materialByCaseId: new Map(),
		qa: [],
	}))
}

/** Refuses, before any work, a run whose searches would not take the arm's mode. */
export function assertArmsRunnable(params: {
	datasetKind: string | undefined
	retrievalLane: string | undefined
	qaProtocol: string
	queryDecomposition: boolean
	scenarios: readonly MemoryBenchmarkScenario[]
}): void {
	if (params.datasetKind !== "longmemeval") {
		throw new Error(
			`paired arms require a LongMemEval dataset: judged answers exist only there, got datasetKind=${params.datasetKind ?? "unknown"}`,
		)
	}
	if (params.retrievalLane === "raw-session") {
		throw new Error(
			"paired arms require the native retrieval lane: raw-session searches do not take an arm's turn recall mode",
		)
	}
	if (
		params.qaProtocol === "official" ||
		params.qaProtocol === "custom-judge"
	) {
		throw new Error(
			`paired arms cannot run under MEMONGO_BENCHMARK_QA_PROTOCOL=${params.qaProtocol}`,
		)
	}
	if (params.queryDecomposition) {
		throw new Error(
			"paired arms cannot run with query decomposition: decomposed searches do not take an arm's turn recall mode",
		)
	}
	const scoped = params.scenarios
		.flatMap((scenario) => scenario.evaluations)
		.find(
			(evaluation) =>
				evaluation.sourceScope !== undefined &&
				evaluation.sourceScope !== "all",
		)
	if (scoped) {
		throw new Error(
			`paired arms cannot run scoped relevance searches (case ${scoped.caseId}): they do not take an arm's turn recall mode`,
		)
	}
}

/** Questions a judge can grade: abstentions, and others with a gold answer. */
export function judgeableCaseIds(scenario: MemoryBenchmarkScenario): string[] {
	return scenario.evaluations
		.filter(
			(evaluation) =>
				evaluation.abstention === true ||
				(evaluation.answer ?? "").trim() !== "",
		)
		.map((evaluation) => evaluation.caseId)
}

/** Every judgeable question of the run in order, as a decoy source. */
export function armsDecoyPool(
	scenarios: readonly MemoryBenchmarkScenario[],
): E2eQaDecoyCandidate[] {
	return scenarios.flatMap((scenario) => {
		const judgeable = new Set(judgeableCaseIds(scenario))
		return scenario.evaluations
			.filter((evaluation) => judgeable.has(evaluation.caseId))
			.map((evaluation) => ({
				caseId: evaluation.caseId,
				question: evaluation.query,
				goldAnswer: evaluation.answer ?? "",
			}))
	})
}

const emptyTotals = (): TokenTotals => ({
	inputTokens: 0,
	outputTokens: 0,
	callsWithoutUsage: 0,
})

export async function runArmScenarioQa(params: {
	arm: BenchmarkArm
	materials: readonly BenchmarkJudgedAnswerMaterial[]
	decoyPool: readonly E2eQaDecoyCandidate[]
	setup: JudgedAnswerSetup
	accounting?: BenchmarkRunAccounting
}): Promise<BenchmarkArmScenarioQa> {
	const { cases } = buildJudgedAnswerCases(
		new Map(params.materials.map((material) => [material.caseId, material])),
	)
	const tokens: ArmTokenTotals = { answer: emptyTotals(), judge: emptyTotals() }
	const account = params.accounting
		? judgedAnswerCallObserver(params.setup, params.accounting)
		: undefined
	// runE2eQa returns its scripts-side envelope; decoyProbes is set with a pool.
	const envelope = (await runE2eQa({
		provider: params.setup.provider,
		model: params.setup.model,
		answerModel: params.setup.model,
		judgeModel: params.setup.judgeModel,
		cases,
		protocol: params.arm.protocol,
		decoyPool: params.decoyPool,
		onProviderCall: (operation, outcome, usage, call) => {
			if (outcome !== "attempted") {
				const totals =
					operation === "answer-generation" ? tokens.answer : tokens.judge
				if (usage) {
					totals.inputTokens += usage.inputTokens
					totals.outputTokens += usage.outputTokens
				} else {
					totals.callsWithoutUsage += 1
				}
			}
			account?.(operation, outcome, usage, call)
		},
	})) as E2eQaEnvelope
	return {
		answerModel: envelope.answerModel,
		judge: envelope.judge,
		judgeVersion: envelope.judgeVersion,
		caseResults: envelope.caseResults,
		attempts: envelope.attempts,
		decoyProbes: envelope.decoyProbes ?? { probes: 0, passes: 0 },
		tokens,
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * True when the checkpointed scenario holds every arm, in order, with its
 * pass executions and a verdict for every judgeable question.
 */
export function checkpointArmsComplete(
	recorded: unknown,
	arms: readonly BenchmarkArm[],
	caseIds: readonly string[],
	measurementPasses: number,
): boolean {
	if (!Array.isArray(recorded) || recorded.length !== arms.length) return false
	return arms.every((arm, index) => {
		const entry: unknown = recorded[index]
		if (
			!isRecord(entry) ||
			entry.name !== arm.name ||
			!Array.isArray(entry.executionsByPass) ||
			entry.executionsByPass.length !== measurementPasses ||
			!isRecord(entry.qa) ||
			!Array.isArray(entry.qa.caseResults)
		)
			return false
		const results = entry.qa.caseResults as ArmCaseResult[]
		return caseIds.every(
			(caseId) =>
				armCaseVerdict(results.find((result) => result.caseId === caseId))
					.verdict !== "missing",
		)
	})
}

export function restoreCheckpointArms(
	runs: readonly BenchmarkArmRun[],
	recorded: readonly BenchmarkCheckpointArm[],
): void {
	runs.forEach((run, index) => {
		const entry = recorded[index] as BenchmarkCheckpointArm
		entry.executionsByPass.forEach((executions, pass) => {
			run.executionsByPass[pass]?.push(...executions)
		})
		run.qa.push(entry.qa)
	})
}

function sumTotals(values: readonly TokenTotals[]): TokenTotals {
	return values.reduce(
		(sum, value) => ({
			inputTokens: sum.inputTokens + value.inputTokens,
			outputTokens: sum.outputTokens + value.outputTokens,
			callsWithoutUsage: sum.callsWithoutUsage + value.callsWithoutUsage,
		}),
		emptyTotals(),
	)
}

function sumTokens(records: readonly BenchmarkArmScenarioQa[]): ArmTokenTotals {
	return {
		answer: sumTotals(records.map((record) => record.tokens.answer)),
		judge: sumTotals(records.map((record) => record.tokens.judge)),
	}
}

/** The arm's envelope over every scenario it answered, as runE2eQa reports one. */
export function summarizeArmQa(params: {
	arm: BenchmarkArm
	records: readonly BenchmarkArmScenarioQa[]
	ingest: BenchmarkIngestFailureCounts
}): E2eQaEnvelope {
	const caseResults = params.records.flatMap((record) => record.caseResults)
	const named = params.records.find((record) => record.answerModel !== null)
	const probes = params.records.reduce(
		(sum, record) => sum + record.decoyProbes.probes,
		0,
	)
	const passes = params.records.reduce(
		(sum, record) => sum + record.decoyProbes.passes,
		0,
	)
	const failed = caseResults.filter((result) => result.error).length
	const ingestFailures = describeIngestFailures(params.ingest)
	const unavailable = [
		...(caseResults.length === 0 ? ["no judged questions"] : []),
		...(ingestFailures.length > 0
			? [
					`QA evidence is incomplete: ${ingestFailures.join("; ")}; accuracy is withheld because judged questions may lack ingested evidence`,
				]
			: []),
	]
	return {
		answerModel: named?.answerModel ?? null,
		judge: named?.judge ?? null,
		judgeVersion: named?.judgeVersion ?? null,
		accuracy:
			unavailable.length > 0
				? null
				: caseResults.filter((result) => result.correct).length /
					caseResults.length,
		latencyMs:
			caseResults.length > 0
				? caseResults.reduce((sum, result) => sum + result.latencyMs, 0) /
					caseResults.length
				: null,
		judgeFalsePositiveRate: probes > 0 ? passes / probes : null,
		cases: {
			eligible: caseResults.length,
			attempted: caseResults.length,
			completed: caseResults.length - failed,
			failed,
		},
		attempts: {
			answerGeneration: params.records.reduce(
				(sum, record) => sum + record.attempts.answerGeneration,
				0,
			),
			answerJudge: params.records.reduce(
				(sum, record) => sum + record.attempts.answerJudge,
				0,
			),
			decoyJudge: params.records.reduce(
				(sum, record) => sum + record.attempts.decoyJudge,
				0,
			),
		},
		caseResults,
		...(unavailable.length > 0
			? { unavailableReason: unavailable.join("; ") }
			: {}),
		...(params.arm.protocol === "custom-v3"
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
			: {}),
	}
}

/** Every arm's metrics, ledgers and answers, and the paired report. */
export function buildArmResults(params: {
	runs: readonly BenchmarkArmRun[]
	configurationHashes: readonly string[]
	scenarios: readonly MemoryBenchmarkScenario[]
	ingest: BenchmarkIngestFailureCounts
	summarize: (executions: BenchmarkCaseExecution[]) => BenchmarkSummary
	expectedSessionMap: Map<string, string[]>
	expectedTurnMap: Map<string, string[]>
}): { arms: BenchmarkArmResult[]; pairedArms: PairedArmsRunReport } {
	const evaluations = params.scenarios.flatMap(
		(scenario) => scenario.evaluations,
	)
	const questionTypeByCaseId = new Map(
		evaluations.map((evaluation) => [
			evaluation.caseId,
			evaluation.questionType,
		]),
	)
	const arms = params.runs.map((run, index): BenchmarkArmResult => {
		const executions = run.executionsByPass[0] ?? []
		const summary = params.summarize(executions)
		const readerCut = attachReaderCutMetrics({
			e2eQa: summarizeArmQa({
				arm: run.arm,
				records: run.qa,
				ingest: params.ingest,
			}),
			breakdown: summary.questionTypeBreakdown,
			questionTypeByCaseId,
		})
		const e2eQa = readerCut.e2eQa as E2eQaEnvelope
		const officialMetrics = mergeLongMemEvalAnswerQuality({
			officialMetrics: summary.officialMetrics,
			e2eQa,
		})
		return {
			name: run.arm.name,
			protocol: run.arm.protocol,
			sessionTurnRecall: run.arm.sessionTurnRecall,
			configurationHash: params.configurationHashes[index] ?? "",
			result: {
				cases: summary.cases,
				scoredCases: summary.scoredCases,
				hitRate: summary.hitRate,
				emptyRate: summary.emptyRate,
				avgTopScore: summary.avgTopScore,
				p95LatencyMs: summary.p95LatencyMs,
				rAt5: summary.rAt5,
				rAt10: summary.rAt10,
				ndcgAt10: summary.ndcgAt10,
				questionTypeBreakdown: readerCut.breakdown,
				...(officialMetrics ? { officialMetrics } : {}),
				missLedger: buildMissLedger({
					executions,
					expectedSessionMap: params.expectedSessionMap,
					expectedTurnMap: params.expectedTurnMap,
				}),
				caseDiagnostics: buildCaseDiagnostics({
					executions,
					expectedSessionMap: params.expectedSessionMap,
					expectedTurnMap: params.expectedTurnMap,
				}),
			},
			e2eQa,
		}
	})
	return {
		arms,
		pairedArms: {
			...buildPairedArmsReport({
				caseIds: evaluations.map((evaluation) => evaluation.caseId),
				arms: params.runs.map((run, index) => ({
					arm: run.arm,
					configurationHash: params.configurationHashes[index] ?? "",
					caseResults: run.qa.flatMap((record) => record.caseResults),
					tokens: sumTokens(run.qa),
				})),
			}),
			ingestFailures: describeIngestFailures(params.ingest),
		},
	}
}
