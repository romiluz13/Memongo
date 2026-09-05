import {
	getAccessSummaries as listAccessSummaries,
	getAccessTrends as listAccessTrends,
} from "./mongodb-access-tracker.js"
import { getMemoryStats } from "./mongodb-analytics.js"
import type { MemoryStats } from "./mongodb-analytics.js"
import type { ChangeStreamLiveness } from "./mongodb-change-stream.js"
import { deleteAllForAgent as runTenantErasure } from "./mongodb-erasure.js"
import type { TenantErasureReceipt } from "./mongodb-erasure.js"
import { getLaneCoverage } from "./mongodb-lane-coverage.js"
import { getDailyCostSums, type DailyCostSum } from "./mongodb-cost-ledger.js"
import { resolveMemoryJobBacklogAlertThreshold } from "./mongodb-manager-jobs.js"
import type { MongoDBManagerHost } from "./mongodb-manager-host.js"
import {
	promoteQuarantined as runPromoteQuarantined,
	rejectQuarantined as runRejectQuarantined,
} from "./mongodb-quarantine-review.js"
import type { QuarantineReviewReceipt } from "./mongodb-quarantine-review.js"
import {
	getLatestIngestRun,
	getLatestProjectionRun,
	getProjectionLag,
} from "./mongodb-ops.js"
import type { IngestRun, ProjectionRun } from "./mongodb-ops.js"
import {
	eventsCollection,
	entitiesCollection,
	relationsCollection,
	episodesCollection,
	proceduresCollection,
	relevanceRunsCollection,
	chunksCollection,
	memoryJobsCollection,
} from "./mongodb-schema.js"
import { probeSearchLaneReadiness } from "./mongodb-schema-capabilities.js"
import { getActiveSourcesForStatus } from "./mongodb-search-ranking.js"
import { vectorSearch } from "./mongodb-search.js"
import type {
	AccessEventCollection,
	MemoryEmbeddingProbeResult,
	MemoryAccessSummary,
	MemoryAccessTrend,
	MemoryProviderStatus,
} from "./types.js"
import { createSubsystemLogger } from "@memongo/lib"
import type { Db } from "mongodb"

/**
 * Admin/status seam extracted from `mongodb-manager.ts` (P4.3): V2 status
 * classification, `getV2Status`, access-summary helpers, and the
 * `ManagerAdminOps` collaborator the facade delegates to.
 */

const log = createSubsystemLogger("memory:mongodb")

export function getAccessSummariesOrEmpty(params: {
	db: Db
	prefix: string
	agentId: string
	collection: AccessEventCollection
	memoryIds: string[]
	windowDays?: number
}) {
	const memoryIds = params.memoryIds.filter(
		(memoryId) => memoryId.trim().length > 0,
	)
	if (memoryIds.length === 0) {
		return Promise.resolve([])
	}
	return listAccessSummaries({
		db: params.db,
		prefix: params.prefix,
		agentId: params.agentId,
		collection: params.collection,
		memoryIds,
		windowDays: params.windowDays,
	})
}

// ---------------------------------------------------------------------------
// Phase 8: v2 standalone functions — write, search, status
// ---------------------------------------------------------------------------

/**
 * Write an event and project it to chunks. Records an ingest run on success or failure.
 * Standalone function following the v2 module pattern (db, prefix, ...).
 */

// ---------------------------------------------------------------------------
// v2 status types
// ---------------------------------------------------------------------------

