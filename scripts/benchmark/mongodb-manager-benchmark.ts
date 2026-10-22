import { attachReaderCutMetrics } from "./benchmark-reader-cut-metrics.js"
import { captureReaderUnits } from "./reader-units.js"
import { hiddenOutputTokensMetadata } from "../mongodb-e2e-qa-calls.js"
import {
	BenchmarkInputRejectedError,
	type BenchmarkAdmittedDataset,
	countBenchmarkRejections,
} from "./mongodb-benchmark-dataset.js"
import { sameAdapterDiagnosticTotals } from "./benchmark-adapter-diagnostics.js"
import {
	endOfBenchmarkUtcDay,
	normalizeBenchmarkConversationTimestamps,
	requireBenchmarkTimestamp,
} from "./benchmark-timestamp.js"
import { hasValidBenchmarkIngestCounts } from "./mongodb-benchmark-checkpoint.js"
/**
 * Benchmark seam extracted from `mongodb-manager.ts` (P4.3): parity-envelope
 * helpers, convergence probes, and replay metadata used by the benchmark
 * collaborator. Internal only — not re-exported from the barrels.
 */

import { createHash, randomUUID } from "node:crypto"
import { access, mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import {
	createBenchmarkRunContext,
	assertBenchmarkRunConfiguration,
	collectBenchmarkTenantStorage,
	resolveDatasetSha256,
	resolveBenchmarkRetrievalLane,
	resolveBenchmarkExecutionProfile,
	percentile50And95,
} from "./benchmark-parity-envelope.js"
import type {
	BenchmarkExecutionProfile,
	BenchmarkRetrievalLane,
	BenchmarkRunContext,
	BenchmarkRunConfiguration,
} from "./benchmark-parity-envelope.js"
import { resolveRegisteredBenchmarkQualityContract } from "./benchmark-quality-contracts.js"
import {
	readBenchmarkCheckpoint,
	writeBenchmarkCheckpointAtomic,
	type BenchmarkCheckpoint,
	type BenchmarkCheckpointScenario,
} from "./mongodb-benchmark-checkpoint.js"
import {
	BENCHMARK_REPO_ROOT,
	type BenchmarkExecutableIdentity,
	computeExecutableDigest,
} from "./benchmark-executable-identity.js"
import { withMongoBenchmarkRetry } from "./mongodb-benchmark-retry.js"
import {
	BENCHMARK_SCENARIO_COLLECTION_SUFFIXES,
	cleanupRegistry,
	describeScenarioCleanupFailure,
	restoreScenarioCleanup,
	sanitizedCleanupError,
	summarizeScenarioCleanup,
} from "./benchmark-scenario-cleanup.js"
import {
	ingestBenchmarkDataset,
	ingestBenchmarkConversations,
	importConversationDataset,
	type BenchmarkConversationImportResult,
	loadBenchmarkDataset,
	resolveBenchmarkDatasetPath,
} from "./mongodb-benchmark-harness.js"
import {
	buildBenchmarkRunReport,
	evaluateRankingCase,
	buildQueryGovernanceReport,
	summarizeBenchmarkExecutions,
	summarizeMeasurementPasses,
	buildMissLedger,
	buildCaseDiagnostics,
	projectBenchmarkParityFields,
} from "./mongodb-benchmark-runner.js"
import type { BenchmarkCaseExecution } from "./mongodb-benchmark-runner.js"
import {
	mergeLongMemEvalAnswerQuality,
	resolveJudgedAnswerSetup,
	runBenchmarkJudgedAnswers,
	type BenchmarkJudgedAnswerMaterial,
	type JudgedAnswerSetup,
} from "./benchmark-answer-quality.js"
import { resolveBenchmarkArms, type BenchmarkArm } from "./benchmark-arms.js"
import {
	armsDecoyPool,
	assertArmsRunnable,
	buildArmResults,
	checkpointArmsComplete,
	createArmRuns,
	judgeableCaseIds,
	restoreCheckpointArms,
	scenarioCheckpointArms,
	runArmScenarioQa,
	type BenchmarkArmScenarioQa,
	type BenchmarkCheckpointArm,
} from "./benchmark-arms-run.js"
import {
	buildPass0ContextDiagnostics,
	captureContextDiagnostics,
} from "./benchmark-context-diagnostics.js"
import {
	prepareOfficialQa,
	resolveBenchmarkQaProtocol,
	scoreOfficialScenario,
	summarizeOfficialBenchmarkQaRun,
} from "./longmemeval-official-scoring.js"
import type { OfficialQaContext } from "./longmemeval-official-scoring.js"
import {
	isExtractionLlmDisabled,
	resolveEnrichmentMode,
	resolveEnrichmentStrictMode,
	resolveEnrichmentProvider,
	enrichSessionsWithLLM,
} from "../../packages/memory-engine/src/mongodb-llm-enrichment.js"
import {
	benchmarkAnswerModelName,
	resolveBenchmarkAnswerProvider,
} from "./benchmark-answer-provider.js"
import { MongoDBManagerBenchmarkScenarioOps } from "./mongodb-manager-benchmark-scenario.js"
import type { BenchmarkReadinessSkip } from "./mongodb-manager-benchmark-scenario.js"
import type { MongoDBManagerHost } from "../../packages/memory-engine/src/mongodb-manager-host.js"
import { MongoDBMemoryManager } from "../../packages/memory-engine/src/mongodb-manager.js"
import {
	resolveDecompositionMode,
	decomposeQuery,
	mergeMultiQueryResults,
} from "../../packages/memory-engine/src/mongodb-query-decomposition.js"
import type {
	RelevanceReport,
	RelevanceSampleState,
} from "../../packages/memory-engine/src/mongodb-relevance.js"
import {
	buildBenchmarkCaseSummary,
	loadLegacyRelevanceDataset,
	persistBenchmarkRegression,
	summarizeBenchmarkCases,
	type RelevanceBenchmarkResult,
} from "./benchmark-relevance.js"
import {
	chunksCollection,
	sessionChunksCollection,
} from "../../packages/memory-engine/src/mongodb-schema.js"
import { resolveScopeRef } from "../../packages/memory-engine/src/mongodb-scope.js"
import { isBenchmarkStrictMode } from "../../packages/memory-engine/src/mongodb-search-ranking.js"
import {
	resolveSessionEvidenceMode,
	resolveSessionEvidenceExpiresAt,
	writeSessionEvidenceOptionA,
	writeSessionEvidenceOptionB,
} from "../../packages/memory-engine/src/mongodb-session-evidence.js"
import {
	resolveUserfactEvidenceMode,
	writeUserfactEvidence,
} from "../../packages/memory-engine/src/mongodb-userfact-evidence.js"
import type {
	BenchmarkE2eQaEnvelope,
	BenchmarkQualityThresholds,
	BenchmarkScenarioCleanupAttempt,
	BenchmarkScenarioCleanupOutcome,
	BenchmarkScenarioCleanupReport,
	BenchmarkTenantStorageMeasurement,
	MemoryBenchmarkDatasetKind,
	MemoryBenchmarkConversation,
	MemoryBenchmarkIngestResult,
	MemoryConversationImportRejection,
	MemorySearchResult,
	BenchmarkRerankerConfig,
	BenchmarkLatencyDistribution,
	BenchmarkStorageFootprint,
	BenchmarkEmbeddingConfig,
	BenchmarkRunIdentity,
	BenchmarkCostAccounting,
} from "../../packages/memory-engine/src/types.js"
import { createSubsystemLogger, resolveUserPath } from "@memongo/lib"
import type { MemoryScope } from "@memongo/lib"
import type { Collection, Document } from "mongodb"

const log = createSubsystemLogger("memory:mongodb")

export { BENCHMARK_SCENARIO_COLLECTION_SUFFIXES }

export function isLegacyBenchmarkFallbackCandidate(err: unknown): boolean {
	return (
		err instanceof BenchmarkInputRejectedError ||
		(err instanceof Error &&
			(err.message === "benchmark dataset contains no valid conversations" ||
				err.message === "benchmark dataset contains no evaluation cases"))
	)
}

/**
 * Benchmark strict mode toggle. Reads MEMONGO_BENCHMARK_STRICT at call time
 * (not at module load) so tests that mutate the env mid-run see the update.
 * Truthy values: "1", "true" (case-insensitive). Everything else is false.
 *
 * Referenced in 22 hot-path sites across this file. Was previously called
 * without a definition (latent ReferenceError masked only by conditionals
 * that never executed in non-strict runs); Task 1.5 uses it in the new
 * readiness-probe delegate, so we define it here.
 */

export function hasBenchmarkSearchableText(value: unknown): boolean {
	return typeof value === "string" && /[\p{L}\p{N}]/u.test(value)
}

type BenchmarkConvergenceNamespace = {
	agentId: string
	scope?: MemoryScope
	scopeRef?: string
	sessionId?: string
}

export function benchmarkConvergenceFilter(
	namespace: BenchmarkConvergenceNamespace,
): Document {
	return {
		agentId: namespace.agentId,
		...(namespace.scope ? { scope: namespace.scope } : {}),
		...(namespace.scopeRef ? { scopeRef: namespace.scopeRef } : {}),
		...(namespace.sessionId ? { sessionId: namespace.sessionId } : {}),
	}
}

export function benchmarkSearchEqualsFilters(
	namespace: BenchmarkConvergenceNamespace,
): Document[] {
	return Object.entries(benchmarkConvergenceFilter(namespace)).map(
		([path, value]) => ({ equals: { path, value } }),
	)
}

export function benchmarkSearchProbeTerm(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined
	const terms = value.match(/[\p{L}\p{N}][\p{L}\p{N}'-]{2,}/gu) ?? []
	return terms.find((term) => term.length >= 4) ?? terms[0]
}

export function parseBenchmarkTurnTimestamp(
	value?: string,
	datasetKind: MemoryBenchmarkDatasetKind = "longmemeval",
): Date | undefined {
	return value === undefined
		? undefined
		: requireBenchmarkTimestamp(datasetKind, value, {
				field: "turn.timestamp",
				conversationIndex: 0,
				sessionIndex: null,
				turnIndex: null,
			})
}

/** Same-day sessions remain eligible; the cutoff uses the parser's UTC calendar. */
export function endOfBenchmarkQuestionDay(date: Date): Date {
	return endOfBenchmarkUtcDay(date)
}

export function buildBenchmarkReplayMetadata(params: {
	baseMetadata?: Record<string, unknown>
	turnMetadata?: Record<string, unknown>
	datasetName?: string
	datasetKind?: MemoryBenchmarkDatasetKind
	conversationId: string
}): Record<string, unknown> {
	return {
		...(params.baseMetadata ?? {}),
		...(params.turnMetadata ?? {}),
		benchmarkDataset: params.datasetName,
		benchmarkDatasetKind: params.datasetKind,
		benchmarkConversationId: params.conversationId,
	}
}

export function attachBenchmarkOperationsReport(
	result: RelevanceBenchmarkResult,
	parity?: {
		runIdentity: import("../../packages/memory-engine/src/types.js").BenchmarkRunIdentity
		embedding: import("../../packages/memory-engine/src/types.js").BenchmarkEmbeddingConfig
		reranker: import("../../packages/memory-engine/src/types.js").BenchmarkRerankerConfig
		storage: import("../../packages/memory-engine/src/types.js").BenchmarkStorageFootprint
		latency: import("../../packages/memory-engine/src/types.js").BenchmarkLatencyDistribution
		cost: import("../../packages/memory-engine/src/types.js").BenchmarkCostAccounting
	},
	qualityThresholds?: BenchmarkQualityThresholds,
	e2eQa?: BenchmarkE2eQaEnvelope,
	conversationRecallRegression?: {
		status: "passed" | "failed"
		evidence: string
	},
	observedBuild?: BenchmarkExecutableIdentity,
): RelevanceBenchmarkResult {
	const queryGovernance = buildQueryGovernanceReport(result)
	// C-039: project the QA envelope into the official LongMemEval metrics so
	// the published envelope carries judged answer accuracy. No-op for runs
	// without an envelope (legacy) or without longMemEval metrics (loCoMo).
	const officialMetrics = mergeLongMemEvalAnswerQuality({
		officialMetrics: result.officialMetrics,
		e2eQa,
	})
	return {
		...result,
		...(officialMetrics !== result.officialMetrics ? { officialMetrics } : {}),
		queryGovernance,
		benchmarkReport: buildBenchmarkRunReport({
			...result,
			...(observedBuild ? { observedBuild } : {}),
			...(officialMetrics !== result.officialMetrics
				? { officialMetrics }
				: {}),
			queryGovernance,
			...(qualityThresholds ? { qualityThresholds } : {}),
			...(e2eQa ? { e2eQa } : {}),
			...(conversationRecallRegression ? { conversationRecallRegression } : {}),
			...(parity
				? {
						runIdentity: parity.runIdentity,
						embedding: parity.embedding,
						reranker: parity.reranker,
						storage: parity.storage,
						latency: parity.latency,
						cost: result.pairedArms
							? {
									...parity.cost,
									pooledArms: result.pairedArms.arms.map((arm) => arm.name),
								}
							: parity.cost,
					}
				: {}),
		}),
	}
}

export type BenchmarkEventEvidenceMaps = {
	sessionIds: Map<string, string>
	turnIds: Map<string, string>
	dialogIds: Map<string, string>
}

export function resolveBenchmarkMeasurementPasses(): number {
	const raw = Number(process.env.MEMONGO_BENCHMARK_MEASUREMENT_PASSES)
	if (!Number.isFinite(raw) || raw < 1) {
		return 1
	}
	return Math.floor(raw)
}

export class MongoDBManagerBenchmarkOps {
	constructor(private readonly host: MongoDBManagerHost) {
		this.scenario = new MongoDBManagerBenchmarkScenarioOps(host)
	}

	private readonly scenario: MongoDBManagerBenchmarkScenarioOps

	private async createBenchmarkScenarioManager(
		agentId: string,
		workspaceDir: string,
	): Promise<MongoDBMemoryManager> {
		const manager = await MongoDBMemoryManager.create({
			cfg: { agents: { list: [{ id: agentId, workspace: workspaceDir }] } },
			agentId,
			resolved: this.host.config,
			extraPaths: [],
			client: this.host.client,
		})
		return manager
	}

	async relevanceBenchmark(params?: {
		datasetPath?: string
		maxResults?: number
		minScore?: number
		// Task 1.A envelope-parity pass-through — accepted today, wired into
		// the envelope by Task 5.E2E (envelope emitter already supports them).
		datasetSha256?: string
		embeddingConfig?: {
			model: string
			dimensions: number
			quantization: "float32" | "int8" | "binary"
		}
		rerankerConfig?: {
			model: string
			version: string | null
			stage: "post-fusion" | "pre-fusion" | "none"
		}
		retrievalLane?: BenchmarkRetrievalLane
		qualityThresholds?: BenchmarkQualityThresholds
		/**
		 * #70: real outcome of the conversation-recall regression suite executed
		 * alongside this run (scripts/run-benchmark.ts runs it). Absent → the
		 * gate stays "not-run" and blocks publication.
		 */
		conversationRecallRegression?: {
			status: "passed" | "failed"
			evidence: string
		}
		/**
		 * Defaults to "shipped". Pass "diagnostic" to opt into the augmented
		 * corpus (evidence documents + LLM enrichment) that the shipped pipeline
		 * never writes — a diagnostic number must never be published as a
		 * product number.
		 */
		executionProfile?: BenchmarkExecutionProfile
		checkpointPath?: string
		resume?: boolean
	}): Promise<RelevanceBenchmarkResult> {
		if (!this.host.relevance) {
			throw new Error("relevance runtime is unavailable")
		}
		const mongoCfg = this.host.config.mongodb!
		if (!mongoCfg.relevance.benchmark.enabled) {
			throw new Error("relevance benchmark is disabled by configuration")
		}
		const datasetPath =
			params?.datasetPath ?? mongoCfg.relevance.benchmark.datasetPath
		const maxResults =
			params?.maxResults ?? (params?.qualityThresholds ? 50 : 10)
		const minScore = params?.minScore ?? 0.01
		const resolvedDatasetPath = await resolveBenchmarkDatasetPath({
			datasetPath,
			baseDir: this.host.workspaceDir,
			allowedRoots: this.getBenchmarkAllowedRoots(),
		})
		const datasetSha256 = await resolveDatasetSha256({
			datasetPath: resolvedDatasetPath,
			override: params?.datasetSha256,
		})
		const qualityThresholds = params?.qualityThresholds
			? resolveRegisteredBenchmarkQualityContract({
					declared: params.qualityThresholds,
					datasetSha256,
				})
			: undefined
		const retrievalLane = resolveBenchmarkRetrievalLane(
			params?.retrievalLane ?? process.env.MEMONGO_BENCHMARK_RETRIEVAL_LANE,
		)
		if (qualityThresholds && retrievalLane !== "native") {
			throw new Error(
				"publication quality contracts require the shipped native retrieval lane",
			)
		}
		if (qualityThresholds && maxResults < 50) {
			throw new Error(
				"publication quality contracts require maxResults >= 50 so @50 metrics use a complete candidate budget",
			)
		}

		const arms = resolveBenchmarkArms(process.env)
		if (arms && qualityThresholds) {
			throw new Error(
				"publication quality contracts cannot run paired arms: unset MEMONGO_BENCHMARK_ARMS",
			)
		}
		const executionProfile = resolveBenchmarkExecutionProfile({
			requested: params?.executionProfile,
			retrievalLane,
			hasQualityContract: Boolean(qualityThresholds),
		})
		const runConfiguration = this.snapshotBenchmarkRunConfiguration({
			executionProfile,
			retrievalLane,
			maxResults,
			minScore,
			qualityContractId: qualityThresholds?.contractId,
			qualityContractVersion: qualityThresholds?.version,
		})
		let runContext = createBenchmarkRunContext({
			runId: randomUUID(),
			configuration: runConfiguration,
		})
		// Observed once at admission: resume binding and report identity share it.
		const executable = await computeExecutableDigest(BENCHMARK_REPO_ROOT)
		let dataset: Awaited<ReturnType<typeof loadBenchmarkDataset>>
		try {
			dataset = await loadBenchmarkDataset(resolvedDatasetPath, {
				baseDir: this.host.workspaceDir,
				allowedRoots: this.getBenchmarkAllowedRoots(),
			})
		} catch (datasetErr) {
			if (!isLegacyBenchmarkFallbackCandidate(datasetErr) || arms) {
				throw datasetErr
			}
			if (qualityThresholds) {
				throw new Error(
					"a publication quality contract cannot run against a legacy-query dataset",
				)
			}
			const cases = await loadLegacyRelevanceDataset(resolvedDatasetPath)
			if (cases.length === 0) {
				throw datasetErr
			}
			const legacy = await this.runLegacyRelevanceBenchmark({
				datasetPath: resolvedDatasetPath,
				maxResults,
				minScore,
			})
			const parity = await this.buildBenchmarkParityBundle({
				datasetPath: resolvedDatasetPath,
				datasetKind: legacy.result.datasetKind,
				retrievalLane,
				datasetSha256Override: params?.datasetSha256,
				latencySamples: legacy.latencySamples,
				runContext,
			})
			return attachBenchmarkOperationsReport(
				legacy.result,
				parity,
				qualityThresholds,
				undefined,
				params?.conversationRecallRegression,
				executable,
			)
		}
		if (
			qualityThresholds &&
			dataset.datasetKind !== qualityThresholds.datasetKind
		) {
			throw new Error(
				`quality contract datasetKind=${qualityThresholds.datasetKind} does not match dataset kind=${dataset.datasetKind ?? "unknown"}`,
			)
		}
		if (
			(dataset.scenarios?.some((scenario) => scenario.evaluations.length > 0) ??
				false) === false
		) {
			const noEvaluationError = new Error(
				"benchmark dataset contains no evaluation cases",
			)
			if (qualityThresholds || arms) {
				throw noEvaluationError
			}
			const cases = await loadLegacyRelevanceDataset(resolvedDatasetPath)
			if (cases.length === 0) {
				throw noEvaluationError
			}
			const legacy = await this.runLegacyRelevanceBenchmark({
				datasetPath: resolvedDatasetPath,
				maxResults,
				minScore,
			})
			const parity = await this.buildBenchmarkParityBundle({
				datasetPath: resolvedDatasetPath,
				datasetKind: legacy.result.datasetKind,
				retrievalLane,
				datasetSha256Override: params?.datasetSha256,
				latencySamples: legacy.latencySamples,
				runContext,
			})
			return attachBenchmarkOperationsReport(
				legacy.result,
				parity,
				qualityThresholds,
				undefined,
				params?.conversationRecallRegression,
				executable,
			)
		}
		const checkpointPath = params?.checkpointPath
			? resolveUserPath(params.checkpointPath)
			: undefined
		if (params?.resume && !checkpointPath) {
			throw new Error("benchmark resume requires checkpointPath")
		}
		const resumeCheckpoint =
			params?.resume && checkpointPath
				? await readBenchmarkCheckpoint(checkpointPath, {
						datasetSha256,
						configurationHash: runContext.configurationHash,
						executableDigest: executable?.digest ?? null,
						scenarioIds: (dataset.scenarios ?? []).map(
							(scenario) => scenario.scenarioId,
						),
					})
				: undefined
		if (resumeCheckpoint) {
			runContext = createBenchmarkRunContext({
				runId: resumeCheckpoint.runId,
				configuration: runConfiguration,
				initialAccounting: resumeCheckpoint.accounting,
			})
		}
		const datasetVersion = datasetSha256
		const scenario = await this.runScenarioBenchmarkDataset({
			datasetPath: resolvedDatasetPath,
			dataset,
			datasetVersion,
			maxResults,
			minScore,
			retrievalLane,
			executionProfile,
			publicationRun: Boolean(qualityThresholds),
			checkpointPath,
			resumeCheckpoint,
			executableDigest: executable?.digest ?? "unavailable",
			datasetSha256,
			runContext,
			...(arms ? { arms } : {}),
		})
		const parity = await this.buildBenchmarkParityBundle({
			datasetPath: resolvedDatasetPath,
			datasetKind: scenario.result.datasetKind,
			retrievalLane,
			datasetSha256Override: params?.datasetSha256,
			latencySamples: scenario.latencySamples,
			runContext,
			tenantStorage: scenario.storage,
		})
		const result = attachBenchmarkOperationsReport(
			scenario.result,
			parity,
			qualityThresholds,
			scenario.e2eQa,
			params?.conversationRecallRegression,
			executable,
		)
		const validation = dataset.timestampValidation
		if (result.benchmarkReport && validation) {
			if (validation.weekdayMismatches > 0)
				result.benchmarkReport.warnings.push(
					`timestamp policy ${validation.policyVersion}: ${validation.weekdayMismatches} weekday labels disagree with numeric dates; numeric UTC fields used`,
				)
			if (validation.literalMidnightLabels > 0)
				result.benchmarkReport.warnings.push(
					`timestamp policy ${validation.policyVersion}: ${validation.literalMidnightLabels} twelve-am labels interpreted literally as midnight; historical noon intent is unresolved`,
				)
		}
		return result
	}

	/**
	 * Task 1.A projection: assemble the parity-envelope bundle from
	 * runtime signals (resolved backend config, run-scoped counters,
	 * latency samples, live `collStats`).
	 */
	async buildBenchmarkParityBundle(params: {
		datasetPath: string
		datasetKind?: MemoryBenchmarkDatasetKind | "legacy-query"
		retrievalLane?: BenchmarkRetrievalLane
		datasetSha256Override?: string
		latencySamples: number[]
		runContext: BenchmarkRunContext
		tenantStorage?: BenchmarkTenantStorageMeasurement
	}): Promise<{
		runIdentity: import("../../packages/memory-engine/src/types.js").BenchmarkRunIdentity
		embedding: import("../../packages/memory-engine/src/types.js").BenchmarkEmbeddingConfig
		reranker: import("../../packages/memory-engine/src/types.js").BenchmarkRerankerConfig
		storage: import("../../packages/memory-engine/src/types.js").BenchmarkStorageFootprint
		latency: import("../../packages/memory-engine/src/types.js").BenchmarkLatencyDistribution
		cost: import("../../packages/memory-engine/src/types.js").BenchmarkCostAccounting
	}> {
		const mongoCfg = this.host.config.mongodb!
		const retrievalLane = params.retrievalLane ?? "native"
		const qualityContractId =
			typeof params.runContext.configuration.settings.qualityContractId ===
			"string"
				? params.runContext.configuration.settings.qualityContractId
				: undefined
		const qualityContractVersion =
			typeof params.runContext.configuration.settings.qualityContractVersion ===
			"string"
				? params.runContext.configuration.settings.qualityContractVersion
				: undefined
		assertBenchmarkRunConfiguration(
			params.runContext,
			this.snapshotBenchmarkRunConfiguration({
				executionProfile: params.runContext.configuration.executionProfile,
				retrievalLane: params.runContext.configuration.retrievalLane,
				maxResults: params.runContext.configuration.maxResults,
				minScore: params.runContext.configuration.minScore,
				qualityContractId,
				qualityContractVersion,
			}),
		)
		return await projectBenchmarkParityFields({
			db: this.host.db,
			collectionName:
				retrievalLane === "raw-session"
					? `${this.host.prefix}session_chunks`
					: `${this.host.prefix}events`,
			collectionNames: BENCHMARK_SCENARIO_COLLECTION_SUFFIXES.map(
				(suffix) => `${this.host.prefix}${suffix}`,
			),
			datasetPath: params.datasetPath,
			datasetKind: params.datasetKind,
			retrievalLane,
			datasetSha256Override: params.datasetSha256Override,
			mongoEmbeddingConfig: {
				numDimensions: mongoCfg.numDimensions,
				quantization: mongoCfg.quantization,
			},
			latencySamples: params.latencySamples,
			cost: params.runContext.accounting.snapshot(),
			runContext: params.runContext,
			tenantStorage: params.tenantStorage,
		})
	}

	async relevanceReport(params?: {
		windowMs?: number
	}): Promise<RelevanceReport> {
		if (!this.host.relevance) {
			throw new Error("relevance runtime is unavailable")
		}
		const windowMs = params?.windowMs ?? 24 * 60 * 60 * 1000
		return await this.host.relevance.buildReport(windowMs)
	}

	relevanceSampleRate(): RelevanceSampleState {
		if (!this.host.relevance) {
			return {
				enabled: false,
				current: 0,
				base: 0,
				max: 0,
				windowSize: 0,
				degradedSignals: 0,
			}
		}
		return this.host.relevance.getSampleState()
	}

	getBenchmarkAllowedRoots(): string[] {
		const envRoots = (process.env.MEMONGO_BENCHMARK_ALLOWED_ROOTS ?? "")
			.split(path.delimiter)
			.map((entry) => entry.trim())
			.filter(Boolean)
			.map((entry) => resolveUserPath(entry))
		// Single-directory convenience knob for operators (containers): one
		// dedicated datasets root instead of a path-delimited list.
		const datasetRoot = process.env.MEMONGO_DATASET_ROOT?.trim()
		return [
			this.host.workspaceDir,
			path.dirname(
				this.host.config.mongodb?.relevance.benchmark.datasetPath ??
					this.host.workspaceDir,
			),
			...(datasetRoot ? [resolveUserPath(datasetRoot)] : []),
			...envRoots,
		]
	}

	async runLegacyRelevanceBenchmark(params: {
		datasetPath: string
		maxResults: number
		minScore: number
	}): Promise<{
		result: RelevanceBenchmarkResult
		latencySamples: number[]
	}> {
		const cases = await loadLegacyRelevanceDataset(params.datasetPath)
		const evaluations: Array<{
			empty: boolean
			topScore: number
			latencyMs: number
			pass: boolean
		}> = []

		for (const entry of cases) {
			const run = await this.host.relevanceExplain({
				query: entry.query,
				sourceScope: entry.sourceScope ?? "all",
				maxResults: params.maxResults,
				minScore: params.minScore,
				deep: false,
			})
			const summary = buildBenchmarkCaseSummary(run.results, run.latencyMs)
			const expectedSources = entry.expectedSources ?? []
			const sourcePass = expectedSources.every((source) =>
				summary.hitSources.some((hitSource) => hitSource === source),
			)
			const scorePass =
				typeof entry.minTopScore === "number"
					? summary.topScore >= entry.minTopScore
					: true
			evaluations.push({
				empty: summary.empty,
				topScore: summary.topScore,
				latencyMs: summary.latencyMs,
				pass: !summary.empty && sourcePass && scorePass,
			})
		}

		const metrics = summarizeBenchmarkCases(evaluations)
		const datasetVersion = createHash("sha256")
			.update(JSON.stringify(cases.map((entry) => entry.query)))
			.digest("hex")
			.slice(0, 16)
		const regressions = await persistBenchmarkRegression({
			db: this.host.db,
			prefix: this.host.prefix,
			agentId: this.host.agentId,
			datasetVersion,
			currentMetrics: {
				...metrics,
				rAt5: 0,
				rAt10: 0,
				ndcgAt10: 0,
			},
		})
		return {
			result: {
				datasetVersion,
				datasetName: path.basename(params.datasetPath),
				datasetKind: "legacy-query",
				cases: cases.length,
				scoredCases: cases.length,
				skippedCases: 0,
				...metrics,
				// Every legacy case is scored, so the scored-case sample is all cases.
				scoredLatency: percentile50And95(
					evaluations.map((entry) => entry.latencyMs),
					"scored-cases",
				),
				rAt5: 0,
				rAt10: 0,
				ndcgAt10: 0,
				questionTypeBreakdown: [],
				regressions,
			},
			latencySamples: evaluations.map((entry) => entry.latencyMs),
		}
	}

	async runScenarioBenchmarkDataset(params: {
		datasetPath: string
		dataset: BenchmarkAdmittedDataset
		datasetVersion: string
		maxResults: number
		minScore: number
		retrievalLane?: BenchmarkRetrievalLane
		executionProfile?: "shipped" | "diagnostic"
		publicationRun?: boolean
		checkpointPath?: string
		resumeCheckpoint?: BenchmarkCheckpoint
		/** Written into every checkpoint; "unavailable" never resumes. */
		executableDigest?: string
		datasetSha256?: string
		runContext: BenchmarkRunContext
		/**
		 * Paired arms (benchmark-arms.ts): each question is ingested once and
		 * every arm searches, answers and judges it before cleanup. The first
		 * arm is the baseline and supplies the run's own result.
		 */
		arms?: readonly BenchmarkArm[]
	}): Promise<{
		result: RelevanceBenchmarkResult
		latencySamples: number[]
		e2eQa?: BenchmarkE2eQaEnvelope
		storage: BenchmarkTenantStorageMeasurement
	}> {
		const scenarios = params.dataset.scenarios ?? []
		const normalizedConversations = scenarios.map((scenario) =>
			normalizeBenchmarkConversationTimestamps(
				scenario.conversations,
				params.dataset.datasetKind,
			),
		)
		const questionDates = new WeakMap<object, Date>()
		for (const [index, scenario] of scenarios.entries())
			for (const evaluation of scenario.evaluations) {
				if (evaluation.metadata?.questionDate !== undefined)
					questionDates.set(
						evaluation,
						requireBenchmarkTimestamp(
							params.dataset.datasetKind,
							evaluation.metadata.questionDate,
							{
								field: "question_date",
								conversationIndex: index,
								sessionIndex: null,
								turnIndex: null,
							},
						),
					)
			}
		if (
			params.resumeCheckpoint &&
			params.resumeCheckpoint.failedLines !== (params.dataset.failedLines ?? 0)
		)
			throw new Error(
				"benchmark checkpoint failedLines count does not match loaded dataset",
			)
		// Absent counts predate B01:C07; such checkpoints also carry an older
		// executable digest, so they never pass resume identity.
		const loadedRejections = countBenchmarkRejections(
			params.dataset.rejections,
			params.dataset.adapterDiagnostics,
		)
		const loadedAdapterTotals = params.dataset.adapterDiagnostics?.totals
		if (
			params.resumeCheckpoint &&
			((params.resumeCheckpoint.rejectedTurns !== undefined &&
				params.resumeCheckpoint.rejectedTurns !==
					loadedRejections.rejectedTurns) ||
				(params.resumeCheckpoint.rejectedConversations !== undefined &&
					params.resumeCheckpoint.rejectedConversations !==
						loadedRejections.rejectedConversations) ||
				// #94: a missing adapter field reads as zero only when the dataset has no adapter diagnostics.
				(params.resumeCheckpoint.adapterDiagnosticsTotals === undefined
					? loadedAdapterTotals !== undefined
					: !sameAdapterDiagnosticTotals(
							params.resumeCheckpoint.adapterDiagnosticsTotals,
							loadedAdapterTotals,
						)))
		)
			throw new Error(
				"benchmark checkpoint rejection counts do not match loaded dataset",
			)
		if (
			params.resumeCheckpoint?.completedScenarios.some(
				(scenario) => !hasValidBenchmarkIngestCounts(scenario.ingest),
			)
		)
			throw new Error("benchmark checkpoint ingest counts are invalid")

		const measurementPasses = resolveBenchmarkMeasurementPasses()
		const armRuns = params.arms
			? createArmRuns(
					params.arms,
					measurementPasses,
					params.runContext.configuration,
				)
			: undefined
		let armsSetup: JudgedAnswerSetup | undefined
		if (armRuns) {
			assertArmsRunnable({
				datasetKind: params.dataset.datasetKind,
				retrievalLane: params.retrievalLane,
				queryDecomposition:
					params.executionProfile !== "shipped" &&
					resolveDecompositionMode(
						process.env.MEMONGO_QUERY_DECOMPOSITION_MODE,
					) === "enabled",
				scenarios,
			})
			const setup = resolveJudgedAnswerSetup(process.env)
			if ("reason" in setup) {
				throw new Error(`paired arms need judged answers: ${setup.reason}`)
			}
			armsSetup = setup
		}
		const armsDecoys = armRuns ? armsDecoyPool(scenarios) : []
		// #66: index 0 is the gate pass — the one the published result, the
		// release gates, and the regression baseline are computed from. With
		// paired arms these are the baseline arm's passes.
		const executionsByPass: BenchmarkCaseExecution[][] = armRuns?.[0]
			? armRuns[0].executionsByPass
			: Array.from({ length: measurementPasses }, () => [])
		const executions = executionsByPass[0]!
		const expectedSessionMap = new Map<string, string[]>()
		const expectedTurnMap = new Map<string, string[]>()
		const storageCollections = new Map<
			string,
			{ documents: number; logicalBytes: number }
		>()
		const storageFailures: string[] = []
		const cleanupByIndex = new Map<
			number,
			BenchmarkScenarioCleanupReport["scenarios"][number]
		>()
		const runToken = randomUUID().slice(0, 8)
		const rawSessionLane = params.retrievalLane === "raw-session"
		// C-039: QA material for LLM-judged answer accuracy, captured from the
		// pass-0 (gate) retrieval loop — the same results the published
		// retrieval metrics are computed from, so the answer half and the
		// retrieval half of the envelope describe one run.
		const e2eQaMaterialByCaseId = new Map<
			string,
			BenchmarkJudgedAnswerMaterial
		>()
		const ingest = {
			conversationsIngested: 0,
			turnsIngested: 0,
			skippedConversations: 0,
			failedLines: params.dataset.failedLines ?? 0,
			failedTurns: 0,
			...loadedRejections,
		}
		if (
			params.publicationRun &&
			ingest.failedLines + ingest.rejectedTurns + ingest.rejectedConversations >
				0
		) {
			throw new Error(
				`publication benchmark dataset parse incomplete: failedLines=${ingest.failedLines}, rejectedConversations=${ingest.rejectedConversations}, rejectedTurns=${ingest.rejectedTurns}`,
			)
		}
		if (params.checkpointPath && !params.datasetSha256) {
			throw new Error(
				"benchmark checkpointing requires the resolved dataset digest",
			)
		}
		// With paired arms a question is complete only when every arm has its
		// verdict; any other restored scenario re-runs.
		const completedCheckpointScenarios = (
			params.resumeCheckpoint?.completedScenarios ?? []
		).filter((checkpointScenario) => {
			if (!params.arms) return true
			const restored = scenarios[checkpointScenario.index]
			return (
				restored !== undefined &&
				checkpointArmsComplete(
					checkpointScenario.arms,
					params.arms,
					judgeableCaseIds(restored),
					measurementPasses,
				)
			)
		})
		// Snapshot original restored work before current completions are appended.
		// An empty restored checkpoint has no missing pass-0 material.
		const restoredCheckpointScenarioCount = completedCheckpointScenarios.length
		const completedCheckpointIndexes = new Set(
			completedCheckpointScenarios.map((scenario) => scenario.index),
		)
		const addStorageRows = (
			rows: BenchmarkTenantStorageMeasurement["collections"],
		) => {
			for (const entry of rows) {
				const current = storageCollections.get(entry.collectionName) ?? {
					documents: 0,
					logicalBytes: 0,
				}
				current.documents += entry.documents
				current.logicalBytes += entry.logicalBytes
				storageCollections.set(entry.collectionName, current)
			}
		}
		for (const checkpointScenario of completedCheckpointScenarios) {
			if (checkpointScenario.executionsByPass.length !== measurementPasses) {
				throw new Error(
					`benchmark checkpoint measurement pass count does not match: scenario=${checkpointScenario.scenarioId}`,
				)
			}
			if (armRuns) {
				// The baseline arm's passes are executionsByPass.
				restoreCheckpointArms(armRuns, checkpointScenario.arms)
			} else {
				for (let pass = 0; pass < measurementPasses; pass++) {
					executionsByPass[pass]!.push(
						...(checkpointScenario.executionsByPass[pass] ?? []),
					)
				}
			}
			ingest.conversationsIngested +=
				checkpointScenario.ingest.conversationsIngested
			ingest.turnsIngested += checkpointScenario.ingest.turnsIngested
			ingest.skippedConversations +=
				checkpointScenario.ingest.skippedConversations
			ingest.failedTurns += checkpointScenario.ingest.failedTurns
			for (const [
				caseId,
				sessionIds,
			] of checkpointScenario.expectedSessionEntries) {
				expectedSessionMap.set(caseId, sessionIds)
			}
			for (const [caseId, turnIds] of checkpointScenario.expectedTurnEntries) {
				expectedTurnMap.set(caseId, turnIds)
			}
			addStorageRows(checkpointScenario.storageCollections)
			if (checkpointScenario.storageFailure) {
				storageFailures.push(checkpointScenario.storageFailure)
			}
			cleanupByIndex.set(
				checkpointScenario.index,
				restoreScenarioCleanup(checkpointScenario.cleanup, {
					runId: params.runContext.runId,
					scenarioId: checkpointScenario.scenarioId,
				}),
			)
		}
		// Slice B: durable QA protocol preflight — separate judge provider,
		// dated answer prompts, anscheck-verified hypotheses persisted to a
		// sidecar beside the checkpoint. Only the exact env values "official"
		// and "custom-judge" opt in; "custom-v1" (or unset), "custom-v2" and
		// "custom-v3" keep the legacy harness, and any other value fails here, before any
		// scenario or provider work is paid for. Custom-judge runs dispatch through the SAME
		// durable scoring path as official runs (preflight, per-scenario
		// scoring, checkpoint gating, summary); only the judge provenance
		// differs.
		let officialQaContext: OfficialQaContext | undefined
		const benchmarkQaProtocol = resolveBenchmarkQaProtocol(process.env)
		if (
			benchmarkQaProtocol === "official" ||
			benchmarkQaProtocol === "custom-judge"
		) {
			if (params.dataset.datasetKind !== "longmemeval") {
				throw new Error(
					`MEMONGO_BENCHMARK_QA_PROTOCOL=${benchmarkQaProtocol} requires a LongMemEval dataset, got datasetKind=${params.dataset.datasetKind ?? "unknown"}`,
				)
			}
			officialQaContext = await prepareOfficialQa({
				env: process.env,
				checkpointPath: params.checkpointPath,
				runId: params.runContext.runId,
				configurationHash: params.runContext.configurationHash,
				datasetSha256: params.datasetSha256 ?? "",
				resumeCompletedScenarios: completedCheckpointScenarios.map(
					(checkpointScenario) => ({
						scenarioId: checkpointScenario.scenarioId,
						declaredCaseIds:
							scenarios[checkpointScenario.index]?.evaluations.map(
								(evaluation) => evaluation.caseId,
							) ?? [],
					}),
				),
			})
		}
		// Slice B round 2: startup orphan accounting. Judged sidecar rows whose
		// scenario had no completed checkpoint entry when this run started stay
		// lost for accounting even if this run later covers them, so recovery
		// cannot silently clear pre-crash uncertainty. Computed from the
		// restored entries only, before this run appends its own completions.
		const officialStartupCoveredCaseIds = new Set<string>()
		for (const checkpointScenario of completedCheckpointScenarios) {
			for (const evaluation of scenarios[checkpointScenario.index]
				?.evaluations ?? []) {
				officialStartupCoveredCaseIds.add(evaluation.caseId)
			}
		}
		const officialStartupLostQuestionIds = officialQaContext
			? Object.values(officialQaContext.sidecar.rows)
					.filter((row) => row.stage === "judged")
					.map((row) => row.questionId)
					.filter(
						(questionId) => !officialStartupCoveredCaseIds.has(questionId),
					)
			: []
		// Slice B round 2: seed an empty identity/accounting checkpoint right
		// after official preflight and BEFORE the first paid scenario, so a
		// crash after the first answered/judged sidecar row still resumes with
		// a recoverable runId (the checkpoint carries the identity gates).
		// Fresh official runs only (a resumed run already has its checkpoint),
		// and never over an existing file — the post-scenario write keeps its
		// overwrite semantics. Same v1 schema; identity gates untouched.
		if (
			officialQaContext &&
			params.checkpointPath &&
			!params.resumeCheckpoint
		) {
			const seedDatasetSha256 = params.datasetSha256
			if (!seedDatasetSha256) {
				throw new Error(
					"benchmark checkpointing requires the resolved dataset digest",
				)
			}
			let checkpointExists = false
			try {
				await access(params.checkpointPath)
				checkpointExists = true
			} catch {
				checkpointExists = false
			}
			if (!checkpointExists) {
				await writeBenchmarkCheckpointAtomic(params.checkpointPath, {
					version: 2,
					failedLines: ingest.failedLines,
					rejectedTurns: ingest.rejectedTurns,
					rejectedConversations: ingest.rejectedConversations,
					...(loadedAdapterTotals
						? { adapterDiagnosticsTotals: loadedAdapterTotals }
						: {}),
					runId: params.runContext.runId,
					datasetSha256: seedDatasetSha256,
					configurationHash: params.runContext.configurationHash,
					configuration: params.runContext.configuration,
					executableDigest: params.executableDigest ?? "unavailable",
					totalScenarios: scenarios.length,
					scenarioIds: scenarios.map((entry) => entry.scenarioId),
					completedScenarios: [],
					accounting: params.runContext.accounting.snapshot(),
					updatedAt: new Date().toISOString(),
				})
			}
		}
		const runForegroundRead = <T>(
			label: string,
			operation: () => Promise<T>,
		): Promise<T> =>
			withMongoBenchmarkRetry(label, operation, {
				onRetry: ({ attempt, maxAttempts, delayMs, error }) => {
					log.warn("retrying transient benchmark MongoDB read", {
						label,
						attempt,
						maxAttempts,
						delayMs,
						error: error instanceof Error ? error.message : String(error),
					})
				},
			})

		for (const [index, scenario] of scenarios.entries()) {
			if (completedCheckpointIndexes.has(index)) {
				log.info("benchmark scenario restored from checkpoint", {
					scenarioId: scenario.scenarioId,
					index,
					totalScenarios: scenarios.length,
				})
				continue
			}
			const scenarioStartedAt = Date.now()
			const passExecutionOffsets = executionsByPass.map(
				(passExecutions) => passExecutions.length,
			)
			const armExecutionOffsets = armRuns?.map((run) =>
				run.executionsByPass.map((passExecutions) => passExecutions.length),
			)
			const scenarioArmQa: BenchmarkArmScenarioQa[] = []
			let checkpointArms: BenchmarkCheckpointArm[] | undefined
			const scenarioIngestTotals = {
				conversationsIngested: 0,
				turnsIngested: 0,
				skippedConversations: 0,
				failedTurns: 0,
			}
			let scenarioStorageCollections: BenchmarkTenantStorageMeasurement["collections"] =
				[]
			let scenarioStorageFailure: string | undefined
			let scenarioCleanup: BenchmarkScenarioCleanupOutcome | undefined
			// The error leaving this scenario, if any: cleanup failure is
			// attached to it instead of replacing it.
			let propagatingError: unknown
			let scenarioManager: MongoDBManagerHost = this.host
			let closeScenarioManager = async (): Promise<void> => {}
			let scenarioWorkspaceDir: string | undefined
			let ownedScenarioAgentId: string | undefined
			let scenarioOps: MongoDBManagerBenchmarkOps = this
			let eventEvidence: BenchmarkEventEvidenceMaps = {
				sessionIds: new Map<string, string>(),
				turnIds: new Map<string, string>(),
				dialogIds: new Map<string, string>(),
			}
			// Slice B round 2: per-scenario official scoring outcome. Stays true
			// for non-official runs (the checkpoint gate is official-only) and
			// is only assigned inside the try, so a scoring throw propagates
			// through the finally without ever reaching the checkpoint write.
			let officialScenarioComplete = true
			// Paired arms: false until every arm has a verdict per question.
			let armsScenarioComplete = !armRuns
			// Closes the scenario manager, measures storage and records cleanup.
			// A close/measurement error stays primary over the scenario error;
			// a cleanup failure is attached to whichever error propagates.
			const finishScenario = async (): Promise<void> => {
				let closeError: { error: unknown } | undefined
				try {
					if (scenarioManager !== this.host) {
						await closeScenarioManager()
						const measurement = await collectBenchmarkTenantStorage({
							db: this.host.db,
							agentId: scenarioManager.agentId,
							collectionNames: BENCHMARK_SCENARIO_COLLECTION_SUFFIXES.map(
								(suffix) => `${this.host.prefix}${suffix}`,
							),
						})
						if (measurement.unavailableReason) {
							scenarioStorageFailure = `${scenario.scenarioId}: ${measurement.unavailableReason}`
							storageFailures.push(scenarioStorageFailure)
						}
						scenarioStorageCollections = measurement.collections
						addStorageRows(measurement.collections)
					} else {
						scenarioStorageFailure = `${scenario.scenarioId}: scenario did not use an isolated benchmark agent`
						storageFailures.push(scenarioStorageFailure)
					}
				} catch (error) {
					closeError = { error }
					propagatingError = error
				}
				try {
					scenarioCleanup = await this.recordBenchmarkScenarioCleanup({
						runId: params.runContext.runId,
						scenarioId: scenario.scenarioId,
						ownedAgentId: ownedScenarioAgentId,
						agentId:
							scenarioManager !== this.host
								? scenarioManager.agentId
								: ownedScenarioAgentId,
						propagatingError,
					})
				} finally {
					if (scenarioWorkspaceDir)
						await rm(scenarioWorkspaceDir, { recursive: true, force: true })
				}
				if (closeError) throw closeError.error
			}
			// Official QA: dataset session dates (haystack timestamps) by
			// session id, so pass-0 passages can carry the dates of the
			// sessions they were retrieved from into the dated answer prompt.
			const sessionDatesBySessionId = new Map<string, string[]>()
			for (const conversation of scenario.conversations) {
				if (typeof conversation.sessionId !== "string") {
					continue
				}
				const dates = new Set<string>()
				for (const turn of conversation.turns) {
					if (
						typeof turn.timestamp === "string" &&
						turn.timestamp.trim().length > 0
					) {
						dates.add(turn.timestamp.trim())
					}
				}
				if (dates.size > 0) {
					sessionDatesBySessionId.set(conversation.sessionId, [...dates].sort())
				}
			}
			const sessionDatesForResult = (result: MemorySearchResult): string[] => {
				const dates = new Set<string>()
				for (const sessionId of this.resolveBenchmarkResultSessionIds(
					result,
					eventEvidence,
				)) {
					for (const date of sessionDatesBySessionId.get(sessionId) ?? []) {
						dates.add(date)
					}
				}
				return [...dates].sort()
			}
			try {
				log.info("benchmark scenario start", {
					scenarioId: scenario.scenarioId,
					index,
					totalScenarios: scenarios.length,
					conversations: scenario.conversations.length,
					evaluations: scenario.evaluations.length,
					retrievalLane: params.retrievalLane ?? "native",
				})
				if (scenario.conversations.length > 0) {
					const scenarioAgentId = `benchmark-${this.host.agentId}-${runToken}-${createHash("sha256").update(`${index}:${scenario.scenarioId}`).digest("hex").slice(0, 12)}`
					ownedScenarioAgentId = scenarioAgentId
					scenarioWorkspaceDir = await mkdtemp(
						path.join(os.tmpdir(), "memongo-benchmark-scenario-"),
					)
					const createdManager = await this.createBenchmarkScenarioManager(
						scenarioAgentId,
						scenarioWorkspaceDir,
					)
					scenarioManager = createdManager as unknown as MongoDBManagerHost
					closeScenarioManager = () => createdManager.close()
					scenarioOps = new MongoDBManagerBenchmarkOps(scenarioManager)
					const scenarioIngest =
						params.executionProfile !== "shipped" &&
						scenarioOps.shouldUseBenchmarkFastIngest()
							? await scenarioOps.fastIngestBenchmarkConversations({
									datasetPath: params.datasetPath,
									datasetName: params.dataset.name,
									datasetKind: params.dataset.datasetKind,
									conversations: scenario.conversations,
									scope: "agent",
									metadata: {
										benchmarkDatasetKind:
											params.dataset.datasetKind ?? "generic",
										benchmarkScenarioId: scenario.scenarioId,
									},
								})
							: await ingestBenchmarkConversations({
									datasetPath: params.datasetPath,
									datasetName: params.dataset.name,
									datasetKind: params.dataset.datasetKind,
									conversations: scenario.conversations,
									scope: "agent",
									metadata: {
										benchmarkDatasetKind:
											params.dataset.datasetKind ?? "generic",
										benchmarkScenarioId: scenario.scenarioId,
									},
									writeTurns: async (turns) =>
										scenarioManager.writeConversationEventsBatch(
											turns,
											params.runContext,
										),
								})
					ingest.conversationsIngested += scenarioIngest.conversationsIngested
					ingest.turnsIngested += scenarioIngest.turnsIngested
					ingest.skippedConversations += scenarioIngest.skippedConversations
					ingest.failedTurns += scenarioIngest.failedTurns
					scenarioIngestTotals.conversationsIngested +=
						scenarioIngest.conversationsIngested
					scenarioIngestTotals.turnsIngested += scenarioIngest.turnsIngested
					scenarioIngestTotals.skippedConversations +=
						scenarioIngest.skippedConversations
					scenarioIngestTotals.failedTurns += scenarioIngest.failedTurns
					if (params.publicationRun && scenarioIngest.failedTurns > 0) {
						throw new Error(
							`publication benchmark scenario ingest incomplete: scenario=${scenario.scenarioId} failedTurns=${scenarioIngest.failedTurns}`,
						)
					}
					log.info("benchmark scenario ingested", {
						scenarioId: scenario.scenarioId,
						agentId: scenarioManager.agentId,
						conversationsIngested: scenarioIngest.conversationsIngested,
						turnsIngested: scenarioIngest.turnsIngested,
						failedTurns: scenarioIngest.failedTurns,
					})
					await this.settleBenchmarkScenarioManager(scenarioManager)
					eventEvidence = await runForegroundRead(
						`event evidence for ${scenario.scenarioId}`,
						() => this.listBenchmarkEventEvidence(scenarioManager.agentId),
					)

					// Session evidence: create session-level documents for retrieval
					const sessionEvidenceMode = resolveSessionEvidenceMode(
						process.env.MEMONGO_SESSION_EVIDENCE_MODE,
					)
					const effectiveSessionEvidenceMode =
						params.executionProfile === "shipped"
							? "none"
							: rawSessionLane
								? "B"
								: sessionEvidenceMode
					const userfactEvidenceMode =
						params.executionProfile === "shipped"
							? "none"
							: resolveUserfactEvidenceMode(
									process.env.MEMONGO_USERFACT_EVIDENCE_MODE,
									process.env.MEMONGO_PREFERENCE_EVIDENCE_MODE,
								)
					const enrichmentMode =
						params.executionProfile === "shipped"
							? "none"
							: resolveEnrichmentMode(process.env.MEMONGO_LLM_ENRICHMENT_MODE)
					let sessionEvidenceDocsWritten = 0
					let sessionEventCount = 0
					if (
						effectiveSessionEvidenceMode !== "none" ||
						(!rawSessionLane &&
							(userfactEvidenceMode === "enabled" || enrichmentMode !== "none"))
					) {
						try {
							// Invert eventId->sessionId to sessionId->[eventIds]
							const sessionEventMap = new Map<string, string[]>()
							for (const [eventId, sessionId] of eventEvidence.sessionIds) {
								const existing = sessionEventMap.get(sessionId)
								if (existing) {
									existing.push(eventId)
								} else {
									sessionEventMap.set(sessionId, [eventId])
								}
							}
							sessionEventCount = sessionEventMap.size
							const scopeRef = resolveScopeRef({
								scope: "agent",
								agentId: scenarioManager.agentId,
							})
							// C-005: session-evidence docs embed their source
							// events, so they inherit the latest source-event
							// expiry and expire with them (TTL index + read
							// guard). Sessions with a never-expiring event stay
							// permanent.
							const sessionExpiresAt = await resolveSessionEvidenceExpiresAt({
								db: this.host.db,
								prefix: this.host.prefix,
								agentId: scenarioManager.agentId,
								scope: "agent",
								scopeRef,
								sessionEventMap,
							})

							if (effectiveSessionEvidenceMode === "A") {
								await writeSessionEvidenceOptionA({
									chunksCollection: chunksCollection(
										this.host.db,
										this.host.prefix,
									),
									conversations: normalizedConversations[index],
									agentId: scenarioManager.agentId,
									scope: "agent",
									scopeRef,
									eventIds: sessionEventMap,
									sessionExpiresAt,
								})
							} else if (effectiveSessionEvidenceMode === "B") {
								sessionEvidenceDocsWritten = await writeSessionEvidenceOptionB({
									sessionChunksCollection: sessionChunksCollection(
										this.host.db,
										this.host.prefix,
									),
									conversations: normalizedConversations[index],
									agentId: scenarioManager.agentId,
									scope: "agent",
									scopeRef,
									eventIds: sessionEventMap,
									sessionExpiresAt,
								})
							}

							// LLM enrichment: replaces regex userfact when available.
							// B1: MEMONGO_EXTRACTION_LLM=off skips ingest-time LLM
							// extraction entirely (the B20 ablation) without
							// unsetting the enrichment env the answerer may share.
							const enrichmentProvider =
								!rawSessionLane &&
								enrichmentMode !== "none" &&
								!isExtractionLlmDisabled(process.env)
									? resolveEnrichmentProvider(process.env)
									: null
							const enrichmentStrict =
								!rawSessionLane &&
								resolveEnrichmentStrictMode(
									process.env.MEMONGO_LLM_ENRICHMENT_STRICT,
								)

							if (
								!rawSessionLane &&
								enrichmentMode !== "none" &&
								enrichmentStrict &&
								!enrichmentProvider
							) {
								if (isExtractionLlmDisabled(process.env)) {
									throw new Error(
										"MEMONGO_LLM_ENRICHMENT_STRICT cannot be combined with MEMONGO_EXTRACTION_LLM=off: strict mode requires the extraction LLM",
									)
								}
								throw new Error(
									"MEMONGO_LLM_ENRICHMENT_STRICT requires a configured LLM enrichment provider",
								)
							}

							if (enrichmentProvider && enrichmentMode !== "none") {
								try {
									const enrichmentModel =
										process.env.MEMONGO_ENRICHMENT_MODEL?.trim() ?? ""
									const enrichmentConcurrencyValue = Number(
										process.env.MEMONGO_ENRICHMENT_CONCURRENCY,
									)
									const enrichmentConcurrency =
										Number.isFinite(enrichmentConcurrencyValue) &&
										enrichmentConcurrencyValue > 0
											? Math.min(10, Math.floor(enrichmentConcurrencyValue))
											: undefined
									const enrichResult = await enrichSessionsWithLLM({
										provider: enrichmentProvider,
										model: enrichmentModel,
										mode: enrichmentMode,
										conversations: scenario.conversations,
										agentId: scenarioManager.agentId,
										scope: "agent",
										scopeRef,
										eventIds: sessionEventMap,
										concurrency: enrichmentConcurrency,
										onProviderCall: (outcome) => {
											const accounting = params.runContext.accounting
											const metadata = {
												provider: enrichmentProvider.name,
												model: enrichmentModel,
											}
											if (outcome === "attempted") {
												accounting.recordAttempt("enrichment", metadata)
											} else if (outcome === "succeeded") {
												accounting.recordSuccess("enrichment", metadata)
											} else {
												accounting.recordFailure("enrichment", metadata)
											}
										},
									})
									// Write LLM-produced userfact docs (replace regex)
									if (enrichResult.userfactDocs.length > 0) {
										await chunksCollection(
											this.host.db,
											this.host.prefix,
										).insertMany(enrichResult.userfactDocs)
									}
									// Write QA evidence docs
									if (enrichResult.qaDocs.length > 0) {
										await chunksCollection(
											this.host.db,
											this.host.prefix,
										).insertMany(enrichResult.qaDocs)
									}
									// Fall back to regex for sessions where LLM failed
									if (
										enrichResult.failedSessionIds.length > 0 &&
										enrichmentStrict
									) {
										throw new Error(
											`LLM enrichment failed for ${enrichResult.sessionsFailed} sessions: ${JSON.stringify(enrichResult.failureSamples)}`,
										)
									}
									if (
										enrichResult.failedSessionIds.length > 0 &&
										userfactEvidenceMode === "enabled"
									) {
										log.warn(
											"LLM enrichment partial failure, falling back to regex for failed sessions",
											{
												scenarioId: scenario.scenarioId,
												sessionsEnriched: enrichResult.sessionsEnriched,
												sessionsFailed: enrichResult.sessionsFailed,
												failedSessionIds: enrichResult.failedSessionIds,
												failureSamples: enrichResult.failureSamples,
											},
										)
										const failedSet = new Set(enrichResult.failedSessionIds)
										const failedConversations = scenario.conversations.filter(
											(c) => c.sessionId && failedSet.has(c.sessionId),
										)
										if (failedConversations.length > 0) {
											await writeUserfactEvidence({
												chunksCollection: chunksCollection(
													this.host.db,
													this.host.prefix,
												),
												conversations: failedConversations,
												agentId: scenarioManager.agentId,
												scope: "agent",
												scopeRef,
												eventIds: sessionEventMap,
											})
										}
									}
								} catch (err) {
									if (enrichmentStrict) {
										throw err
									}
									log.warn("LLM enrichment failed, falling back to regex", {
										scenarioId: scenario.scenarioId,
										error: err instanceof Error ? err.message : String(err),
									})
									// Full fallback to regex userfact extraction
									if (userfactEvidenceMode === "enabled") {
										await writeUserfactEvidence({
											chunksCollection: chunksCollection(
												this.host.db,
												this.host.prefix,
											),
											conversations: scenario.conversations,
											agentId: scenarioManager.agentId,
											scope: "agent",
											scopeRef,
											eventIds: sessionEventMap,
										})
									}
								}
							} else if (
								!rawSessionLane &&
								userfactEvidenceMode === "enabled"
							) {
								// No LLM provider: use regex extraction
								await writeUserfactEvidence({
									chunksCollection: chunksCollection(
										this.host.db,
										this.host.prefix,
									),
									conversations: normalizedConversations[index],
									agentId: scenarioManager.agentId,
									scope: "agent",
									scopeRef,
									eventIds: sessionEventMap,
								})
							}
						} catch (err) {
							log.warn("benchmark evidence creation failed", {
								sessionMode: effectiveSessionEvidenceMode,
								userfactMode: userfactEvidenceMode,
								scenarioId: scenario.scenarioId,
								error: err instanceof Error ? err.message : String(err),
							})
							if (isBenchmarkStrictMode()) {
								const message = err instanceof Error ? err.message : String(err)
								throw new Error(
									`benchmark evidence creation failed in strict mode: scenario=${scenario.scenarioId}: ${message}`,
								)
							}
						}
						// Allow auto-embed to index enrichment docs before evaluation.
						// MongoDB auto-embed is eventually consistent — mongot processes
						// docs async via change streams + Voyage API. Empirically 5-15s
						// for ~40 docs on Atlas Local. Fixed delay + write queue settle.
						await this.settleBenchmarkScenarioManager(scenarioManager)
						const [chunkEvidenceCount, sessionEvidenceCount] =
							await Promise.all([
								chunksCollection(this.host.db, this.host.prefix).countDocuments(
									{
										agentId: scenarioManager.agentId,
										source: {
											$in: [
												"session-evidence",
												"userfact-evidence",
												"qa-evidence",
											],
										},
									},
								),
								sessionChunksCollection(
									this.host.db,
									this.host.prefix,
								).countDocuments({
									agentId: scenarioManager.agentId,
									source: "session-evidence",
								}),
							])
						const evidenceCount = chunkEvidenceCount + sessionEvidenceCount
						if (rawSessionLane) {
							const nonAbstentionEvaluations = scenario.evaluations.filter(
								(evaluation) => !evaluation.abstention,
							).length
							if (
								nonAbstentionEvaluations > 0 &&
								sessionEvidenceDocsWritten === 0
							) {
								throw new Error(
									`raw-session benchmark evidence creation produced zero session documents: scenario=${scenario.scenarioId} agentId=${scenarioManager.agentId} conversations=${scenario.conversations.length} nonAbstentionEvaluations=${nonAbstentionEvaluations}`,
								)
							}
							if (sessionEvidenceCount < sessionEvidenceDocsWritten) {
								throw new Error(
									`raw-session benchmark session_chunks persistence mismatch: scenario=${scenario.scenarioId} agentId=${scenarioManager.agentId} written=${sessionEvidenceDocsWritten} persisted=${sessionEvidenceCount}`,
								)
							}
							log.info("raw-session benchmark evidence ready", {
								scenarioId: scenario.scenarioId,
								agentId: scenarioManager.agentId,
								writtenSessionDocs: sessionEvidenceDocsWritten,
								persistedSessionDocs: sessionEvidenceCount,
								sessionEventCount,
								nonAbstentionEvaluations,
							})
						}
						if (chunkEvidenceCount > 0 && !rawSessionLane) {
							const settleMs =
								Number(process.env.MEMONGO_EVIDENCE_SETTLE_MS) || 15_000
							log.info(
								`waiting ${settleMs}ms for auto-embed convergence (${chunkEvidenceCount} chunk evidence docs)`,
								{
									scenarioId: scenario.scenarioId,
									evidenceCount: chunkEvidenceCount,
								},
							)
							await new Promise((r) => setTimeout(r, settleMs))
						}
					}
					await runForegroundRead(
						`search convergence for ${scenario.scenarioId}`,
						() =>
							this.waitForBenchmarkSearchConvergence({
								agentId: scenarioManager.agentId,
								retrievalLane: params.retrievalLane,
							}),
					)
				} else {
					eventEvidence = await runForegroundRead(
						`event evidence for ${scenario.scenarioId}`,
						() => this.listBenchmarkEventEvidence(this.host.agentId),
					)
				}

				// #66: repeat ONLY the measurement loop. Ingest, evidence, settle,
				// convergence, and cleanup each stay at exactly one per scenario, so
				// n samples of a condition cost n eval loops instead of n full runs.
				// Paired arms: each arm measures, then answers and judges, in arm
				// order, against this one ingest; cleanup waits for every arm.
				for (const armRun of armRuns ?? [undefined]) {
					const qaProtocol = armRun?.arm.protocol ?? benchmarkQaProtocol
					const armExecutionsByPass =
						armRun?.executionsByPass ?? executionsByPass
					const materialByCaseId =
						armRun?.materialByCaseId ?? e2eQaMaterialByCaseId
					for (let pass = 0; pass < measurementPasses; pass++) {
						const passExecutions = armExecutionsByPass[pass]!
						for (const evaluation of scenario.evaluations) {
							const startedAt = Date.now()
							const validQuestionDate = questionDates.get(evaluation)
							// B3: search with the end of the question's calendar day (see
							// endOfBenchmarkQuestionDay) so same-day answer sessions remain
							// eligible under the engine's validAt guard.
							const searchableQuestionDate = validQuestionDate
								? endOfBenchmarkQuestionDay(validQuestionDate)
								: undefined
							try {
								// Query decomposition: break preference-style queries into sub-queries
								const decompositionMode = resolveDecompositionMode(
									process.env.MEMONGO_QUERY_DECOMPOSITION_MODE,
								)
								const decompositionProvider =
									decompositionMode === "enabled"
										? resolveBenchmarkAnswerProvider(process.env)
										: null

								let results: MemorySearchResult[]
								// #66: per-lane latency of the search that produced `results`.
								// Only the plain search() path carries a lane breakdown.
								let latencyByLane: Record<string, number> | undefined
								let roundPartnerRequested = false

								if (rawSessionLane) {
									results = await runForegroundRead(
										`raw-session search for ${evaluation.caseId}`,
										() =>
											scenarioOps.searchBenchmarkRawSession(evaluation.query, {
												maxResults: params.maxResults,
												minScore: params.minScore,
											}),
									)
								} else if (
									decompositionProvider &&
									decompositionMode === "enabled" &&
									params.executionProfile !== "shipped"
								) {
									// #66: decomposition sits outside search(), so its cost and the
									// N sub-searches it fans out never reach the lane breakdown.
									const decomposeStartedAt = Date.now()
									const decomposed = await decomposeQuery({
										provider: decompositionProvider,
										// B1: decomposition is a query-side call in the answer
										// pipeline, so it follows the benchmark answer provider,
										// not the extraction provider.
										model: benchmarkAnswerModelName(process.env),
										query: evaluation.query,
										questionType: evaluation.questionType,
										onProviderCall: (outcome) => {
											const accounting = params.runContext.accounting
											const metadata = {
												provider: decompositionProvider.name,
												model: benchmarkAnswerModelName(process.env),
											}
											if (outcome === "attempted") {
												accounting.recordAttempt(
													"query-decomposition",
													metadata,
												)
											} else if (outcome === "succeeded") {
												accounting.recordSuccess(
													"query-decomposition",
													metadata,
												)
											} else {
												accounting.recordFailure(
													"query-decomposition",
													metadata,
												)
											}
										},
									})
									const decomposeMs = Date.now() - decomposeStartedAt
									// Run each sub-query through the search pipeline
									const subSearchStartedAt = Date.now()
									const resultSets: MemorySearchResult[][] = []
									for (const subQuery of decomposed.subQueries) {
										const subResults = await runForegroundRead(
											`decomposed search for ${evaluation.caseId}`,
											() =>
												scenarioManager.search(
													subQuery,
													{
														maxResults: params.maxResults,
														minScore: params.minScore,
														questionDate: searchableQuestionDate,
													},
													params.runContext,
												),
										)
										resultSets.push(subResults)
									}
									// Also run the original query to avoid losing good direct matches
									const originalResults = await runForegroundRead(
										`original decomposed search for ${evaluation.caseId}`,
										() =>
											scenarioManager.search(
												evaluation.query,
												{
													maxResults: params.maxResults,
													minScore: params.minScore,
													questionDate: searchableQuestionDate,
												},
												params.runContext,
											),
									)
									resultSets.push(originalResults)
									latencyByLane = {
										"phase:decompose": decomposeMs,
										"phase:decompose-searches": Date.now() - subSearchStartedAt,
									}
									// Merge all result sets with RRF
									results = mergeMultiQueryResults(
										resultSets,
										params.maxResults,
									) as MemorySearchResult[]
								} else {
									const relevanceScope =
										evaluation.sourceScope &&
										scenarioManager.relevance &&
										evaluation.sourceScope !== "all"
											? evaluation.sourceScope
											: undefined
									roundPartnerRequested =
										!relevanceScope && qaProtocol === "custom-v3"
									results = relevanceScope
										? (
												await runForegroundRead(
													`relevance search for ${evaluation.caseId}`,
													() =>
														scenarioManager.relevanceExplain({
															query: evaluation.query,
															sourceScope: relevanceScope,
															maxResults: params.maxResults,
															minScore: params.minScore,
															deep: false,
															questionDate: searchableQuestionDate,
														}),
												)
											).results
										: await runForegroundRead(
												`search for ${evaluation.caseId}`,
												() =>
													scenarioManager.search(
														evaluation.query,
														{
															maxResults: params.maxResults,
															minScore: params.minScore,
															questionDate: searchableQuestionDate,
															onLaneLatency: (lanes) => {
																latencyByLane = lanes
															},
															...(roundPartnerRequested
																? { includeRoundPartner: true }
																: {}),
															...(armRun
																? {
																		sessionTurnRecall:
																			armRun.arm.sessionTurnRecall,
																	}
																: {}),
														},
														params.runContext,
													),
											)
								}
								passExecutions.push(
									evaluateRankingCase({
										caseId: evaluation.caseId,
										results,
										latencyMs: Date.now() - startedAt,
										...(latencyByLane && Object.keys(latencyByLane).length > 0
											? { latencyByLane }
											: {}),
										relevantSessionIds: evaluation.expectedSessionIds,
										relevantTurnIds: evaluation.expectedTurnIds,
										relevantDialogIds: evaluation.expectedDialogIds,
										resolveSessionIds: (result) =>
											this.resolveBenchmarkResultSessionIds(
												result,
												eventEvidence,
											),
										resolveTurnIds: (result) =>
											this.resolveBenchmarkResultTurnIds(result, eventEvidence),
										resolveDialogIds: (result) =>
											this.resolveBenchmarkResultDialogIds(
												result,
												eventEvidence,
											),
										datasetKind: params.dataset.datasetKind,
										officialRetrieval: evaluation.officialRetrieval,
										questionType: evaluation.questionType,
										abstention: evaluation.abstention,
										traceOptions: { maxCandidates: 50 },
									}),
								)
								if (pass === 0) {
									// Keep passages and their per-passage session dates
									// and roles index-aligned: a dropped passage drops
									// its dates and role too. B5: the reader gets the
									// full passage text, not the 700-char display
									// preview. B9: the role labels the speaking turn
									// (User:/Assistant:) in the dated answer prompt.
									const passagesWithDates = results
										.map((result, index) => ({
											passage: result.text ?? result.snippet,
											dates: sessionDatesForResult(result),
											role: result.role,
											retrievedRank: index + 1,
										}))
										.filter(
											(entry) =>
												typeof entry.passage === "string" &&
												entry.passage.trim().length > 0,
										)
									materialByCaseId.set(evaluation.caseId, {
										caseId: evaluation.caseId,
										question: evaluation.query,
										goldAnswer: evaluation.answer ?? "",
										abstention: evaluation.abstention === true,
										contextPassages: passagesWithDates.map(
											(entry) => entry.passage,
										),
										questionType: evaluation.questionType,
										questionDate:
											typeof evaluation.metadata?.questionDate === "string"
												? evaluation.metadata.questionDate
												: undefined,
										passageDates: passagesWithDates.map((entry) => entry.dates),
										passageRoles: passagesWithDates.map((entry) => entry.role),
										...(qaProtocol === "custom-v3"
											? captureReaderUnits({
													caseId: evaluation.caseId,
													results,
													roundPartnerRequested,
													evidence: eventEvidence,
													collectSourceEventIds: (result) =>
														this.collectBenchmarkResultSourceEventIds(result),
													resolveSessionIds: (result) =>
														this.resolveBenchmarkResultSessionIds(
															result,
															eventEvidence,
														),
													resolveTurnIds: (result) =>
														this.resolveBenchmarkResultTurnIds(
															result,
															eventEvidence,
														),
													sessionDates: (sessionId) =>
														sessionDatesBySessionId.get(sessionId) ?? [],
													evaluation,
													conversations: scenario.conversations,
												})
											: {}),
										...(qaProtocol === "custom-v1" || qaProtocol === "custom-v2"
											? captureContextDiagnostics(evaluation.caseId, () =>
													buildPass0ContextDiagnostics({
														results,
														keptRanks: passagesWithDates.map(
															(entry) => entry.retrievedRank,
														),
														evidence: eventEvidence,
														collectSourceEventIds: (result) =>
															this.collectBenchmarkResultSourceEventIds(result),
														resolveSessionIds: (result) =>
															this.resolveBenchmarkResultSessionIds(
																result,
																eventEvidence,
															),
														resolveTurnIds: (result) =>
															this.resolveBenchmarkResultTurnIds(
																result,
																eventEvidence,
															),
														evaluation,
														conversations: scenario.conversations,
													}),
												)
											: {}),
									})
								}
								// Track expected IDs for miss ledger
								expectedSessionMap.set(
									evaluation.caseId,
									evaluation.expectedSessionIds,
								)
								expectedTurnMap.set(
									evaluation.caseId,
									evaluation.expectedTurnIds ?? [],
								)
							} catch (err) {
								const message = err instanceof Error ? err.message : String(err)
								if (isBenchmarkStrictMode()) {
									throw new Error(
										`benchmark evaluation query failed in strict mode: scenario=${scenario.scenarioId} case=${evaluation.caseId}: ${message}`,
									)
								}
								log.warn("benchmark evaluation query failed", {
									scenarioId: scenario.scenarioId,
									caseId: evaluation.caseId,
									error: err instanceof Error ? err.message : String(err),
								})
								// B4: a query failure is a reliability failure, not a wrong
								// answer. executionError (a pre-existing evaluateRankingCase
								// mechanism) marks the case system-failure and excludes it
								// from scoring.
								passExecutions.push(
									evaluateRankingCase({
										caseId: evaluation.caseId,
										results: [],
										latencyMs: Date.now() - startedAt,
										executionError: message,
										relevantSessionIds: evaluation.expectedSessionIds,
										relevantTurnIds: evaluation.expectedTurnIds,
										relevantDialogIds: evaluation.expectedDialogIds,
										resolveSessionIds: (result) =>
											this.resolveBenchmarkResultSessionIds(
												result,
												eventEvidence,
											),
										resolveTurnIds: (result) =>
											this.resolveBenchmarkResultTurnIds(result, eventEvidence),
										resolveDialogIds: (result) =>
											this.resolveBenchmarkResultDialogIds(
												result,
												eventEvidence,
											),
										datasetKind: params.dataset.datasetKind,
										officialRetrieval: evaluation.officialRetrieval,
										questionType: evaluation.questionType,
										abstention: evaluation.abstention,
									}),
								)
								if (pass === 0) {
									materialByCaseId.set(evaluation.caseId, {
										caseId: evaluation.caseId,
										question: evaluation.query,
										goldAnswer: evaluation.answer ?? "",
										abstention: evaluation.abstention === true,
										contextPassages: [],
										passageDates: [],
										passageRoles: [],
										upstreamFailure: message,
										questionType: evaluation.questionType,
										questionDate:
											typeof evaluation.metadata?.questionDate === "string"
												? evaluation.metadata.questionDate
												: undefined,
									})
								}
								expectedSessionMap.set(
									evaluation.caseId,
									evaluation.expectedSessionIds,
								)
								expectedTurnMap.set(
									evaluation.caseId,
									evaluation.expectedTurnIds ?? [],
								)
							}
						}
					}
					if (armRun && armsSetup) {
						const qa = await runArmScenarioQa({
							arm: armRun.arm,
							materials: scenario.evaluations.flatMap((evaluation) => {
								const material = armRun.materialByCaseId.get(evaluation.caseId)
								return material ? [material] : []
							}),
							decoyPool: armsDecoys,
							setup: armsSetup,
							accounting: params.runContext.accounting,
						})
						armRun.qa.push(qa)
						scenarioArmQa.push(qa)
					}
				}
				if (armRuns && params.arms) {
					checkpointArms = scenarioCheckpointArms({
						runs: armRuns,
						offsets: armExecutionOffsets,
						qa: scenarioArmQa,
					})
					armsScenarioComplete = checkpointArmsComplete(
						checkpointArms,
						params.arms,
						judgeableCaseIds(scenario),
						measurementPasses,
					)
				}
				log.info("benchmark scenario complete", {
					scenarioId: scenario.scenarioId,
					agentId: scenarioManager.agentId,
					index,
					totalScenarios: scenarios.length,
					evaluations: scenario.evaluations.length,
					elapsedMs: Date.now() - scenarioStartedAt,
				})
				// Slice B round 2 (corrections 1+3): official per-scenario scoring
				// runs INSIDE the try, after the evaluations and BEFORE the
				// finally block's worker stop / storage measurement / cleanup —
				// answer every declared case with the dated prompt and judge with
				// the separate provider, persisting to the sidecar before the
				// checkpoint write. A scoring failure leaves the scenario
				// un-checkpointed (retry re-pays only this scenario), and the
				// return value's `complete` gates the checkpoint below: an
				// incomplete scenario (unavailable cases) is never recorded as
				// completed, so it re-runs on resume.
				if (officialQaContext) {
					const officialQa = officialQaContext
					const officialOutcome = await scoreOfficialScenario({
						context: officialQa,
						scenarioId: scenario.scenarioId,
						declaredCaseIds: scenario.evaluations.map(
							(evaluation) => evaluation.caseId,
						),
						materialByCaseId: e2eQaMaterialByCaseId,
						onProviderCall: (operation, outcome, usage) => {
							// Per-role attribution matching the custom-v1 harness:
							// answer-generation bills the answer model, judging bills
							// the judge model. Transport usage forwards unchanged; a
							// missing usage stays missing (never zeroed).
							const metadata = {
								provider:
									operation === "answer-generation"
										? officialQa.answerProvider.name
										: officialQa.judgeProvider.name,
								model:
									operation === "answer-generation"
										? officialQa.answerModel
										: officialQa.judgeModel,
								...(usage ?? {}),
								...(outcome === "attempted"
									? {}
									: hiddenOutputTokensMetadata(usage)),
							}
							if (outcome === "attempted") {
								params.runContext.accounting.recordAttempt(operation, metadata)
							} else if (outcome === "succeeded") {
								params.runContext.accounting.recordSuccess(operation, metadata)
							} else {
								params.runContext.accounting.recordFailure(operation, metadata)
							}
						},
					})
					officialScenarioComplete = officialOutcome.complete
				}
			} catch (scenarioErr) {
				// B4 (d): a readiness failure (convergence timeout, permanent
				// probe error, empty required lane) aborts the run instead of
				// continuing: such failures are cluster-correlated, so the
				// remaining scenarios would spend answer/judge tokens against
				// a half-indexed store. The checkpoint keeps every completed
				// scenario, so a --resume re-runs and re-pays only this one.
				log.error(
					"benchmark scenario failed; run aborted (resume re-runs only this scenario)",
					{
						scenarioId: scenario.scenarioId,
						index,
						totalScenarios: scenarios.length,
						checkpointPath: params.checkpointPath,
						error:
							scenarioErr instanceof Error
								? scenarioErr.message
								: String(scenarioErr),
					},
				)
				propagatingError = scenarioErr
				throw scenarioErr
			} finally {
				await finishScenario()
			}

			if (scenarioCleanup) cleanupByIndex.set(index, scenarioCleanup)

			// Slice B round 2: the checkpoint write happens after the finally
			// block's worker stop / storage measurement / cleanup, and only for
			// complete official scenarios (an incomplete one must re-run on
			// resume, so it is never recorded as completed). Non-official runs
			// keep the legacy always-write behavior.
			if (
				params.checkpointPath &&
				(!officialQaContext || officialScenarioComplete) &&
				armsScenarioComplete
			) {
				const datasetSha256 = params.datasetSha256
				if (!datasetSha256) {
					throw new Error(
						"benchmark checkpointing requires the resolved dataset digest",
					)
				}
				const checkpointScenario: BenchmarkCheckpointScenario = {
					index,
					scenarioId: scenario.scenarioId,
					executionsByPass: executionsByPass.map((passExecutions, pass) =>
						passExecutions.slice(passExecutionOffsets[pass]),
					),
					ingest: scenarioIngestTotals,
					expectedSessionEntries: scenario.evaluations.map((evaluation) => [
						evaluation.caseId,
						expectedSessionMap.get(evaluation.caseId) ?? [],
					]),
					expectedTurnEntries: scenario.evaluations.map((evaluation) => [
						evaluation.caseId,
						expectedTurnMap.get(evaluation.caseId) ?? [],
					]),
					storageCollections: scenarioStorageCollections,
					...(scenarioStorageFailure
						? { storageFailure: scenarioStorageFailure }
						: {}),
					...(scenarioCleanup ? { cleanup: scenarioCleanup } : {}),
					...(checkpointArms ? { arms: checkpointArms } : {}),
				}
				completedCheckpointScenarios.push(checkpointScenario)
				completedCheckpointScenarios.sort(
					(left, right) => left.index - right.index,
				)
				await writeBenchmarkCheckpointAtomic(params.checkpointPath, {
					version: 2,
					failedLines: ingest.failedLines,
					rejectedTurns: ingest.rejectedTurns,
					rejectedConversations: ingest.rejectedConversations,
					...(loadedAdapterTotals
						? { adapterDiagnosticsTotals: loadedAdapterTotals }
						: {}),
					runId: params.runContext.runId,
					datasetSha256,
					configurationHash: params.runContext.configurationHash,
					configuration: params.runContext.configuration,
					executableDigest: params.executableDigest ?? "unavailable",
					totalScenarios: scenarios.length,
					scenarioIds: scenarios.map((entry) => entry.scenarioId),
					completedScenarios: completedCheckpointScenarios,
					accounting: params.runContext.accounting.snapshot(),
					updatedAt: new Date().toISOString(),
				})
			}
		}

		// #66: pass 1 is the gate pass — every published metric, release gate, and
		// regression baseline below is computed from it alone, so gate semantics
		// are identical whether one pass ran or ten.
		const summarizeExecutions = (passExecutions: BenchmarkCaseExecution[]) =>
			summarizeBenchmarkExecutions({
				datasetName: params.dataset.name,
				datasetKind: params.dataset.datasetKind,
				retrievalLane: params.retrievalLane,
				scenarios: scenarios.length,
				executions: passExecutions,
				ingest,
				readinessSkips: this.readinessSkips,
			})
		const passSummaries = executionsByPass.map(summarizeExecutions)
		const summary = passSummaries[0]!
		const measurementPassReport = summarizeMeasurementPasses(passSummaries)
		const regressions = await persistBenchmarkRegression({
			db: this.host.db,
			prefix: this.host.prefix,
			agentId: this.host.agentId,
			datasetVersion: params.datasetVersion,
			currentMetrics: {
				hitRate: summary.hitRate,
				emptyRate: summary.emptyRate,
				avgTopScore: summary.avgTopScore,
				p95LatencyMs: summary.p95LatencyMs,
				rAt5: summary.rAt5,
				rAt10: summary.rAt10,
				ndcgAt10: summary.ndcgAt10,
			},
		})
		const storageCollectionRows = Array.from(
			storageCollections,
			([collectionName, values]) => ({ collectionName, ...values }),
		)
		const storage: BenchmarkTenantStorageMeasurement =
			storageFailures.length > 0
				? {
						documents: null,
						logicalBytes: null,
						collections: storageCollectionRows,
						unavailableReason: storageFailures.join("; "),
					}
				: {
						documents: storageCollectionRows.reduce(
							(sum, entry) => sum + entry.documents,
							0,
						),
						logicalBytes: storageCollectionRows.reduce(
							(sum, entry) => sum + entry.logicalBytes,
							0,
						),
						collections: storageCollectionRows,
					}
		// C-039: LLM-judged answer accuracy over the pass-0 (gate) retrieval
		// results. Returns undefined for non-LongMemEval datasets; an
		// all-null envelope with a reason when accuracy cannot be measured.
		// Slice B: official mode summarizes from the sidecar instead — the
		// custom-v1 judged-answers path never runs alongside the official
		// protocol. The merge into officialMetrics happens in
		// attachBenchmarkOperationsReport.
		let e2eQa: BenchmarkE2eQaEnvelope | undefined
		let questionTypeBreakdown = summary.questionTypeBreakdown
		const armResults = armRuns
			? buildArmResults({
					runs: armRuns,
					scenarios,
					ingest,
					summarize: summarizeExecutions,
					expectedSessionMap,
					expectedTurnMap,
				})
			: undefined
		if (armResults) {
			// The baseline arm's answers are the run's own.
			e2eQa = armResults.arms[0]?.e2eQa
			questionTypeBreakdown =
				armResults.arms[0]?.result.questionTypeBreakdown ??
				questionTypeBreakdown
		} else if (officialQaContext) {
			// Covered = every scenario that either completed in this run or was
			// restored from the checkpoint; official preflight guarantees a
			// checkpoint exists, so these two sets are the full run.
			const coveredCaseIds = new Set<string>()
			for (const checkpointScenario of completedCheckpointScenarios) {
				for (const evaluation of scenarios[checkpointScenario.index]
					?.evaluations ?? []) {
					coveredCaseIds.add(evaluation.caseId)
				}
			}
			const officialSummary = await summarizeOfficialBenchmarkQaRun({
				context: officialQaContext,
				scenarios,
				coveredCaseIds,
				datasetSha256: params.datasetSha256 ?? "",
				// Slice B round 2 (correction 6): a resumed official run is
				// honestly incomplete even when coverage ends up full, and
				// startup orphans stay lost no matter what this run covered.
				resumedFromCheckpoint: params.resumeCheckpoint !== undefined,
				startupLostQuestionIds: officialStartupLostQuestionIds,
				// B08:C06: run totals include checkpoint-restored scenarios, so a
				// resumed run keeps the failures it restored.
				ingest,
			})
			e2eQa = officialSummary.envelope
		} else if (
			benchmarkQaProtocol === "custom-v1" ||
			benchmarkQaProtocol === "custom-v2" ||
			benchmarkQaProtocol === "custom-v3"
		) {
			// C-5: reader-cut metrics come from the judged case results only.
			const readerCut = attachReaderCutMetrics({
				e2eQa: await runBenchmarkJudgedAnswers({
					datasetKind: params.dataset.datasetKind,
					materialByCaseId: e2eQaMaterialByCaseId,
					resumedFromCheckpoint: restoredCheckpointScenarioCount > 0,
					protocol: benchmarkQaProtocol,
					ingest,
					accounting: params.runContext?.accounting,
				}),
				breakdown: questionTypeBreakdown,
				questionTypeByCaseId: new Map(
					[...e2eQaMaterialByCaseId].map(([caseId, material]) => [
						caseId,
						material.questionType,
					]),
				),
			})
			e2eQa = readerCut.e2eQa
			questionTypeBreakdown = readerCut.breakdown
		}
		// Explicitly pick only the fields defined in RelevanceBenchmarkResult
		// to prevent any runtime-leaked properties from inflating the response
		// beyond V8's JSON.stringify limit (~512 MB).
		return {
			result: {
				datasetVersion: params.datasetVersion,
				datasetName: summary.datasetName,
				datasetKind: summary.datasetKind,
				scenarios: summary.scenarios,
				cases: summary.cases,
				scoredCases: summary.scoredCases,
				skippedCases: summary.skippedCases,
				execution: summary.execution,
				caseOutcomes: summary.caseOutcomes,
				hitRate: summary.hitRate,
				emptyRate: summary.emptyRate,
				avgTopScore: summary.avgTopScore,
				p95LatencyMs: summary.p95LatencyMs,
				scoredLatency: summary.scoredLatency,
				...(summary.laneLatencyP95
					? { laneLatencyP95: summary.laneLatencyP95 }
					: {}),
				...(measurementPassReport
					? { measurementPasses: measurementPassReport }
					: {}),
				rAt5: summary.rAt5,
				rAt10: summary.rAt10,
				ndcgAt10: summary.ndcgAt10,
				questionTypeBreakdown,
				...(summary.officialMetrics
					? { officialMetrics: summary.officialMetrics }
					: {}),
				...(summary.ingest ? { ingest: summary.ingest } : {}),
				regressions,
				missLedger: buildMissLedger({
					executions,
					expectedSessionMap,
					expectedTurnMap,
				}),
				caseDiagnostics: buildCaseDiagnostics({
					executions,
					expectedSessionMap,
					expectedTurnMap,
				}),
				scenarioCleanup: summarizeScenarioCleanup(
					Array.from(cleanupByIndex)
						.sort(([left], [right]) => left - right)
						.map(([, outcome]) => outcome),
				),
				...(armResults
					? { arms: armResults.arms, pairedArms: armResults.pairedArms }
					: {}),
			},
			latencySamples: executions.map((e) => e.latencyMs),
			...(e2eQa ? { e2eQa } : {}),
			storage,
		}
	}

	async benchmarkIngest(params: {
		datasetPath: string
		scope?: MemoryScope
		limitConversations?: number
		limitTurnsPerConversation?: number
	}): Promise<MemoryBenchmarkIngestResult> {
		const datasetPath = await resolveBenchmarkDatasetPath({
			datasetPath: params.datasetPath,
			baseDir: this.host.workspaceDir,
			allowedRoots: this.getBenchmarkAllowedRoots(),
		})
		return ingestBenchmarkDataset({
			datasetPath,
			baseDir: this.host.workspaceDir,
			allowedRoots: this.getBenchmarkAllowedRoots(),
			scope: params.scope,
			limitConversations: params.limitConversations,
			limitTurnsPerConversation: params.limitTurnsPerConversation,
			// B6: bounded batches through the canonical batch write API (per-item
			// idempotency + receipts) instead of one write per turn.
			writeTurns: async (turns) =>
				this.host.writeConversationEventsBatch(turns),
		})
	}

	async importConversations(params: {
		datasetPath: string
		scope?: MemoryScope
		scopeRef?: string
		limitConversations?: number
		limitTurnsPerConversation?: number
	}): Promise<BenchmarkConversationImportResult> {
		const datasetPath = await resolveBenchmarkDatasetPath({
			datasetPath: params.datasetPath,
			baseDir: this.host.workspaceDir,
			allowedRoots: this.getBenchmarkAllowedRoots(),
		})
		return importConversationDataset({
			datasetPath,
			baseDir: this.host.workspaceDir,
			allowedRoots: this.getBenchmarkAllowedRoots(),
			scope: params.scope,
			limitConversations: params.limitConversations,
			limitTurnsPerConversation: params.limitTurnsPerConversation,
			// B6: bounded batches through the canonical batch write API (per-item
			// idempotency + receipts) instead of one write per turn.
			writeTurns: async (turns) =>
				this.host.writeConversationEventsBatch(
					turns.map((turn) => ({
						...turn,
						// Tenant isolation: force the caller's authorized scope/scopeRef
						// onto every imported turn so a dataset that declares its own
						// conversation.scope cannot land events outside the caller's
						// tenant.
						...(params.scope !== undefined ? { scope: params.scope } : {}),
						...(params.scopeRef !== undefined
							? { scopeRef: params.scopeRef }
							: {}),
					})),
				),
		})
	}

	// ---- Scenario-lifecycle delegations (P4.3 split) ----

	snapshotBenchmarkRunConfiguration(params: {
		executionProfile: "shipped" | "diagnostic"
		retrievalLane: BenchmarkRetrievalLane
		maxResults: number
		minScore: number
		qualityContractId?: string
		qualityContractVersion?: string
	}): BenchmarkRunConfiguration {
		return this.scenario.snapshotBenchmarkRunConfiguration(params)
	}

	async settleBenchmarkScenarioManager(
		manager: MongoDBManagerHost,
	): Promise<void> {
		return this.scenario.settleBenchmarkScenarioManager(manager)
	}

	shouldUseBenchmarkFastIngest(): boolean {
		return this.scenario.shouldUseBenchmarkFastIngest()
	}

	async insertBenchmarkDocumentsInBatches(
		collection: Collection<Document>,
		docs: Document[],
	): Promise<void> {
		return this.scenario.insertBenchmarkDocumentsInBatches(collection, docs)
	}

	async fastIngestBenchmarkConversations(params: {
		datasetPath: string
		datasetName?: string
		datasetKind?: MemoryBenchmarkDatasetKind
		conversations: MemoryBenchmarkConversation[]
		failedLines?: number
		rejections?: MemoryConversationImportRejection[]
		scope?: MemoryScope
		metadata?: Record<string, unknown>
	}): Promise<MemoryBenchmarkIngestResult> {
		return this.scenario.fastIngestBenchmarkConversations(params)
	}

	async waitForBenchmarkSearchConvergence(params: {
		agentId: string
		retrievalLane?: BenchmarkRetrievalLane
		scope?: MemoryScope
		scopeRef?: string
		sessionId?: string
	}): Promise<void> {
		return this.scenario.waitForBenchmarkSearchConvergence(params)
	}

	async waitForBenchmarkSearchReadiness(params?: {
		retrievalLane?: BenchmarkRetrievalLane
		scope?: MemoryScope
		scopeRef?: string
		sessionId?: string
	}): Promise<void> {
		return this.scenario.waitForBenchmarkSearchReadiness(params)
	}

	async waitForBenchmarkVectorSearchCollectionConvergence(params: {
		agentId: string
		scope?: MemoryScope
		scopeRef?: string
		sessionId?: string
		label: string
		collection: Collection<Document>
		collectionName: string
		indexName: string
		textPath: string
		requireSearchableDocuments?: boolean
	}): Promise<void> {
		return this.scenario.waitForBenchmarkVectorSearchCollectionConvergence(
			params,
		)
	}

	async waitForBenchmarkEventSearchConvergence(agentId: string): Promise<void> {
		return this.scenario.waitForBenchmarkEventSearchConvergence(agentId)
	}

	async waitForBenchmarkSearchCollectionConvergence(params: {
		agentId: string
		scope?: MemoryScope
		scopeRef?: string
		sessionId?: string
		label: string
		collection: Collection<Document>
		collectionName: string
		indexName: string
		textPath: string
		requireSearchableDocuments?: boolean
	}): Promise<void> {
		return this.scenario.waitForBenchmarkSearchCollectionConvergence(params)
	}

	/**
	 * B4: readiness waits skipped without evidence (no capability, no vector
	 * stage, legitimately empty lane) in non-strict mode. Surfaced in the run
	 * summary next to the execution failure counts.
	 */
	get readinessSkips(): BenchmarkReadinessSkip[] {
		return this.scenario.readinessSkips
	}

	async cleanupBenchmarkScenarioData(
		agentId: string,
	): Promise<BenchmarkScenarioCleanupAttempt> {
		return this.scenario.cleanupBenchmarkScenarioData(agentId)
	}

	/**
	 * B08:C03: the scenario's cleanup outcome. KEEP_SCENARIO_DATA retains rows.
	 * A cleanup failure is appended (sanitized) to an error that is already
	 * propagating instead of replacing it; with no such error a thrown cleanup
	 * still fails the run, with a sanitized error.
	 */
	async recordBenchmarkScenarioCleanup(params: {
		runId: string
		scenarioId: string
		ownedAgentId: string | undefined
		agentId: string | undefined
		propagatingError: unknown
	}): Promise<BenchmarkScenarioCleanupOutcome> {
		const base = {
			version: 1 as const,
			runId: params.runId,
			scenarioId: params.scenarioId,
			agentId: params.agentId ?? null,
			registry: cleanupRegistry(BENCHMARK_SCENARIO_COLLECTION_SUFFIXES),
			collections: [],
		}
		let outcome: BenchmarkScenarioCleanupOutcome
		if (!params.ownedAgentId || !params.agentId) {
			outcome = { ...base, status: "not-attempted" }
		} else if (process.env.MEMONGO_BENCHMARK_KEEP_SCENARIO_DATA === "1") {
			outcome = { ...base, status: "retained" }
		} else {
			try {
				const attempt = await this.cleanupBenchmarkScenarioData(params.agentId)
				outcome = {
					...base,
					status: attempt.status,
					registry: attempt.registry,
					collections: attempt.collections,
				}
			} catch (cleanupErr) {
				outcome = {
					...base,
					status: "failed",
					errorName: sanitizedCleanupError(cleanupErr).errorName,
				}
				// The raw cleanup error can carry driver text; only the
				// sanitized description leaves this method.
				if (params.propagatingError === undefined)
					throw new Error(describeScenarioCleanupFailure(outcome))
			}
		}
		if (
			outcome.status === "failed" &&
			params.propagatingError instanceof Error
		) {
			params.propagatingError.message += `; ${describeScenarioCleanupFailure(outcome)}`
		}
		return outcome
	}

	async listBenchmarkEventSessions(
		agentId: string,
	): Promise<Map<string, string>> {
		return this.scenario.listBenchmarkEventSessions(agentId)
	}

	async listBenchmarkEventEvidence(
		agentId: string,
	): Promise<BenchmarkEventEvidenceMaps> {
		return this.scenario.listBenchmarkEventEvidence(agentId)
	}

	collectBenchmarkResultSourceEventIds(result: MemorySearchResult): string[] {
		return this.scenario.collectBenchmarkResultSourceEventIds(result)
	}

	resolveBenchmarkResultSessionIds(
		result: MemorySearchResult,
		evidence: BenchmarkEventEvidenceMaps | Map<string, string>,
	): string[] {
		return this.scenario.resolveBenchmarkResultSessionIds(result, evidence)
	}

	resolveBenchmarkResultTurnIds(
		result: MemorySearchResult,
		evidence: BenchmarkEventEvidenceMaps,
	): string[] {
		return this.scenario.resolveBenchmarkResultTurnIds(result, evidence)
	}

	resolveBenchmarkResultDialogIds(
		result: MemorySearchResult,
		evidence: BenchmarkEventEvidenceMaps,
	): string[] {
		return this.scenario.resolveBenchmarkResultDialogIds(result, evidence)
	}

	async buildBenchmarkDatasetVersion(datasetPath: string): Promise<string> {
		return this.scenario.buildBenchmarkDatasetVersion(datasetPath)
	}

	async searchBenchmarkRawSession(
		query: string,
		opts: {
			maxResults: number
			minScore: number
		},
	): Promise<MemorySearchResult[]> {
		return this.scenario.searchBenchmarkRawSession(query, opts)
	}
}
