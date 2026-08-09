import { createHash } from "node:crypto"
import type {
	ClientSession,
	Collection,
	Db,
	Document,
	MongoClient,
} from "mongodb"
import { type MemoryScope, createSubsystemLogger } from "@memongo/lib"
import { isDuplicateKeyError } from "./internal.js"
import {
	type EntityExtractor,
	type ExtractedEntity as ExtractorExtractedEntity,
	RegexEntityExtractor,
	isAmbiguousPersonName,
} from "./mongodb-entity-extractor.js"
import { recordMutation } from "./mongodb-mutations.js"
import { recordProjectionRun } from "./mongodb-ops.js"
import type { EnrichmentProvider } from "./mongodb-llm-enrichment.js"
import { extractTypedRelations } from "./mongodb-relation-extraction.js"
import {
	entitiesCollection,
	entityLinksCollection,
	relationsCollection,
} from "./mongodb-schema.js"
import { resolveUserSearchMaxTimeMs } from "./mongodb-search-budget.js"
import { resolveScopeRef } from "./mongodb-scope.js"
import { emitTelemetry } from "./mongodb-telemetry.js"
import {
	buildCurrentValidityClause,
	buildLiveStateClause,
	mergeQueryClauses,
	resolveTemporalAsOf,
} from "./mongodb-temporal.js"
import {
	isTransactionUnsupported,
	MAJORITY_TRANSACTION_OPTIONS,
} from "./mongodb-transactions.js"

const log = createSubsystemLogger("memory:mongodb:graph")

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type EntityType =
	| "person"
	| "org"
	| "project"
	| "topic"
	| "feature"
	| "issue"
	| "document"
	| "custom"
	| "location"
	| "system"
	| "concept"

export type Entity = {
	entityId: string
	name: string
	type: EntityType
	aliases?: string[]
	agentId: string
	scope: MemoryScope
	scopeRef?: string
	metadata?: Record<string, unknown>
	sourceEventIds?: string[]
	confidenceSource?: "onboarding" | "learned" | "inferred"
	ambiguousFlags?: string[]
	mentionCount?: number
	wikiUrl?: string
	updatedAt: Date
}

export type RelationType =
	| "works_on"
	| "owns"
	| "depends_on"
	| "blocked_by"
	| "decided"
	| "mentioned_with"
	| "reported_by"
	| "related_to"

export type RelationState = "active" | "invalidated" | "conflicted"

export type Relation = {
	fromEntityId: string
	toEntityId: string
	type: RelationType
	weight?: number
	confidence?: number
	agentId: string
	scope: MemoryScope
	scopeRef?: string
	state?: RelationState
	metadata?: Record<string, unknown>
	provenance?: Record<string, unknown>
	sourceEventIds?: string[]
	sourceReliability?: number
	reinforcementCount?: number
	validFrom?: Date
	validTo?: Date
	reviewAt?: Date
	lastConfirmedAt?: Date
	supersedes?: Record<string, unknown>
	invalidatedBy?: Record<string, unknown>
	updatedAt: Date
}

export type EntityLinkType =
	| "confirmed_same"
	| "candidate_same"
	| "related_mention"
export type EntityLinkStatus = "active" | "rejected"

export type EntityLink = {
	linkId: string
	fromEntityId: string
	toEntityId: string
	linkType: EntityLinkType
	status: EntityLinkStatus
	confidence: number
	agentId: string
	scope: MemoryScope
	scopeRef?: string
	sourceEventIds?: string[]
	provenance?: Record<string, unknown>
	updatedAt: Date
}

export type GraphExpansionResult = {
	rootEntity: Entity
	connections: Array<{
		entity: Entity
		relation: Relation
		depth: number
	}>
}

function relationPriority(type: RelationType): number {
	switch (type) {
		case "works_on":
		case "owns":
		case "depends_on":
		case "blocked_by":
		case "decided":
		case "reported_by":
			return 3
		case "related_to":
			return 2
		default:
			return 1
	}
}

function relationRecency(value: unknown): number {
	return value instanceof Date ? value.getTime() : 0
}

function canonicalizeEntityPair(left: string, right: string) {
	return left <= right
		? { fromEntityId: left, toEntityId: right }
		: { fromEntityId: right, toEntityId: left }
}

function arraysEqual(
	left: string[] | undefined,
	right: string[] | undefined,
): boolean {
	const a = left ?? []
	const b = right ?? []
	return a.length === b.length && a.every((value, index) => value === b[index])
}

function hasProcessedSourceEvents(
	existing: Document,
	sourceEventIds: string[] | undefined,
): boolean {
	if (!sourceEventIds || sourceEventIds.length === 0) {
		return false
	}
	const existingIds = new Set(
		Array.isArray(existing.sourceEventIds)
			? existing.sourceEventIds.map((value) => String(value))
			: [],
	)
	return sourceEventIds.every((eventId) => existingIds.has(eventId))
}

function mergeSourceEventIds(
	existing: Document | null,
	sourceEventIds: string[],
): string[] {
	return Array.from(
		new Set([
			...(existing && Array.isArray(existing.sourceEventIds)
				? existing.sourceEventIds.map((value) => String(value))
				: []),
			...sourceEventIds,
		]),
	)
}

function hasRelationChanged(existing: Document, relation: Relation): boolean {
	const effectiveState = relation.state ?? "active"
	const effectiveSourceReliability = inferRelationSourceReliability(relation)
	const existingSourceReliability =
		typeof existing.sourceReliability === "number"
			? existing.sourceReliability
			: Array.isArray(existing.sourceEventIds) &&
					existing.sourceEventIds.length > 0
				? 0.9
				: 0.8
	return (
		(typeof existing.weight === "number" ? existing.weight : undefined) !==
			relation.weight ||
		(typeof existing.confidence === "number"
			? existing.confidence
			: undefined) !== relation.confidence ||
		(typeof existing.state === "string"
			? (existing.state as RelationState)
			: "active") !== effectiveState ||
		existingSourceReliability !== effectiveSourceReliability ||
		JSON.stringify(existing.metadata ?? null) !==
			JSON.stringify(relation.metadata ?? null) ||
		JSON.stringify(existing.provenance ?? null) !==
			JSON.stringify(relation.provenance ?? null) ||
		!arraysEqual(
			Array.isArray(existing.sourceEventIds)
				? existing.sourceEventIds.map((value) => String(value))
				: undefined,
			relation.sourceEventIds,
		)
	)
}

function inferRelationSourceReliability(relation: Relation): number {
	if (typeof relation.sourceReliability === "number") {
		return relation.sourceReliability
	}
	if ((relation.sourceEventIds?.length ?? 0) > 0) {
		return 0.9
	}
	return 0.8
}

function inferRelationReviewAt(
	relation: Relation,
	now: Date,
): Date | undefined {
	if (relation.reviewAt) {
		return relation.reviewAt
	}
	if (relation.validTo) {
		return relation.validTo
	}
	if (relation.type === "owns") {
		return new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000)
	}
	return undefined
}

function buildRelationTraversalClause(asOf?: Date): Document {
	const resolvedAsOf = resolveTemporalAsOf(asOf)
	return mergeQueryClauses(
		buildLiveStateClause({
			liveStates: ["active", "conflicted"],
			includeMissingAsLive: true,
		}),
		buildCurrentValidityClause({ asOf: resolvedAsOf }),
	)
}