export type V2Status = {
	events: { count: number; latestTimestamp?: Date }
	entities: { count: number }
	relations: { count: number }
	episodes: { count: number; latestTimestamp?: Date }
	procedures: { count: number; latestTimestamp?: Date }
	projectionLag: Record<string, number | null>
	projectionHealth: Record<
		string,
		| "ok"
		| "projection-behind"
		| "derived-product-unavailable"
		| "health-uncertain"
	>
	laneCoverage: Record<
		string,
		{ hasData: boolean; count: number; lastUpdated: Date | null }
	>
	health: {
		overall: "ok" | "degraded" | "health-uncertain"
		retrieval: "ok" | "retrieval-degraded" | "health-uncertain"
		recentNoRelevantResults: boolean
		canonicalIngest: "ok" | "canonical-ingest-failed" | "health-uncertain"
		/** Whether every query used to assemble this status response succeeded. */
		dataCompleteness?: "complete" | "partial"
		/** Query labels whose values were replaced with safe fallbacks. */
		failedChecks?: string[]
		derivedProducts: Record<
			string,
			| "ok"
			| "projection-behind"
			| "derived-product-unavailable"
			| "health-uncertain"
		>
		diagnostics: string[]
	}
	retrievalPaths: string[]
	/**
	 * C-016: change-stream watcher liveness (null when change streams are
	 * disabled or unavailable on this deployment). A recovering/stopped
	 * watcher means cross-instance sync is not currently flowing.
	 */
	changeStream?: ChangeStreamLiveness | null
	/**
	 * C-016: runtime search-lane health. The booleans come from the most
	 * recent live index-status probe (boot snapshot only until the first
	 * probe runs — `probedAt` absent means boot snapshot); `lastFailure`
	 * records the search-path failure that triggered the latest re-poll.
	 */
	searchLanes?: {
		vectorSearch: boolean
		textSearch: boolean
		probedAt?: Date
		lastFailure: { path: string; error: string; at: Date } | null
	}
	/**
	 * Memory-job queue depth by state. `deadLettered` counts jobs that
	 * exhausted their attempt budget (deadLetterAt set): those are never
	 * reclaimed and stay until an operator requeues or deletes them, which is
	 * exactly why they are surfaced here instead of aging out invisibly.
	 * `failed` counts only jobs that still have attempt budget left.
	 */
	memoryJobs?: {
		pending: number
		running: number
		failed: number
		deadLettered: number
		/**
		 * WS-11 change 3 (09-report R6): backlog alert verdict. `depth` is
		 * pending + running (work admitted but not finished); `triggered` is
		 * depth above the configured threshold, so "how far behind are we"
		 * is answerable from status alone without reading the drain's
		 * memory-job-backlog telemetry.
		 */
		backlogAlert: {
			depth: number
			threshold: number
			triggered: boolean
		}
	}
	/**
	 * C-017: per-tenant spend ledger sums over the trailing window. `daily`
	 * lists the UTC days that have at least one ledger document (absent days
	 * spent nothing). The aggregation itself swallows failures and degrades
	 * to [] (cost data is best-effort); the allSettled guard and
	 * `costLedger.dailySums` failed-check label are defense-in-depth for a
	 * synchronous throw outside the aggregation's own catch.
	 */
	costLedger?: {
		windowDays: number
		daily: DailyCostSum[]
	}
}

const PROJECTION_BEHIND_SECONDS = 5 * 60
const V2_STATUS_CHECK_LABELS = [
	"events.count",
	"entities.count",
	"relations.count",
	"episodes.count",
	"procedures.count",
	"projectionLag.chunks",
	"projectionLag.entities",
	"projectionLag.relations",
	"projectionLag.episodes",
	"projectionLag.structured-promotion",
	"projectionLag.procedures",
	"latestIngestRun",
	"latestProjectionRun.chunks",
	"latestProjectionRun.entities",
	"latestProjectionRun.relations",
	"latestProjectionRun.episodes",
	"latestProjectionRun.structured-promotion",
	"latestProjectionRun.procedures",
	"laneCoverage",
	"latestRetrievalRun",
	"events.latestTimestamp",
	"episodes.latestTimestamp",
	"procedures.latestTimestamp",
	"memoryJobs.pending",
	"memoryJobs.running",
	"memoryJobs.failed",
	"memoryJobs.deadLettered",
	"costLedger.dailySums",
] as const

