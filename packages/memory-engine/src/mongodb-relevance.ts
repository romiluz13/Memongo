import { createHash, randomUUID } from "node:crypto"
import { readFile } from "node:fs/promises"
import type { Db } from "mongodb"
import { createSubsystemLogger } from "@memongo/lib"
import type { ResolvedMongoDBConfig } from "./backend-config.js"
import type { DetectedCapabilities } from "./mongodb-schema.js"
import {
	relevanceArtifactsCollection,
	relevanceRegressionsCollection,
	relevanceRunsCollection,
} from "./mongodb-schema.js"
import type {
	MemoryBenchmarkDatasetKind,
	MemoryBenchmarkOfficialMetrics,
	MemoryBenchmarkQuestionTypeMetrics,
	MemoryBenchmarkRunReport,
	MemorySearchResult,
	QueryGovernanceReport,
} from "./types.js"

const log = createSubsystemLogger("memory:mongodb:relevance")

export type RelevanceSourceScope = "all" | "memory" | "kb" | "structured"
export type RelevanceHealth = "ok" | "degraded" | "insufficient-data"

export type ExplainArtifactType =
	| "searchExplain"
	| "vectorExplain"
	| "fusionExplain"
	| "scoreDetails"
	| "trace"

export type RelevanceArtifact = {
	artifactType: ExplainArtifactType
	summary: Record<string, unknown>
	rawExplain?: unknown
	compression?: "none"
}

export type RelevanceRunPersistInput = {
	query: string
	sourceScope: RelevanceSourceScope
	latencyMs: number
	topK: number
	hitSources: string[]
	fallbackPath?: string
	status: RelevanceHealth
	sampled: boolean
	sampleRate: number
	artifacts: RelevanceArtifact[]
	diagnosticMode?: boolean
}

export type RelevanceSampleState = {
	enabled: boolean
	current: number
	base: number
	max: number
	windowSize: number
	degradedSignals: number
}

export type RelevanceReport = {
	health: RelevanceHealth
	runs: number
	sampledRuns: number
	emptyRate: number
	avgTopScore: number
	fallbackRate: number
	lastRegressionAt?: string
	profileCapabilities: {
		textExplain: boolean
		vectorExplain: boolean
		fusionExplain: boolean
	}
}

export type RelevanceBenchmarkCase = {
	query: string
	sourceScope?: RelevanceSourceScope
	minTopScore?: number
	expectedSources?: string[]
}

export type RelevanceBenchmarkResult = {
	datasetVersion: string
	datasetName?: string
	datasetKind?: MemoryBenchmarkDatasetKind | "legacy-query"
	scenarios?: number
	cases: number
	scoredCases?: number
	skippedCases?: number
	hitRate: number
	emptyRate: number
	avgTopScore: number
	p95LatencyMs: number
	rAt5?: number
	rAt10?: number
	ndcgAt10?: number
	questionTypeBreakdown?: MemoryBenchmarkQuestionTypeMetrics[]
	officialMetrics?: MemoryBenchmarkOfficialMetrics
	ingest?: {
		conversationsIngested: number
		turnsIngested: number
		skippedConversations: number
		failedLines: number
		failedTurns: number
	}
	regressions: Array<{
		metricName: string
		baseline: number
		current: number
		delta: number
		severity: "low" | "medium" | "high"
	}>
	queryGovernance?: QueryGovernanceReport
	benchmarkReport?: MemoryBenchmarkRunReport
	missLedger?: import("./mongodb-benchmark-runner.js").BenchmarkMissLedgerEntry[]
	caseDiagnostics?: import("./mongodb-benchmark-runner.js").BenchmarkCaseDiagnosticEntry[]
}

type RecentSignal = {
	empty: boolean
	lowScore: boolean
	fallback: boolean
	degraded: boolean
}

function normalizeQuery(query: string): string {
	return query.trim().replace(/\s+/g, " ").toLowerCase()
}

function hashQuery(query: string): string {
	return createHash("sha256").update(normalizeQuery(query)).digest("hex")
}

function redactQuery(query: string): string {
	// Keep shape and spacing while redacting letters/digits.
	return query.replace(/[A-Za-z0-9]/g, "x")
}

function percentile(values: number[], p: number): number {
	if (values.length === 0) {
		return 0
	}
	const sorted = [...values].toSorted((a, b) => a - b)
	const rank = Math.min(
		sorted.length - 1,
		Math.max(0, Math.ceil((p / 100) * sorted.length) - 1),
	)
	return sorted[rank] ?? 0
}