function makeEntityLinkId(params: {
	fromEntityId: string
	toEntityId: string
	linkType: EntityLinkType
	agentId: string
	scope: MemoryScope
	scopeRef: string
}): string {
	return createHash("sha256")
		.update(
			`${params.agentId}:${params.scope}:${params.scopeRef}:${params.fromEntityId}:${params.toEntityId}:${params.linkType}`,
		)
		.digest("hex")
		.slice(0, 24)
}

function normalizeEntityNameTokens(value: string): string[] {
	return value
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.map((token) => token.trim())
		.filter((token) => token.length >= 3)
}

function inferEntityLinkType(
	left: ExtractedEntity,
	right: ExtractedEntity,
): {
	linkType: EntityLinkType
	confidence: number
	provenance?: Record<string, unknown>
} {
	const leftTokens = normalizeEntityNameTokens(left.name)
	const rightTokens = normalizeEntityNameTokens(right.name)
	const sharedTokens = leftTokens.filter((token) => rightTokens.includes(token))

	if (
		left.type === right.type &&
		left.type === "person" &&
		sharedTokens.length > 0 &&
		left.entityId !== right.entityId
	) {
		return {
			linkType: "candidate_same",
			confidence: 0.65,
			provenance: { heuristic: "shared-name-tokens", sharedTokens },
		}
	}

	return {
		linkType: "related_mention",
		confidence: 0.2,
		provenance: { heuristic: "co-mentioned" },
	}
}

// ---------------------------------------------------------------------------
// Upsert entity
// ---------------------------------------------------------------------------

export async function upsertEntity(params: {
	db: Db
	prefix: string
	entity: Entity
}): Promise<{ upserted: boolean }> {
	const { db, prefix, entity } = params
	try {
		const collection = entitiesCollection(db, prefix)

		const now = new Date()
		const scopeRef = resolveScopeRef({
			scope: entity.scope,
			scopeRef: entity.scopeRef,
			agentId: entity.agentId,
		})
		const setDoc: Document = {
			entityId: entity.entityId,
			name: entity.name,
			type: entity.type,
			agentId: entity.agentId,
			scope: entity.scope,
			scopeRef,
			updatedAt: now,
		}
		if (entity.aliases !== undefined) {
			setDoc.aliases = entity.aliases
		}
		if (entity.metadata !== undefined) {
			setDoc.metadata = entity.metadata
		}
		if (entity.wikiUrl !== undefined) {
			setDoc.wikiUrl = entity.wikiUrl
		}

		// Build accumulator operators for array/counter fields
		const addToSet: Document = {}
		if (entity.sourceEventIds !== undefined) {
			addToSet.sourceEventIds = { $each: entity.sourceEventIds }
		}
		if (entity.ambiguousFlags !== undefined) {
			addToSet.ambiguousFlags = { $each: entity.ambiguousFlags }
		}

		const result = await collection.updateOne(
			{
				entityId: entity.entityId,
				agentId: entity.agentId,
				scope: entity.scope,
				scopeRef,
			},
			{
				$set: setDoc,
				$inc: { mentionCount: 1 },
				$setOnInsert: {
					createdAt: now,
					...(entity.confidenceSource
						? { confidenceSource: entity.confidenceSource }
						: {}),
				},
				...(Object.keys(addToSet).length > 0 ? { $addToSet: addToSet } : {}),
			},
			{ upsert: true },
		)

		const upserted = result.upsertedCount > 0
		log.info(
			`entity ${upserted ? "created" : "updated"}: ${entity.entityId} name=${entity.name}`,
		)

		// Fire-and-forget: record mutation audit trail (non-blocking)
		Promise.allSettled([
			recordMutation({
				db,
				prefix,
				mutation: {
					collectionName: "entities",
					documentId: entity.entityId,
					operation: upserted ? "create" : "update",
					agentId: entity.agentId,
					oldValue: null,
					newValue: setDoc,
					actorRole: "system",
				},
			}),
		]).catch((err) => {
			log.warn(
				`entity audit failed: ${err instanceof Error ? err.message : String(err)}`,
			)
		})

		return { upserted }
	} catch (err) {
		log.error(
			`upsertEntity failed: ${err instanceof Error ? err.message : String(err)}`,
		)
		throw err
	}
}

// ---------------------------------------------------------------------------
// Upsert relation
// ---------------------------------------------------------------------------

