/**
 * Consolidation Agent (Dreamer) — 5-phase offline pipeline:
 *
 *   Phase 0 — Gate: rate limiter + event count check
 *   Phase 1 — Orient: $facet parallel stats (unprocessed count, roles, top scopes)
 *   Phase 2 — Extract + Decide: 8-category pattern matching + $vectorSearch
 *             similarity-based ADD/NOOP decisions
 *   Phase 3 — Deduction: stub for future LLM agent
 *   Phase 4 — Induction: stub for future LLM agent
 *   Phase 5 — Prune + Profile: near-duplicate merge via $vectorSearch (> 0.92)
 *
 * The Dreamer writes promoted facts to `structured_memory` via the existing
 * `writeStructuredMemory()` function and marks processed events with
 * `dreamerProcessedAt` + `dreamerRunId`.
 *
 * This module does NOT use `markEventsConsolidated()` (which requires an
 * `episodeId` for episode consolidation) — it has its own
 * `markEventsDreamerProcessed()` that sets dreamer-specific fields.
 *
 * @module mongodb-consolidator
 */

import { randomUUID } from "node:crypto"
import { startConsolidationHeartbeat } from "./consolidation-heartbeat.js"
import type { ClientSession, Collection, Db, Document } from "mongodb"
import {
	createSubsystemLogger,
	isMemoryScopeValue,
	type MemoryScope,
} from "@memongo/lib"
import { isDuplicateKeyError } from "./internal.js"
import {
	buildUnexpiredClause,
	buildCurrentValidityClause,
} from "./mongodb-temporal.js"
import { DURABLE_JOB_WRITE_CONCERN } from "./mongodb-memory-jobs.js"
import { scanNovelty } from "./mongodb-novelty.js"
import { resolveConsolidationMaxEvents } from "./mongodb-consolidation-options.js"
import { traceReasoningChain } from "./mongodb-reasoning-chain.js"
import { computeImportanceDecay } from "./mongodb-trust.js"
import {
	eventsCollection,
	consolidationRunsCollection,
	memoryQuarantineCollection,
} from "./mongodb-schema.js"
import { INDEX_AUTOEMBED_MODEL } from "./mongodb-schema-search-definitions.js"
import { classifyInjection } from "./mongodb-injection-classifier.js"
import {
	type AdmissionToken,
	captureAdmissionToken,
	isErasureGateConflictError,
	isMalformedGateError,
	withFencedWrite,
} from "./mongodb-write-fence.js"
import {
	extractAndUpsertEntities,
	type EntityExtractionDiagnostics,
} from "./mongodb-graph.js"
import { recordProjectionRun } from "./mongodb-ops.js"
import { emitTelemetry } from "./mongodb-telemetry.js"
import { settledFailureMeta } from "./query-diagnostics.js"
import {
	isExtractionLlmDisabled,
	resolveEnrichmentProvider,
} from "./mongodb-llm-enrichment.js"
import {
	instrumentProviderCostSpend,
	recordEmbeddingSpendInSession,
	recordLLMSpendInSession,
} from "./mongodb-cost-ledger.js"
import {
	LLM_DEDUP_MAX_SIMILARITY,
	LLM_DEDUP_MIN_SIMILARITY,
	adjudicateFactMerge,
	foldSourceEventIds,
	prepareConflictedCandidateResolution,
} from "./mongodb-consolidation-adjudication.js"
import {
	persistPreparedContradictionInvalidations,
	type PreparedContradictionInvalidation,
} from "./mongodb-contradiction.js"
import {
	buildInferredMemoryEntry,
	deduceFactsFromMemories,
	induceFactsFromMemories,
} from "./mongodb-consolidation-reasoning.js"
import {
	writeStructuredMemory,
	invalidateStructuredMemoryByHandle,
	MemoryLifecycleConflictError,
	MemoryQuarantinedWriteError,
	structuredEntryFromDoc,
	type StructuredMemoryType,
} from "./mongodb-structured-memory.js"
import {
	CONFIDENCE_BY_SOURCE,
	type ConsolidationCandidate,
	type ConsolidationOptions,
	type ConsolidationResult,
	type DreamerOrientStats,
} from "./types.js"

const log = createSubsystemLogger("memory:mongodb:consolidator")

// ---------------------------------------------------------------------------
// Constants / Defaults
// ---------------------------------------------------------------------------

// Quality floor only. This must never behave as a recency filter: whether a
// fact is worth keeping does not depend on how long ago it was stated. Decay
// belongs in retrieval ranking, not write eligibility.
const DEFAULT_MIN_COMBINED_SCORE = 0.15
const DEFAULT_MIN_INTERVAL_MS = 3_600_000 // 1 hour
// Renewed during asynchronous work; expired or replaced leases reject writes.
const DEFAULT_CONSOLIDATION_LEASE_MS = 15 * 60_000
const DEFAULT_NOVELTY_WEIGHT = 0.4
// Raised from 0.3 to absorb the access weight below, keeping the score scale
// near unity so the 0.15 threshold keeps the meaning callers already rely on.
const DEFAULT_IMPORTANCE_WEIGHT = 0.6
// Access is structurally ~0 at write time (raw events are appended, not
// retrieved) and normalizedAccess is batch-relative, so the same event scores
// 1.0 alone and 0.01 in a busy batch. It was 0.3 of the gate and carried no
// signal. Weight 0 rather than removal keeps the option honored for callers
// who set it explicitly.
const DEFAULT_ACCESS_WEIGHT = 0
// An event missing from the novelty report was never SCORED — scanNovelty caps
// its candidate set — so its novelty is unknown, not zero. Treating unknown as
// "perfectly duplicate" silently discarded every event past that cap. Real
// duplicate detection is the $vectorSearch NOOP check in the promotion loop.
const UNSCORED_NOVELTY = 0.5
// Cap the facts fed to the reasoning phases so a large memory does not blow the
// LLM context window or token budget on a single consolidation run.
const REASONING_MAX_FACTS = 40

// ---------------------------------------------------------------------------
// Rule-based pattern matching (conservative: false negatives OK,
// false positives NOT OK) — expanded from 2 to 8 categories
// ---------------------------------------------------------------------------

type CategoryPattern = {
	type: StructuredMemoryType
	pattern: RegExp
}