export function classifyCanonicalIngestHealth(
	latestIngestRun: Pick<IngestRun, "status"> | null,
): "ok" | "canonical-ingest-failed" | "health-uncertain" {
	if (!latestIngestRun) {
		return "health-uncertain"
	}
	return latestIngestRun.status === "failed" ? "canonical-ingest-failed" : "ok"
}

export function classifyProjectionHealth(params: {
	latestRun: Pick<ProjectionRun, "status"> | null
	lagSeconds: number | null
}):
	| "ok"
	| "projection-behind"
	| "derived-product-unavailable"
	| "health-uncertain" {
	const { latestRun, lagSeconds } = params
	if (!latestRun) {
		return "health-uncertain"
	}
	if (latestRun.status === "failed") {
		return "derived-product-unavailable"
	}
	if (lagSeconds === null) {
		return "health-uncertain"
	}
	if (lagSeconds > PROJECTION_BEHIND_SECONDS) {
		return "projection-behind"
	}
	return "ok"
}

export function classifyRetrievalHealth(params: {
	status?: string | null
	hitSources?: string[] | null
}): {
	state: "ok" | "retrieval-degraded" | "health-uncertain"
	recentNoRelevantResults: boolean
} {
	const status = params.status ?? null
	const hitSources = params.hitSources ?? []
	if (status === "ok") {
		return { state: "ok", recentNoRelevantResults: false }
	}
	if (status === "degraded") {
		return {
			state: "retrieval-degraded",
			recentNoRelevantResults: hitSources.length === 0,
		}
	}
	return { state: "health-uncertain", recentNoRelevantResults: false }
}

export function computeOverallV2Health(params: {
	retrieval: "ok" | "retrieval-degraded" | "health-uncertain"
	canonicalIngest: "ok" | "canonical-ingest-failed" | "health-uncertain"
	derivedProducts: Array<
		| "ok"
		| "projection-behind"
		| "derived-product-unavailable"
		| "health-uncertain"
	>
}): "ok" | "degraded" | "health-uncertain" {
	const { retrieval, canonicalIngest, derivedProducts } = params
	if (
		retrieval === "retrieval-degraded" ||
		canonicalIngest === "canonical-ingest-failed" ||
		derivedProducts.some(
			(state) =>
				state === "projection-behind" ||
				state === "derived-product-unavailable",
		)
	) {
		return "degraded"
	}
	if (
		retrieval === "health-uncertain" ||
		canonicalIngest === "health-uncertain" ||
		derivedProducts.some((state) => state === "health-uncertain")
	) {
		return "health-uncertain"
	}
	return "ok"
}

/**
 * Gather v2 health metrics: collection counts, projection lag, available retrieval paths.
 */