export async function upsertRelation(params: {
	db: Db
	prefix: string
	relation: Relation
	client?: MongoClient
	session?: ClientSession
	eventReceiptIds?: string[]
}): Promise<{ upserted: boolean }> {
	const { db, prefix, relation } = params
	try {
		const collection = relationsCollection(db, prefix)
		const scopeRef = resolveScopeRef({
			scope: relation.scope,
			scopeRef: relation.scopeRef,
			agentId: relation.agentId,
		})
		const identityFilter = {
			fromEntityId: relation.fromEntityId,
			toEntityId: relation.toEntityId,
			type: relation.type,
			agentId: relation.agentId,
			scope: relation.scope,
			scopeRef,
		}
		type PersistOutcome = {
			upserted: boolean
			changed: boolean
			setDoc: Document
			existing: Document | null
		}
		const persist = async (
			session?: ClientSession,
		): Promise<PersistOutcome> => {
			const existing = session
				? await collection.findOne(identityFilter, { session })
				: await collection.findOne(identityFilter)
			// If the SAME sourceEventIds (or eventReceiptIds) have already been
			// processed, skip ONLY the destructive `owns` invalidation side effect —
			// NOT the hasRelationChanged path, so weight/confidence/state/metadata
			// updates still apply when the same event re-arrives with changed fields.
			const alreadyProcessed =
				existing &&
				(hasProcessedSourceEvents(existing, params.eventReceiptIds) ||
					hasProcessedSourceEvents(existing, relation.sourceEventIds))

			const now = new Date()
			const state = relation.state ?? "active"
			const sourceReliability = inferRelationSourceReliability(relation)
			const lastConfirmedAt = relation.lastConfirmedAt ?? now
			const reviewAt = inferRelationReviewAt(relation, now)
			const setDoc: Document = {
				fromEntityId: relation.fromEntityId,
				toEntityId: relation.toEntityId,
				// P3.8: denormalized locator id ("from-to") so readFile's relation
				// locator resolves with one findOne instead of scanning up to 50
				// relations and JS-matching the pair.
				relationId: `${relation.fromEntityId}-${relation.toEntityId}`,
				type: relation.type,
				agentId: relation.agentId,
				scope: relation.scope,
				scopeRef,
				state,
				sourceReliability,
				lastConfirmedAt,
				updatedAt: now,
			}
			if (relation.weight !== undefined) setDoc.weight = relation.weight
			if (relation.confidence !== undefined) {
				setDoc.confidence = relation.confidence
			}
			if (relation.metadata !== undefined) setDoc.metadata = relation.metadata
			if (relation.provenance !== undefined) {
				setDoc.provenance = relation.provenance
			}
			if (relation.sourceEventIds !== undefined) {
				setDoc.sourceEventIds = mergeSourceEventIds(
					existing,
					relation.sourceEventIds,
				)
			}
			if (reviewAt !== undefined) setDoc.reviewAt = reviewAt

			let invalidatedRelationCount = 0
			if (relation.type === "owns" && state === "active" && !alreadyProcessed) {
				const filter = {
					agentId: relation.agentId,
					scope: relation.scope,
					scopeRef,
					type: relation.type,
					toEntityId: relation.toEntityId,
					fromEntityId: { $ne: relation.fromEntityId },
					state: { $ne: "invalidated" },
				}
				const update = {
					$set: {
						state: "invalidated",
						validTo: now,
						updatedAt: now,
						invalidatedBy: {
							fromEntityId: relation.fromEntityId,
							toEntityId: relation.toEntityId,
							type: relation.type,
							at: now.toISOString(),
							reason: "exclusive-relation-replaced",
						},
					},
				}
				const invalidation = session
					? await collection.updateMany(filter, update, { session })
					: await collection.updateMany(filter, update)
				invalidatedRelationCount = invalidation.modifiedCount
			}

			let update: Document
			if (!existing) {
				setDoc.validFrom = relation.validFrom ?? now
				setDoc.reinforcementCount = relation.reinforcementCount ?? 1
				if (invalidatedRelationCount > 0) {
					setDoc.supersedes = {
						type: relation.type,
						toEntityId: relation.toEntityId,
						invalidatedRelationCount,
					}
				}
				update = { $set: setDoc, $setOnInsert: { createdAt: now } }
			} else if (alreadyProcessed) {
				// Same sourceEventIds already processed: skip the destructive owns
				// invalidation, but still apply field updates (weight/confidence/state/
				// metadata) and bump reinforcement, so re-emits with changed fields
				// are not silently dropped.
				const currentValidFrom =
					existing.validFrom instanceof Date
						? existing.validFrom
						: existing.createdAt instanceof Date
							? existing.createdAt
							: now
				// No $inc here: this event was already applied to this relation, so
				// re-applying it is a replay, not new reinforcement. Incrementing
				// would also make concurrent writers of the SAME event each add one
				// (withTransaction re-runs this callback after a WriteConflict).
				update = {
					$set: {
						...setDoc,
						validFrom: currentValidFrom,
						lastConfirmedAt: now,
					},
				}
			} else if (!hasRelationChanged(existing, relation)) {
				const currentValidFrom =
					existing.validFrom instanceof Date
						? existing.validFrom
						: existing.createdAt instanceof Date
							? existing.createdAt
							: now
				update = {
					$set: {
						...setDoc,
						validFrom: currentValidFrom,
						lastConfirmedAt: now,
					},
					$inc: { reinforcementCount: 1 },
				}
			} else {
				setDoc.validFrom = now
				setDoc.reinforcementCount = relation.reinforcementCount ?? 1
				setDoc.supersedes = {
					type: String(existing.type ?? relation.type),
					fromEntityId: String(existing.fromEntityId ?? relation.fromEntityId),
					toEntityId: String(existing.toEntityId ?? relation.toEntityId),
					updatedAt:
						existing.updatedAt instanceof Date
							? existing.updatedAt.toISOString()
							: undefined,
				}
				if (invalidatedRelationCount > 0) {
					setDoc.supersedes = {
						...(setDoc.supersedes as Record<string, unknown>),
						invalidatedRelationCount,
					}
				}
				update = { $set: setDoc, $setOnInsert: { createdAt: now } }
			}

			const result = await collection.updateOne(identityFilter, update, {
				upsert: true,
				...(session ? { session } : {}),
			})
			return {
				upserted: result.upsertedCount > 0,
				changed: true,
				setDoc,
				existing,
			}
		}

		const client = params.client
		const outcome = params.session
			? await persist(params.session)
			: client
				? await (async () => {
						const session = client.startSession()
						try {
							let result: PersistOutcome | undefined
							await session.withTransaction(async () => {
								result = await persist(session)
							}, MAJORITY_TRANSACTION_OPTIONS)
							return (
								result ?? {
									upserted: false,
									changed: false,
									setDoc: {},
									existing: null,
								}
							)
						} catch (err) {
							if (!isTransactionUnsupported(err)) throw err
							log.info(
								"transactions not supported for relation writes, falling back to direct writes",
							)
							return await persist()
						} finally {
							await session.endSession()
						}
					})()
				: await persist()

		if (!outcome.changed) return { upserted: false }
		const upserted = outcome.upserted
		log.info(
			`relation ${upserted ? "created" : "updated"}: ${relation.fromEntityId} -[${relation.type}]-> ${relation.toEntityId}`,
		)

		// Fire-and-forget: record mutation audit trail (non-blocking)
		Promise.allSettled([
			recordMutation({
				db,
				prefix,
				mutation: {
					collectionName: "relations",
					documentId: `${relation.fromEntityId}:${relation.toEntityId}`,
					operation: upserted ? "create" : "update",
					agentId: relation.agentId,
					oldValue: outcome.existing,
					newValue: outcome.setDoc,
					actorRole: "system",
				},
			}),
		]).catch((err) => {
			log.warn(
				`relation audit failed: ${err instanceof Error ? err.message : String(err)}`,
			)
		})

		return { upserted }
	} catch (err) {
		log.error(
			`upsertRelation failed: ${err instanceof Error ? err.message : String(err)}`,
		)
		throw err
	}
}

// ---------------------------------------------------------------------------
// Upsert entity link
// ---------------------------------------------------------------------------

export async function upsertEntityLink(params: {
	db: Db
	prefix: string
	link: Omit<EntityLink, "linkId" | "updatedAt" | "scopeRef"> & {
		linkId?: string
		updatedAt?: Date
		scopeRef?: string
	}
}): Promise<{ upserted: boolean; linkId: string }> {
	const { db, prefix, link } = params
	try {
		const collection = entityLinksCollection(db, prefix)
		const scopeRef = resolveScopeRef({
			scope: link.scope,
			scopeRef: link.scopeRef,
			agentId: link.agentId,
		})
		const pair = canonicalizeEntityPair(link.fromEntityId, link.toEntityId)
		const linkId =
			link.linkId ??
			makeEntityLinkId({
				...pair,
				linkType: link.linkType,
				agentId: link.agentId,
				scope: link.scope,
				scopeRef,
			})
		const now = link.updatedAt ?? new Date()
		const setDoc: Document = {
			linkId,
			...pair,
			linkType: link.linkType,
			status: link.status,
			confidence: link.confidence,
			agentId: link.agentId,
			scope: link.scope,
			scopeRef,
			updatedAt: now,
		}
		if (link.sourceEventIds !== undefined) {
			setDoc.sourceEventIds = link.sourceEventIds
		}
		if (link.provenance !== undefined) {
			setDoc.provenance = link.provenance
		}

		const result = await collection.updateOne(
			{
				agentId: link.agentId,
				scope: link.scope,
				scopeRef,
				fromEntityId: pair.fromEntityId,
				toEntityId: pair.toEntityId,
				linkType: link.linkType,
			},
			{ $set: setDoc, $setOnInsert: { createdAt: now } },
			{ upsert: true },
		)

		return { upserted: result.upsertedCount > 0, linkId }
	} catch (err) {
		log.error(
			`upsertEntityLink failed: ${err instanceof Error ? err.message : String(err)}`,
		)
		throw err
	}
}

export async function setEntityLinkStatus(params: {
	db: Db
	prefix: string
	agentId: string
	scope: MemoryScope
	fromEntityId: string
	toEntityId: string
	linkType: EntityLinkType
	scopeRef?: string
	status: EntityLinkStatus
}): Promise<boolean> {
	const { db, prefix, agentId, scope, linkType, status } = params
	const collection = entityLinksCollection(db, prefix)
	const scopeRef = resolveScopeRef({
		scope,
		scopeRef: params.scopeRef,
		agentId,
	})
	const pair = canonicalizeEntityPair(params.fromEntityId, params.toEntityId)
	const result = await collection.updateOne(
		{
			agentId,
			scope,
			scopeRef,
			fromEntityId: pair.fromEntityId,
			toEntityId: pair.toEntityId,
			linkType,
		},
		{ $set: { status, updatedAt: new Date() } },
	)
	return result.matchedCount > 0
}