function detectSeverity(deltaAbs: number): "low" | "medium" | "high" {
	if (deltaAbs >= 0.25) {
		return "high"
	}
	if (deltaAbs >= 0.1) {
		return "medium"
	}
	return "low"
}

function extractNumberByKeys(
	value: unknown,
	keys: string[],
	depth = 0,
): number | undefined {
	if (depth > 8 || value === null || value === undefined) {
		return undefined
	}
	if (typeof value === "number" && Number.isFinite(value)) {
		return value
	}
	if (Array.isArray(value)) {
		for (const item of value) {
			const found = extractNumberByKeys(item, keys, depth + 1)
			if (found !== undefined) {
				return found
			}
		}
		return undefined
	}
	if (typeof value === "object") {
		const record = value as Record<string, unknown>
		for (const key of keys) {
			const direct = record[key]
			if (typeof direct === "number" && Number.isFinite(direct)) {
				return direct
			}
		}
		for (const nested of Object.values(record)) {
			const found = extractNumberByKeys(nested, keys, depth + 1)
			if (found !== undefined) {
				return found
			}
		}
	}
	return undefined
}

export function summarizeExplain(raw: unknown): Record<string, unknown> {
	const executionTimeMs =
		extractNumberByKeys(raw, ["executionTimeMillisEstimate"]) ??
		extractNumberByKeys(raw, ["executionTimeMillis"])
	const nReturned = extractNumberByKeys(raw, ["nReturned"])
	const numCandidates = extractNumberByKeys(raw, [
		"numCandidates",
		"candidatesExamined",
	])
	return {
		executionTimeMs: executionTimeMs ?? null,
		nReturned: nReturned ?? null,
		numCandidates: numCandidates ?? null,
	}
}

export class MongoDBRelevanceRuntime {
	private readonly runs
	private readonly artifacts
	private readonly regressions
	private readonly profileCapabilities
	private readonly recentSignals: RecentSignal[] = []
	private currentSampleRate: number

	constructor(
		private readonly db: Db,
		private readonly prefix: string,
		private readonly agentId: string,
		private readonly cfg: ResolvedMongoDBConfig,
		capabilities: DetectedCapabilities,
	) {
		this.runs = relevanceRunsCollection(db, prefix)
		this.artifacts = relevanceArtifactsCollection(db, prefix)
		this.regressions = relevanceRegressionsCollection(db, prefix)
		this.currentSampleRate = cfg.relevance.telemetry.baseSampleRate
		this.profileCapabilities = {
			textExplain: capabilities.textSearch,
			vectorExplain: capabilities.vectorSearch,
			fusionExplain: capabilities.rankFusion || capabilities.scoreFusion,
		}
	}

	shouldSample(): boolean {
		if (!this.cfg.relevance.enabled || !this.cfg.relevance.telemetry.enabled) {
			return false
		}
		return Math.random() < this.currentSampleRate
	}

	getSampleState(): RelevanceSampleState {
		const degradedSignals = this.recentSignals.filter(
			(signal) => signal.degraded,
		).length
		return {
			enabled:
				this.cfg.relevance.enabled && this.cfg.relevance.telemetry.enabled,
			current: this.currentSampleRate,
			base: this.cfg.relevance.telemetry.baseSampleRate,
			max: this.cfg.relevance.telemetry.adaptive.maxSampleRate,
			windowSize: this.recentSignals.length,
			degradedSignals,
		}
	}

	getCurrentHealth(): RelevanceHealth {
		const minWindow = this.cfg.relevance.telemetry.adaptive.minWindowSize
		if (this.recentSignals.length < minWindow) {
			return "insufficient-data"
		}
		const degradedSignals = this.recentSignals.filter(
			(signal) => signal.degraded,
		).length
		return degradedSignals / this.recentSignals.length >= 0.2
			? "degraded"
			: "ok"
	}

	getProfileCapabilities(): RelevanceReport["profileCapabilities"] {
		return this.profileCapabilities
	}

	evaluateHealth(
		results: MemorySearchResult[],
		fallbackPath?: string,
	): RelevanceHealth {
		if (results.length === 0) {
			return "degraded"
		}
		const topScore = results[0]?.score ?? 0
		if (topScore < 0.2 || Boolean(fallbackPath)) {
			return "degraded"
		}
		return "ok"
	}

	recordSignal(results: MemorySearchResult[], fallbackPath?: string): void {
		const topScore = results[0]?.score ?? 0
		const signal: RecentSignal = {
			empty: results.length === 0,
			lowScore: topScore < 0.2,
			fallback: Boolean(fallbackPath),
			degraded: results.length === 0 || topScore < 0.2 || Boolean(fallbackPath),
		}
		this.recentSignals.push(signal)
		const maxWindow = Math.max(
			this.cfg.relevance.telemetry.adaptive.minWindowSize,
			20,
		)
		while (this.recentSignals.length > maxWindow) {
			this.recentSignals.shift()
		}
		this.recomputeSampleRate()
	}

