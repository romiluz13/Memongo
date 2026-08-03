/**
 * Benchmark seam extracted from `mongodb-manager.ts` (P4.3): parity-envelope
 * helpers, convergence probes, and replay metadata used by the benchmark
 * collaborator. Internal only — not re-exported from the barrels.
 */

import { createHash, randomUUID } from "node:crypto"
import path from "node:path"
import {
	createBenchmarkRunContext,
	assertBenchmarkRunConfiguration,
	collectBenchmarkTenantStorage,
	resolveDatasetSha256,
	resolveBenchmarkRetrievalLane,
	resolveBenchmarkExecutionProfile,
} from "./benchmark-parity-envelope.js"
import type {
	BenchmarkExecutionProfile,
	BenchmarkRetrievalLane,
	BenchmarkRunContext,
	BenchmarkRunConfiguration,
} from "./benchmark-parity-envelope.js"
import { resolveRegisteredBenchmarkQualityContract } from "./benchmark-quality-contracts.js"
import {
	ingestBenchmarkDataset,
	ingestBenchmarkConversations,
	importConversationDataset,
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
	resolveEnrichmentMode,
	resolveEnrichmentStrictMode,
	resolveEnrichmentProvider,
	enrichSessionsWithLLM,
} from "./mongodb-llm-enrichment.js"
import { MongoDBManagerBenchmarkScenarioOps } from "./mongodb-manager-benchmark-scenario.js"
import type { MongoDBManagerHost } from "./mongodb-manager-host.js"
import type { MongoDBMemoryManager } from "./mongodb-manager.js"
import {
	resolveDecompositionMode,
	decomposeQuery,
	mergeMultiQueryResults,
} from "./mongodb-query-decomposition.js"
import { MongoDBRelevanceRuntime } from "./mongodb-relevance.js"
import type {
	RelevanceBenchmarkResult,
	RelevanceReport,
	RelevanceSampleState,
} from "./mongodb-relevance.js"
import { chunksCollection, sessionChunksCollection } from "./mongodb-schema.js"
import { resolveScopeRef } from "./mongodb-scope.js"
import { isBenchmarkStrictMode } from "./mongodb-search-ranking.js"
import {
	resolveSessionEvidenceMode,
	writeSessionEvidenceOptionA,
	writeSessionEvidenceOptionB,
} from "./mongodb-session-evidence.js"
import {
	resolveUserfactEvidenceMode,
	writeUserfactEvidence,
} from "./mongodb-userfact-evidence.js"
import type {
	BenchmarkE2eQaEnvelope,
	BenchmarkQualityThresholds,
	BenchmarkTenantStorageMeasurement,
	MemoryBenchmarkDataset,
	MemoryBenchmarkDatasetKind,
	MemoryBenchmarkConversation,
	MemoryBenchmarkIngestResult,
	MemoryConversationImportResult,
	MemorySearchResult,
	BenchmarkRerankerConfig,
	BenchmarkLatencyDistribution,
	BenchmarkStorageFootprint,
	BenchmarkEmbeddingConfig,
	BenchmarkRunIdentity,
	BenchmarkCostAccounting,
} from "./types.js"
import { createSubsystemLogger, resolveUserPath } from "@memongo/lib"
import type { MemoryScope } from "@memongo/lib"
import type { Collection, Document } from "mongodb"

const log = createSubsystemLogger("memory:mongodb")

export const BENCHMARK_SCENARIO_COLLECTION_SUFFIXES = [
	"events",
	"chunks",
	"session_chunks",
	"memory_evidence",
	"structured_mem",
	"structured_mem_revisions",
	"procedures",
	"procedure_revisions",
	"entities",
	"relations",
	"entity_links",
	"episodes",
	"ingest_runs",
	"projection_runs",
	"lane_coverage",
	"relevance_runs",
	"relevance_regressions",
	"relevance_artifacts",
	"recall_traces",
	"memory_jobs",
	"consolidation_runs",
	"memory_mutations",
] as const