export async function getEntityLinks(params: {
	db: Db
	prefix: string
	agentId: string
	entityId: string
	scope?: MemoryScope
	scopeRef?: string
	status?: EntityLinkStatus
	linkTypes?: EntityLinkType[]
	limit?: number
}): Promise<EntityLink[]> {
	const {
		db,
		prefix,
		agentId,
		entityId,
		scope,
		scopeRef,
		status,
		linkTypes,
		limit,
	} = params
	const collection = entityLinksCollection(db, prefix)
	const filter: Document = {
		agentId,
		$or: [{ fromEntityId: entityId }, { toEntityId: entityId }],
	}
	if (scope) {
		filter.scope = scope
	}
	if (scopeRef) {
		filter.scopeRef = scopeRef
	}
	if (status) {
		filter.status = status
	}
	if (linkTypes && linkTypes.length > 0) {
		filter.linkType = { $in: linkTypes }
	}

	const docs = await collection
		.find(filter)
		// MongoDB FindCursor.sort — not Array#sort (unicorn false positive).
		// oxlint-disable-next-line unicorn/no-array-sort
		.sort({ confidence: -1, updatedAt: -1 })
		.limit(limit ?? 50)
		.toArray()
	return docs as unknown as EntityLink[]
}

// ---------------------------------------------------------------------------
// Find entities by name (regex search on name/aliases)
// ---------------------------------------------------------------------------

export async function findEntitiesByName(params: {
	db: Db
	prefix: string
	query: string
	agentId: string
	scope?: MemoryScope
	scopeRef?: string
	limit?: number
}): Promise<Entity[]> {
	const { db, prefix, query, agentId, scope, scopeRef, limit } = params
	try {
		const collection = entitiesCollection(db, prefix)

		// Case-insensitive regex search on name and aliases
		const escapedQuery = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
		const regex = new RegExp(escapedQuery, "i")

		const filter: Document = {
			agentId,
			$or: [{ name: { $regex: regex } }, { aliases: { $regex: regex } }],
		}
		if (scope) {
			filter.scope = scope
		}
		if (scopeRef) {
			filter.scopeRef = scopeRef
		}

		const docs = await collection
			.find(filter)
			// oxlint-disable-next-line unicorn/no-array-sort -- MongoDB cursor .sort(), not Array
			.sort({ updatedAt: -1 })
			.limit(limit ?? 50)
			.toArray()

		return docs as unknown as Entity[]
	} catch (err) {
		log.error(
			`findEntitiesByName failed: ${err instanceof Error ? err.message : String(err)}`,
		)
		throw err
	}
}

// ---------------------------------------------------------------------------
// Get entities by type
// ---------------------------------------------------------------------------

export async function getEntitiesByType(params: {
	db: Db
	prefix: string
	type: EntityType
	agentId: string
	scope?: MemoryScope
	scopeRef?: string
	limit?: number
}): Promise<Entity[]> {
	const { db, prefix, type, agentId, scope, scopeRef, limit } = params
	try {
		const collection = entitiesCollection(db, prefix)

		const docs = await collection
			.find({
				agentId,
				type,
				...(scope ? { scope } : {}),
				...(scopeRef ? { scopeRef } : {}),
			})
			// oxlint-disable-next-line unicorn/no-array-sort -- MongoDB cursor .sort(), not Array
			.sort({ updatedAt: -1 })
			.limit(limit ?? 50)
			.toArray()

		return docs as unknown as Entity[]
	} catch (err) {
		log.error(
			`getEntitiesByType failed: ${err instanceof Error ? err.message : String(err)}`,
		)
		throw err
	}
}

// ---------------------------------------------------------------------------
// Graph expansion using $graphLookup
// NOTE: Traversal is outbound-only (fromEntityId -> toEntityId). The
// $graphLookup follows toEntityId -> fromEntityId edges, meaning it walks
// forward through the directed relation graph. Bidirectional expansion
// (also following toEntityId -> toEntityId reverse edges) can be added in
// a future phase if needed.
// ---------------------------------------------------------------------------

