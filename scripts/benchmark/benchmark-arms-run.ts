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
	measureE2eQaCases,
	runE2eQa,
} from "../mongodb-e2e-qa.js"
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
import type { OperationRunConfiguration } from "../../packages/memory-engine/src/mongodb-operation-accounting.js"
import {
	type BenchmarkArm,
	benchmarkArmConfiguration,
} from "./benchmark-arms.js"
import type { BenchmarkRunAccounting } from "./benchmark-parity-envelope.js"
import { attachReaderCutMetrics } from "./benchmark-reader-cut-metrics.js"
import {
	type BenchmarkCaseExecution,
	type BenchmarkSummary,
	buildCaseDiagnostics,
	buildMissLedger,
} from "./mongodb-benchmark-runner.js"

/** One arm's answer and judge outcome for one scenario. */
export type BenchmarkArmScenarioQa = {
	answerModel: string | null
	judge: string | null
	judgeVersion: string | null
	caseResults: ArmCaseResult[]
	attempts: BenchmarkE2eQaEnvelope["attempts"]
	/** Null when the scenario had no judged question, so no judge ran. */
	decoyProbes: { probes: number; passes: number } | null
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
	configurationHash: string
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
	configuration: OperationRunConfiguration,
): BenchmarkArmRun[] {
	return arms.map((arm) => ({
		arm,
		configurationHash: benchmarkArmConfiguration(configuration, arm)
			.configurationHash,
		executionsByPass: Array.from({ length: measurementPasses }, () => []),
		materialByCaseId: new Map(),
		qa: [],
	}))
}

/** Refuses, before any work, a run whose searches would not take the arm's mode. */
export function assertArmsRunnable(params: {
	datasetKind: string | undefined
	retrievalLane: string | undefined
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
	accounting: BenchmarkRunAccounting
}): Promise<BenchmarkArmScenarioQa> {
	const { cases } = buildJudgedAnswerCases(
		new Map(params.materials.map((material) => [material.caseId, material])),
	)
	const tokens: ArmTokenTotals = { answer: emptyTotals(), judge: emptyTotals() }
	const account = judgedAnswerCallObserver(params.setup, params.accounting)
	const envelope = await runE2eQa({
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
			account(operation, outcome, usage, call)
		},
	})
	let decoyProbes: BenchmarkArmScenarioQa["decoyProbes"] = null
	if (cases.length > 0) {
		if (!envelope.decoyProbes) {
			throw new Error(
				`paired arms: arm ${params.arm.name} judged ${cases.length} questions with a decoy pool but reported no decoy probes`,
			)
		}
		decoyProbes = envelope.decoyProbes
	}
	return {
		answerModel: envelope.answerModel,
		judge: envelope.judge,
		judgeVersion: envelope.judgeVersion,
		caseResults: envelope.caseResults,
		attempts: envelope.attempts,
		decoyProbes,
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
	recorded: readonly BenchmarkCheckpointArm[] | undefined,
): void {
	runs.forEach((run, index) => {
		const entry = recorded?.[index]
		if (entry?.name !== run.arm.name) {
			throw new Error(
				`benchmark checkpoint has no entry for arm ${run.arm.name}`,
			)
		}
		if (entry.executionsByPass.length !== run.executionsByPass.length) {
			throw new Error(
				`benchmark checkpoint arm ${run.arm.name} holds ${entry.executionsByPass.length} measurement passes; the run takes ${run.executionsByPass.length}`,
			)
		}
		run.executionsByPass.forEach((executions, pass) => {
			executions.push(
				...(entry.executionsByPass[pass] as BenchmarkCaseExecution[]),
			)
		})
		run.qa.push(entry.qa)
	})
}

/**
 * The scenario's share of every arm for the checkpoint: the executions each
 * arm added since `offsets` was taken, and its answers. Every arm must have
 * answered the scenario.
 */
export function scenarioCheckpointArms(params: {
	runs: readonly BenchmarkArmRun[]
	/** Per arm, each pass's execution count when the scenario began. */
	offsets: readonly (readonly number[])[] | undefined
	qa: readonly BenchmarkArmScenarioQa[]
}): BenchmarkCheckpointArm[] {
	return params.runs.map((run, index) => {
		const offsets = params.offsets?.[index]
		if (offsets?.length !== run.executionsByPass.length) {
			throw new Error(
				`paired arms: arm ${run.arm.name} has no execution offsets for this scenario`,
			)
		}
		const qa = params.qa[index]
		if (!qa) {
			throw new Error(
				`paired arms: arm ${run.arm.name} has no answers for this scenario`,
			)
		}
		return {
			name: run.arm.name,
			executionsByPass: run.executionsByPass.map((executions, pass) =>
				executions.slice(offsets[pass]),
			),
			qa,
		}
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
	const attempts = params.records.reduce(
		(sum, record) => ({
			answerGeneration: sum.answerGeneration + record.attempts.answerGeneration,
			answerJudge: sum.answerJudge + record.attempts.answerJudge,
			decoyJudge: sum.decoyJudge + record.attempts.decoyJudge,
		}),
		{ answerGeneration: 0, answerJudge: 0, decoyJudge: 0 },
	)
	// A scenario without a judged question ran no probe and adds none.
	const decoyProbes = params.records
		.flatMap((record) => (record.decoyProbes ? [record.decoyProbes] : []))
		.reduce(
			(sum, probed) => ({
				probes: sum.probes + probed.probes,
				passes: sum.passes + probed.passes,
			}),
			{ probes: 0, passes: 0 },
		)
	const measured = measureE2eQaCases({
		caseResults,
		decoyProbes,
		protocol: params.arm.protocol,
	})
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
		accuracy: unavailable.length > 0 ? null : measured.accuracy,
		latencyMs: measured.latencyMs,
		judgeFalsePositiveRate: measured.judgeFalsePositiveRate,
		cases: measured.cases,
		attempts,
		caseResults,
		...(unavailable.length > 0
			? { unavailableReason: unavailable.join("; ") }
			: {}),
		...measured.reader,
	}
}

/** Every arm's metrics, ledgers and answers, and the paired report. */
export function buildArmResults(params: {
	runs: readonly BenchmarkArmRun[]
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
	const arms = params.runs.map((run): BenchmarkArmResult => {
		const executions = run.executionsByPass[0]
		if (!executions) {
			throw new Error(`arm ${run.arm.name} has no first measurement pass`)
		}
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
		const e2eQa = readerCut.e2eQa
		const officialMetrics = mergeLongMemEvalAnswerQuality({
			officialMetrics: summary.officialMetrics,
			e2eQa,
		})
		return {
			name: run.arm.name,
			protocol: run.arm.protocol,
			sessionTurnRecall: run.arm.sessionTurnRecall,
			configurationHash: run.configurationHash,
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
				arms: params.runs.map((run) => ({
					arm: run.arm,
					configurationHash: run.configurationHash,
					caseResults: run.qa.flatMap((record) => record.caseResults),
					tokens: sumTokens(run.qa),
				})),
			}),
			ingestFailures: describeIngestFailures(params.ingest),
		},
	}
}