	private recomputeSampleRate(): void {
		const base = this.cfg.relevance.telemetry.baseSampleRate
		const adaptiveCfg = this.cfg.relevance.telemetry.adaptive
		if (!adaptiveCfg.enabled) {
			this.currentSampleRate = base
			return
		}
		if (this.recentSignals.length < adaptiveCfg.minWindowSize) {
			this.currentSampleRate = base
			return
		}
		const degradedCount = this.recentSignals.filter(
			(signal) => signal.degraded,
		).length
		const degradedRate = degradedCount / this.recentSignals.length
		this.currentSampleRate =
			degradedRate >= 0.2 ? adaptiveCfg.maxSampleRate : base
	}

	async persistRun(input: RelevanceRunPersistInput): Promise<string> {
		const runId = randomUUID()
		const privacyMode = this.cfg.relevance.telemetry.queryPrivacyMode
		const queryHash =
			privacyMode === "none" ? undefined : hashQuery(input.query)
		const queryRedacted =
			privacyMode === "raw"
				? input.query
				: privacyMode === "redacted-hash"
					? redactQuery(input.query)
					: undefined
		const now = new Date()
		const topScores = input.artifacts
			.map((artifact) => artifact.summary?.topScore)
			.filter(
				(value): value is number =>
					typeof value === "number" && Number.isFinite(value),
			)
		const topScore = topScores.length > 0 ? topScores[0] : undefined

		const runDoc = {
			runId,
			agentId: this.agentId,
			ts: now,
			sourceScope: input.sourceScope,
			profile: this.cfg.deploymentProfile,
			capabilities: this.profileCapabilities,
			latencyMs: input.latencyMs,
			topK: input.topK,
			hitSources: input.hitSources,
			status: input.status,
			sampleRate: input.sampleRate,
			sampled: input.sampled,
			diagnosticMode: Boolean(input.diagnosticMode),
			...(queryHash ? { queryHash } : {}),
			...(queryRedacted ? { queryRedacted } : {}),
			...(input.fallbackPath ? { fallbackPath: input.fallbackPath } : {}),
			...(typeof topScore === "number" ? { topScore } : {}),
		}

		await this.runs.insertOne(runDoc)

		const persistRaw =
			this.cfg.relevance.telemetry.persistRawExplain &&
			(input.status === "degraded" || Boolean(input.diagnosticMode))
		if (input.artifacts.length > 0) {
			await this.artifacts.insertMany(
				input.artifacts.map((artifact) => {
					const rawExplain = persistRaw ? artifact.rawExplain : undefined
					return {
						runId,
						artifactType: artifact.artifactType,
						summary: artifact.summary,
						rawExplain,
						rawSizeBytes: rawExplain ? JSON.stringify(rawExplain).length : 0,
						compression: "none",
						ts: now,
					}
				}),
			)
		}

		return runId
	}

	async buildReport(windowMs: number): Promise<RelevanceReport> {
		const since = new Date(Date.now() - windowMs)
		const runs = await this.runs
			.find({ agentId: this.agentId, ts: { $gte: since } })
			.project({
				_id: 0,
				status: 1,
				sampled: 1,
				fallbackPath: 1,
				topScore: 1,
			})
			.toArray()

		const total = runs.length
		if (total === 0) {
			return {
				health: "insufficient-data",
				runs: 0,
				sampledRuns: 0,
				emptyRate: 0,
				avgTopScore: 0,
				fallbackRate: 0,
				profileCapabilities: this.profileCapabilities,
			}
		}

		const degradedCount = runs.filter((run) => run.status === "degraded").length
		const emptyCount = runs.filter(
			(run) => run.status === "degraded" && !(run.topScore > 0),
		).length
		const sampledRuns = runs.filter((run) => run.sampled === true).length
		const fallbackCount = runs.filter(
			(run) => typeof run.fallbackPath === "string",
		).length
		const topScores = runs
			.map((run) => run.topScore)
			.filter((value): value is number => typeof value === "number")
		const avgTopScore =
			topScores.length > 0
				? topScores.reduce((sum, value) => sum + value, 0) / topScores.length
				: 0
		const health: RelevanceHealth =
			total < 20
				? "insufficient-data"
				: degradedCount / total >= 0.2
					? "degraded"
					: "ok"
		const latestRegression = await this.regressions
			.find(
				{ agentId: this.agentId },
				{ sort: { ts: -1 }, limit: 1, projection: { ts: 1 } },
			)
			.toArray()

		return {
			health,
			runs: total,
			sampledRuns,
			emptyRate: emptyCount / total,
			avgTopScore,
			fallbackRate: fallbackCount / total,
			lastRegressionAt:
				latestRegression[0]?.ts instanceof Date
					? latestRegression[0].ts.toISOString()
					: undefined,
			profileCapabilities: this.profileCapabilities,
		}
	}