export async function expandGraph(params: {
	db: Db
	prefix: string
	entityId: string
	agentId: string
	scope?: MemoryScope
	scopeRef?: string
	maxDepth?: number
	bidirectional?: boolean
	maxConnections?: number
	asOf?: Date
}): Promise<GraphExpansionResult | null> {
	const {
		db,
		prefix,
		entityId,
		agentId,
		scope,
		scopeRef,
		maxDepth,
		bidirectional,
		maxConnections,
		asOf,
	} = params
	const graphStart = Date.now()
	try {
		const entCol = entitiesCollection(db, prefix)
		const relCol = relationsCollection(db, prefix)

		// 1. Find root entity
		const rootEntity = (await entCol.findOne({
			entityId,
			agentId,
			...(scope ? { scope } : {}),
			...(scopeRef ? { scopeRef } : {}),
		})) as unknown as Entity | null
		if (!rootEntity) {
			return null
		}

		const graphLookupDepth = Math.max(0, (maxDepth ?? 2) - 1)
		const connectionLimit = maxConnections ?? 100
		const directRelationLimit = Math.max(1, connectionLimit)
		const relationTraversalClause = buildRelationTraversalClause(asOf)

		// 3. Collect all unique relations with their depths
		// Direct relations are depth 0, transitive relations come from $graphLookup
		const relationsByKey = new Map<
			string,
			{ relation: Document; depth: number }
		>()

		function collectRelations(rels: Document[]): void {
			for (const directRel of rels) {
				const key = `${directRel.fromEntityId}:${directRel.toEntityId}:${directRel.type}`
				if (!relationsByKey.has(key)) {
					relationsByKey.set(key, { relation: directRel, depth: 0 })
				}
				// Process transitive relations from $graphLookup
				const transitive = (directRel.transitiveRelations ?? []) as Document[]
				for (const transRel of transitive) {
					const tKey = `${transRel.fromEntityId}:${transRel.toEntityId}:${transRel.type}`
					const depth = ((transRel.depth as number) ?? 0) + 1
					if (!relationsByKey.has(tKey)) {
						relationsByKey.set(tKey, { relation: transRel, depth })
					}
				}
			}
		}

		if (bidirectional) {
			// 2b. Run forward + reverse as two SEPARATE aggregations (not $facet).
			// $facet has a 100MB per-branch limit with no spill to disk; a large
			// graph can exceed that and abort the whole aggregation. Separate
			// aggregations can spill to disk, bounding memory per branch.
			const forwardPipeline: Document[] = [
				{
					$match: mergeQueryClauses(
						{
							fromEntityId: entityId,
							agentId,
							...(scope ? { scope } : {}),
							...(scopeRef ? { scopeRef } : {}),
						},
						relationTraversalClause,
					),
				},
				{ $limit: directRelationLimit },
				{
					$graphLookup: {
						from: `${prefix}relations`,
						startWith: "$toEntityId",
						connectFromField: "toEntityId",
						connectToField: "fromEntityId",
						as: "transitiveRelations",
						maxDepth: graphLookupDepth,
						depthField: "depth",
						restrictSearchWithMatch: mergeQueryClauses(
							{
								agentId,
								...(scope ? { scope } : {}),
								...(scopeRef ? { scopeRef } : {}),
							},
							relationTraversalClause,
						),
					},
				},
			]

			const reversePipeline: Document[] = [
				{
					$match: mergeQueryClauses(
						{
							toEntityId: entityId,
							agentId,
							...(scope ? { scope } : {}),
							...(scopeRef ? { scopeRef } : {}),
						},
						relationTraversalClause,
					),
				},
				{ $limit: directRelationLimit },
				{
					$graphLookup: {
						from: `${prefix}relations`,
						startWith: "$fromEntityId",
						connectFromField: "fromEntityId",
						connectToField: "toEntityId",
						as: "transitiveRelations",
						maxDepth: graphLookupDepth,
						depthField: "depth",
						restrictSearchWithMatch: mergeQueryClauses(
							{
								agentId,
								...(scope ? { scope } : {}),
								...(scopeRef ? { scopeRef } : {}),
							},
							relationTraversalClause,
						),
					},
				},
			]

			const [forwardRels, reverseRels] = await Promise.all([
				relCol.aggregate(forwardPipeline).toArray(),
				relCol.aggregate(reversePipeline).toArray(),
			])
			collectRelations(forwardRels as Document[])
			collectRelations(reverseRels as Document[])
		} else {
			// 2a. Outbound-only pipeline (original behavior)
			const relPipeline: Document[] = [
				{
					$match: mergeQueryClauses(
						{
							fromEntityId: entityId,
							agentId,
							...(scope ? { scope } : {}),
							...(scopeRef ? { scopeRef } : {}),
						},
						relationTraversalClause,
					),
				},
				{ $limit: directRelationLimit },
				{
					$graphLookup: {
						from: `${prefix}relations`,
						startWith: "$toEntityId",
						connectFromField: "toEntityId",
						connectToField: "fromEntityId",
						as: "transitiveRelations",
						maxDepth: graphLookupDepth,
						depthField: "depth",
						restrictSearchWithMatch: mergeQueryClauses(
							{
								agentId,
								...(scope ? { scope } : {}),
								...(scopeRef ? { scopeRef } : {}),
							},
							relationTraversalClause,
						),
					},
				},
			]

			const relResults = await relCol.aggregate(relPipeline).toArray()
			collectRelations(relResults)
		}

		// 4. Collect all connected entity IDs
		const connectedEntityIds = new Set<string>()
		const entries = Array.from(relationsByKey.values())
		for (const { relation } of entries) {
			if (relation.toEntityId !== entityId) {
				connectedEntityIds.add(relation.toEntityId as string)
			}
			if (relation.fromEntityId !== entityId) {
				connectedEntityIds.add(relation.fromEntityId as string)
			}
		}

		// 5. Look up connected entity details (scoped by agentId)
		const entityMap = new Map<string, Entity>()
		if (connectedEntityIds.size > 0) {
			const entityDocs = await entCol
				.find({
					entityId: { $in: Array.from(connectedEntityIds) },
					agentId,
					...(scope ? { scope } : {}),
					...(scopeRef ? { scopeRef } : {}),
				})
				.toArray()
			for (const doc of entityDocs) {
				entityMap.set(doc.entityId as string, doc as unknown as Entity)
			}
		}

		// 6. Build connections array
		const connections: GraphExpansionResult["connections"] = []
		for (const { relation, depth } of entries) {
			const targetEntityId =
				relation.toEntityId === entityId
					? (relation.fromEntityId as string)
					: (relation.toEntityId as string)
			const targetEntity = entityMap.get(targetEntityId)
			if (targetEntity) {
				connections.push({
					entity: targetEntity,
					relation: relation as unknown as Relation,
					depth,
				})
			}
		}

		connections.sort((a, b) => {
			if (a.depth !== b.depth) {
				return a.depth - b.depth
			}
			const priorityDiff =
				relationPriority(b.relation.type) - relationPriority(a.relation.type)
			if (priorityDiff !== 0) {
				return priorityDiff
			}
			const weightDiff = (b.relation.weight ?? 0) - (a.relation.weight ?? 0)
			if (weightDiff !== 0) {
				return weightDiff
			}
			const recencyDiff =
				relationRecency(b.relation.updatedAt) -
				relationRecency(a.relation.updatedAt)
			if (recencyDiff !== 0) {
				return recencyDiff
			}
			return a.entity.name.localeCompare(b.entity.name)
		})

		// 7. Apply maxConnections limit
		const limitedConnections = connections.slice(0, connectionLimit)
		if (connections.length > connectionLimit) {
			log.warn(
				`expandGraph: truncated ${connections.length} connections to maxConnections=${connectionLimit} for entity=${entityId}`,
			)
		}

		emitTelemetry(db, prefix, {
			meta: { agentId, operation: "graph-expansion" },
			durationMs: Date.now() - graphStart,
			ok: true,
			resultCount: limitedConnections.length,
		})

		return { rootEntity, connections: limitedConnections }
	} catch (err) {
		log.error(
			`expandGraph failed: ${err instanceof Error ? err.message : String(err)}`,
		)
		throw err
	}
}

// ---------------------------------------------------------------------------
// Delete entity (cascade delete relations)
// ---------------------------------------------------------------------------

export async function deleteEntity(params: {
	db: Db
	prefix: string
	entityId: string
	agentId: string
}): Promise<{ deletedEntity: boolean; deletedRelations: number }> {
	const { db, prefix, entityId, agentId } = params
	try {
		const entCol = entitiesCollection(db, prefix)
		const relCol = relationsCollection(db, prefix)

		// Delete entity scoped by agentId
		const entityResult = await entCol.deleteOne({ entityId, agentId })

		// Cascade delete all relations involving this entity, scoped by agentId
		const relResult = await relCol.deleteMany({
			$or: [{ fromEntityId: entityId }, { toEntityId: entityId }],
			agentId,
		})

		log.info(
			`deleted entity=${entityId} (found=${entityResult.deletedCount > 0}, relations=${relResult.deletedCount})`,
		)

		return {
			deletedEntity: entityResult.deletedCount > 0,
			deletedRelations: relResult.deletedCount,
		}
	} catch (err) {
		log.error(
			`deleteEntity failed: ${err instanceof Error ? err.message : String(err)}`,
		)
		throw err
	}
}

// ---------------------------------------------------------------------------
// Conservative delete entity (conflict detection + audit trail)
// ---------------------------------------------------------------------------

/**
 * Safe wrapper around `deleteEntity` that checks for conflicting relations
 * before proceeding. If the entity has relations and `force` is not set,
 * the delete is blocked and the conflict is reported.
 *
 * When the delete proceeds:
 * - The entity doc is read first (for audit oldValue snapshot)
 * - `deleteEntity` is called (cascade deletes relations)
 * - A mutation audit record is written (fire-and-forget)
 *
 * Audit failures never prevent the deletion from succeeding.
 */