export async function getV2Status(
	db: Db,
	prefix: string,
	agentId: string,
): Promise<V2Status> {
	try {
		const settled = await Promise.allSettled([
			eventsCollection(db, prefix).countDocuments({ agentId }),
			entitiesCollection(db, prefix).countDocuments({ agentId }),
			relationsCollection(db, prefix).countDocuments({ agentId }),
			episodesCollection(db, prefix).countDocuments({ agentId }),
			proceduresCollection(db, prefix).countDocuments({ agentId }),
			getProjectionLag({ db, prefix, agentId, projectionType: "chunks" }),
			getProjectionLag({ db, prefix, agentId, projectionType: "entities" }),
			getProjectionLag({ db, prefix, agentId, projectionType: "relations" }),
			getProjectionLag({ db, prefix, agentId, projectionType: "episodes" }),
			getProjectionLag({
				db,
				prefix,
				agentId,
				projectionType: "structured-promotion",
			}),
			getProjectionLag({ db, prefix, agentId, projectionType: "procedures" }),
			getLatestIngestRun({ db, prefix, agentId }),
			getLatestProjectionRun({ db, prefix, agentId, projectionType: "chunks" }),
			getLatestProjectionRun({
				db,
				prefix,
				agentId,
				projectionType: "entities",
			}),
			getLatestProjectionRun({
				db,
				prefix,
				agentId,
				projectionType: "relations",
			}),
			getLatestProjectionRun({
				db,
				prefix,
				agentId,
				projectionType: "episodes",
			}),
			getLatestProjectionRun({
				db,
				prefix,
				agentId,
				projectionType: "structured-promotion",
			}),
			getLatestProjectionRun({
				db,
				prefix,
				agentId,
				projectionType: "procedures",
			}),
			getLaneCoverage({ db, prefix, agentId }),
			relevanceRunsCollection(db, prefix).findOne(
				{ agentId },
				{ sort: { ts: -1 }, projection: { status: 1, hitSources: 1 } },
			),
			eventsCollection(db, prefix).findOne(
				{ agentId },
				{ sort: { timestamp: -1 }, projection: { timestamp: 1 } },
			),
			episodesCollection(db, prefix).findOne(
				{ agentId },
				{ sort: { updatedAt: -1 }, projection: { updatedAt: 1 } },
			),
			proceduresCollection(db, prefix).findOne(
				{ agentId },
				{ sort: { updatedAt: -1 }, projection: { updatedAt: 1 } },
			),
			memoryJobsCollection(db, prefix).countDocuments({
				agentId,
				status: "pending",
			}),
			memoryJobsCollection(db, prefix).countDocuments({
				agentId,
				status: "running",
			}),
			memoryJobsCollection(db, prefix).countDocuments({
				agentId,
				status: "failed",
				deadLetterAt: { $exists: false },
			}),
			memoryJobsCollection(db, prefix).countDocuments({
				agentId,
				deadLetterAt: { $exists: true },
			}),
			// C-017: trailing per-day cost ledger sums (tokens + embed units).
			getDailyCostSums(db, prefix, agentId, 30),
		])

		// Extract fulfilled values, default to safe fallbacks on rejection
		const val = <T>(r: PromiseSettledResult<T>, fallback: T): T =>
			r.status === "fulfilled" ? r.value : fallback

		const eventCount = val(settled[0], 0)
		const entityCount = val(settled[1], 0)
		const relationCount = val(settled[2], 0)
		const episodeCount = val(settled[3], 0)
		const procedureCount = val(settled[4], 0)
		const chunksLag = val(settled[5], null)
		const entitiesLag = val(settled[6], null)
		const relationsLag = val(settled[7], null)
		const episodesLag = val(settled[8], null)
		const structuredPromotionLag = val(settled[9], null)
		const proceduresLag = val(settled[10], null)
		const latestIngest = val(settled[11], null)
		const latestChunksProjection = val(settled[12], null)
		const latestEntitiesProjection = val(settled[13], null)
		const latestRelationsProjection = val(settled[14], null)
		const latestEpisodesProjection = val(settled[15], null)
		const latestStructuredPromotion = val(settled[16], null)
		const latestProceduresProjection = val(settled[17], null)
		const laneCoverageDoc = val(settled[18], null) as {
			lanes?: Record<
				string,
				{ hasData: boolean; count: number; lastUpdated: Date | null }
			>
		} | null
		const latestRetrievalSafe = val(settled[19], null) as {
			status?: string
			hitSources?: string[]
		} | null
		const latestEvent = val(settled[20], null) as { timestamp?: Date } | null
		const latestEpisode = val(settled[21], null) as { updatedAt?: Date } | null
		const latestProcedure = val(settled[22], null) as {
			updatedAt?: Date
		} | null
		const memoryJobsPending = val(settled[23], 0)
		const memoryJobsRunning = val(settled[24], 0)
		const memoryJobsFailed = val(settled[25], 0)
		const memoryJobsDeadLettered = val(settled[26], 0)
		const costDailySums = val(settled[27], [] as DailyCostSum[])
		// WS-11 change 3: backlog-depth gauge inputs (pending + running is
		// admitted-but-unfinished work; the threshold is the alert verdict).
		const memoryJobsBacklogDepth = memoryJobsPending + memoryJobsRunning
		const memoryJobsBacklogThreshold = resolveMemoryJobBacklogAlertThreshold()
		const failedChecks = settled.flatMap((result, index) =>
			result.status === "rejected" ? [V2_STATUS_CHECK_LABELS[index]] : [],
		)

		const canonicalIngest = classifyCanonicalIngestHealth(latestIngest)
		const retrievalHealth = classifyRetrievalHealth({
			status: latestRetrievalSafe?.status,
			hitSources: latestRetrievalSafe?.hitSources,
		})
		const derivedProducts = {
			chunks: classifyProjectionHealth({
				latestRun: latestChunksProjection,
				lagSeconds: chunksLag,
			}),
			entities: classifyProjectionHealth({
				latestRun: latestEntitiesProjection,
				lagSeconds: entitiesLag,
			}),
			relations: classifyProjectionHealth({
				latestRun: latestRelationsProjection,
				lagSeconds: relationsLag,
			}),
			episodes: classifyProjectionHealth({
				latestRun: latestEpisodesProjection,
				lagSeconds: episodesLag,
			}),
			"structured-promotion": classifyProjectionHealth({
				latestRun: latestStructuredPromotion,
				lagSeconds: structuredPromotionLag,
			}),
			procedures: classifyProjectionHealth({
				latestRun: latestProceduresProjection,
				lagSeconds: proceduresLag,
			}),
		}
		const diagnostics = [
			retrievalHealth.state === "retrieval-degraded"
				? "retrieval-degraded"
				: null,
			retrievalHealth.recentNoRelevantResults ? "no-relevant-results" : null,
			canonicalIngest === "canonical-ingest-failed"
				? "canonical-ingest-failed"
				: null,
			canonicalIngest === "health-uncertain"
				? "health-uncertain:canonical-ingest"
				: null,
			...Object.entries(derivedProducts).map(([name, state]) => {
				if (state === "projection-behind") {
					return `projection-behind:${name}`
				}
				if (state === "derived-product-unavailable") {
					return `derived-product-unavailable:${name}`
				}
				if (state === "health-uncertain") {
					return `health-uncertain:${name}`
				}
				return null
			}),
		].filter((value): value is string => Boolean(value))
		const overall = computeOverallV2Health({
			retrieval: retrievalHealth.state,
			canonicalIngest,
			derivedProducts: Object.values(derivedProducts),
		})

		// Log any individual failures for diagnostics
		for (const [index, r] of settled.entries()) {
			if (r.status === "rejected") {
				log.error("getV2Status partial failure", {
					check: V2_STATUS_CHECK_LABELS[index],
					error: r.reason,
				})
			}
		}

		return {
			events: {
				count: eventCount,
				latestTimestamp: latestEvent?.timestamp,
			},
			entities: { count: entityCount },
			relations: { count: relationCount },
			episodes: {
				count: episodeCount,
				latestTimestamp: latestEpisode?.updatedAt,
			},
			procedures: {
				count: procedureCount,
				latestTimestamp: latestProcedure?.updatedAt,
			},
			projectionLag: {
				chunks: chunksLag,
				entities: entitiesLag,
				relations: relationsLag,
				episodes: episodesLag,
				"structured-promotion": structuredPromotionLag,
				procedures: proceduresLag,
			},
			projectionHealth: derivedProducts,
			laneCoverage: laneCoverageDoc?.lanes ?? {},
			health: {
				overall,
				retrieval: retrievalHealth.state,
				recentNoRelevantResults: retrievalHealth.recentNoRelevantResults,
				canonicalIngest,
				dataCompleteness: failedChecks.length === 0 ? "complete" : "partial",
				failedChecks,
				derivedProducts,
				diagnostics,
			},
			retrievalPaths: [
				"active-critical",
				"structured",
				"raw-window",
				"graph",
				"hybrid",
				"kb",
				"episodic",
				"procedural",
			],
			memoryJobs: {
				pending: memoryJobsPending,
				running: memoryJobsRunning,
				failed: memoryJobsFailed,
				deadLettered: memoryJobsDeadLettered,
				// WS-11 change 3: the backlog gauge's pull surface — verdict is
				// computable from the counts already fetched, no extra round trip.
				backlogAlert: {
					depth: memoryJobsBacklogDepth,
					threshold: memoryJobsBacklogThreshold,
					triggered: memoryJobsBacklogDepth > memoryJobsBacklogThreshold,
				},
			},
			costLedger: {
				windowDays: 30,
				daily: costDailySums,
			},
		}
	} catch (err) {
		log.error("getV2Status failed", { error: err })
		throw err
	}
}