const CATEGORY_PATTERNS: CategoryPattern[] = [
	{
		// First-person plural matters as much as singular here: in practice
		// decisions get recorded as "we decided" / "we chose" far more often
		// than "I decided", and the singular-only form silently dropped every
		// one of them. Both readings are unambiguously a decision, so this stays
		// within the false-positives-are-not-OK rule above.
		type: "decision",
		pattern:
			/\b(?:(?:I|we)\s+(?:decided|chose|picked|selected|went with))\s+(.+)/i,
	},
	{
		type: "preference",
		pattern: /\b(?:I\s+(?:prefer|like|want|always use|love))\s+(.+)/i,
	},
	{
		type: "fact",
		pattern:
			/\b(?:The\s+\w+\s+(?:uses?|is|has|runs?|supports?|requires?))\s+(.+)/i,
	},
	{
		type: "contact",
		pattern:
			/\b(?:(?:contact|reach|email|call|ask)\s+\w+\s+(?:at|for|about))\s*(.+)/i,
	},
	{
		type: "todo",
		pattern:
			/\b(?:TODO|FIXME|need\s+to|have\s+to|must|should)(?:\s*:)?\s+(.+)/i,
	},
	{
		type: "milestone",
		pattern:
			/\b(?:(?:shipped|launched|released|completed|finished|deployed)\s+(.+))/i,
	},
	{
		type: "problem",
		pattern:
			/\b(?:(?:there\s+is\s+a\s+(?:bug|issue|problem|error)|(?:bug|issue|problem|error)\s+in))\s+(.+)/i,
	},
	{
		type: "emotional",
		pattern:
			/\b(?:I'm\s+(?:frustrated|happy|excited|worried|concerned|anxious|confused|delighted))\s*(.+)/i,
	},
]

type PatternMatch = {
	type: StructuredMemoryType
	key: string
	value: string
}

/**
 * Attempt to extract a deducible fact from event body text.
 * Returns null if no high-confidence pattern matches.
 * Checks all 8 category patterns in priority order.
 */
export function matchPatterns(body: string): PatternMatch | null {
	for (const { type, pattern } of CATEGORY_PATTERNS) {
		const match = pattern.exec(body)
		if (match?.[1]) {
			const extracted = match[1].trim()
			const key = extracted.length > 120 ? extracted.slice(0, 120) : extracted
			return { type, key, value: body }
		}
	}
	return null
}

// ---------------------------------------------------------------------------
// Similarity threshold constants
// ---------------------------------------------------------------------------

const SIMILARITY_THRESHOLD_NOOP = 0.85
const SIMILARITY_THRESHOLD_PRUNE = 0.92

/**
 * Phase 3.7 — Quality filter: heuristic patterns that indicate a memory is
 * derivable from the current agent context (git, files, repo structure) and
 * therefore not worth storing as durable structured memory.
 *
 * Examples: "uses TypeScript", "is a monorepo", "runs on Node 20"
 */
const DERIVABLE_PATTERNS = [
	/^(?:uses?|runs?\s+on|built with|written in|powered by)\s+[\w\s.]+$/i,
	/^(?:this is|it is|the project is)\s+a\s+\w+\s+(?:project|repo|app|monorepo|package)/i,
	/^(?:the codebase|the repo|the project)\s+(?:is|uses|has|contains)\s/i,
	/^(?:node|bun|npm|pnpm|yarn|python|go|rust|java)\s+\d+/i,
	/^(?:package manager|runtime|framework|language)\s+(?:is|:)\s+/i,
]

export function isDerivableFromContext(value: string): boolean {
	const trimmed = value.trim()
	if (!trimmed || trimmed.length > 200) {
		return false
	}
	return DERIVABLE_PATTERNS.some((re) => re.test(trimmed))
}

// ---------------------------------------------------------------------------
// markEventsDreamerProcessed — sets dreamerProcessedAt + dreamerRunId
// on processed events. Distinct from markEventsConsolidated (which
// requires an episodeId for episode consolidation).
// ---------------------------------------------------------------------------

export async function markEventsDreamerProcessed(params: {
	db: Db
	prefix: string
	eventIds: string[]
	runId: string
	agentId?: string
	session?: ClientSession
}): Promise<number> {
	const { db, prefix, eventIds, runId } = params
	if (eventIds.length === 0) {
		return 0
	}
	const collection = eventsCollection(db, prefix)
	const result = await collection.updateMany(
		{
			...(params.agentId !== undefined ? { agentId: params.agentId } : {}),
			eventId: { $in: eventIds },
		},
		{
			$set: {
				dreamerProcessedAt: new Date(),
				dreamerRunId: runId,
			},
		},
		...(params.session ? [{ session: params.session }] : []),
	)
	log.info(
		`marked ${result.modifiedCount} events as dreamer-processed (runId=${runId})`,
	)
	return result.modifiedCount
}

// ---------------------------------------------------------------------------
// Conflict detection helper
// ---------------------------------------------------------------------------

/**
 * Check whether promoting a fact with the given key would conflict with
 * an existing structured memory entry. Uses the document state field
 * as the conflict signal.
 *
 * Returns true if a conflict is detected (promotion should be skipped).
 */
async function hasConflict(params: {
	db: Db
	prefix: string
	agentId: string
	type: string
	key: string
	scope?: MemoryScope
	scopeRef?: string
}): Promise<boolean> {
	const { db, prefix, agentId, type, key, scope, scopeRef } = params
	const structuredCol = db.collection(`${prefix}structured_mem`)
	const filter: Document = {
		agentId,
		type,
		key,
		state: { $ne: "invalidated" },
		// P4.4.1 (B1): an expired entry reads as gone, so it must not block
		// promotion as a conflict ahead of the TTL sweep.
		...buildUnexpiredClause(),
	}
	if (scope) filter.scope = scope
	if (scopeRef) filter.scopeRef = scopeRef
	const existing = await structuredCol.findOne(filter)

	if (!existing) {
		return false
	}

	// A conflicted state indicates an existing conflict
	const state = (existing.state as string) ?? "active"
	return state === "conflicted"
}

// ---------------------------------------------------------------------------
// Main consolidation pipeline
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Phase-0 gate — atomic lease (mirrors claimMemoryJob in mongodb-memory-jobs)
// ---------------------------------------------------------------------------

/**
 * Deterministic gate identity: one gate document per (agentId, scope,
 * scopeRef) triple. B7: the key is a length-prefixed JSON tuple, not plain
 * concatenation — `("agent","session","sess:1")` and `("agentsession","",
 * "sess:1")` used to collapse to the same string and share one gate lease.
 * Length prefixes keep component boundaries recoverable for any component
 * content; absent scope/scopeRef encode as empty strings, preserving the
 * established scoped-vs-unscoped gate granularity. Scoped and unscoped runs
 * are separate gates, as they were under the previous runScopeFilter.
 */
function consolidationGateKey(identity: {
	agentId: string
	scope?: MemoryScope
	scopeRef?: string
}): string {
	const parts = [
		identity.agentId,
		identity.scope ?? "",
		identity.scopeRef ?? "",
	]
	return parts.map((part) => `${part.length}:${JSON.stringify(part)}`).join("|")
}

export class ConsolidationLeaseLostError extends Error {
	constructor(runId: string) {
		super(`consolidation lease lost for run ${runId}`)
		this.name = "ConsolidationLeaseLostError"
	}
}

async function touchConsolidationLease(params: {
	consolidationRuns: Collection
	gateKey: string
	runId: string
	leaseToken: string
	leaseMs: number
	session: ClientSession
}): Promise<void> {
	const result = await params.consolidationRuns.updateOne(
		{
			gateKey: params.gateKey,
			runId: params.runId,
			status: "running",
			leaseToken: params.leaseToken,
			leaseExpiresAt: { $gt: new Date() },
		},
		[
			{
				$set: {
					leaseExpiresAt: {
						$max: [
							{ $add: ["$$NOW", params.leaseMs] },
							// The transaction must modify this row to acquire its write lock.
							{ $add: ["$leaseExpiresAt", 1] },
						],
					},
				},
			},
		],
		{ session: params.session },
	)
	if (result.matchedCount === 0) {
		throw new ConsolidationLeaseLostError(params.runId)
	}
}

/**
 * Fenced terminal update: only the live lease holder may mark the run
 * completed/failed. matchedCount === 0 means the lease expired (or was
 * re-claimed) while this run was still working — its terminal state must not
 * overwrite the successor's gate document.
 */
async function finishConsolidationRun(params: {
	consolidationRuns: Collection
	gateKey: string
	runId: string
	leaseToken: string
	update: Document
}): Promise<void> {
	const result = await params.consolidationRuns.updateOne(
		{
			gateKey: params.gateKey,
			runId: params.runId,
			status: "running",
			leaseToken: params.leaseToken,
			leaseExpiresAt: { $gt: new Date() },
		},
		{
			$set: params.update,
			$unset: { leaseToken: "", leaseExpiresAt: "" },
		},
		{ writeConcern: DURABLE_JOB_WRITE_CONCERN },
	)
	if (result.matchedCount === 0) {
		log.warn(
			`consolidation completion fenced for run=${params.runId}: lease lost or expired`,
		)
	}
}

export async function consolidateMemory(params: {
	db: Db
	prefix: string
	agentId: string
	options?: ConsolidationOptions
	admission?: AdmissionToken
}): Promise<ConsolidationResult> {
	const { db, prefix, agentId, options } = params
	const startMs = Date.now()
	const runId = randomUUID()

	const maxEvents = resolveConsolidationMaxEvents(options?.maxEvents)
	const supplied = params.admission
	if (
		supplied !== undefined &&
		(!supplied ||
			supplied.kind !== "admission" ||
			supplied.agentId !== agentId ||
			!Number.isInteger(supplied.epoch) ||
			supplied.epoch < 0)
	)
		throw new TypeError("consolidation admission token does not match caller")
	const admission =
		supplied ?? (await captureAdmissionToken({ db, prefix, agentId }))
	const minCombinedScore =
		options?.minCombinedScore ?? DEFAULT_MIN_COMBINED_SCORE
	const minIntervalMs = options?.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS
	const noveltyWeight = options?.noveltyWeight ?? DEFAULT_NOVELTY_WEIGHT
	const importanceWeight =
		options?.importanceWeight ?? DEFAULT_IMPORTANCE_WEIGHT
	const accessWeight = options?.accessWeight ?? DEFAULT_ACCESS_WEIGHT

	// P4.4.2 — contradiction wiring: resolve-instead-of-skip, default ON.
	// P4.4.3 — LLM-adjudicated dedup: opt-in, default OFF.
	const resolveContradictionsEnabled = options?.resolveContradictions ?? true
	const llmDedupEnabled = options?.llmDedup ?? false

	// Single LLM seam for the whole run: contradiction resolution (P4.4.2),
	// deduction/induction (issue #31), and LLM-adjudicated dedup (P4.4.3) all
	// share one provider resolution, so a misconfigured provider warns once
	// and every LLM-dependent phase degrades together.
	const llmUsage: { inputTokens?: number; outputTokens?: number; at: Date }[] =
		[]
	const embeddingUsage: { at: Date }[] = []
	const llmProvider = (() => {
		try {
			// B1: MEMONGO_EXTRACTION_LLM=off makes the whole reasoning seam
			// degrade together (zero provider calls) so the benchmark can
			// ablate extraction without unsetting the enrichment env.
			const resolved = isExtractionLlmDisabled(process.env)
				? null
				: resolveEnrichmentProvider(process.env)
			// C-017: reasoning LLM calls land in the per-tenant cost ledger;
			// the same seam feeds contradiction/deduction/induction/dedup.
			return (
				resolved &&
				instrumentProviderCostSpend({
					db,
					prefix,
					agentId,
					provider: resolved,
					onUsage: (usage) => {
						if (
							[usage.inputTokens, usage.outputTokens].some(
								(count) =>
									count !== undefined &&
									Number.isFinite(count) &&
									Math.floor(count) > 0,
							)
						)
							llmUsage.push(usage)
					},
				})
			)
		} catch (err) {
			log.warn(
				`enrichment provider resolution failed; LLM-dependent phases degrade: ${err instanceof Error ? err.message : String(err)}`,
			)
			return null
		}
	})()
	const llmModel = process.env.MEMONGO_ENRICHMENT_MODEL?.trim() ?? ""

	const emptyResult: ConsolidationResult = {
		runId,
		agentId,
		eventsProcessed: 0,
		factsPromoted: 0,
		factsPruned: 0,
		conflictsResolved: 0,
		durationMs: 0,
		candidates: [],
	}

	// ===================================================================
	// Phase 0 — Gate (atomic lease claim + rate limiter)
	// ===================================================================
	//
	// One gate document per scope identity, claimed atomically with the same
	// lease pattern as claimMemoryJob: findOneAndUpdate + upsert keyed on the
	// deterministic gateKey. Two replicas can no longer both pass the gate —
	// the loser's upsert collides on uq_consolidation_runs_gate (E11000) —
	// and a crashed run's lease expires so the next claim self-heals (no more
	// status:"running" zombies). NOTE: legacy per-run docs (pre-lease, no
	// gateKey) are invisible to this gate, so the first run after upgrade is
	// not rate-limited by them; every phase is idempotent, so one extra run
	// per scope is harmless.
	const consolidationRuns = consolidationRunsCollection(db, prefix)
	const gateKey = consolidationGateKey({
		agentId,
		scope: options?.scope,
		scopeRef: options?.scopeRef,
	})
	const leaseMs = options?.leaseMs ?? DEFAULT_CONSOLIDATION_LEASE_MS
	const now = new Date()
	const claimableStartedBefore = new Date(now.getTime() - minIntervalMs)
	const leaseToken = randomUUID()
	const claimFilter: Document = {
		gateKey,
		$or: [
			{
				status: "completed",
				startedAt: { $lte: claimableStartedBefore },
			},
			// Pacing applies to completed runs only; a failed run is
			// immediately reclaimable.
			{ status: "failed" },
			{ status: "running", leaseExpiresAt: { $lte: now } },
			// Runs written before the lease existed are claimable immediately.
			{ status: "running", leaseExpiresAt: { $exists: false } },
		],
	}
	const claimPipeline: Document[] = [
		{
			$set: {
				gateKey,
				agentId,
				...(options?.scope ? { scope: options.scope } : {}),
				...(options?.scopeRef ? { scopeRef: options.scopeRef } : {}),
				runId,
				status: "running",
				// Server time ($$NOW) so cross-replica clock skew cannot shorten
				// or stretch the lease; the FILTER comparisons above use the
				// client clock (an $expr would defeat index bounds) and assume
				// NTP-synced replicas, same residual as the job queue.
				startedAt: "$$NOW",
				leaseToken,
				leaseExpiresAt: { $add: ["$$NOW", leaseMs] },
			},
		},
		{
			$unset: [
				"completedAt",
				"error",
				"durationMs",
				"eventsProcessed",
				"factsPromoted",
				"factsInferred",
				"factsPruned",
				"conflictsResolved",
			],
		},
	]
	try {
		await withFencedWrite({
			db,
			prefix,
			token: admission,
			fn: (session) =>
				consolidationRuns.findOneAndUpdate(claimFilter, claimPipeline, {
					upsert: true,
					returnDocument: "after",
					session,
				}),
		})
	} catch (err) {
		if (!isDuplicateKeyError(err)) {
			throw err
		}
		// The gate doc exists but is not claimable: either another replica
		// holds a live lease, or the last run finished inside minIntervalMs.
		// Re-read only to log the right reason.
		const gate = await consolidationRuns.findOne({ gateKey })
		if (gate?.status === "running") {
			log.info(
				`consolidation already running for agent=${agentId} (lease held)`,
			)
		} else {
			log.info(
				`consolidation rate-limited for agent=${agentId} (< ${minIntervalMs}ms since last run)`,
			)
		}
		emptyResult.durationMs = Date.now() - startMs
		return emptyResult
	}

	const runFencedWrite = <T>(fn: (session: ClientSession) => Promise<T>) =>
		withFencedWrite({
			db,
			prefix,
			token: admission,
			fn: async (session) => {
				await touchConsolidationLease({
					consolidationRuns,
					gateKey,
					runId,
					leaseToken,
					leaseMs,
					session,
				})
				return fn(session)
			},
		})
	const heartbeat = startConsolidationHeartbeat({
		leaseMs,
		renew: () => runFencedWrite(async () => {}),
	})
	const withConsolidationWrite = <T>(
		fn: (session: ClientSession) => Promise<T>,
	): Promise<T> =>
		heartbeat.enqueue(() => {
			heartbeat.throwIfFailed()
			return runFencedWrite(fn)
		})
	try {
		// Query un-dreamer-processed events
		const eventsCol = eventsCollection(db, prefix)
		const filter: Document = {
			agentId,
			dreamerProcessedAt: { $exists: false },
		}
		if (options?.scope) {
			filter.scope = options.scope
		}
		if (options?.scopeRef) {
			filter.scopeRef = options.scopeRef
		}
		if (options?.timeRange) {
			filter.timestamp = {
				$gte: options.timeRange.from,
				$lte: options.timeRange.to,
			}
		}

		let events = await eventsCol
			.find(filter)
			.sort({ timestamp: -1 })
			.limit(maxEvents)
			.toArray()

		// Post-query entity set filter: match events mentioning any of the entities
		if (options?.entitySet?.length) {
			const entityPattern = new RegExp(
				options.entitySet
					.map((e) => e.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
					.join("|"),
				"i",
			)
			events = events.filter(
				(e) => typeof e.body === "string" && entityPattern.test(e.body),
			)
		}

		if (events.length === 0) {
			const durationMs = Date.now() - startMs
			await heartbeat.stop()
			heartbeat.throwIfFailed()
			await finishConsolidationRun({
				consolidationRuns,
				gateKey,
				runId,
				leaseToken,
				update: {
					status: "completed",
					completedAt: new Date(),
					eventsProcessed: 0,
					factsPromoted: 0,
					factsPruned: 0,
					conflictsResolved: 0,
					durationMs,
				},
			})
			return { ...emptyResult, durationMs }
		}

		// ===================================================================
		// Phase 1 — Orient ($facet parallel stats)
		// ===================================================================

		let orientStats: DreamerOrientStats | undefined
		try {
			const orientFilter: Document = { agentId }
			if (options?.scope) orientFilter.scope = options.scope
			if (options?.scopeRef) orientFilter.scopeRef = options.scopeRef
			// Fleet audit P1-7: bound the orient scan to the window this run
			// actually processes. Unbounded, this $facet walked the agent's entire
			// event history on every consolidation, growing linearly forever, to
			// feed a log line. `events` is sorted timestamp-desc, so the last entry
			// is the oldest event in this run's batch.
			const oldestBatchTimestamp = events[events.length - 1]?.timestamp
			if (oldestBatchTimestamp instanceof Date) {
				orientFilter.timestamp = { $gte: oldestBatchTimestamp }
			}
			const [facetResult] = await eventsCol
				.aggregate([
					{ $match: orientFilter },
					{
						$facet: {
							unprocessed: [
								{
									$match: {
										dreamerProcessedAt: { $exists: false },
									},
								},
								{ $count: "n" },
							],
							byType: [{ $group: { _id: "$role", count: { $sum: 1 } } }],
							topTopics: [
								{
									$group: {
										_id: "$scope",
										lastActivity: { $max: "$timestamp" },
									},
								},
								{ $sort: { lastActivity: -1 } },
								{ $limit: 5 },
							],
						},
					},
				])
				.toArray()

			if (facetResult) {
				const unprocessedArr = facetResult.unprocessed as Array<{
					n: number
				}>
				const byTypeArr = facetResult.byType as Array<{
					_id: string
					count: number
				}>
				const topTopicsArr = facetResult.topTopics as Array<{
					_id: string
					lastActivity: Date
				}>

				orientStats = {
					unprocessedCount: unprocessedArr?.[0]?.n ?? 0,
					byRole: byTypeArr.map((r) => ({ role: r._id, count: r.count })),
					topScopes: topTopicsArr.map((t) => ({
						scope: t._id,
						lastActivity: t.lastActivity,
					})),
				}

				log.info(
					`orient: ${orientStats.unprocessedCount} unprocessed, ${orientStats.byRole.length} roles, ${orientStats.topScopes.length} top scopes`,
				)
			}
		} catch (err) {
			log.warn(
				`orient phase failed, continuing without stats: ${err instanceof Error ? err.message : String(err)}`,
			)
		}

		// ===================================================================
		// Score each event (unchanged scoring model)
		// ===================================================================

		// Get novelty scores (graceful degradation if mongot unavailable).
		// The limit matters: scanNovelty defaults to scoring only 10 events, and
		// this call used to omit it, so on a 100-event run 90 events came back
		// unscored and were dropped by the score gate. Ask for as many as we are
		// consolidating.
		const noveltyOpts = {
			limit: maxEvents,
			...(options?.scope ? { scope: options.scope } : {}),
			...(options?.scopeRef ? { scopeRef: options.scopeRef } : {}),
			...(options?.timeRange
				? {
						timeRange: {
							start: options.timeRange.from,
							end: options.timeRange.to,
						},
					}
				: {}),
		}
		const noveltyReport = await scanNovelty({
			db,
			prefix,
			agentId,
			options: noveltyOpts,
		})
		const noveltyByEventId = new Map<string, number>()
		for (const ne of noveltyReport.events) {
			noveltyByEventId.set(ne.eventId, ne.noveltyScore)
		}

		// Compute max access count for normalization
		const maxAccessCount = Math.max(
			1,
			...events.map((e) =>
				typeof e.accessCount === "number" ? e.accessCount : 0,
			),
		)

		const allCandidates: ConsolidationCandidate[] = events.map((event) => {
			const scoredNovelty = noveltyByEventId.get(event.eventId as string)
			const noveltyScore = scoredNovelty ?? UNSCORED_NOVELTY
			const importanceRaw =
				typeof event.importance === "number" &&
				Number.isFinite(event.importance)
					? Math.min(1, Math.max(0, event.importance))
					: 0.5
			// Retained as an observability field only, never as a gate. An event's
			// age describes how it should RANK today, not whether it is a durable
			// fact worth keeping: "I prefer tabs" is exactly as true 27 days later.
			const impDecay = computeImportanceDecay(
				event.importance as number | undefined,
				event.timestamp instanceof Date ? event.timestamp : undefined,
			)
			const rawAccess =
				typeof event.accessCount === "number" ? event.accessCount : 0
			const normalizedAccess = rawAccess / maxAccessCount

			const combinedScore =
				noveltyWeight * noveltyScore +
				importanceWeight * importanceRaw +
				accessWeight * normalizedAccess

			// Scope-isolation safety: source-event scope/scopeRef flow through the
			// candidate so the downstream similarity filter + canonical write can
			// never merge memories from different scopes, even if the caller
			// passed an incorrect or omitted ConsolidationOptions.scope.
			const eventScope =
				typeof event.scope === "string"
					? (event.scope as MemoryScope)
					: undefined
			const eventScopeRef =
				typeof event.scopeRef === "string" ? event.scopeRef : undefined

			return {
				eventId: event.eventId as string,
				body: (event.body as string) ?? "",
				timestamp:
					event.timestamp instanceof Date ? event.timestamp : new Date(0),
				noveltyScore,
				importance: importanceRaw,
				importanceDecay: impDecay,
				accessCount: rawAccess,
				combinedScore,
				...(eventScope ? { scope: eventScope } : {}),
				...(eventScopeRef ? { scopeRef: eventScopeRef } : {}),
			}
		})

		// Filter by minCombinedScore and sort descending
		const filteredCandidates = allCandidates
			// An explicit importance of 0 is a caller veto: never promote this.
			.filter((c) => (c.importance ?? 0.5) > 0)
			.filter((c) => c.combinedScore >= minCombinedScore)
			.toSorted((a, b) => b.combinedScore - a.combinedScore)

		// ===================================================================
		// Phase 2 — Extract + Decide (8 patterns + similarity-based ADD/NOOP)
		// ===================================================================

		const structuredCol = db.collection(`${prefix}structured_mem`)
		let factsPromoted = 0
		let factsInferred = 0
		let conflictsResolved = 0
		const failedEventIds = new Set<string>()
		let firstCandidateError: unknown

		for (const candidate of filteredCandidates) {
			// Scope-isolation safety: derive scope isolation from the CANDIDATE
			// event, not the caller's ConsolidationOptions. If the caller
			// passed an options.scope/scopeRef that disagrees with the
			// candidate's, log.warn and skip rather than silently producing
			// a cross-scope consolidation or aborting the whole run.
			const candidateScope = candidate.scope ?? options?.scope
			const candidateScopeRef = candidate.scopeRef ?? options?.scopeRef
			const benchmarkStrict = process.env.MEMONGO_BENCHMARK_STRICT
			const strictScopeMismatch =
				benchmarkStrict === "1" || benchmarkStrict?.toLowerCase() === "true"

			if (
				options?.scope &&
				candidate.scope &&
				options.scope !== candidate.scope
			) {
				const message = `consolidator scope mismatch: options.scope=${options.scope} but candidate.scope=${candidate.scope} (event=${candidate.eventId})`
				if (strictScopeMismatch) {
					throw new Error(message)
				}
				log.warn(`${message} - skipping to prevent cross-scope write`)
				failedEventIds.add(candidate.eventId)
				continue
			}
			if (
				options?.scopeRef &&
				candidate.scopeRef &&
				options.scopeRef !== candidate.scopeRef
			) {
				const message = `consolidator scopeRef mismatch: options.scopeRef=${options.scopeRef} but candidate.scopeRef=${candidate.scopeRef} (event=${candidate.eventId})`
				if (strictScopeMismatch) {
					throw new Error(message)
				}
				log.warn(`${message} - skipping to prevent cross-scope write`)
				failedEventIds.add(candidate.eventId)
				continue
			}

			try {
				// Injection-safety: injection / memory-poisoning defense.
				// Route injection-shaped candidates to memory_quarantine with
				// status="pending-review" BEFORE any pattern extraction or canonical
				// write. Tier-1 classifier is always on; tier-2 LLM is off by default.
				const injectionVerdict = classifyInjection({ content: candidate.body })
				if (injectionVerdict.classification === "injection-likely") {
					const quarantine = {
						quarantineId: randomUUID(),
						agentId,
						...(candidateScope ? { scope: candidateScope } : {}),
						...(candidateScopeRef ? { scopeRef: candidateScopeRef } : {}),
						content: candidate.body,
						classification: "injection-likely",
						tier: injectionVerdict.tier,
						matchedPatterns: injectionVerdict.matchedPatterns,
						status: "pending-review",
						createdAt: new Date(),
						sourceEventIds: [candidate.eventId],
					}
					await withConsolidationWrite((session) =>
						memoryQuarantineCollection(db, prefix).insertOne(quarantine, {
							session,
						}),
					)
					log.warn(
						`quarantined candidate event=${candidate.eventId}: injection patterns=${injectionVerdict.matchedPatterns.join(",")}`,
					)
					continue
				}

				const match = matchPatterns(candidate.body)
				if (!match) {
					continue
				}

				// Walk reasoning chain for provenance context (fire-and-forget)
				traceReasoningChain({
					db,
					prefix,
					agentId,
					factId: candidate.eventId,
					collection: "events",
				}).catch((err) => {
					log.warn(
						`reasoning chain trace failed for event=${candidate.eventId}: ${String(err)}`,
					)
				})

				// Check for conflicts with existing structured memory
				const conflicted = await hasConflict({
					db,
					prefix,
					agentId,
					type: match.type,
					key: match.key,
					scope: candidateScope,
					scopeRef: candidateScopeRef,
				})

				let preparedContradictions: PreparedContradictionInvalidation[] = []
				if (conflicted) {
					// P4.4.2 — contradiction wiring: resolve instead of skip (default
					// ON). Prepare retirement before the normal candidate filters;
					// commit it with the surviving candidate so the
					// surviving candidate is re-evaluated by the normal pipeline.
					// Flag off, no LLM configured, or the candidate itself being the
					// loser all preserve the historical skip exactly.
					let conflictResolved = false
					if (resolveContradictionsEnabled && llmProvider) {
						preparedContradictions = await prepareConflictedCandidateResolution(
							{
								db,
								prefix,
								provider: llmProvider,
								model: llmModel,
								agentId,
								candidate: {
									key: match.key,
									value: match.value,
									...(candidateScope ? { scope: candidateScope } : {}),
									...(candidateScopeRef ? { scopeRef: candidateScopeRef } : {}),
								},
								runId,
								admission,
							},
						)
						conflictResolved = preparedContradictions.length > 0
						if (conflictResolved) {
							log.info(
								`contradiction resolved for ${match.type}/${match.key} from event=${candidate.eventId}: prepared ${preparedContradictions.length} contradicted fact(s), re-evaluating candidate`,
							)
						}
					}
					conflictsResolved++
					if (!conflictResolved) {
						log.warn(
							`conflict detected for ${match.type}/${match.key} from event=${candidate.eventId}, skipping promotion`,
						)
						continue
					}
				}

				// Similarity check via $vectorSearch — decide ADD vs NOOP.
				// Scope is isolated to the SAME scope as the candidate so two
				// events in different scopes can never be merged by the dreamer.
				const simFilter: Document = { agentId, state: { $ne: "invalidated" } }
				if (candidateScope) simFilter.scope = candidateScope
				if (candidateScopeRef) simFilter.scopeRef = candidateScopeRef

				let decision: "ADD" | "NOOP" = "ADD"
				try {
					const similarResults = await structuredCol
						.aggregate([
							{
								$vectorSearch: {
									index: `${prefix}structured_mem_vector`,
									path: "value",
									query: { text: candidate.body },
									model: INDEX_AUTOEMBED_MODEL,
									numCandidates: 100,
									limit: 5,
									filter: simFilter,
								},
							},
							{ $addFields: { score: { $meta: "vectorSearchScore" } } },
							// P4.4.1 (B1): an expired lookalike must not force a NOOP —
							// expiresAt is not a serving-index filter field, so exclude
							// post-ANN until the TTL sweep removes the doc.
							{
								$match: {
									...simFilter,
									"provenance.origin": { $ne: "llm-inference" },
									...buildUnexpiredClause(),
								},
							},
							{ $limit: 5 },
						])
						.toArray()
					// C-017: the executed probe embedded candidate.body server-side
					// (autoEmbed) — bill one consolidation embedding unit.
					embeddingUsage.push({ at: new Date() })

					if (similarResults.length > 0) {
						// Check the top result's similarity score
						const topScore =
							typeof similarResults[0].score === "number"
								? similarResults[0].score
								: 0
						if (topScore > SIMILARITY_THRESHOLD_NOOP) {
							decision = "NOOP"
							log.info(
								`NOOP: similar memory found for event=${candidate.eventId} (score=${topScore.toFixed(3)})`,
							)
						}
					}
				} catch (err) {
					// Graceful degradation: if $vectorSearch fails, fall back to ADD
					log.warn(
						`similarity check failed for event=${candidate.eventId}, defaulting to ADD: ${err instanceof Error ? err.message : String(err)}`,
					)
				}

				if (decision === "NOOP") {
					continue
				}

				// Phase 3.7 — Quality filter: skip memories derivable from code/context
				if (isDerivableFromContext(match.value)) {
					log.info(
						`quality-filter: skipping derivable memory for event=${candidate.eventId}: "${match.value.slice(0, 80)}"`,
					)
					continue
				}

				// Promote to structured memory (ADD) — preserve scope isolation by
				// writing the CANDIDATE's scope/scopeRef, not the options. Phase 2
				// Scope-isolation safety: since the source event is what generated the
				// structured fact, the fact inherits the source's scope. If the
				// caller's options disagreed with the candidate, we already threw
				// above.
				await withConsolidationWrite(async (session) => {
					const written = await writeStructuredMemory({
						db,
						prefix,
						entry: {
							type: match.type,
							key: match.key,
							value: match.value,
							agentId,
							source: "agent",
							confidence: CONFIDENCE_BY_SOURCE.agent_extracted,
							sourceAgent: { id: agentId, name: "dreamer", runId },
							sourceEventIds: [candidate.eventId],
							...(candidateScope
								? {
										scope: candidateScope as
											| "session"
											| "user"
											| "agent"
											| "workspace"
											| "tenant"
											| "global",
									}
								: {}),
							...(candidateScopeRef ? { scopeRef: candidateScopeRef } : {}),
						},
						embeddingMode: "automated",
						session,
						transactionalSideEffects: "inline",
					})
					if (preparedContradictions.length === 0) return
					if (written.quarantined)
						throw new MemoryQuarantinedWriteError(
							written.id,
							written.matchedPatterns ?? [],
						)
					const scope = (candidateScope ?? "agent") as MemoryScope
					const scopeRef = candidateScopeRef ?? `agent:${agentId}`
					const source = await structuredCol.findOne(
						{
							agentId,
							scope,
							scopeRef,
							type: match.type,
							key: match.key,
							value: match.value,
							state: "active",
							...buildCurrentValidityClause(),
							...buildUnexpiredClause(),
						},
						{ session },
					)
					if (
						!source ||
						!Number.isInteger(source.revision) ||
						source.revision < 1
					)
						throw new Error(
							"contradiction candidate was not persisted as an active source",
						)
					const retired = await persistPreparedContradictionInvalidations({
						db,
						prefix,
						agentId,
						scope,
						scopeRef,
						session,
						runId,
						prepared: preparedContradictions.map((decision) => ({
							...decision,
							newFact: { key: match.key, value: match.value, revision: 0 },
						})),
					})
					if (retired !== preparedContradictions.length)
						throw new Error(
							"prepared contradiction targets changed before candidate commit",
						)
				})

				factsPromoted++
			} catch (err) {
				if (
					isErasureGateConflictError(err) ||
					isMalformedGateError(err) ||
					err instanceof ConsolidationLeaseLostError
				)
					throw err
				failedEventIds.add(candidate.eventId)
				firstCandidateError ??= err
				log.warn(
					`candidate processing failed for event=${candidate.eventId}: ${err instanceof Error ? err.message : String(err)}`,
				)
			}
		}

		// ===================================================================
		// Phase 2.5 — Entity extraction for all processed events
		// The graph projection is a required durable effect of consolidation: a
		// failed extraction fails its event through the same
		// failedEventIds/firstCandidateError path as candidate failures, so the
		// event stays unacknowledged, the run records failed, and the caller/job
		// retries. Successful peers remain acknowledged; a failed event rolls back.
		// ===================================================================

		const recordGraphDiagnostics = async (
			status: "ok" | "failed",
			diagnostics: {
				durationMs: number
				extractionMethod: string
				entitiesExtracted: number
				relationsCreated: number
			},
		) => {
			try {
				await withConsolidationWrite(async (session) => {
					await recordProjectionRun({
						db,
						prefix,
						session,
						run: {
							agentId,
							projectionType: "entities",
							status,
							itemsProjected: diagnostics.entitiesExtracted,
							durationMs: diagnostics.durationMs,
						},
					})
					await recordProjectionRun({
						db,
						prefix,
						session,
						run: {
							agentId,
							projectionType: "relations",
							status,
							itemsProjected: diagnostics.relationsCreated,
							durationMs: diagnostics.durationMs,
						},
					})
					if (status === "failed" || diagnostics.entitiesExtracted > 0) {
						await emitTelemetry(
							db,
							prefix,
							{
								meta: { agentId, operation: "entity-extraction" },
								durationMs: diagnostics.durationMs,
								ok: status === "ok",
								extractionMethod: diagnostics.extractionMethod,
								entitiesExtracted: diagnostics.entitiesExtracted,
							},
							{ session },
						)
					}
				})
			} catch (err) {
				if (
					isErasureGateConflictError(err) ||
					isMalformedGateError(err) ||
					err instanceof ConsolidationLeaseLostError
				)
					throw err
				log.warn(
					"entity extraction diagnostics failed",
					settledFailureMeta(err, ""),
				)
			}
		}
		try {
			let extractionFailures = 0
			for (const event of events) {
				const extractionStartMs = Date.now()
				let diagnostics: EntityExtractionDiagnostics
				try {
					const extracted = await withConsolidationWrite((session) =>
						extractAndUpsertEntities({
							db,
							prefix,
							agentId,
							eventContent: typeof event.body === "string" ? event.body : "",
							scope:
								(options?.scope as
									| "session"
									| "user"
									| "agent"
									| "workspace"
									| "tenant"
									| "global") ??
								(typeof event.scope === "string"
									? (event.scope as
											| "session"
											| "user"
											| "agent"
											| "workspace"
											| "tenant"
											| "global")
									: "agent"),
							scopeRef:
								options?.scopeRef ??
								(typeof event.scopeRef === "string"
									? event.scopeRef
									: undefined),
							sourceEventId: event.eventId as string,
							role:
								typeof event.role === "string"
									? (event.role as "user" | "assistant" | "system" | "tool")
									: undefined,
							session,
							recordRun: false,
						}),
					)
					diagnostics = extracted.diagnostics as EntityExtractionDiagnostics
				} catch (err) {
					if (
						isErasureGateConflictError(err) ||
						isMalformedGateError(err) ||
						err instanceof ConsolidationLeaseLostError
					)
						throw err
					await recordGraphDiagnostics("failed", {
						durationMs: Date.now() - extractionStartMs,
						extractionMethod: "regex",
						entitiesExtracted: 0,
						relationsCreated: 0,
					})
					extractionFailures++
					failedEventIds.add(event.eventId as string)
					firstCandidateError ??= err
					continue
				}
				await recordGraphDiagnostics("ok", diagnostics)
			}
			if (extractionFailures > 0) {
				log.warn(
					`entity extraction failed for ${extractionFailures} of ${events.length} events in dreamer run=${runId}; failed events stay unacknowledged`,
				)
			}
			log.info(
				`entity extraction completed for ${events.length - extractionFailures} of ${events.length} events in dreamer run=${runId}`,
			)
		} catch (err) {
			if (
				isErasureGateConflictError(err) ||
				isMalformedGateError(err) ||
				err instanceof ConsolidationLeaseLostError
			)
				throw err
			for (const event of events) failedEventIds.add(event.eventId as string)
			firstCandidateError ??= err
			log.warn(
				`entity extraction phase failed; events left unacknowledged: ${err instanceof Error ? err.message : String(err)}`,
			)
		}

		// ===================================================================
		// Phase 3 — Deduction / Phase 4 — Induction (issue #31)
		// Derive NEW facts from the durable facts in this scope: deduction (strict
		// entailment) and induction (probable generalization). Inferred facts are
		// written flagged (origin "llm-inference", low confidence, reinforcementCount
		// 0) so they are distinguishable from observed facts and never treated as
		// fully corroborated. Degrades to the historical skip when no LLM is set.
		// ===================================================================

		if (!llmProvider) {
			log.info("deduction phase: no LLM configured, skipping")
			log.info("induction phase: no LLM configured, skipping")
		} else {
			try {
				const reasoningModel = llmModel
				// Reason over OBSERVED facts only: exclude prior inferences so a run
				// cannot compound inference-on-inference and erode grounding.
				const factFilter: Document = {
					agentId,
					type: "fact",
					state: { $ne: "invalidated" },
					"provenance.origin": { $ne: "llm-inference" },
					// P4.4.1 (B1): expired facts read as gone — they must not feed
					// deduction/induction ahead of the TTL sweep.
					...buildUnexpiredClause(),
				}
				if (options?.scope) factFilter.scope = options.scope
				if (options?.scopeRef) factFilter.scopeRef = options.scopeRef

				const factDocs = await structuredCol
					.find(factFilter)
					.sort({ updatedAt: -1 })
					.limit(REASONING_MAX_FACTS)
					.toArray()

				// CRITICAL: never mix scopes. Phase 2 isolates each fact under its
				// source scope, so a single run legitimately spans many scopes/tenants.
				// Group facts by (scope, scopeRef) and reason strictly within a group,
				// writing each inferred fact back under that same scope — otherwise an
				// inference derived from tenant B's data could surface to tenant A.
				const groups = new Map<
					string,
					{ scope?: MemoryScope; scopeRef?: string; values: string[] }
				>()
				for (const doc of factDocs) {
					const value = typeof doc.value === "string" ? doc.value : ""
					if (!value) continue
					const scope =
						typeof doc.scope === "string"
							? (doc.scope as MemoryScope)
							: undefined
					const scopeRef =
						typeof doc.scopeRef === "string" ? doc.scopeRef : undefined
					const groupKey = `${scope ?? ""}\u0000${scopeRef ?? ""}`
					const group = groups.get(groupKey) ?? { scope, scopeRef, values: [] }
					group.values.push(value)
					groups.set(groupKey, group)
				}

				for (const group of groups.values()) {
					if (group.values.length < 2) continue
					const [deduced, induced] = await Promise.all([
						deduceFactsFromMemories({
							provider: llmProvider,
							model: reasoningModel,
							facts: group.values,
						}),
						induceFactsFromMemories({
							provider: llmProvider,
							model: reasoningModel,
							facts: group.values,
						}),
					])

					const observed = group.values.map((value) => value.toLowerCase())
					const seen = new Set(observed)
					// Skip an inference that merely restates an observed fact. Observed
					// values are full event bodies while inferences are concise, so exact
					// equality is not enough — reject on substring overlap either way.
					// (A future improvement is $vectorSearch similarity like Phase 2.)
					const restatesObserved = (candidate: string) =>
						observed.some(
							(value) => value.includes(candidate) || candidate.includes(value),
						)

					for (const reasoned of [...deduced, ...induced]) {
						const key = reasoned.value.toLowerCase()
						if (seen.has(key) || restatesObserved(key)) continue
						seen.add(key)
						const entry = buildInferredMemoryEntry({
							reasoned,
							agentId,
							scope: group.scope,
							scopeRef: group.scopeRef,
							runId,
						})
						try {
							const result = await withConsolidationWrite((session) =>
								writeStructuredMemory({
									db,
									prefix,
									entry,
									embeddingMode: "automated",
									session,
									transactionalSideEffects: "inline",
								}),
							)
							if (result.upserted) factsInferred++
						} catch (err) {
							if (
								isErasureGateConflictError(err) ||
								isMalformedGateError(err) ||
								err instanceof ConsolidationLeaseLostError
							)
								throw err
							log.warn(
								`inferred fact write failed during consolidation: ${err instanceof Error ? err.message : String(err)}`,
							)
						}
					}
				}
				if (factsInferred > 0) {
					log.info(
						`reasoning phases inferred ${factsInferred} new fact(s) for agent=${agentId}`,
					)
				}
			} catch (err) {
				if (
					isErasureGateConflictError(err) ||
					isMalformedGateError(err) ||
					err instanceof ConsolidationLeaseLostError
				)
					throw err
				log.warn(
					`consolidation reasoning phases failed (non-blocking): ${err instanceof Error ? err.message : String(err)}`,
				)
			}
		}

		// ===================================================================
		// Phase 4.6 — LLM-adjudicated dedup (P4.4.3, flag-gated default OFF)
		//
		// Optional phase between the NOOP gate (0.85) and prune: fact pairs in
		// the similarity band [0.75, 0.92] get a 1-by-1 LLM merge verdict. Below
		// the band the pair is distinct enough that merging is never right;
		// above it the deterministic prune already handles the pair, so an LLM
		// call would be wasted. On MERGE the kept (newer) fact gets the
		// synthesized union text and the union of sourceEventIds as the
		// proof-count analog (capped at MAX_SOURCE_EVENT_IDS); the merged-away
		// (older) fact is invalidated via the same mechanism prune uses. LLM
		// failure or malformed JSON is treated as no-merge — never throws.
		// ===================================================================

		let factsMerged = 0
		if (llmDedupEnabled) {
			if (!llmProvider) {
				log.info("llm-dedup phase: no LLM configured, skipping")
			} else {
				try {
					const dedupFilter: Document = {
						agentId,
						state: { $ne: "invalidated" },
						// P4.4.1 (B1): expired facts read as gone — exclude them from
						// merge candidacy ahead of the TTL sweep.
						...buildUnexpiredClause(),
					}
					if (options?.scope) dedupFilter.scope = options.scope
					if (options?.scopeRef) dedupFilter.scopeRef = options.scopeRef

					const recentFacts = await structuredCol
						.find(dedupFilter)
						.sort({ updatedAt: -1 })
						.limit(50)
						.toArray()

					const retiredIds = new Set<string>()
					const adjudicatedPairs = new Set<string>()

					for (const fact of recentFacts) {
						if (typeof fact.value !== "string" || !fact.value) continue
						const factId = String(fact._id)
						// Skip facts merged away by a prior iteration in this loop
						if (retiredIds.has(factId)) continue

						try {
							const similars = await structuredCol
								.aggregate([
									{
										$vectorSearch: {
											index: `${prefix}structured_mem_vector`,
											path: "value",
											query: { text: fact.value },
											model: INDEX_AUTOEMBED_MODEL,
											numCandidates: 80,
											limit: 4, // +1 to account for self-match consuming a slot
											// Scope from the FACT, never from options — same
											// tenant-isolation invariant prune enforces.
											filter: {
												agentId,
												...(fact.scope ? { scope: fact.scope } : {}),
												...(fact.scopeRef ? { scopeRef: fact.scopeRef } : {}),
											},
										},
									},
									{ $addFields: { score: { $meta: "vectorSearchScore" } } },
									{
										$match: {
											_id: { $ne: fact._id },
											state: { $ne: "invalidated" },
											// P4.4.1 (B1): expired docs read as gone — never merge
											// against them (post-ANN; the serving index has no
											// expiresAt filter field).
											...buildUnexpiredClause(),
										},
									},
								])
								.toArray()
							// C-017: the executed probe embedded fact.value server-side
							// (autoEmbed) — bill one consolidation embedding unit.
							embeddingUsage.push({ at: new Date() })

							for (const dup of similars) {
								// Tenant floor, belt-and-suspenders: never merge across
								// scope/scopeRef, same as prune.
								if (
									dup.scope !== fact.scope ||
									dup.scopeRef !== fact.scopeRef
								) {
									continue
								}
								const dupId = String(dup._id)
								if (retiredIds.has(dupId)) continue
								const dupScore = typeof dup.score === "number" ? dup.score : 0
								if (
									dupScore < LLM_DEDUP_MIN_SIMILARITY ||
									dupScore > LLM_DEDUP_MAX_SIMILARITY
								) {
									continue
								}
								if (
									(fact.provenance?.origin === "llm-inference") !==
									(dup.provenance?.origin === "llm-inference")
								)
									continue
								// Adjudicate each unordered pair at most once per run.
								const pairKey = [factId, dupId].sort().join(" ")
								if (adjudicatedPairs.has(pairKey)) continue
								adjudicatedPairs.add(pairKey)

								const verdict = await adjudicateFactMerge({
									provider: llmProvider,
									model: llmModel,
									factA: {
										key: typeof fact.key === "string" ? fact.key : "",
										value: fact.value,
									},
									factB: {
										key: typeof dup.key === "string" ? dup.key : "",
										value: String(dup.value ?? ""),
									},
								})
								if (verdict.verdict !== "MERGE" || !verdict.mergedValue) {
									continue
								}

								// Same winner rule as prune: the NEWER fact survives, the
								// older one is merged away.
								const dupUpdated =
									dup.updatedAt instanceof Date ? dup.updatedAt : new Date(0)
								const factUpdated =
									fact.updatedAt instanceof Date ? fact.updatedAt : new Date(0)
								const keptDoc = dupUpdated > factUpdated ? dup : fact
								const mergedAwayDoc = dupUpdated > factUpdated ? fact : dup

								if (
									[keptDoc, mergedAwayDoc].some(
										(doc) =>
											doc._id === undefined ||
											doc.agentId !== agentId ||
											!isMemoryScopeValue(doc.scope) ||
											typeof doc.scopeRef !== "string" ||
											!doc.scopeRef.trim() ||
											typeof doc.type !== "string" ||
											!doc.type.trim() ||
											typeof doc.key !== "string" ||
											!doc.key.trim() ||
											typeof doc.value !== "string" ||
											!doc.value.trim() ||
											!Number.isInteger(doc.revision) ||
											doc.revision < 1 ||
											doc.state !== "active",
									)
								)
									continue
								const pair = [keptDoc, mergedAwayDoc].map((doc) => ({
									_id: doc._id,
									agentId,
									scope: doc.scope,
									scopeRef: doc.scopeRef,
									type: doc.type,
									key: doc.key,
									revision: doc.revision,
									state: "active",
								}))
								try {
									await withConsolidationWrite(async (session) => {
										for (const filter of pair) {
											if (!(await structuredCol.findOne(filter, { session })))
												throw new MemoryLifecycleConflictError({
													reason: "stale-revision",
													expectedRevision: filter.revision,
													actualRevision: 0,
												})
										}
										const updated = await writeStructuredMemory({
											db,
											prefix,
											entry: {
												...structuredEntryFromDoc(keptDoc, {
													value: verdict.mergedValue,
													sourceEventIds: foldSourceEventIds(
														keptDoc.sourceEventIds,
														mergedAwayDoc.sourceEventIds,
													),
												}),
												state: "active",
											},
											embeddingMode: "automated",
											session,
											transactionalSideEffects: "inline",
											expectedId: keptDoc._id,
											expectedRevision: keptDoc.revision,
											actorRole: "system",
											mutationMeta: { reason: "llm-dedup-merge", runId },
										})
										if (updated.quarantined)
											throw new MemoryQuarantinedWriteError(
												updated.id,
												updated.matchedPatterns ?? [],
											)
										const handle = {
											family: "structured" as const,
											id: [
												"structured",
												mergedAwayDoc.scope,
												encodeURIComponent(mergedAwayDoc.scopeRef),
												mergedAwayDoc.type,
												mergedAwayDoc.key,
											].join(":"),
											agentId,
											scope: mergedAwayDoc.scope,
											scopeRef: mergedAwayDoc.scopeRef,
											revision: mergedAwayDoc.revision,
											state: "active" as const,
											structured: {
												type: mergedAwayDoc.type,
												key: mergedAwayDoc.key,
											},
										}
										const retired = await invalidateStructuredMemoryByHandle({
											db,
											prefix,
											handle,
											expectedId: mergedAwayDoc._id,
											session,
											transactionalSideEffects: "inline",
											actorRole: "system",
											invalidatedBy: { reason: "llm-dedup-merge", runId },
										})
										if (
											!retired ||
											retired.handle.state !== "invalidated" ||
											retired.handle.revision !== handle.revision + 1
										)
											throw new MemoryLifecycleConflictError({
												reason: "stale-revision",
												expectedRevision: handle.revision,
												actualRevision: retired?.handle.revision ?? 0,
											})
									})
								} catch (err) {
									if (
										isErasureGateConflictError(err) ||
										isMalformedGateError(err) ||
										err instanceof ConsolidationLeaseLostError
									)
										throw err
									log.warn(
										`llm-dedup merge write failed for fact=${factId}: ${err instanceof Error ? err.message : String(err)}`,
									)
									continue
								}
								retiredIds.add(String(mergedAwayDoc._id))
								factsMerged++
								log.info(
									`llm-dedup merged ${String(mergedAwayDoc._id)} into ${String(keptDoc._id)} (score=${dupScore.toFixed(3)})`,
								)
								break
							}
						} catch (err) {
							if (
								isErasureGateConflictError(err) ||
								isMalformedGateError(err) ||
								err instanceof ConsolidationLeaseLostError
							)
								throw err
							// Graceful degradation: a failed pair is a no-merge, never fatal
							log.warn(
								`llm-dedup adjudication failed for fact=${factId}: ${err instanceof Error ? err.message : String(err)}`,
							)
						}
					}
				} catch (err) {
					if (
						isErasureGateConflictError(err) ||
						isMalformedGateError(err) ||
						err instanceof ConsolidationLeaseLostError
					)
						throw err
					log.warn(
						`llm-dedup phase failed: ${err instanceof Error ? err.message : String(err)}`,
					)
				}
			}
		}

		// ===================================================================
		// Phase 5 — Prune + Profile (near-duplicate merge)
		// ===================================================================

		let prunedCount = 0
		try {
			// Find recently promoted facts and check for near-duplicates
			// Use $vectorSearch to find pairs with similarity > 0.92
			// Scope-isolated: only prune within the same scope
			const pruneFilter: Document = {
				agentId,
				state: { $ne: "invalidated" },
				// P4.4.1 (B1): expired facts read as gone — they must not drive
				// near-duplicate invalidation of live facts.
				...buildUnexpiredClause(),
			}
			if (options?.scope) pruneFilter.scope = options.scope
			if (options?.scopeRef) pruneFilter.scopeRef = options.scopeRef

			const recentFacts = await structuredCol
				.find(pruneFilter)
				.sort({ updatedAt: -1 })
				.limit(50)
				.toArray()

			const invalidatedIds = new Set<string>()

			for (const fact of recentFacts) {
				if (typeof fact.value !== "string" || !fact.value) continue
				// Skip facts invalidated by a prior iteration in this loop
				if (invalidatedIds.has(String(fact._id))) continue

				try {
					const duplicates = await structuredCol
						.aggregate([
							{
								$vectorSearch: {
									index: `${prefix}structured_mem_vector`,
									path: "value",
									query: { text: fact.value },
									model: INDEX_AUTOEMBED_MODEL,
									numCandidates: 80,
									limit: 4, // +1 to account for self-match consuming a slot
									// Scope from the FACT, never from options: with options.scope
									// absent (master key, MCP), an agentId-only filter would let
									// the invalidation below destroy another tenant's fact. Same
									// invariant Phases 2-4 enforce from the document's own scope.
									filter: {
										agentId,
										...(fact.scope ? { scope: fact.scope } : {}),
										...(fact.scopeRef ? { scopeRef: fact.scopeRef } : {}),
									},
								},
							},
							{ $addFields: { score: { $meta: "vectorSearchScore" } } },
							{
								$match: {
									_id: { $ne: fact._id },
									state: { $ne: "invalidated" },
									// P4.4.1 (B1): expired docs read as gone — never prune a
									// live fact against one (post-ANN; the serving index has
									// no expiresAt filter field).
									...buildUnexpiredClause(),
								},
							},
						])
						.toArray()
					// C-017: the executed probe embedded fact.value server-side
					// (autoEmbed) — bill one consolidation embedding unit.
					embeddingUsage.push({ at: new Date() })

					for (const dup of duplicates) {
						// Tenant floor, belt-and-suspenders: even if the store returns a
						// cross-scope doc, never invalidate across scope/scopeRef.
						if (dup.scope !== fact.scope || dup.scopeRef !== fact.scopeRef) {
							continue
						}
						if (
							(fact.provenance?.origin === "llm-inference") !==
							(dup.provenance?.origin === "llm-inference")
						)
							continue
						const dupScore = typeof dup.score === "number" ? dup.score : 0
						if (dupScore > SIMILARITY_THRESHOLD_PRUNE) {
							// Invalidate the older duplicate
							const dupUpdated =
								dup.updatedAt instanceof Date ? dup.updatedAt : new Date(0)
							const factUpdated =
								fact.updatedAt instanceof Date ? fact.updatedAt : new Date(0)
							const olderDoc = dupUpdated < factUpdated ? dup : fact

							if (
								olderDoc._id === undefined ||
								olderDoc.agentId !== agentId ||
								typeof olderDoc.scope !== "string" ||
								!isMemoryScopeValue(olderDoc.scope) ||
								typeof olderDoc.scopeRef !== "string" ||
								!olderDoc.scopeRef ||
								typeof olderDoc.type !== "string" ||
								!olderDoc.type ||
								typeof olderDoc.key !== "string" ||
								!olderDoc.key ||
								!Number.isInteger(olderDoc.revision) ||
								olderDoc.revision < 1
							)
								continue
							const handle = {
								family: "structured" as const,
								id: [
									"structured",
									agentId,
									olderDoc.scope,
									olderDoc.scopeRef,
									olderDoc.type,
									olderDoc.key,
								]
									.map(encodeURIComponent)
									.join(":"),
								agentId,
								scope: olderDoc.scope,
								scopeRef: olderDoc.scopeRef,
								revision: olderDoc.revision as number,
								state: "active" as const,
								structured: { type: olderDoc.type, key: olderDoc.key },
							}
							let retired: Awaited<
								ReturnType<typeof invalidateStructuredMemoryByHandle>
							>
							try {
								retired = await withConsolidationWrite((session) =>
									invalidateStructuredMemoryByHandle({
										db,
										prefix,
										handle,
										expectedId: olderDoc._id,
										session,
										transactionalSideEffects: "inline",
										invalidatedBy: { reason: "near-duplicate-prune", runId },
										actorRole: "system",
									}),
								)
							} catch (err) {
								if (err instanceof MemoryLifecycleConflictError) continue
								throw err
							}
							if (
								!retired ||
								retired.handle.state !== "invalidated" ||
								retired.handle.revision !== handle.revision + 1
							)
								continue
							invalidatedIds.add(String(olderDoc._id))
							prunedCount++
							log.info(
								`pruned near-duplicate: ${String(olderDoc._id)} (score=${dupScore.toFixed(3)})`,
							)
							if (olderDoc === fact) break
						}
					}
				} catch (err) {
					if (
						isErasureGateConflictError(err) ||
						isMalformedGateError(err) ||
						err instanceof ConsolidationLeaseLostError
					)
						throw err
					// Graceful degradation: if $vectorSearch fails during prune, skip
					log.warn(
						`prune similarity check failed for fact=${String(fact._id)}: ${err instanceof Error ? err.message : String(err)}`,
					)
				}
			}
		} catch (err) {
			if (
				isErasureGateConflictError(err) ||
				isMalformedGateError(err) ||
				err instanceof ConsolidationLeaseLostError
			)
				throw err
			log.warn(
				`prune phase failed: ${err instanceof Error ? err.message : String(err)}`,
			)
		}

		// ===================================================================
		// Acknowledge only events whose candidate processing completed durably.
		// ===================================================================

		// Keep provider/search side effects outside the retryable transaction.
		// Erasure takes precedence over retaining spend from a stale run.
		const usage = llmUsage.slice()
		const embeds = embeddingUsage.slice()
		if (usage.length > 0 || embeds.length > 0) {
			await heartbeat.enqueue(() =>
				withFencedWrite({
					db,
					prefix,
					token: admission,
					fn: async (session) => {
						for (const spend of usage) {
							await recordLLMSpendInSession({
								db,
								prefix,
								agentId,
								spend,
								at: spend.at,
								session,
							})
						}
						for (const spend of embeds) {
							await recordEmbeddingSpendInSession({
								db,
								prefix,
								agentId,
								kind: "consolidation",
								units: 1,
								at: spend.at,
								session,
							})
						}
					},
				}),
			)
			llmUsage.splice(0, usage.length)
			embeddingUsage.splice(0, embeds.length)
		}

		const successfulEventIds = events
			.map((event) => event.eventId as string)
			.filter((eventId) => !failedEventIds.has(eventId))
		if (successfulEventIds.length > 0) {
			await withConsolidationWrite((session) =>
				markEventsDreamerProcessed({
					db,
					prefix,
					eventIds: successfulEventIds,
					runId,
					agentId,
					session,
				}),
			)
		}

		// ===================================================================
		// Record run completion
		// ===================================================================

		const durationMs = Date.now() - startMs

		await heartbeat.stop()
		heartbeat.throwIfFailed()
		await finishConsolidationRun({
			consolidationRuns,
			gateKey,
			runId,
			leaseToken,
			update: {
				status: firstCandidateError ? "failed" : "completed",
				completedAt: new Date(),
				eventsProcessed: successfulEventIds.length,
				factsPromoted,
				factsInferred,
				factsMerged,
				factsPruned: prunedCount,
				conflictsResolved,
				durationMs,
				...(firstCandidateError
					? {
							error:
								firstCandidateError instanceof Error
									? firstCandidateError.message
									: String(firstCandidateError),
						}
					: {}),
			},
		})

		if (firstCandidateError) {
			throw firstCandidateError
		}

		log.info(
			`consolidation run=${runId} completed: ${successfulEventIds.length} events processed, ${factsPromoted} facts promoted, ${prunedCount} pruned, ${durationMs}ms`,
		)

		// ===================================================================
		// Return result
		// ===================================================================

		return {
			runId,
			agentId,
			eventsProcessed: successfulEventIds.length,
			factsPromoted,
			factsInferred,
			factsMerged,
			factsPruned: prunedCount,
			conflictsResolved,
			durationMs,
			candidates: filteredCandidates,
			orientStats,
			prunedCount,
		}
	} finally {
		await heartbeat.stop()
	}
}