export async function deleteEntityConservative(params: {
	db: Db
	prefix: string
	entityId: string
	agentId: string
	force?: boolean
}): Promise<{
	deletedEntity: boolean
	deletedRelations: number
	conflictDetected: boolean
	conflictingRelationCount?: number
	auditRecorded: boolean
}> {
	const { db, prefix, entityId, agentId, force } = params
	try {
		const entCol = entitiesCollection(db, prefix)
		const relCol = relationsCollection(db, prefix)

		// 1. Check for conflicting relations
		const relationCount = await relCol.countDocuments({
			$or: [{ fromEntityId: entityId }, { toEntityId: entityId }],
			agentId,
		})

		// 2. If relations exist and force is not true, block the delete
		if (relationCount > 0 && force !== true) {
			log.info(
				`deleteEntityConservative: blocked deletion of entity=${entityId} — ${relationCount} conflicting relation(s)`,
			)
			return {
				deletedEntity: false,
				deletedRelations: 0,
				conflictDetected: true,
				conflictingRelationCount: relationCount,
				auditRecorded: false,
			}
		}

		// 3. Read entity doc before delete (for audit oldValue snapshot)
		const entityDoc = await entCol.findOne({ entityId, agentId })
		if (!entityDoc) {
			log.info(
				`deleteEntityConservative: entity=${entityId} not found for agent=${agentId}`,
			)
			return {
				deletedEntity: false,
				deletedRelations: 0,
				conflictDetected: false,
				auditRecorded: false,
			}
		}

		// 4. Proceed with delete via existing deleteEntity
		const deleteResult = await deleteEntity({ db, prefix, entityId, agentId })

		// 5. Fire-and-forget audit record
		let auditRecorded = false
		try {
			const [auditResult] = await Promise.allSettled([
				recordMutation({
					db,
					prefix,
					mutation: {
						collectionName: "entities",
						documentId: entityId,
						operation: "delete",
						agentId,
						oldValue: entityDoc as unknown as Document,
						newValue: null,
						actorRole: "system",
					},
				}),
			])
			auditRecorded = auditResult.status === "fulfilled"
		} catch (err) {
			log.warn(
				`deleteEntityConservative audit failed: ${err instanceof Error ? err.message : String(err)}`,
			)
		}

		log.info(
			`deleteEntityConservative: deleted entity=${entityId}, relations=${deleteResult.deletedRelations}, audit=${auditRecorded}`,
		)

		return {
			deletedEntity: deleteResult.deletedEntity,
			deletedRelations: deleteResult.deletedRelations,
			conflictDetected: false,
			auditRecorded,
		}
	} catch (err) {
		log.error(
			`deleteEntityConservative failed: ${err instanceof Error ? err.message : String(err)}`,
		)
		throw err
	}
}

// ---------------------------------------------------------------------------
// Rule-based entity extraction
// ---------------------------------------------------------------------------

// STOP_WORDS: canonical source is now mongodb-entity-extractor.ts
// Previously defined inline here, now imported by RegexEntityExtractor

// Default entity extractor instance (shared, stateless)
// Regex patterns now live in RegexEntityExtractor (mongodb-entity-extractor.ts)
const defaultExtractor = new RegexEntityExtractor()

function makeEntityId(
	name: string,
	type: string,
	agentId: string,
	scope: MemoryScope,
	scopeRef: string,
): string {
	return createHash("sha256")
		.update(`${agentId}:${scope}:${scopeRef}:${name.toLowerCase()}:${type}`)
		.digest("hex")
		.slice(0, 16)
}

type ExtractedEntity = { entityId: string; name: string; type: EntityType }

type BulkUpdateOneOp = {
	updateOne: {
		filter: Record<string, unknown>
		update: Record<string, unknown> | Array<Record<string, unknown>>
		upsert: boolean
	}
}

/**
 * Indexes of the ops that failed with E11000 inside a MongoBulkWriteError.
 * A single-op batch can also surface as a plain duplicate-key server error.
 */
function duplicateKeyWriteErrorIndexes(err: unknown): number[] {
	if (typeof err !== "object" || err === null) {
		return []
	}
	const writeErrors = (err as { writeErrors?: unknown }).writeErrors
	if (Array.isArray(writeErrors)) {
		return writeErrors
			.filter(
				(writeError): writeError is { index: number; code: number } =>
					typeof writeError === "object" &&
					writeError !== null &&
					(writeError as { code?: unknown }).code === 11000 &&
					typeof (writeError as { index?: unknown }).index === "number",
			)
			.map((writeError) => writeError.index)
	}
	return isDuplicateKeyError(err) ? [0] : []
}

/**
 * (P2.5 c) Bulk-write upsert ops with duplicate-key recovery. Two concurrent
 * extractors racing the same unique identity both upsert; the loser's insert
 * is rejected with E11000 even though its UPDATE would have applied cleanly
 * against the winner's now-existing document. Swallowing the whole batch as a
 * "partial failure" silently drops the losing op's update (mentionCount,
 * sourceEventIds, link confidence). Retry each duplicate-key writeError as a
 * plain update (upsert: false) — the same E11000-retry pattern the engine
 * already uses on the structured/event write paths. Non-duplicate failures
 * keep the previous warn-and-continue behavior.
 */
async function bulkWriteUpsertsWithDuplicateKeyRetry(params: {
	collection: Collection
	ops: BulkUpdateOneOp[]
	context: string
}): Promise<void> {
	try {
		await params.collection.bulkWrite(params.ops, { ordered: false })
		return
	} catch (bulkErr) {
		const duplicateIndexes = duplicateKeyWriteErrorIndexes(bulkErr)
		if (duplicateIndexes.length === 0) {
			log.warn(`bulkWrite ${params.context} partial failure`, {
				error: bulkErr,
			})
			return
		}
		for (const index of duplicateIndexes) {
			const op = params.ops[index]
			if (!op) {
				continue
			}
			try {
				// The winner's document exists now — replay the losing op as a
				// plain update so its side effects are not silently dropped.
				await params.collection.updateOne(
					op.updateOne.filter,
					op.updateOne.update,
					{ upsert: false },
				)
			} catch (retryErr) {
				log.warn(`bulkWrite ${params.context} duplicate-key retry failed`, {
					error: retryErr,
				})
			}
		}
	}
}

/**
 * Extract structural entities from event content and upsert them.
 * Uses a pluggable EntityExtractor (defaults to RegexEntityExtractor).
 *
 * Deterministic entityIds via hash of name.toLowerCase() + type.
 * Fire-and-forget: caller decides whether to await.
 * SEPARATE from writeEvent -- not called automatically.
 */