/**
 * Admin/status collaborator (P4.3). Methods land in a later seam step.
 */
export class MongoDBManagerAdminOps {
	/** C-016: most recent live search-lane probe outcome (null = boot snapshot). */
	private searchLaneHealth: {
		vectorSearch: boolean
		textSearch: boolean
		probedAt: Date
	} | null = null
	/** C-016: latest search-path failure that triggered a readiness re-poll. */
	private lastSearchLaneFailure: {
		path: string
		error: string
		at: Date
	} | null = null
	/** C-016: guards against a re-poll storm from rapid search-path failures. */
	private searchLaneRePollInFlight = false

	constructor(private readonly host: MongoDBManagerHost) {}

	async accessTrends(params?: {
		collection?: AccessEventCollection
		memoryIds?: string[]
		windowDays?: number
		limit?: number
	}): Promise<MemoryAccessTrend[]> {
		return listAccessTrends({
			db: this.host.db,
			prefix: this.host.prefix,
			agentId: this.host.agentId,
			collection: params?.collection,
			memoryIds:
				params?.memoryIds?.filter((memoryId) => memoryId.trim().length > 0) ??
				undefined,
			windowDays: params?.windowDays,
			limit: params?.limit,
		})
	}

	async accessSummaries(params: {
		collection: AccessEventCollection
		memoryIds: string[]
		windowDays?: number
	}): Promise<MemoryAccessSummary[]> {
		return getAccessSummariesOrEmpty({
			db: this.host.db,
			prefix: this.host.prefix,
			agentId: this.host.agentId,
			collection: params.collection,
			memoryIds: params.memoryIds,
			windowDays: params.windowDays,
		})
	}

