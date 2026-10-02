import { randomUUID } from "node:crypto"
import type { Db } from "mongodb"
import { createSubsystemLogger } from "@memongo/lib"
import type { ResolvedMongoDBConfig } from "./backend-config.js"
import { applyDiagnosticQueryPrivacy } from "./mongodb-diagnostic-privacy.js"
import type { DetectedCapabilities } from "./mongodb-schema.js"
import {
	relevanceArtifactsCollection,
	relevanceRegressionsCollection,
	relevanceRunsCollection,
} from "./mongodb-schema.js"
import type { MemorySearchResult } from "./types.js"
import {
	type AdmissionToken,
	captureAdmissionToken,
	ErasureGateConflictError,
	withFencedWrite,
} from "./mongodb-write-fence.js"

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
	admission?: AdmissionToken
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

type RecentSignal = {
	empty: boolean
	lowScore: boolean
	fallback: boolean
	degraded: boolean
}

// RET-21: query normalization/hashing/redaction moved to
// mongodb-diagnostic-privacy.js — one policy shared with the recall-trace
// path, so the two diagnostic stores can never drift apart again.

// RET-14: extraction is KEY-matched at any depth — a number is only a
// match when a requested key maps to it. A bare numeric leaf (no key
// context) is never a match, so unrelated numerics elsewhere in the
// document (e.g. serverInfo.port) can never masquerade as explain stats.
function extractNumberByKeys(
	value: unknown,
	keys: string[],
	depth = 0,
): number | undefined {
	if (depth > 8 || value === null || value === undefined) {
		return undefined
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
	// EL-035: executionStats.executionTimeMillis is the measured total;
	// executionTimeMillisEstimate is a queryPlanner-stage estimate kept as
	// the fallback for explains captured at queryPlanner verbosity.
	const executionTimeMs =
		extractNumberByKeys(raw, ["executionTimeMillis"]) ??
		extractNumberByKeys(raw, ["executionTimeMillisEstimate"])
	const nReturned = extractNumberByKeys(raw, ["nReturned"])
	// Absent keys stay null — never a sibling value (RET-14).
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
		const admission =
			input.admission ??
			(await captureAdmissionToken({
				db: this.db,
				prefix: this.prefix,
				agentId: this.agentId,
			}))
		if (admission.agentId !== this.agentId)
			throw new ErasureGateConflictError(this.agentId)
		const runId = randomUUID()
		// RET-21: the shared transform — identical semantics to the previous
		// inline logic (none → no query fields; redacted-hash → hash +
		// redacted; raw → hash + raw), now sourced from the single policy
		// module the recall-trace path also consumes.
		const { queryHash, queryRedacted } = applyDiagnosticQueryPrivacy(
			input.query,
			this.cfg.relevance.telemetry.queryPrivacyMode,
		)
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

		const persistRaw =
			this.cfg.relevance.telemetry.persistRawExplain &&
			(input.status === "degraded" || Boolean(input.diagnosticMode))
		const artifactDocs = input.artifacts.map((artifact) => {
			const rawExplain = persistRaw ? artifact.rawExplain : undefined
			return {
				runId,
				// W02: artifacts carry their own immutable tenant identity
				// so tenant erasure can reach them directly instead of
				// only through their parent run row. Legacy rows (no
				// agentId) remain covered by the runId join while their
				// parents exist.
				agentId: this.agentId,
				artifactType: artifact.artifactType,
				summary: artifact.summary,
				rawExplain,
				rawSizeBytes: rawExplain ? JSON.stringify(rawExplain).length : 0,
				compression: "none",
				ts: now,
			}
		})
		await withFencedWrite({
			db: this.db,
			prefix: this.prefix,
			token: admission,
			fn: async (session) => {
				await this.runs.insertOne(runDoc, { session })
				if (artifactDocs.length > 0)
					await this.artifacts.insertMany(artifactDocs, { session })
			},
		})

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

	logTelemetryFailure(err: unknown): void {
		const message = err instanceof Error ? err.message : String(err)
		log.warn(`relevance telemetry failure: ${message}`)
	}
}