export async function extractAndUpsertEntities(params: {
	db: Db
	prefix: string
	agentId: string
	eventContent: string
	scope: MemoryScope
	scopeRef?: string
	sourceEventId?: string
	extractor?: EntityExtractor
	role?: "user" | "assistant" | "system" | "tool"
}): Promise<{ entities: ExtractedEntity[]; relationsCreated: number }> {
	const { db, prefix, agentId, eventContent, scope, sourceEventId, role } =
		params
	const startMs = Date.now()
	const scopeRef = resolveScopeRef({
		scope,
		scopeRef: params.scopeRef,
		agentId,
	})

	// Use provided extractor or default to RegexEntityExtractor
	const extractor = params.extractor ?? defaultExtractor
	const extractorContext = role ? { agentId, scope, scopeRef, role } : undefined
	const extractorResults = await extractor.extract(
		eventContent,
		extractorContext,
	)

	// Bridge: compute entityId for each extracted entity (existing makeEntityId logic)
	const extracted: ExtractedEntity[] = []
	const extractorMeta = new Map<string, ExtractorExtractedEntity>()
	const seen = new Set<string>()
	for (const r of extractorResults) {
		const entityId = makeEntityId(r.name, r.type, agentId, scope, scopeRef)
		if (!seen.has(entityId)) {
			seen.add(entityId)
			extracted.push({ entityId, name: r.name, type: r.type as EntityType })
			extractorMeta.set(entityId, r)
		}
	}

	if (extracted.length === 0) {
		await Promise.allSettled([
			recordProjectionRun({
				db,
				prefix,
				run: {
					agentId,
					projectionType: "entities",
					status: "ok",
					itemsProjected: 0,
					durationMs: Date.now() - startMs,
				},
			}),
			recordProjectionRun({
				db,
				prefix,
				run: {
					agentId,
					projectionType: "relations",
					status: "ok",
					itemsProjected: 0,
					durationMs: Date.now() - startMs,
				},
			}),
		])
		return { entities: [], relationsCreated: 0 }
	}

	// H1 audit fix: batch upsert entities via bulkWrite (replaces sequential upsertEntity loop)
	try {
		const now = new Date()
		// Resolve sourceRole for entity upserts (Phase 8: role-based extraction)
		const validSourceRole =
			role === "user" || role === "assistant" ? role : undefined
		const entityOps = extracted.map((entity) => {
			const meta = extractorMeta.get(entity.entityId)
			const isLlm = meta?.extractionMethod === "llm"
			const isHighConfidenceLlm = isLlm && (meta?.confidence ?? 0) >= 0.8
			const confidenceSource: "learned" | "inferred" = isHighConfidenceLlm
				? "learned"
				: "inferred"

			// Ambiguous person name detection
			const isPersonType = entity.type === "person"
			const isAmbiguous = isPersonType && isAmbiguousPersonName(entity.name)

			const setDoc: Record<string, unknown> = {
				entityId: entity.entityId,
				name: entity.name,
				type: entity.type,
				agentId,
				scope,
				scopeRef,
				updatedAt: now,
				...(validSourceRole ? { sourceRole: validSourceRole } : {}),
			}

			// Build $addToSet for array fields that accumulate over time
			const addToSet: Record<string, unknown> = {}
			if (sourceEventId) {
				addToSet.sourceEventIds = sourceEventId
			}
			if (isAmbiguous) {
				addToSet.ambiguousFlags = entity.name.toLowerCase()
			}

			const update = sourceEventId
				? [
						{
							$set: {
								...Object.fromEntries(
									Object.entries(setDoc).map(([key, value]) => [
										key,
										{ $literal: value },
									]),
								),
								mentionCount: {
									$cond: [
										{
											$in: [
												{ $literal: sourceEventId },
												{ $ifNull: ["$sourceEventIds", []] },
											],
										},
										{ $ifNull: ["$mentionCount", 0] },
										{
											$add: [{ $ifNull: ["$mentionCount", 0] }, 1],
										},
									],
								},
								sourceEventIds: {
									$setUnion: [
										{ $ifNull: ["$sourceEventIds", []] },
										{ $literal: [sourceEventId] },
									],
								},
								...(isAmbiguous
									? {
											ambiguousFlags: {
												$setUnion: [
													{ $ifNull: ["$ambiguousFlags", []] },
													{ $literal: [entity.name.toLowerCase()] },
												],
											},
										}
									: {}),
								createdAt: {
									$ifNull: ["$createdAt", { $literal: now }],
								},
								extractedAt: {
									$ifNull: ["$extractedAt", { $literal: now }],
								},
								confidenceSource: {
									$ifNull: [
										"$confidenceSource",
										{ $literal: confidenceSource },
									],
								},
							},
						},
					]
				: {
						$set: setDoc,
						$inc: { mentionCount: 1 },
						$setOnInsert: {
							createdAt: now,
							extractedAt: now,
							confidenceSource,
						},
						...(Object.keys(addToSet).length > 0
							? { $addToSet: addToSet }
							: {}),
					}

			return {
				updateOne: {
					filter: { entityId: entity.entityId, agentId, scope, scopeRef },
					update,
					upsert: true,
				},
			}
		})
		if (entityOps.length > 0) {
			await bulkWriteUpsertsWithDuplicateKeyRetry({
				collection: entitiesCollection(db, prefix),
				ops: entityOps,
				context: "entity upserts",
			})
		}

		// H1 audit fix: batch relation + entity-link upserts (replaces sequential loops)
		let relationsCreated = 0
		if (extracted.length >= 2) {
			const relationOps: Array<{
				updateOne: {
					filter: Record<string, unknown>
					update: Record<string, unknown>
					upsert: boolean
				}
			}> = []
			const linkOps: Array<{
				updateOne: {
					filter: Record<string, unknown>
					update: Record<string, unknown>
					upsert: boolean
				}
			}> = []

			for (let i = 0; i < extracted.length - 1 && i < 5; i++) {
				for (let j = i + 1; j < extracted.length && j < 6; j++) {
					const link = inferEntityLinkType(extracted[i], extracted[j])
					const pair = canonicalizeEntityPair(
						extracted[i].entityId,
						extracted[j].entityId,
					)
					const linkId = makeEntityLinkId({
						...pair,
						linkType: link.linkType,
						agentId,
						scope,
						scopeRef,
					})

					// Entity link op (same 6-field filter as upsertEntityLink)
					linkOps.push({
						updateOne: {
							filter: {
								agentId,
								scope,
								scopeRef,
								fromEntityId: pair.fromEntityId,
								toEntityId: pair.toEntityId,
								linkType: link.linkType,
							},
							update: {
								$set: {
									linkId,
									...pair,
									linkType: link.linkType,
									status: "active",
									confidence: link.confidence,
									agentId,
									scope,
									scopeRef,
									updatedAt: now,
									...(link.provenance ? { provenance: link.provenance } : {}),
								},
								$setOnInsert: { createdAt: now },
								...(sourceEventId
									? { $addToSet: { sourceEventIds: sourceEventId } }
									: {}),
							},
							upsert: true,
						},
					})

					// Relation op (same filter as upsertRelation)
					relationOps.push({
						updateOne: {
							filter: {
								fromEntityId: extracted[i].entityId,
								toEntityId: extracted[j].entityId,
								type: "mentioned_with",
								agentId,
								scope,
								scopeRef,
							},
							update: {
								$set: {
									fromEntityId: extracted[i].entityId,
									toEntityId: extracted[j].entityId,
									// P3.8: denormalized locator id (see upsertRelation).
									relationId: `${extracted[i].entityId}-${extracted[j].entityId}`,
									type: "mentioned_with",
									weight: 0.2,
									agentId,
									scope,
									scopeRef,
									updatedAt: now,
								},
								$setOnInsert: { createdAt: now },
								...(sourceEventId
									? { $addToSet: { sourceEventIds: sourceEventId } }
									: {}),
							},
							upsert: true,
						},
					})
					relationsCreated++
				}
			}

			if (relationOps.length > 0) {
				await bulkWriteUpsertsWithDuplicateKeyRetry({
					collection: relationsCollection(db, prefix),
					ops: relationOps,
					context: "relation upserts",
				})
			}
			if (linkOps.length > 0) {
				await bulkWriteUpsertsWithDuplicateKeyRetry({
					collection: entityLinksCollection(db, prefix),
					ops: linkOps,
					context: "entity-link upserts",
				})
			}
		}

		log.info(
			`extracted ${extracted.length} entities and ${relationsCreated} relations from event content for agent=${agentId}`,
		)

		// H6 audit fix: emit entity-extraction telemetry
		emitTelemetry(db, prefix, {
			meta: { agentId, operation: "entity-extraction" },
			durationMs: Date.now() - startMs,
			ok: true,
			extractionMethod: extractorResults[0]?.extractionMethod ?? "regex",
			entitiesExtracted: extracted.length,
		})

		await Promise.allSettled([
			recordProjectionRun({
				db,
				prefix,
				run: {
					agentId,
					projectionType: "entities",
					status: "ok",
					itemsProjected: extracted.length,
					durationMs: Date.now() - startMs,
				},
			}),
			recordProjectionRun({
				db,
				prefix,
				run: {
					agentId,
					projectionType: "relations",
					status: "ok",
					itemsProjected: relationsCreated,
					durationMs: Date.now() - startMs,
				},
			}),
		])
		return { entities: extracted, relationsCreated }
	} catch (err) {
		// H6 audit fix: emit entity-extraction telemetry on failure
		emitTelemetry(db, prefix, {
			meta: { agentId, operation: "entity-extraction" },
			durationMs: Date.now() - startMs,
			ok: false,
			extractionMethod:
				extractor instanceof RegexEntityExtractor ? "regex" : "llm",
			entitiesExtracted: 0,
		})

		await Promise.allSettled([
			recordProjectionRun({
				db,
				prefix,
				run: {
					agentId,
					projectionType: "entities",
					status: "failed",
					itemsProjected: 0,
					durationMs: Date.now() - startMs,
				},
			}),
			recordProjectionRun({
				db,
				prefix,
				run: {
					agentId,
					projectionType: "relations",
					status: "failed",
					itemsProjected: 0,
					durationMs: Date.now() - startMs,
				},
			}),
		])
		log.error(
			`extractAndUpsertEntities failed: ${err instanceof Error ? err.message : String(err)}`,
		)
		throw err
	}
}