	status(): MemoryProviderStatus {
		const mongoCfg = this.host.config.mongodb!
		const vectorEnabled =
			this.host.capabilities.vectorSearch &&
			this.host.probeEmbeddingModeSupportsVector()
		const lexicalEnabled = this.host.capabilities.textSearch
		const hybridEnabled = vectorEnabled && lexicalEnabled
		return {
			backend: "mongodb",
			provider: "mongodb-automated",
			model: "automated (server-managed)",
			files: this.host.fileCount,
			chunks: this.host.chunkCount,
			dirty: this.host.dirty,
			workspaceDir: this.host.workspaceDir,
			sources: getActiveSourcesForStatus(mongoCfg.sources, mongoCfg.kb.enabled),
			custom: {
				deploymentProfile: mongoCfg.deploymentProfile,
				embeddingMode: mongoCfg.embeddingMode,
				fusionMethod: mongoCfg.fusionMethod,
				capabilities: this.host.capabilities,
				searchModes: {
					vector: vectorEnabled,
					lexical: lexicalEnabled,
					hybrid: hybridEnabled,
				},
				searchMode: this.host.lastSearchMode,
				searchModeDetails: this.host.lastSearchDetails,
				retrievalPaths: [
					"active-critical",
					"structured",
					"raw-window",
					"graph",
					"hybrid",
					"kb",
					"episodic",
					"procedural",
				],
				sourceCoverage: {
					reference:
						mongoCfg.sources?.reference?.enabled && mongoCfg.kb.enabled,
					conversation: mongoCfg.sources?.conversation?.enabled,
					structured: mongoCfg.sources?.structured?.enabled,
				},
				database: mongoCfg.database,
				collectionPrefix: mongoCfg.collectionPrefix,
				quantization: mongoCfg.quantization,
				relevance: this.host.relevance
					? {
							enabled: mongoCfg.relevance.enabled,
							telemetry: {
								state:
									mongoCfg.relevance.enabled &&
									mongoCfg.relevance.telemetry.enabled
										? "enabled"
										: "disabled",
							},
							sampleRate: {
								current: this.host.relevance.getSampleState().current,
							},
							health: this.host.relevance.getCurrentHealth(),
							lastRegressionAt: undefined,
							profileCapabilities: this.host.relevance.getProfileCapabilities(),
						}
					: {
							enabled: false,
							telemetry: { state: "disabled" },
							sampleRate: { current: 0 },
							health: "insufficient-data",
							profileCapabilities: {
								textExplain: false,
								vectorExplain: false,
								fusionExplain: false,
							},
						},
			},
		}
	}