	async loadBenchmarkDataset(
		pathname: string,
	): Promise<RelevanceBenchmarkCase[]> {
		const raw = await readFile(pathname, "utf-8")
		const rows = raw
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line.length > 0 && !line.startsWith("#"))
		const cases: RelevanceBenchmarkCase[] = []
		let skippedRows = 0
		for (const row of rows) {
			try {
				const parsed = JSON.parse(row) as RelevanceBenchmarkCase
				if (
					typeof parsed.query !== "string" ||
					parsed.query.trim().length === 0
				) {
					skippedRows++
					continue
				}
				cases.push(parsed)
			} catch {
				skippedRows++
			}
		}
		if (skippedRows > 0) {
			log.warn(`legacy benchmark dataset skipped ${skippedRows} invalid rows`)
		}
		return cases
	}

	async persistRegression(
		datasetVersion: string,
		currentMetrics: Record<
			| "hitRate"
			| "emptyRate"
			| "avgTopScore"
			| "p95LatencyMs"
			| "rAt5"
			| "rAt10"
			| "ndcgAt10",
			number
		>,
	): Promise<RelevanceBenchmarkResult["regressions"]> {
		const metricNames = [
			"hitRate",
			"emptyRate",
			"avgTopScore",
			"p95LatencyMs",
			"rAt5",
			"rAt10",
			"ndcgAt10",
		] as const
		const now = new Date()
		const regressions: RelevanceBenchmarkResult["regressions"] = []

		for (const metricName of metricNames) {
			const previous = await this.regressions
				.find(
					{
						agentId: this.agentId,
						datasetVersion,
						metricName,
					},
					{ sort: { ts: -1 }, limit: 1, projection: { current: 1 } },
				)
				.toArray()
			const current = currentMetrics[metricName]
			const baseline =
				typeof previous[0]?.current === "number" &&
				Number.isFinite(previous[0].current)
					? previous[0].current
					: current
			const delta = current - baseline
			const severity = detectSeverity(Math.abs(delta))
			regressions.push({
				metricName,
				baseline,
				current,
				delta,
				severity,
			})

			try {
				await this.regressions.insertOne({
					regressionId: randomUUID(),
					agentId: this.agentId,
					ts: now,
					datasetVersion,
					metricName,
					baseline,
					current,
					delta,
					severity,
					failingCases: [],
				})
			} catch (err) {
				log.warn("failed to persist benchmark regression metric", {
					datasetVersion,
					metricName,
					error: err,
				})
			}
		}

		return regressions
	}

	static buildCaseSummary(
		results: MemorySearchResult[],
		latencyMs: number,
	): {
		empty: boolean
		hitSources: string[]
		topScore: number
		latencyMs: number
	} {
		const hitSources = Array.from(
			new Set(results.map((result) => result.source)),
		)
		return {
			empty: results.length === 0,
			hitSources,
			topScore: results[0]?.score ?? 0,
			latencyMs,
		}
	}

	static summarizeBenchmarkCases(
		cases: Array<{
			empty: boolean
			topScore: number
			latencyMs: number
			pass: boolean
		}>,
	): {
		hitRate: number
		emptyRate: number
		avgTopScore: number
		p95LatencyMs: number
	} {
		if (cases.length === 0) {
			return { hitRate: 0, emptyRate: 0, avgTopScore: 0, p95LatencyMs: 0 }
		}
		const hitCount = cases.filter((entry) => entry.pass).length
		const emptyCount = cases.filter((entry) => entry.empty).length
		const topScores = cases.map((entry) => entry.topScore)
		const latencies = cases.map((entry) => entry.latencyMs)
		return {
			hitRate: hitCount / cases.length,
			emptyRate: emptyCount / cases.length,
			avgTopScore:
				topScores.reduce((sum, value) => sum + value, 0) / topScores.length,
			p95LatencyMs: percentile(latencies, 95),
		}
	}

	logTelemetryFailure(err: unknown): void {
		const message = err instanceof Error ? err.message : String(err)
		log.warn(`relevance telemetry failure: ${message}`)
	}
}