export function isLegacyBenchmarkFallbackCandidate(err: unknown): boolean {
	return (
		err instanceof Error &&
		(err.message === "benchmark dataset contains no valid conversations" ||
			err.message === "benchmark dataset contains no evaluation cases")
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

export function parseBenchmarkTurnTimestamp(value?: string): Date | undefined {
	if (!value) return undefined
	const parsed = new Date(value)
	return Number.isNaN(parsed.getTime()) ? undefined : parsed
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
		runIdentity: import("./types.js").BenchmarkRunIdentity
		embedding: import("./types.js").BenchmarkEmbeddingConfig
		reranker: import("./types.js").BenchmarkRerankerConfig
		storage: import("./types.js").BenchmarkStorageFootprint
		latency: import("./types.js").BenchmarkLatencyDistribution
		cost: import("./types.js").BenchmarkCostAccounting
	},
	qualityThresholds?: BenchmarkQualityThresholds,
	e2eQa?: BenchmarkE2eQaEnvelope,
	conversationRecallRegression?: {
		status: "passed" | "failed"
		evidence: string
	},
): RelevanceBenchmarkResult {
	const queryGovernance = buildQueryGovernanceReport(result)
	return {
		...result,
		queryGovernance,
		benchmarkReport: buildBenchmarkRunReport({
			...result,
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
						cost: parity.cost,
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
		const minScore = params?.minScore ?? mongoCfg.reranking?.minScore ?? 0.01
		const resolvedDatasetPath = await resolveBenchmarkDatasetPath({
			datasetPath,
			baseDir: this.host.workspaceDir,
			allowedRoots: this.host.getBenchmarkAllowedRoots(),
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

		const executionProfile = resolveBenchmarkExecutionProfile({
			requested: params?.executionProfile,
			retrievalLane,
			hasQualityContract: Boolean(qualityThresholds),
		})
		const runContext = createBenchmarkRunContext({
			runId: randomUUID(),
			configuration: this.host.snapshotBenchmarkRunConfiguration({
				executionProfile,
				retrievalLane,
				maxResults,
				minScore,
				qualityContractId: qualityThresholds?.contractId,
				qualityContractVersion: qualityThresholds?.version,
			}),
		})
		let dataset: MemoryBenchmarkDataset
		try {
			dataset = await loadBenchmarkDataset(resolvedDatasetPath, {
				baseDir: this.host.workspaceDir,
				allowedRoots: this.host.getBenchmarkAllowedRoots(),
			})
		} catch (datasetErr) {
			if (!isLegacyBenchmarkFallbackCandidate(datasetErr)) {
				throw datasetErr
			}
			if (qualityThresholds) {
				throw new Error(
					"a publication quality contract cannot run against a legacy-query dataset",
				)
			}
			const cases =
				await this.host.relevance.loadBenchmarkDataset(resolvedDatasetPath)
			if (cases.length === 0) {
				throw datasetErr
			}
			const legacy = await this.host.runLegacyRelevanceBenchmark({
				datasetPath: resolvedDatasetPath,
				maxResults,
				minScore,
			})
			const parity = await this.host.buildBenchmarkParityBundle({
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
			if (qualityThresholds) {
				throw noEvaluationError
			}
			const cases =
				await this.host.relevance.loadBenchmarkDataset(resolvedDatasetPath)
			if (cases.length === 0) {
				throw noEvaluationError
			}
			const legacy = await this.host.runLegacyRelevanceBenchmark({
				datasetPath: resolvedDatasetPath,
				maxResults,
				minScore,
			})
			const parity = await this.host.buildBenchmarkParityBundle({
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
			)
		}
		const datasetVersion = datasetSha256
		const scenario = await this.host.runScenarioBenchmarkDataset({
			datasetPath: resolvedDatasetPath,
			dataset,
			datasetVersion,
			maxResults,
			minScore,
			retrievalLane,
			executionProfile,
			runContext,
		})
		const parity = await this.host.buildBenchmarkParityBundle({
			datasetPath: resolvedDatasetPath,
			datasetKind: scenario.result.datasetKind,
			retrievalLane,
			datasetSha256Override: params?.datasetSha256,
			latencySamples: scenario.latencySamples,
			runContext,
			tenantStorage: scenario.storage,
		})
		return attachBenchmarkOperationsReport(
			scenario.result,
			parity,
			qualityThresholds,
			scenario.e2eQa,
			params?.conversationRecallRegression,
		)
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
		runIdentity: import("./types.js").BenchmarkRunIdentity
		embedding: import("./types.js").BenchmarkEmbeddingConfig
		reranker: import("./types.js").BenchmarkRerankerConfig
		storage: import("./types.js").BenchmarkStorageFootprint
		latency: import("./types.js").BenchmarkLatencyDistribution
		cost: import("./types.js").BenchmarkCostAccounting
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
			this.host.snapshotBenchmarkRunConfiguration({
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
			mongoRerankerConfig: {
				enabled:
					retrievalLane === "raw-session"
						? false
						: (mongoCfg.reranking?.enabled ?? false),
				model:
					retrievalLane === "raw-session"
						? "none"
						: (mongoCfg.reranking?.model ?? "rerank-2.5"),
				topN:
					retrievalLane === "raw-session"
						? 0
						: (mongoCfg.reranking?.topN ?? 20),
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
		const cases = await this.host.relevance!.loadBenchmarkDataset(
			params.datasetPath,
		)
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
			const summary = MongoDBRelevanceRuntime.buildCaseSummary(
				run.results,
				run.latencyMs,
			)
			const expectedSources = entry.expectedSources ?? []
			const sourcePass = expectedSources.every((source) =>
				summary.hitSources.includes(source),
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

		const metrics = MongoDBRelevanceRuntime.summarizeBenchmarkCases(evaluations)
		const datasetVersion = createHash("sha256")
			.update(JSON.stringify(cases.map((entry) => entry.query)))
			.digest("hex")
			.slice(0, 16)
		const regressions = await this.host.relevance!.persistRegression(
			datasetVersion,
			{
				...metrics,
				rAt5: 0,
				rAt10: 0,
				ndcgAt10: 0,
			},
		)
		return {
			result: {
				datasetVersion,
				datasetName: path.basename(params.datasetPath),
				datasetKind: "legacy-query",
				cases: cases.length,
				scoredCases: cases.length,
				skippedCases: 0,
				...metrics,
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
		dataset: MemoryBenchmarkDataset
		datasetVersion: string
		maxResults: number
		minScore: number
		retrievalLane?: BenchmarkRetrievalLane
		executionProfile?: "shipped" | "diagnostic"
		runContext: BenchmarkRunContext
	}): Promise<{
		result: RelevanceBenchmarkResult
		latencySamples: number[]
		e2eQa?: BenchmarkE2eQaEnvelope
		storage: BenchmarkTenantStorageMeasurement
	}> {
		const scenarios = params.dataset.scenarios ?? []
		const measurementPasses = resolveBenchmarkMeasurementPasses()
		// #66: index 0 is the gate pass — the one the published result, the
		// release gates, and the regression baseline are computed from.
		const executionsByPass: BenchmarkCaseExecution[][] = Array.from(
			{ length: measurementPasses },
			() => [],
		)
		const executions = executionsByPass[0]!
		const expectedSessionMap = new Map<string, string[]>()
		const expectedTurnMap = new Map<string, string[]>()
		const storageCollections = new Map<
			string,
			{ documents: number; logicalBytes: number }
		>()
		const storageFailures: string[] = []
		const runToken = randomUUID().slice(0, 8)
		const rawSessionLane = params.retrievalLane === "raw-session"
		const ingest = {
			conversationsIngested: 0,
			turnsIngested: 0,
			skippedConversations: 0,
			failedLines: params.dataset.failedLines ?? 0,
			failedTurns: 0,
		}

		for (const [index, scenario] of scenarios.entries()) {
			const scenarioStartedAt = Date.now()
			let scenarioManager: MongoDBManagerHost = this.host
			let eventEvidence: BenchmarkEventEvidenceMaps = {
				sessionIds: new Map<string, string>(),
				turnIds: new Map<string, string>(),
				dialogIds: new Map<string, string>(),
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
					scenarioManager = this.host.createBenchmarkScenarioManager(
						scenarioAgentId,
						params.executionProfile === "shipped",
					)
					const scenarioIngest =
						params.executionProfile !== "shipped" &&
						scenarioManager.shouldUseBenchmarkFastIngest()
							? await scenarioManager.fastIngestBenchmarkConversations({
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
									conversations: scenario.conversations,
									scope: "agent",
									metadata: {
										benchmarkDatasetKind:
											params.dataset.datasetKind ?? "generic",
										benchmarkScenarioId: scenario.scenarioId,
									},
									writeTurn: async (turn) => {
										await scenarioManager.writeConversationEvent(
											turn,
											params.runContext,
										)
									},
								})
					ingest.conversationsIngested += scenarioIngest.conversationsIngested
					ingest.turnsIngested += scenarioIngest.turnsIngested
					ingest.skippedConversations += scenarioIngest.skippedConversations
					ingest.failedTurns += scenarioIngest.failedTurns
					log.info("benchmark scenario ingested", {
						scenarioId: scenario.scenarioId,
						agentId: scenarioManager.agentId,
						conversationsIngested: scenarioIngest.conversationsIngested,
						turnsIngested: scenarioIngest.turnsIngested,
						failedTurns: scenarioIngest.failedTurns,
					})
					await this.host.settleBenchmarkScenarioManager(scenarioManager)
					eventEvidence = await this.host.listBenchmarkEventEvidence(
						scenarioManager.agentId,
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

							if (effectiveSessionEvidenceMode === "A") {
								await writeSessionEvidenceOptionA({
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
							} else if (effectiveSessionEvidenceMode === "B") {
								sessionEvidenceDocsWritten = await writeSessionEvidenceOptionB({
									sessionChunksCollection: sessionChunksCollection(
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

							// LLM enrichment: replaces regex userfact when available
							const enrichmentProvider =
								!rawSessionLane && enrichmentMode !== "none"
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
										strict: enrichmentStrict,
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
									conversations: scenario.conversations,
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
						await this.host.settleBenchmarkScenarioManager(scenarioManager)
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
					await this.host.waitForBenchmarkSearchConvergence({
						agentId: scenarioManager.agentId,
						retrievalLane: params.retrievalLane,
					})
				} else {
					eventEvidence = await this.host.listBenchmarkEventEvidence(
						this.host.agentId,
					)
				}

				// #66: repeat ONLY the measurement loop. Ingest, evidence, settle,
				// convergence, and cleanup each stay at exactly one per scenario, so
				// n samples of a condition cost n eval loops instead of n full runs.
				for (let pass = 0; pass < measurementPasses; pass++) {
					const passExecutions = executionsByPass[pass]!
					if (pass > 0) {
						await this.host.flushBenchmarkQueryCache(scenarioManager.agentId)
					}
					for (const evaluation of scenario.evaluations) {
						const startedAt = Date.now()
						// Parse questionDate from evaluation metadata for temporal scoring
						const evalQuestionDate =
							typeof evaluation.metadata?.questionDate === "string"
								? new Date(evaluation.metadata.questionDate)
								: undefined
						const validQuestionDate =
							evalQuestionDate && !Number.isNaN(evalQuestionDate.getTime())
								? evalQuestionDate
								: undefined
						try {
							// Query decomposition: break preference-style queries into sub-queries
							const decompositionMode = resolveDecompositionMode(
								process.env.MEMONGO_QUERY_DECOMPOSITION_MODE,
							)
							const decompositionProvider =
								decompositionMode === "enabled"
									? resolveEnrichmentProvider(process.env)
									: null

							let results: MemorySearchResult[]
							// #66: per-lane latency of the search that produced `results`.
							// Only the plain search() path carries a lane breakdown.
							let latencyByLane: Record<string, number> | undefined

							if (rawSessionLane) {
								results = await scenarioManager.searchBenchmarkRawSession(
									evaluation.query,
									{
										maxResults: params.maxResults,
										minScore: params.minScore,
									},
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
									model: process.env.MEMONGO_ENRICHMENT_MODEL?.trim() ?? "",
									query: evaluation.query,
									questionType: evaluation.questionType,
									onProviderCall: (outcome) => {
										const accounting = params.runContext.accounting
										const metadata = {
											provider: decompositionProvider.name,
											model: process.env.MEMONGO_ENRICHMENT_MODEL?.trim() ?? "",
										}
										if (outcome === "attempted") {
											accounting.recordAttempt("query-decomposition", metadata)
										} else if (outcome === "succeeded") {
											accounting.recordSuccess("query-decomposition", metadata)
										} else {
											accounting.recordFailure("query-decomposition", metadata)
										}
									},
								})
								const decomposeMs = Date.now() - decomposeStartedAt
								// Run each sub-query through the search pipeline
								const subSearchStartedAt = Date.now()
								const resultSets: MemorySearchResult[][] = []
								for (const subQuery of decomposed.subQueries) {
									const subResults = await scenarioManager.search(
										subQuery,
										{
											maxResults: params.maxResults,
											minScore: params.minScore,
											questionDate: validQuestionDate,
										},
										params.runContext,
									)
									resultSets.push(subResults)
								}
								// Also run the original query to avoid losing good direct matches
								const originalResults = await scenarioManager.search(
									evaluation.query,
									{
										maxResults: params.maxResults,
										minScore: params.minScore,
										questionDate: validQuestionDate,
									},
									params.runContext,
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
								results = relevanceScope
									? (
											await scenarioManager.relevanceExplain({
												query: evaluation.query,
												sourceScope: relevanceScope,
												maxResults: params.maxResults,
												minScore: params.minScore,
												deep: false,
												questionDate: validQuestionDate,
											})
										).results
									: await scenarioManager.search(
											evaluation.query,
											{
												maxResults: params.maxResults,
												minScore: params.minScore,
												questionDate: validQuestionDate,
												onLaneLatency: (lanes) => {
													latencyByLane = lanes
												},
											},
											params.runContext,
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
										this.host.resolveBenchmarkResultSessionIds(
											result,
											eventEvidence,
										),
									resolveTurnIds: (result) =>
										this.host.resolveBenchmarkResultTurnIds(
											result,
											eventEvidence,
										),
									resolveDialogIds: (result) =>
										this.host.resolveBenchmarkResultDialogIds(
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
							passExecutions.push(
								evaluateRankingCase({
									caseId: evaluation.caseId,
									results: [],
									latencyMs: Date.now() - startedAt,
									relevantSessionIds: evaluation.expectedSessionIds,
									relevantTurnIds: evaluation.expectedTurnIds,
									relevantDialogIds: evaluation.expectedDialogIds,
									resolveSessionIds: (result) =>
										this.host.resolveBenchmarkResultSessionIds(
											result,
											eventEvidence,
										),
									resolveTurnIds: (result) =>
										this.host.resolveBenchmarkResultTurnIds(
											result,
											eventEvidence,
										),
									resolveDialogIds: (result) =>
										this.host.resolveBenchmarkResultDialogIds(
											result,
											eventEvidence,
										),
									datasetKind: params.dataset.datasetKind,
									officialRetrieval: evaluation.officialRetrieval,
									questionType: evaluation.questionType,
									abstention: evaluation.abstention,
									executionError: message,
								}),
							)
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
				log.info("benchmark scenario complete", {
					scenarioId: scenario.scenarioId,
					agentId: scenarioManager.agentId,
					index,
					totalScenarios: scenarios.length,
					evaluations: scenario.evaluations.length,
					elapsedMs: Date.now() - scenarioStartedAt,
				})
			} finally {
				if (scenarioManager !== this.host) {
					await scenarioManager.stopMemoryJobWorker()
					const measurement = await collectBenchmarkTenantStorage({
						db: this.host.db,
						agentId: scenarioManager.agentId,
						collectionNames: BENCHMARK_SCENARIO_COLLECTION_SUFFIXES.map(
							(suffix) => `${this.host.prefix}${suffix}`,
						),
					})
					if (measurement.unavailableReason) {
						storageFailures.push(
							`${scenario.scenarioId}: ${measurement.unavailableReason}`,
						)
					}
					for (const entry of measurement.collections) {
						const current = storageCollections.get(entry.collectionName) ?? {
							documents: 0,
							logicalBytes: 0,
						}
						current.documents += entry.documents
						current.logicalBytes += entry.logicalBytes
						storageCollections.set(entry.collectionName, current)
					}
				} else {
					storageFailures.push(
						`${scenario.scenarioId}: scenario did not use an isolated benchmark agent`,
					)
				}
				if (
					scenarioManager !== this.host &&
					process.env.MEMONGO_BENCHMARK_KEEP_SCENARIO_DATA !== "1"
				) {
					await this.host.cleanupBenchmarkScenarioData(scenarioManager.agentId)
				}
			}
		}

		// #66: pass 1 is the gate pass — every published metric, release gate, and
		// regression baseline below is computed from it alone, so gate semantics
		// are identical whether one pass ran or ten.
		const passSummaries = executionsByPass.map((passExecutions) =>
			summarizeBenchmarkExecutions({
				datasetName: params.dataset.name,
				datasetKind: params.dataset.datasetKind,
				retrievalLane: params.retrievalLane,
				scenarios: scenarios.length,
				executions: passExecutions,
				ingest,
			}),
		)
		const summary = passSummaries[0]!
		const measurementPassReport = summarizeMeasurementPasses(passSummaries)
		const regressions = await this.host.relevance!.persistRegression(
			params.datasetVersion,
			{
				hitRate: summary.hitRate,
				emptyRate: summary.emptyRate,
				avgTopScore: summary.avgTopScore,
				p95LatencyMs: summary.p95LatencyMs,
				rAt5: summary.rAt5,
				rAt10: summary.rAt10,
				ndcgAt10: summary.ndcgAt10,
			},
		)
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
				...(summary.laneLatencyP95
					? { laneLatencyP95: summary.laneLatencyP95 }
					: {}),
				...(measurementPassReport
					? { measurementPasses: measurementPassReport }
					: {}),
				rAt5: summary.rAt5,
				rAt10: summary.rAt10,
				ndcgAt10: summary.ndcgAt10,
				questionTypeBreakdown: summary.questionTypeBreakdown,
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
			},
			latencySamples: executions.map((e) => e.latencyMs),
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
			allowedRoots: this.host.getBenchmarkAllowedRoots(),
		})
		return ingestBenchmarkDataset({
			datasetPath,
			baseDir: this.host.workspaceDir,
			allowedRoots: this.host.getBenchmarkAllowedRoots(),
			scope: params.scope,
			limitConversations: params.limitConversations,
			limitTurnsPerConversation: params.limitTurnsPerConversation,
			writeTurn: async (turn) => {
				await this.host.writeConversationEvent(turn)
			},
		})
	}

	async importConversations(params: {
		datasetPath: string
		scope?: MemoryScope
		scopeRef?: string
		limitConversations?: number
		limitTurnsPerConversation?: number
	}): Promise<MemoryConversationImportResult> {
		const datasetPath = await resolveBenchmarkDatasetPath({
			datasetPath: params.datasetPath,
			baseDir: this.host.workspaceDir,
			allowedRoots: this.host.getBenchmarkAllowedRoots(),
		})
		return importConversationDataset({
			datasetPath,
			baseDir: this.host.workspaceDir,
			allowedRoots: this.host.getBenchmarkAllowedRoots(),
			scope: params.scope,
			limitConversations: params.limitConversations,
			limitTurnsPerConversation: params.limitTurnsPerConversation,
			writeTurn: async (turn) => {
				// Tenant isolation: force the caller's authorized scope/scopeRef onto
				// every imported turn so a dataset that declares its own
				// conversation.scope cannot land events outside the caller's tenant.
				await this.host.writeConversationEvent({
					...turn,
					...(params.scope !== undefined ? { scope: params.scope } : {}),
					...(params.scopeRef !== undefined
						? { scopeRef: params.scopeRef }
						: {}),
				})
			},
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
	}): Promise<void> {
		return this.scenario.waitForBenchmarkSearchCollectionConvergence(params)
	}

	async cleanupBenchmarkScenarioData(agentId: string): Promise<void> {
		return this.scenario.cleanupBenchmarkScenarioData(agentId)
	}

	async flushBenchmarkQueryCache(agentId: string): Promise<void> {
		return this.scenario.flushBenchmarkQueryCache(agentId)
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