/**
 * Extract typed semantic relations among an event's entities and upsert them as
 * graph edges (#34). Runs only in the LLM-backed background path. Each typed
 * relation reuses upsertRelation (so it inherits the same versioning/exclusivity
 * machinery as any other edge) and carries the extraction confidence as weight
 * plus llm-relation-extraction provenance. Tenant-scoped by (agentId, scope,
 * scopeRef) from the event. Provider and persistence failures propagate so the
 * durable extraction job can retry.
 */
export async function extractAndUpsertTypedRelations(params: {
	db: Db
	prefix: string
	client?: MongoClient
	agentId: string
	scope: MemoryScope
	scopeRef: string
	eventContent: string
	entities: Array<{ entityId: string; name: string }>
	provider: EnrichmentProvider
	model: string
	sourceEventId?: string
	validFrom?: Date
	leaseFence?: () => Promise<boolean>
}): Promise<number> {
	const {
		db,
		prefix,
		agentId,
		scope,
		scopeRef,
		eventContent,
		entities,
		provider,
		model,
		sourceEventId,
		validFrom,
	} = params
	if (entities.length < 2) return 0

	try {
		const relations = await extractTypedRelations({
			provider,
			model,
			text: eventContent,
			entities,
		})
		let created = 0
		for (const rel of relations) {
			if (params.leaseFence && (await params.leaseFence())) {
				return created
			}
			const result = await upsertRelation({
				db,
				prefix,
				client: params.client,
				eventReceiptIds: sourceEventId ? [sourceEventId] : undefined,
				relation: {
					fromEntityId: rel.fromEntityId,
					toEntityId: rel.toEntityId,
					type: rel.type,
					weight: rel.confidence,
					confidence: rel.confidence,
					agentId,
					scope,
					scopeRef,
					provenance: {
						origin: "llm-relation-extraction",
						rationale: rel.rationale,
						...(sourceEventId ? { runId: sourceEventId } : {}),
					},
					...(sourceEventId ? { sourceEventIds: [sourceEventId] } : {}),
					...(validFrom ? { validFrom } : {}),
					updatedAt: new Date(),
				},
			})
			if (result.upserted) created += 1
		}
		return created
	} catch (err) {
		log.warn(
			`extractAndUpsertTypedRelations failed: ${err instanceof Error ? err.message : String(err)}`,
		)
		throw err
	}
}

// ---------------------------------------------------------------------------
// Fuzzy entity search via Atlas Search autocomplete
// ---------------------------------------------------------------------------

/**
 * Search entities using Atlas Search autocomplete on name/aliases.
 *
 * P3.8: the request path is capability-gated — callers pass the detected
 * textSearch capability so deployments without mongot go straight to the
 * escaped $regex fallback instead of paying a failed $search round trip per
 * lookup. A runtime $search failure still degrades to the same fallback.
 */
export async function searchEntitiesAutocomplete(params: {
	db: Db
	prefix: string
	agentId: string
	scope: MemoryScope
	scopeRef: string
	query: string
	limit?: number
	/** Detected textSearch capability; false/omitted uses the regex fallback. */
	textSearchAvailable?: boolean
}): Promise<Entity[]> {
	const { db, prefix, agentId, scope, scopeRef, query, limit } = params
	const maxResults = limit ?? 10

	if (params.textSearchAvailable !== true) {
		return findEntitiesByName({
			db,
			prefix,
			query,
			agentId,
			scope,
			scopeRef,
			limit: maxResults,
		})
	}

	try {
		const collection = entitiesCollection(db, prefix)
		const pipeline: Document[] = [
			{
				$search: {
					index: "entity_autocomplete",
					compound: {
						should: [
							{
								autocomplete: {
									query,
									path: "name",
								},
							},
							{
								autocomplete: {
									query,
									path: "aliases",
								},
							},
						],
						filter: [
							{ equals: { path: "agentId", value: agentId } },
							{ equals: { path: "scope", value: scope } },
							{ equals: { path: "scopeRef", value: scopeRef } },
						],
					},
				},
			},
			{ $limit: maxResults },
		]

		const docs = await collection
			// P3.8: user-driven $search pipelines carry a maxTimeMS ceiling.
			.aggregate(pipeline, { maxTimeMS: resolveUserSearchMaxTimeMs() })
			.toArray()
		return docs as unknown as Entity[]
	} catch (err) {
		log.warn(
			`searchEntitiesAutocomplete $search failed, falling back to regex: ${err instanceof Error ? err.message : String(err)}`,
		)
		// Fallback to findEntitiesByName
		return findEntitiesByName({
			db,
			prefix,
			query,
			agentId,
			scope,
			scopeRef,
			limit: maxResults,
		})
	}
}

// ---------------------------------------------------------------------------
// Relation locator lookup (P3.8)
// ---------------------------------------------------------------------------

/**
 * Resolve a relation by its locator id ("fromEntityId-toEntityId", the id
 * embedded in `relation:` chunk paths) with a single findOne on the
 * idx_relations_agent_scope_scoperef_relationid index.
 *
 * Relations written before the relationId field existed fall back to the
 * legacy bounded scan (up to 50 most-recent relations, JS-matched) so old
 * deployments keep resolving until those edges are re-upserted.
 */
export async function findRelationByLocatorId(params: {
	db: Db
	prefix: string
	agentId: string
	scope: MemoryScope
	scopeRef: string
	relationId: string
}): Promise<Document | null> {
	const { db, prefix, agentId, scope, scopeRef, relationId } = params
	const collection = relationsCollection(db, prefix)
	const direct = await collection.findOne(
		{ agentId, scope, scopeRef, relationId },
		{ sort: { updatedAt: -1, _id: 1 } },
	)
	if (direct) {
		return direct
	}
	const candidates = await collection
		.find(
			{ agentId, scope, scopeRef },
			{
				sort: { updatedAt: -1, _id: 1 },
				limit: 50,
			},
		)
		.toArray()
	return (
		candidates.find((candidate) => {
			const fromEntityId = String(candidate.fromEntityId ?? "")
			const toEntityId = String(candidate.toEntityId ?? "")
			return `${fromEntityId}-${toEntityId}` === relationId
		}) ?? null
	)
}