	async probeEmbeddingAvailability(): Promise<MemoryEmbeddingProbeResult> {
		const mongoCfg = this.host.config.mongodb!

		if (mongoCfg.embeddingMode === "automated") {
			if (
				mongoCfg.deploymentProfile !== "atlas-local-preview" &&
				mongoCfg.deploymentProfile !== "atlas-managed"
			) {
				return {
					ok: false,
					error: `embeddingMode "automated" is only supported on atlas-local-preview or atlas-managed in Memongo`,
				}
			}
			// C-016: live index-status round trip instead of the boot-time
			// capability snapshot — catches a mongot that died after boot or an
			// index an operator dropped mid-process. A transport failure
			// propagates to the caller as a probe failure.
			const readiness = await this.probeSearchLanes()
			return readiness.vectorSearch
				? { ok: true }
				: {
						ok: false,
						error: "vector search index is not queryable (live probe)",
					}
		}

		return { ok: false, error: "unsupported embedding mode" }
	}

	async probeVectorAvailability(): Promise<boolean> {
		if (!this.probeEmbeddingModeSupportsVector()) {
			return false
		}
		// C-016: live index-status round trip instead of the boot-time
		// capability snapshot. The embedding-mode/deployment gate above is
		// configuration (not runtime state), so it stays; the boot snapshot
		// does not — a live probe that can answer must be the answer.
		const readiness = await this.probeSearchLanes()
		return readiness.vectorSearch
	}

	/**
	 * C-016: live search-lane readiness (listSearchIndexes on the chunks
	 * collection + queryable/type checks). Records the outcome for
	 * getDetailedStatus(). Transport errors propagate.
	 */
	private async probeSearchLanes(): Promise<{
		vectorSearch: boolean
		textSearch: boolean
	}> {
		const probeCollectionName = chunksCollection(
			this.host.db,
			this.host.prefix,
		).collectionName
		const readiness = await probeSearchLaneReadiness(
			this.host.db,
			probeCollectionName,
		)
		this.searchLaneHealth = { ...readiness, probedAt: new Date() }
		return readiness
	}

