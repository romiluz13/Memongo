import type { Db, Document } from "mongodb"
import { type MemoryScope, createSubsystemLogger } from "@memongo/lib"
import {
	structuredMemCollection,
	entitiesCollection,
	episodesCollection,
	eventsCollection,
} from "./mongodb-schema.js"
import {
	buildCurrentValidityClause,
	buildUnexpiredClause,
	mergeQueryClauses,
} from "./mongodb-temporal.js"
import { emitTelemetry, type TelemetryDocument } from "./mongodb-telemetry.js"
import {
	ErasureGateConflictError,
	type AdmissionToken,
} from "./mongodb-write-fence.js"

const log = createSubsystemLogger("memory:mongodb:profile")
function emitReadTelemetry(
	db: Db,
	prefix: string,
	doc: Omit<TelemetryDocument, "ts">,
	admission?: AdmissionToken,
): void {
	if (admission) {
		void emitTelemetry(db, prefix, doc, { admission }).catch(() =>
			log.warn("profile telemetry emit failed"),
		)
	} else {
		emitTelemetry(db, prefix, doc)
	}
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ProfileSynthesis = {
	agentId: string
	scope: MemoryScope
	scopeRef: string
	/** Structured memory grouped by type */
	preferences: ProfileMemoryItem[]
	decisions: ProfileMemoryItem[]
	facts: ProfileMemoryItem[]
	todos: ProfileMemoryItem[]
	/** Top entities by relation count */
	topEntities: ProfileEntity[]
	/** Most recent episode summaries */
	recentEpisodes: ProfileEpisode[]
	/** Activity patterns derived from events */
	activityPatterns: ActivityPatterns
	/** Synthesis timestamp */
	synthesizedAt: Date
}

export type ProfileMemoryItem = {
	key: string
	value: string
	salience: string
	updatedAt: Date
}

export type ProfileEntity = {
	name: string
	type: string
	relationCount: number
}

export type ProfileEpisode = {
	title: string
	summary: string
	type: string
	timeRange: { start: Date; end: Date }
}

export type ActivityPatterns = {
	/** Distribution of events by role (user, assistant, system, tool) */
	roleDistribution: Record<string, number>
	/** Total event count in the analysis window */
	totalEvents: number
	/** Most recent event timestamp */
	lastActive: Date | null
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Synthesize a dynamic agent profile from structured memory, entities,
 * episodes, and events. Read-only aggregation across 5 collections.
 *
 * Uses $facet for structured_mem (single pass), $lookup + $group for
 * entity relation counts, simple find for episodes, and $group for
 * event activity patterns.
 */
export async function synthesizeProfile(params: {
	admission?: AdmissionToken
	db: Db
	prefix: string
	agentId: string
	scope: MemoryScope
	scopeRef: string
	/** Max items per structured memory type. Default: 20 */
	maxPerType?: number
	/** Max entities to return. Default: 10 */
	maxEntities?: number
	/** Max episodes to return. Default: 10 */
	maxEpisodes?: number
	/** Activity window in ms. Default: 30 days */
	activityWindowMs?: number
}): Promise<ProfileSynthesis> {
	const profileStart = Date.now()
	const {
		db,
		prefix,
		agentId,
		scope,
		scopeRef,
		maxPerType = 20,
		maxEntities = 10,
		maxEpisodes = 10,
		activityWindowMs = 30 * 24 * 60 * 60 * 1000,
	} = params
	if (
		params.admission &&
		(params.admission.kind !== "admission" ||
			params.admission.agentId !== agentId)
	)
		throw new ErasureGateConflictError(agentId)

	const scopeFilter = { agentId, scope, scopeRef }
	// One captured instant for the temporal guards and the activity window so
	// every guard evaluates against the same moment.
	const asOf = new Date()
	const activitySince = new Date(asOf.getTime() - activityWindowMs)

	try {
		// Run all 4 queries concurrently; a source failure rejects the whole
		// synthesis into the outer ok:false path instead of resolving empty.
		const [structuredResults, entityResults, episodeResults, activityResults] =
			await Promise.all([
				// 1. Structured memory via $facet (single pass, pre-filtered by $match to stay under 100MB)
				structuredMemCollection(db, prefix)
					.aggregate([
						// P4.4.1 (B1): hide TTL-expired docs until the sweep removes
						// them.
						{
							$match: mergeQueryClauses(
								scopeFilter,
								{ state: "active" },
								buildUnexpiredClause({ asOf }),
								buildCurrentValidityClause({ asOf }),
							),
						},
						{
							$facet: {
								preferences: [
									{ $match: { type: "preference" } },
									{ $sort: { updatedAt: -1 } },
									{ $limit: maxPerType },
									{
										$project: { key: 1, value: 1, salience: 1, updatedAt: 1 },
									},
								],
								decisions: [
									{ $match: { type: "decision" } },
									{ $sort: { updatedAt: -1 } },
									{ $limit: maxPerType },
									{
										$project: { key: 1, value: 1, salience: 1, updatedAt: 1 },
									},
								],
								facts: [
									{ $match: { type: "fact" } },
									{ $sort: { updatedAt: -1 } },
									{ $limit: maxPerType },
									{
										$project: { key: 1, value: 1, salience: 1, updatedAt: 1 },
									},
								],
								todos: [
									{ $match: { type: "todo" } },
									{ $sort: { updatedAt: -1 } },
									{ $limit: maxPerType },
									{
										$project: { key: 1, value: 1, salience: 1, updatedAt: 1 },
									},
								],
							},
						},
					])
					.toArray(),

				// 2. Top entities by relation count via two indexed $eq lookups (C2/M3 audit fix)
				// Split $or in $expr into two separate $lookup stages so each can use its own index.
				// $expr with $or cannot use indexes; $expr with $eq can.
				maxEntities === 0
					? Promise.resolve([])
					: entitiesCollection(db, prefix)
							.aggregate([
								{ $match: scopeFilter },
								// Lookup 1: outgoing relations count (uses index on fromEntityId)
								{
									$lookup: {
										from: `${prefix}relations`,
										let: { eid: "$entityId" },
										pipeline: [
											{
												$match: {
													$expr: { $eq: ["$fromEntityId", "$$eid"] },
													...scopeFilter,
												},
											},
											{ $count: "cnt" },
										],
										as: "outRels",
									},
								},
								// Lookup 2: incoming relations count (uses index on toEntityId)
								{
									$lookup: {
										from: `${prefix}relations`,
										let: { eid: "$entityId" },
										pipeline: [
											{
												$match: {
													$expr: { $eq: ["$toEntityId", "$$eid"] },
													...scopeFilter,
												},
											},
											{ $count: "cnt" },
										],
										as: "inRels",
									},
								},
								// Sum the two counts (no full relation docs in memory — only $count results)
								{
									$addFields: {
										relationCount: {
											$add: [
												{ $ifNull: [{ $arrayElemAt: ["$outRels.cnt", 0] }, 0] },
												{ $ifNull: [{ $arrayElemAt: ["$inRels.cnt", 0] }, 0] },
											],
										},
									},
								},
								{ $sort: { relationCount: -1 } },
								{ $limit: maxEntities },
								{ $project: { name: 1, type: 1, relationCount: 1 } },
							])
							.toArray(),

				// 3. Recent episodes
				maxEpisodes === 0
					? Promise.resolve([])
					: episodesCollection(db, prefix)
							.find({ ...scopeFilter, status: { $ne: "deleted" } })
							// MongoDB FindCursor.sort — not Array#sort (unicorn false positive).
							// oxlint-disable-next-line unicorn/no-array-sort
							.sort({ "timeRange.start": -1 })
							.limit(maxEpisodes)
							.project({ title: 1, summary: 1, type: 1, timeRange: 1 })
							.toArray(),

				// 4. Activity patterns from events (last N days)
				eventsCollection(db, prefix)
					.aggregate([
						{
							// P4.4.1 (B1): hide TTL-expired docs until the sweep removes
							// them — the same read-side guard the other events readers
							// apply.
							$match: mergeQueryClauses(
								scopeFilter,
								buildUnexpiredClause({ asOf }),
								{ timestamp: { $gte: activitySince } },
							),
						},
						{
							$group: {
								_id: "$role",
								count: { $sum: 1 },
								lastTs: { $max: "$timestamp" },
							},
						},
					])
					.toArray(),
			])

		// Assemble results; the defaults cover legitimately empty sources.
		const structured = structuredResults[0] ?? {
			preferences: [],
			decisions: [],
			facts: [],
			todos: [],
		}

		const roleDistribution: Record<string, number> = {}
		let totalEvents = 0
		let lastActive: Date | null = null
		for (const r of activityResults) {
			roleDistribution[r._id as string] = r.count as number
			totalEvents += r.count as number
			const ts = r.lastTs as Date
			if (!lastActive || ts > lastActive) {
				lastActive = ts
			}
		}

		const durationMs = Date.now() - profileStart
		emitReadTelemetry(
			db,
			prefix,
			{
				meta: { agentId, operation: "profile-synthesis" },
				durationMs,
				ok: true,
				resultCount: totalEvents,
			},
			params.admission,
		)

		log.info("profile synthesis complete", { agentId, durationMs, totalEvents })

		return {
			agentId,
			scope,
			scopeRef,
			preferences: mapMemoryItems(structured.preferences as Document[]),
			decisions: mapMemoryItems(structured.decisions as Document[]),
			facts: mapMemoryItems(structured.facts as Document[]),
			todos: mapMemoryItems(structured.todos as Document[]),
			topEntities: entityResults.map((e) => ({
				name: e.name as string,
				type: e.type as string,
				relationCount: e.relationCount as number,
			})),
			recentEpisodes: episodeResults.map((e) => ({
				title: e.title as string,
				summary: e.summary as string,
				type: e.type as string,
				timeRange: e.timeRange as { start: Date; end: Date },
			})),
			activityPatterns: { roleDistribution, totalEvents, lastActive },
			synthesizedAt: new Date(),
		}
	} catch (err) {
		log.error("synthesizeProfile failed", { agentId, error: err })
		emitReadTelemetry(
			db,
			prefix,
			{
				meta: { agentId, operation: "profile-synthesis" },
				durationMs: Date.now() - profileStart,
				ok: false,
			},
			params.admission,
		)
		throw err
	}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mapMemoryItems(items: Document[]): ProfileMemoryItem[] {
	return items.map((i) => ({
		key: i.key as string,
		value: i.value as string,
		salience: (i.salience as string) ?? "normal",
		updatedAt: i.updatedAt as Date,
	}))
}
