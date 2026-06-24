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
import type { Db, Document } from "mongodb"
import { createSubsystemLogger, type MemoryScope } from "@memongo/lib"
import { scanNovelty } from "./mongodb-novelty.js"
import { traceReasoningChain } from "./mongodb-reasoning-chain.js"
import { computeImportanceDecay } from "./mongodb-trust.js"
import {
	eventsCollection,
	consolidationRunsCollection,
	memoryQuarantineCollection,
} from "./mongodb-schema.js"
import { classifyInjection } from "./mongodb-injection-classifier.js"
import { extractAndUpsertEntities } from "./mongodb-graph.js"
import {
	writeStructuredMemory,
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

const DEFAULT_MAX_EVENTS = 100
const DEFAULT_MIN_COMBINED_SCORE = 0.15 // Minimum combined score for Dreamer candidates (novelty + importance + access all live)
const DEFAULT_MIN_INTERVAL_MS = 3_600_000 // 1 hour
const DEFAULT_NOVELTY_WEIGHT = 0.4
const DEFAULT_IMPORTANCE_WEIGHT = 0.3
const DEFAULT_ACCESS_WEIGHT = 0.3

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
		type: "decision",
		pattern: /\b(?:I\s+(?:decided|chose|picked|selected|went with))\s+(.+)/i,
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
		pattern: /\b(?:TODO|FIXME|need\s+to|have\s+to|must|should)\s*:?\s+(.+)/i,
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
function matchPatterns(body: string): PatternMatch | null {
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
}): Promise<number> {
	const { db, prefix, eventIds, runId } = params
	if (eventIds.length === 0) {
		return 0
	}
	const collection = eventsCollection(db, prefix)
	const result = await collection.updateMany(
		{ eventId: { $in: eventIds } },
		{
			$set: {
				dreamerProcessedAt: new Date(),
				dreamerRunId: runId,
			},
		},
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
}): Promise<boolean> {
	const { db, prefix, agentId, type, key } = params
	const structuredCol = db.collection(`${prefix}structured_mem`)
	const existing = await structuredCol.findOne({
		agentId,
		type,
		key,
		state: { $ne: "invalidated" },
	})

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

export async function consolidateMemory(params: {
	db: Db
	prefix: string
	agentId: string
	options?: ConsolidationOptions
}): Promise<ConsolidationResult> {
	const { db, prefix, agentId, options } = params
	const startMs = Date.now()
	const runId = randomUUID()

	const maxEvents = options?.maxEvents ?? DEFAULT_MAX_EVENTS
	const minCombinedScore =
		options?.minCombinedScore ?? DEFAULT_MIN_COMBINED_SCORE
	const minIntervalMs = options?.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS
	const noveltyWeight = options?.noveltyWeight ?? DEFAULT_NOVELTY_WEIGHT
	const importanceWeight =
		options?.importanceWeight ?? DEFAULT_IMPORTANCE_WEIGHT
	const accessWeight = options?.accessWeight ?? DEFAULT_ACCESS_WEIGHT

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
	// Phase 0 — Gate (rate limiter + event count check)
	// ===================================================================

	const consolidationRuns = consolidationRunsCollection(db, prefix)
	const lastRun = await consolidationRuns.findOne(
		{ agentId, status: { $in: ["completed", "running"] } },
		{ sort: { startedAt: -1 } },
	)

	if (lastRun?.startedAt instanceof Date) {
		const elapsed = Date.now() - lastRun.startedAt.getTime()
		if (elapsed < minIntervalMs) {
			log.info(
				`consolidation rate-limited for agent=${agentId} (${elapsed}ms < ${minIntervalMs}ms)`,
			)
			emptyResult.durationMs = Date.now() - startMs
			return emptyResult
		}
	}

	// Record run start
	await consolidationRuns.insertOne({
		runId,
		agentId,
		startedAt: new Date(),
		status: "running",
	})

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
		await consolidationRuns.updateOne(
			{ runId },
			{
				$set: {
					status: "completed",
					completedAt: new Date(),
					eventsProcessed: 0,
					factsPromoted: 0,
					factsPruned: 0,
					conflictsResolved: 0,
					durationMs,
				},
			},
		)
		return { ...emptyResult, durationMs }
	}

	// ===================================================================
	// Phase 1 — Orient ($facet parallel stats)
	// ===================================================================

	let orientStats: DreamerOrientStats | undefined
	try {
		const [facetResult] = await eventsCol
			.aggregate([
				{ $match: { agentId } },
				{
					$facet: {
						unprocessed: [
							{
								$match: {
									agentId,
									dreamerProcessedAt: { $exists: false },
								},
							},
							{ $count: "n" },
						],
						byType: [
							{ $match: { agentId } },
							{ $group: { _id: "$role", count: { $sum: 1 } } },
						],
						topTopics: [
							{ $match: { agentId } },
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

	// Get novelty scores (graceful degradation if mongot unavailable)
	const noveltyOpts = options
		? {
				scope: options.scope,
				...(options.timeRange
					? {
							timeRange: {
								start: options.timeRange.from,
								end: options.timeRange.to,
							},
						}
					: {}),
			}
		: undefined
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
		const noveltyScore = noveltyByEventId.get(event.eventId as string) ?? 0
		const impDecay = computeImportanceDecay(
			event.importance as number | undefined,
			event.timestamp instanceof Date ? event.timestamp : undefined,
		)
		const rawAccess =
			typeof event.accessCount === "number" ? event.accessCount : 0
		const normalizedAccess = rawAccess / maxAccessCount

		const combinedScore =
			noveltyWeight * noveltyScore +
			importanceWeight * impDecay +
			accessWeight * normalizedAccess

		// Scope-isolation safety: source-event scope/scopeRef flow through the
		// candidate so the downstream similarity filter + canonical write can
		// never merge memories from different scopes, even if the caller
		// passed an incorrect or omitted ConsolidationOptions.scope.
		const eventScope =
			typeof event.scope === "string" ? (event.scope as MemoryScope) : undefined
		const eventScopeRef =
			typeof event.scopeRef === "string" ? event.scopeRef : undefined

		return {
			eventId: event.eventId as string,
			body: (event.body as string) ?? "",
			timestamp:
				event.timestamp instanceof Date ? event.timestamp : new Date(0),
			noveltyScore,
			importanceDecay: impDecay,
			accessCount: rawAccess,
			combinedScore,
			...(eventScope ? { scope: eventScope } : {}),
			...(eventScopeRef ? { scopeRef: eventScopeRef } : {}),
		}
	})

	// Filter by minCombinedScore and sort descending
	const filteredCandidates = allCandidates
		.filter((c) => c.combinedScore >= minCombinedScore)
		.toSorted((a, b) => b.combinedScore - a.combinedScore)

	// ===================================================================
	// Phase 2 — Extract + Decide (8 patterns + similarity-based ADD/NOOP)
	// ===================================================================

	const structuredCol = db.collection(`${prefix}structured_mem`)
	let factsPromoted = 0
	let conflictsResolved = 0

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
			continue
		}

		try {
			// Injection-safety: injection / memory-poisoning defense.
			// Route injection-shaped candidates to memory_quarantine with
			// status="pending-review" BEFORE any pattern extraction or canonical
			// write. Tier-1 classifier is always on; tier-2 LLM is off by default.
			const injectionVerdict = classifyInjection({ content: candidate.body })
			if (injectionVerdict.classification === "injection-likely") {
				await memoryQuarantineCollection(db, prefix).insertOne({
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
				})
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
			})

			if (conflicted) {
				log.warn(
					`conflict detected for ${match.type}/${match.key} from event=${candidate.eventId}, skipping promotion`,
				)
				conflictsResolved++
				continue
			}

			// Similarity check via $vectorSearch — decide ADD vs NOOP.
			// Scope is isolated to the SAME scope as the candidate so two
			// events in different scopes can never be merged by the dreamer.
			const simFilter: Document = { agentId }
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
								model: "voyage-4-large",
								numCandidates: 50,
								limit: 5,
								filter: simFilter,
							},
						},
						{ $addFields: { score: { $meta: "vectorSearchScore" } } },
						{ $limit: 5 },
					])
					.toArray()

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
			await writeStructuredMemory({
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
			})

			factsPromoted++
		} catch (err) {
			log.warn(
				`candidate processing failed for event=${candidate.eventId}: ${err instanceof Error ? err.message : String(err)}`,
			)
		}
	}

	// ===================================================================
	// Phase 2.5 — Entity extraction for all processed events
	// Fire-and-forget: entity extraction is a side effect of Dreamer processing.
	// Errors in entity extraction do not block consolidation.
	// ===================================================================

	try {
		await Promise.allSettled(
			events.map((event) =>
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
						(typeof event.scopeRef === "string" ? event.scopeRef : undefined),
					sourceEventId: event.eventId as string,
					role:
						typeof event.role === "string"
							? (event.role as "user" | "assistant" | "system" | "tool")
							: undefined,
				}),
			),
		)
		log.info(
			`entity extraction completed for ${events.length} events in dreamer run=${runId}`,
		)
	} catch (err) {
		log.warn(
			`entity extraction during consolidation failed (non-blocking): ${err instanceof Error ? err.message : String(err)}`,
		)
	}

	// ===================================================================
	// Phase 3 — Deduction (stub for future LLM agent)
	// ===================================================================

	log.info("deduction phase: no LLM configured, skipping")

	// ===================================================================
	// Phase 4 — Induction (stub for future LLM agent)
	// ===================================================================

	log.info("induction phase: no LLM configured, skipping")

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
								model: "voyage-4-large",
								numCandidates: 20,
								limit: 4, // +1 to account for self-match consuming a slot
								filter: {
									agentId,
									...(options?.scope ? { scope: options.scope } : {}),
									...(options?.scopeRef ? { scopeRef: options.scopeRef } : {}),
								},
							},
						},
						{ $addFields: { score: { $meta: "vectorSearchScore" } } },
						{
							$match: {
								_id: { $ne: fact._id },
								state: { $ne: "invalidated" },
							},
						},
					])
					.toArray()

				for (const dup of duplicates) {
					const dupScore = typeof dup.score === "number" ? dup.score : 0
					if (dupScore > SIMILARITY_THRESHOLD_PRUNE) {
						// Invalidate the older duplicate
						const dupUpdated =
							dup.updatedAt instanceof Date ? dup.updatedAt : new Date(0)
						const factUpdated =
							fact.updatedAt instanceof Date ? fact.updatedAt : new Date(0)
						const olderDoc = dupUpdated < factUpdated ? dup : fact

						await structuredCol.updateOne(
							{ _id: olderDoc._id },
							{ $set: { state: "invalidated" } },
						)
						invalidatedIds.add(String(olderDoc._id))
						prunedCount++
						log.info(
							`pruned near-duplicate: ${String(olderDoc._id)} (score=${dupScore.toFixed(3)})`,
						)
					}
				}
			} catch (err) {
				// Graceful degradation: if $vectorSearch fails during prune, skip
				log.warn(
					`prune similarity check failed for fact=${String(fact._id)}: ${err instanceof Error ? err.message : String(err)}`,
				)
			}
		}
	} catch (err) {
		log.warn(
			`prune phase failed: ${err instanceof Error ? err.message : String(err)}`,
		)
	}

	// ===================================================================
	// Mark ALL processed events as dreamer-processed
	// ===================================================================

	const allEventIds = events.map((e) => e.eventId as string)
	await markEventsDreamerProcessed({
		db,
		prefix,
		eventIds: allEventIds,
		runId,
	})

	// ===================================================================
	// Record run completion
	// ===================================================================

	const durationMs = Date.now() - startMs

	await consolidationRuns.updateOne(
		{ runId },
		{
			$set: {
				status: "completed",
				completedAt: new Date(),
				eventsProcessed: events.length,
				factsPromoted,
				factsPruned: prunedCount,
				conflictsResolved,
				durationMs,
			},
		},
	)

	log.info(
		`consolidation run=${runId} completed: ${events.length} events processed, ${factsPromoted} facts promoted, ${prunedCount} pruned, ${durationMs}ms`,
	)

	// ===================================================================
	// Return result
	// ===================================================================

	return {
		runId,
		agentId,
		eventsProcessed: events.length,
		factsPromoted,
		factsPruned: prunedCount,
		conflictsResolved,
		durationMs,
		candidates: filteredCandidates,
		orientStats,
		prunedCount,
	}
}