	/**
	 * C-016: a v2 search path failed at query time (e.g. mongot died after
	 * boot). Records the failure and triggers a throttled live re-poll of
	 * index readiness so status reflects the outage instead of the boot-time
	 * snapshot. The re-poll result lands in getDetailedStatus() via
	 * `searchLanes` (and the next /ready probe answers from live state).
	 */
	noteSearchLaneFailure(path: string, error: unknown): void {
		this.lastSearchLaneFailure = {
			path,
			error: error instanceof Error ? error.message : String(error),
			at: new Date(),
		}
		if (this.searchLaneRePollInFlight) {
			return
		}
		this.searchLaneRePollInFlight = true
		this.probeSearchLanes()
			.then((readiness) => {
				if (!readiness.vectorSearch || !readiness.textSearch) {
					log.warn("search lane re-poll after path failure: lanes not ready", {
						path,
						vectorSearch: readiness.vectorSearch,
						textSearch: readiness.textSearch,
					})
				}
			})
			.catch((err) => {
				log.warn("search lane re-poll after path failure failed", {
					path,
					error: err instanceof Error ? err.message : String(err),
				})
			})
			.finally(() => {
				this.searchLaneRePollInFlight = false
			})
	}

	probeEmbeddingModeSupportsVector(): boolean {
		const mongoCfg = this.host.config.mongodb!
		return (
			mongoCfg.embeddingMode === "automated" &&
			(mongoCfg.deploymentProfile === "atlas-local-preview" ||
				mongoCfg.deploymentProfile === "atlas-managed")
		)
	}

	async getDetailedStatus(): Promise<V2Status> {
		const status = await getV2Status(
			this.host.db,
			this.host.prefix,
			this.host.agentId,
		)
		// C-016: runtime capability re-verification surfaces — change-stream
		// liveness (null when the watcher never started) and the live
		// search-lane probe state (boot snapshot until the first probe).
		const watcher = this.host.changeStreamWatcher
		return {
			...status,
			changeStream: watcher ? watcher.liveness : null,
			searchLanes: {
				vectorSearch:
					this.searchLaneHealth?.vectorSearch ??
					this.host.capabilities.vectorSearch,
				textSearch:
					this.searchLaneHealth?.textSearch ??
					this.host.capabilities.textSearch,
				...(this.searchLaneHealth
					? { probedAt: this.searchLaneHealth.probedAt }
					: {}),
				lastFailure: this.lastSearchLaneFailure,
			},
		}
	}

	/**
	 * C-003 tenant-level erasure: delete every document this agent owns
	 * across every collection, with per-collection receipts and a
	 * critical-severity audit record that survives the erase.
	 */
	async deleteAllForAgent(): Promise<TenantErasureReceipt> {
		return runTenantErasure({
			db: this.host.db,
			prefix: this.host.prefix,
			agentId: this.host.agentId,
		})
	}

	/**
	 * C-004 quarantine review: overrule the injection classifier and write
	 * the quarantined candidate as structured memory, recording the decision.
	 */
	async promoteQuarantined(params: {
		quarantineId: string
		reviewerId?: string
		reviewNotes?: string
	}): Promise<QuarantineReviewReceipt> {
		return runPromoteQuarantined({
			db: this.host.db,
			prefix: this.host.prefix,
			agentId: this.host.agentId,
			quarantineId: params.quarantineId,
			embeddingMode: this.host.config.mongodb?.embeddingMode ?? "automated",
			reviewerId: params.reviewerId,
			reviewNotes: params.reviewNotes,
		})
	}

	/**
	 * C-004 quarantine review: discard the quarantined candidate, recording
	 * the decision as durable audit trail.
	 */
	async rejectQuarantined(params: {
		quarantineId: string
		reviewerId?: string
		reviewNotes?: string
	}): Promise<QuarantineReviewReceipt> {
		return runRejectQuarantined({
			db: this.host.db,
			prefix: this.host.prefix,
			agentId: this.host.agentId,
			quarantineId: params.quarantineId,
			reviewerId: params.reviewerId,
			reviewNotes: params.reviewNotes,
		})
	}

	async stats(): Promise<MemoryStats> {
		const embeddingMode = this.host.config.mongodb?.embeddingMode ?? "automated"
		return getMemoryStats(this.host.db, this.host.prefix, undefined, {
			embeddingMode,
		})
	}
}
