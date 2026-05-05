import type {
	ClientSession,
	Collection,
	Db,
	Document,
	MongoClient,
} from "mongodb"
import {
	type MemoryMongoDBEmbeddingMode,
	type MemoryScope,
	createSubsystemLogger,
} from "@memongo/lib"
import type { EmbeddingStatus } from "./mongodb-embedding-retry.js"
import { recordMutation, type MutationMeta } from "./mongodb-mutations.js"
import { summarizeExplain } from "./mongodb-relevance.js"
import type { DetectedCapabilities } from "./mongodb-schema.js"
import {
	structuredMemCollection,
	structuredMemRevisionsCollection,
} from "./mongodb-schema.js"
import { resolveScopeRef } from "./mongodb-scope.js"
import {
	buildVectorSearchStage,
	MONGODB_MAX_NUM_CANDIDATES,
	runSearchAggregateWithRetry,
	type SearchExplainOptions,
} from "./mongodb-search.js"
import {
	buildCurrentValidityClause,
	mergeQueryClauses,
	resolveTemporalAsOf,
} from "./mongodb-temporal.js"
import type {
	MemoryActorRole,
	MemoryFeedbackSignal,
	MemoryLifecycleItem,
	MemorySearchResult,
	MemorySourceAgent,
	MemoryStructuredStableHandle,
} from "./types.js"

const log = createSubsystemLogger("memory:mongodb:structured")

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type StructuredMemoryType =
	| "decision"
	| "preference"
	| "person"
	| "todo"
	| "fact"
	| "project"
	| "architecture"
	| "contact"
	| "milestone"
	| "problem"
	| "emotional"
	| "identity"
	| "instruction"
	| "custom"

export type StructuredMemorySalience = "critical" | "high" | "normal" | "low"
export type StructuredMemoryTemporalScope =
	| "ongoing"
	| "bounded"
	| "permanent"
	| "transient"
export type StructuredMemoryState = "active" | "invalidated" | "conflicted"

export type StructuredMemoryEntry = {
	type: StructuredMemoryType
	key: string
	value: string
	context?: string
	confidence?: number
	source?: "agent" | "user" | "session" | "ingestion"
	sessionId?: string
	agentId: string
	tags?: string[]
	scope?: MemoryScope
	scopeRef?: string
	workspaceDir?: string
	userId?: string
	tenantId?: string
	salience?: StructuredMemorySalience
	temporalScope?: StructuredMemoryTemporalScope
	provenance?: Record<string, unknown>
	sourceEventIds?: string[]
	state?: StructuredMemoryState
	validTo?: Date
	reviewAt?: Date
	lastConfirmedAt?: Date
	openedAt?: Date
	openedCount?: number
	lastUsedAt?: Date
	reinforcementCount?: number
	sourceReliability?: number
	sourceAgent?: MemorySourceAgent
	/** Code/config stored as first-class memory (Phase 3.6). */
	artifact?: import("./types.js").MemoryArtifact
}

export type StructuredMemoryLifecyclePatch = Partial<
	Pick<
		StructuredMemoryEntry,
		| "value"
		| "context"
		| "confidence"
		| "source"
		| "sessionId"
		| "tags"
		| "salience"
		| "temporalScope"
		| "provenance"
		| "sourceEventIds"
		| "validTo"
		| "reviewAt"
		| "lastConfirmedAt"
		| "sourceReliability"
		| "sourceAgent"
		| "artifact"
	>
>

type StructuredMemoryRevision = {
	type: StructuredMemoryType
	key: string
	value: string
	context?: string
	confidence?: number
	source?: "agent" | "user" | "session" | "ingestion"
	sessionId?: string
	agentId: string
	tags?: string[]
	scope: MemoryScope
	scopeRef: string
	revision: number
	state: StructuredMemoryState
	salience: StructuredMemorySalience
	temporalScope: StructuredMemoryTemporalScope
	provenance?: Record<string, unknown>
	sourceEventIds?: string[]
	sourceReliability?: number
	reinforcementCount?: number
	validFrom: Date
	validTo: Date
	supersededAt: Date
	reviewAt?: Date
	lastConfirmedAt?: Date
	supersedes?: Record<string, unknown>
	invalidatedBy?: Record<string, unknown>
	conflictsWith?: Record<string, unknown>[]
	createdAt?: Date
	updatedAt: Date
}

function computeChangedFields(oldDoc: Document, newDoc: Document): string[] {
	const fields = new Set<string>()
	const allKeys = new Set([...Object.keys(oldDoc), ...Object.keys(newDoc)])
	for (const key of allKeys) {
		if (key === "_id" || key === "updatedAt" || key === "createdAt") {
			continue
		}
		const oldVal = JSON.stringify(oldDoc[key] ?? null)
		const newVal = JSON.stringify(newDoc[key] ?? null)
		if (oldVal !== newVal) {
			fields.add(key)
		}
	}
	return Array.from(fields)
}

function applyStructuredConfirmationSnapshot(
	doc: Document,
	now: Date,
): Document {
	const updated = structuredClone(doc) as Document
	updated.updatedAt = now
	updated.lastConfirmedAt = now
	updated.reinforcementCount = Number(updated.reinforcementCount ?? 0) + 1
	return updated
}

function arraysEqual(
	left: string[] | undefined,
	right: string[] | undefined,
): boolean {
	const a = left ?? []
	const b = right ?? []
	return a.length === b.length && a.every((value, index) => value === b[index])
}

function hasStructuredValueChanged(
	existing: Document,
	entry: StructuredMemoryEntry,
): boolean {
	return (
		existing.value !== entry.value ||
		(typeof existing.context === "string" ? existing.context : undefined) !==
			entry.context ||
		(typeof existing.confidence === "number"
			? existing.confidence
			: undefined) !== entry.confidence ||
		(typeof existing.source === "string" ? existing.source : undefined) !==
			entry.source ||
		(typeof existing.sessionId === "string"
			? existing.sessionId
			: undefined) !== entry.sessionId ||
		(typeof existing.salience === "string" ? existing.salience : undefined) !==
			entry.salience ||
		(typeof existing.temporalScope === "string"
			? existing.temporalScope
			: undefined) !== entry.temporalScope ||
		(typeof existing.state === "string" ? existing.state : undefined) !==
			entry.state ||
		(typeof existing.sourceReliability === "number"
			? existing.sourceReliability
			: undefined) !== entry.sourceReliability ||
		JSON.stringify(existing.provenance ?? null) !==
			JSON.stringify(entry.provenance ?? null) ||
		!arraysEqual(
			Array.isArray(existing.sourceEventIds)
				? existing.sourceEventIds.map((value) => String(value))
				: undefined,
			entry.sourceEventIds,
		) ||
		!arraysEqual(
			Array.isArray(existing.tags)
				? existing.tags.map((tag) => String(tag))
				: undefined,
			entry.tags,
		)
	)
}

function inferSalience(entry: StructuredMemoryEntry): StructuredMemorySalience {
	if (entry.salience) {
		return entry.salience
	}
	const haystack =
		`${entry.value} ${entry.context ?? ""} ${(entry.tags ?? []).join(" ")}`.toLowerCase()
	if (
		/\b(war|crisis|emergency|safety|danger|urgent|critical)\b/.test(haystack)
	) {
		return "critical"
	}
	if (
		/\b(blocker|blocked|constraint|right now|currently|active)\b/.test(haystack)
	) {
		return "high"
	}
	if (entry.type === "preference" || entry.type === "decision") {
		return "high"
	}
	if (entry.type === "todo") {
		return "normal"
	}
	return "normal"
}

function inferTemporalScope(
	entry: StructuredMemoryEntry,
): StructuredMemoryTemporalScope {
	if (entry.temporalScope) {
		return entry.temporalScope
	}
	switch (entry.type) {
		case "preference":
		case "person":
		case "architecture":
		case "decision":
			return "permanent"
		case "project":
		case "todo":
		case "fact":
			return "ongoing"
		default:
			return "transient"
	}
}

function inferSourceReliability(entry: StructuredMemoryEntry): number {
	if (typeof entry.sourceReliability === "number") {
		return entry.sourceReliability
	}
	switch (entry.source) {
		case "user":
			return 0.95
		case "ingestion":
			return 0.85
		case "session":
			return 0.8
		default:
			return 0.75
	}
}

function inferReviewAt(params: {
	entry: StructuredMemoryEntry
	salience: StructuredMemorySalience
	temporalScope: StructuredMemoryTemporalScope
	now: Date
}): Date | undefined {
	if (params.entry.reviewAt) {
		return params.entry.reviewAt
	}
	if (params.entry.validTo) {
		return params.entry.validTo
	}
	if (params.temporalScope === "bounded") {
		return new Date(params.now.getTime() + 7 * 24 * 60 * 60 * 1000)
	}
	if (params.temporalScope === "ongoing" && params.salience === "critical") {
		return new Date(params.now.getTime() + 24 * 60 * 60 * 1000)
	}
	if (params.temporalScope === "ongoing" && params.salience === "high") {
		return new Date(params.now.getTime() + 3 * 24 * 60 * 60 * 1000)
	}
	if (params.temporalScope === "transient") {
		return new Date(params.now.getTime() + 24 * 60 * 60 * 1000)
	}
	return undefined
}

function buildRevisionDoc(params: {
	existing: Document
	scope: MemoryScope
	scopeRef: string
	now: Date
}): StructuredMemoryRevision {
	const revision =
		typeof params.existing.revision === "number" &&
		Number.isFinite(params.existing.revision)
			? params.existing.revision
			: 1
	const validFrom =
		params.existing.validFrom instanceof Date
			? params.existing.validFrom
			: params.existing.createdAt instanceof Date
				? params.existing.createdAt
				: params.existing.updatedAt instanceof Date
					? params.existing.updatedAt
					: params.now

	return {
		type: params.existing.type as StructuredMemoryType,
		key: String(params.existing.key ?? ""),
		value: String(params.existing.value ?? ""),
		agentId: String(params.existing.agentId ?? ""),
		scope: params.scope,
		scopeRef: params.scopeRef,
		revision,
		state:
			typeof params.existing.state === "string"
				? (params.existing.state as StructuredMemoryState)
				: "active",
		salience:
			typeof params.existing.salience === "string"
				? (params.existing.salience as StructuredMemorySalience)
				: "normal",
		temporalScope:
			typeof params.existing.temporalScope === "string"
				? (params.existing.temporalScope as StructuredMemoryTemporalScope)
				: "permanent",
		validFrom,
		validTo: params.now,
		supersededAt: params.now,
		updatedAt:
			params.existing.updatedAt instanceof Date
				? params.existing.updatedAt
				: params.now,
		...(typeof params.existing.context === "string"
			? { context: params.existing.context }
			: {}),
		...(typeof params.existing.confidence === "number"
			? { confidence: params.existing.confidence }
			: {}),
		...(typeof params.existing.source === "string"
			? { source: params.existing.source as StructuredMemoryEntry["source"] }
			: {}),
		...(typeof params.existing.sourceReliability === "number"
			? { sourceReliability: params.existing.sourceReliability }
			: {}),
		...(typeof params.existing.sessionId === "string"
			? { sessionId: params.existing.sessionId }
			: {}),
		...(Array.isArray(params.existing.tags)
			? { tags: params.existing.tags.map((tag) => String(tag)) }
			: {}),
		...(Array.isArray(params.existing.sourceEventIds)
			? {
					sourceEventIds: params.existing.sourceEventIds.map((value) =>
						String(value),
					),
				}
			: {}),
		...(params.existing.provenance &&
		typeof params.existing.provenance === "object"
			? { provenance: params.existing.provenance as Record<string, unknown> }
			: {}),
		...(typeof params.existing.reinforcementCount === "number"
			? { reinforcementCount: params.existing.reinforcementCount }
			: {}),
		...(params.existing.reviewAt instanceof Date
			? { reviewAt: params.existing.reviewAt }
			: {}),
		...(params.existing.lastConfirmedAt instanceof Date
			? { lastConfirmedAt: params.existing.lastConfirmedAt }
			: {}),
		...(params.existing.supersedes &&
		typeof params.existing.supersedes === "object"
			? { supersedes: params.existing.supersedes as Record<string, unknown> }
			: {}),
		...(params.existing.invalidatedBy &&
		typeof params.existing.invalidatedBy === "object"
			? {
					invalidatedBy: params.existing.invalidatedBy as Record<
						string,
						unknown
					>,
				}
			: {}),
		...(Array.isArray(params.existing.conflictsWith)
			? {
					conflictsWith: params.existing.conflictsWith.filter(
						(value): value is Record<string, unknown> =>
							Boolean(value && typeof value === "object"),
					),
				}
			: {}),
		...(params.existing.createdAt instanceof Date
			? { createdAt: params.existing.createdAt }
			: {}),
	}
}

function structuredFilterFromHandle(
	handle: MemoryStructuredStableHandle,
): Document {
	return {
		agentId: handle.agentId,
		scope: handle.scope,
		scopeRef: handle.scopeRef,
		type: handle.structured.type,
		key: handle.structured.key,
	}
}

function structuredRevisionFromDoc(doc: Document): number {
	return typeof doc.revision === "number" && Number.isFinite(doc.revision)
		? doc.revision
		: 1
}

function structuredStateFromDoc(doc: Document): StructuredMemoryState {
	return doc.state === "invalidated" || doc.state === "conflicted"
		? doc.state
		: "active"
}

function structuredHandleFromDoc(doc: Document): MemoryStructuredStableHandle {
	const type = String(doc.type ?? "")
	const key = String(doc.key ?? "")
	const agentId = String(doc.agentId ?? "")
	const scope =
		typeof doc.scope === "string" ? (doc.scope as MemoryScope) : "agent"
	const scopeRef = String(doc.scopeRef ?? doc.agentId ?? "")
	return {
		family: "structured",
		id: ["structured", agentId, scope, scopeRef, type, key]
			.map((value) => encodeURIComponent(value))
			.join(":"),
		agentId,
		scope,
		scopeRef,
		revision: structuredRevisionFromDoc(doc),
		state: structuredStateFromDoc(doc),
		structured: { type, key },
		...(doc.validFrom instanceof Date ? { validFrom: doc.validFrom } : {}),
		...(doc.validTo instanceof Date ? { validTo: doc.validTo } : {}),
		...(doc.updatedAt instanceof Date ? { updatedAt: doc.updatedAt } : {}),
	}
}

function structuredLifecycleItemFromDoc(
	doc: Document,
): Extract<MemoryLifecycleItem, { family: "structured" }> {
	return {
		family: "structured",
		handle: structuredHandleFromDoc(doc),
		data: {
			type: String(doc.type ?? ""),
			key: String(doc.key ?? ""),
			value: String(doc.value ?? ""),
			...(typeof doc.context === "string" ? { context: doc.context } : {}),
			...(typeof doc.confidence === "number"
				? { confidence: doc.confidence }
				: {}),
			...(typeof doc.source === "string" ? { source: doc.source } : {}),
			...(typeof doc.sessionId === "string"
				? { sessionId: doc.sessionId }
				: {}),
			...(Array.isArray(doc.tags)
				? { tags: doc.tags.map((tag) => String(tag)) }
				: {}),
			...(typeof doc.salience === "string" ? { salience: doc.salience } : {}),
			...(typeof doc.temporalScope === "string"
				? { temporalScope: doc.temporalScope }
				: {}),
			...(doc.provenance && typeof doc.provenance === "object"
				? { provenance: doc.provenance as Record<string, unknown> }
				: {}),
			...(Array.isArray(doc.sourceEventIds)
				? { sourceEventIds: doc.sourceEventIds.map((value) => String(value)) }
				: {}),
			...(typeof doc.sourceReliability === "number"
				? { sourceReliability: doc.sourceReliability }
				: {}),
			...(typeof doc.reinforcementCount === "number"
				? { reinforcementCount: doc.reinforcementCount }
				: {}),
			...(doc.reviewAt instanceof Date ? { reviewAt: doc.reviewAt } : {}),
			...(doc.lastConfirmedAt instanceof Date
				? { lastConfirmedAt: doc.lastConfirmedAt }
				: {}),
			...(doc.sourceAgent && typeof doc.sourceAgent === "object"
				? { sourceAgent: doc.sourceAgent as MemorySourceAgent }
				: {}),
			...(doc.artifact && typeof doc.artifact === "object"
				? {
						artifact: doc.artifact as import("./types.js").MemoryArtifact,
					}
				: {}),
		},
		...(doc.createdAt instanceof Date ? { createdAt: doc.createdAt } : {}),
		...(doc.updatedAt instanceof Date ? { updatedAt: doc.updatedAt } : {}),
	}
}

function structuredEntryFromDoc(
	doc: Document,
	patch: StructuredMemoryLifecyclePatch,
): StructuredMemoryEntry {
	const entry: StructuredMemoryEntry = {
		type: String(doc.type ?? "custom") as StructuredMemoryType,
		key: String(doc.key ?? ""),
		value: String(doc.value ?? ""),
		agentId: String(doc.agentId ?? ""),
		scope: typeof doc.scope === "string" ? (doc.scope as MemoryScope) : "agent",
		scopeRef: String(doc.scopeRef ?? doc.agentId ?? ""),
		...(typeof doc.context === "string" ? { context: doc.context } : {}),
		...(typeof doc.confidence === "number"
			? { confidence: doc.confidence }
			: {}),
		...(typeof doc.source === "string"
			? { source: doc.source as StructuredMemoryEntry["source"] }
			: {}),
		...(typeof doc.sessionId === "string" ? { sessionId: doc.sessionId } : {}),
		...(Array.isArray(doc.tags)
			? { tags: doc.tags.map((tag) => String(tag)) }
			: {}),
		...(typeof doc.salience === "string"
			? { salience: doc.salience as StructuredMemorySalience }
			: {}),
		...(typeof doc.temporalScope === "string"
			? { temporalScope: doc.temporalScope as StructuredMemoryTemporalScope }
			: {}),
		...(doc.provenance && typeof doc.provenance === "object"
			? { provenance: doc.provenance as Record<string, unknown> }
			: {}),
		...(Array.isArray(doc.sourceEventIds)
			? { sourceEventIds: doc.sourceEventIds.map((value) => String(value)) }
			: {}),
		...(typeof doc.sourceReliability === "number"
			? { sourceReliability: doc.sourceReliability }
			: {}),
		...(doc.reviewAt instanceof Date ? { reviewAt: doc.reviewAt } : {}),
		...(doc.validTo instanceof Date ? { validTo: doc.validTo } : {}),
		...(doc.lastConfirmedAt instanceof Date
			? { lastConfirmedAt: doc.lastConfirmedAt }
			: {}),
		...(doc.sourceAgent && typeof doc.sourceAgent === "object"
			? { sourceAgent: doc.sourceAgent as MemorySourceAgent }
			: {}),
		...(doc.artifact && typeof doc.artifact === "object"
			? { artifact: doc.artifact as import("./types.js").MemoryArtifact }
			: {}),
	}
	return { ...entry, ...patch }
}

// ---------------------------------------------------------------------------
// Write (upsert)
// ---------------------------------------------------------------------------

export async function writeStructuredMemory(params: {
	db: Db
	prefix: string
	entry: StructuredMemoryEntry
	embeddingMode: MemoryMongoDBEmbeddingMode
	client?: MongoClient
	session?: ClientSession
	actorRole?: MemoryActorRole
	mutationMeta?: MutationMeta
}): Promise<{ upserted: boolean; id: string }> {
	const { db, prefix, entry } = params
	const collection = structuredMemCollection(db, prefix)
	const revisions = structuredMemRevisionsCollection(db, prefix)

	// Memongo stores structured memory as text and relies on MongoDB automatic
	// embeddings during vector search instead of precomputing vectors here.
	const embeddingStatus: EmbeddingStatus = "pending"

	const now = new Date()
	const scope = entry.scope ?? "agent"
	const scopeRef = resolveScopeRef({
		scope,
		scopeRef: entry.scopeRef,
		agentId: entry.agentId,
		sessionId: entry.sessionId,
		workspaceDir: entry.workspaceDir,
		userId: entry.userId,
		tenantId: entry.tenantId,
	})
	const salience = inferSalience(entry)
	const temporalScope = inferTemporalScope(entry)
	const sourceReliability = inferSourceReliability(entry)
	const state = entry.state ?? "active"
	const reviewAt = inferReviewAt({ entry, salience, temporalScope, now })
	const lastConfirmedAt = entry.lastConfirmedAt ?? now
	const setDoc: Document = {
		type: entry.type,
		key: entry.key,
		value: entry.value,
		agentId: entry.agentId,
		scope,
		scopeRef,
		embeddingStatus,
		state,
		salience,
		temporalScope,
		sourceReliability,
		lastConfirmedAt,
		validFrom: now,
		updatedAt: now,
	}
	if (entry.context !== undefined) {
		setDoc.context = entry.context
	}
	if (entry.confidence !== undefined) {
		setDoc.confidence = entry.confidence
	}
	if (entry.source !== undefined) {
		setDoc.source = entry.source
	}
	if (entry.sessionId !== undefined) {
		setDoc.sessionId = entry.sessionId
	}
	if (entry.tags !== undefined) {
		setDoc.tags = entry.tags
	}
	if (entry.provenance !== undefined) {
		setDoc.provenance = entry.provenance
	}
	if (entry.sourceEventIds !== undefined) {
		setDoc.sourceEventIds = entry.sourceEventIds
	}
	if (reviewAt !== undefined) {
		setDoc.reviewAt = reviewAt
	}
	if (entry.validTo !== undefined) {
		setDoc.validTo = entry.validTo
	}
	if (entry.openedAt !== undefined) {
		setDoc.openedAt = entry.openedAt
	}
	if (entry.lastUsedAt !== undefined) {
		setDoc.lastUsedAt = entry.lastUsedAt
	}
	if (entry.openedCount !== undefined) {
		setDoc.openedCount = entry.openedCount
	}
	if (entry.reinforcementCount !== undefined) {
		setDoc.reinforcementCount = entry.reinforcementCount
	}
	if (entry.sourceAgent !== undefined) {
		setDoc.sourceAgent = entry.sourceAgent
	}
	if (entry.artifact !== undefined) {
		setDoc.artifact = entry.artifact
	}

	const identityFilter = {
		agentId: entry.agentId,
		scope,
		scopeRef,
		type: entry.type,
		key: entry.key,
	}

	// Captured for fire-and-forget audit after persist completes
	let existingBeforeWrite: Document | null = null

	const persist = async (
		session?: ClientSession,
	): Promise<{ upserted: boolean; id: string; revision: number }> => {
		const existing = await collection.findOne(
			identityFilter,
			session ? { session } : undefined,
		)
		existingBeforeWrite = existing
		if (!existing) {
			const result = await collection.updateOne(
				identityFilter,
				{
					$set: {
						...setDoc,
						revision: 1,
						reinforcementCount: entry.reinforcementCount ?? 1,
					},
					$setOnInsert: { createdAt: now, openedCount: entry.openedCount ?? 0 },
				},
				{ upsert: true, ...(session ? { session } : {}) },
			)
			return {
				upserted: result.upsertedCount > 0,
				id: result.upsertedId ? String(result.upsertedId) : entry.key,
				revision: 1,
			}
		}

		const currentRevision =
			typeof existing.revision === "number" &&
			Number.isFinite(existing.revision)
				? existing.revision
				: 1
		const currentValidFrom =
			existing.validFrom instanceof Date
				? existing.validFrom
				: existing.createdAt instanceof Date
					? existing.createdAt
					: existing.updatedAt instanceof Date
						? existing.updatedAt
						: now

		if (!hasStructuredValueChanged(existing, entry)) {
			await collection.updateOne(
				identityFilter,
				{
					$set: {
						...setDoc,
						revision: currentRevision,
						validFrom: currentValidFrom,
						lastConfirmedAt: now,
					},
					$inc: {
						reinforcementCount: 1,
					},
				},
				session ? { session } : {},
			)
			return { upserted: false, id: entry.key, revision: currentRevision }
		}

		await revisions.insertOne(
			buildRevisionDoc({ existing, scope, scopeRef, now }),
			session ? { session } : {},
		)
		const nextSetDoc: Document = {
			...setDoc,
			revision: currentRevision + 1,
			validFrom: now,
			supersedes: {
				revision: currentRevision,
				type: String(existing.type ?? entry.type),
				key: String(existing.key ?? entry.key),
			},
		}
		if (state === "conflicted") {
			nextSetDoc.conflictsWith = [
				{
					revision: currentRevision,
					type: String(existing.type ?? entry.type),
					key: String(existing.key ?? entry.key),
				},
			]
		}

		await collection.updateOne(
			identityFilter,
			{
				$set: nextSetDoc,
				$setOnInsert: {
					createdAt:
						existing.createdAt instanceof Date ? existing.createdAt : now,
					openedCount:
						typeof existing.openedCount === "number" ? existing.openedCount : 0,
				},
			},
			{ upsert: true, ...(session ? { session } : {}) },
		)
		return { upserted: false, id: entry.key, revision: currentRevision + 1 }
	}

	const client = params.client
	const outcome = params.session
		? await persist(params.session)
		: client
			? await (async () => {
					const session = client.startSession()
					try {
						let result:
							| { upserted: boolean; id: string; revision: number }
							| undefined
						await session.withTransaction(async () => {
							result = await persist(session)
						})
						return result ?? { upserted: false, id: entry.key, revision: 1 }
					} catch (err) {
						const message = err instanceof Error ? err.message : String(err)
						log.warn(
							`structured memory transaction unavailable, falling back to sequential writes: ${message}`,
						)
						return await persist()
					} finally {
						await session.endSession()
					}
				})()
			: await persist()

	log.info(
		`structured memory ${outcome.upserted ? "created" : "updated"}: type=${entry.type} key=${entry.key} revision=${outcome.revision}`,
	)

	// Fire-and-forget: record mutation audit trail (non-blocking)
	const oldSnapshot = existingBeforeWrite
	const changedFields =
		oldSnapshot != null ? computeChangedFields(oldSnapshot, setDoc) : undefined
	Promise.allSettled([
		recordMutation({
			db,
			prefix,
			mutation: {
				collectionName: "structured_mem",
				documentId: entry.key,
				operation: oldSnapshot == null ? "create" : "update",
				agentId: entry.agentId,
				oldValue: oldSnapshot ?? null,
				newValue: setDoc,
				changedFields,
				actorRole: params.actorRole ?? "system",
				...(params.mutationMeta ? { meta: params.mutationMeta } : {}),
			},
		}),
	]).catch((err) => {
		log.warn(
			`structured memory audit failed: ${err instanceof Error ? err.message : String(err)}`,
		)
	})

	return { upserted: outcome.upserted, id: outcome.id }
}

// ---------------------------------------------------------------------------
// Lifecycle ergonomics
// ---------------------------------------------------------------------------

export async function getStructuredMemoryByHandle(params: {
	db: Db
	prefix: string
	handle: MemoryStructuredStableHandle
}): Promise<Extract<MemoryLifecycleItem, { family: "structured" }> | null> {
	const doc = await structuredMemCollection(params.db, params.prefix).findOne(
		structuredFilterFromHandle(params.handle),
	)
	return doc ? structuredLifecycleItemFromDoc(doc) : null
}

export async function updateStructuredMemoryByHandle(params: {
	db: Db
	prefix: string
	handle: MemoryStructuredStableHandle
	patch: StructuredMemoryLifecyclePatch
	embeddingMode: MemoryMongoDBEmbeddingMode
	client?: MongoClient
	actorRole?: MemoryActorRole
	mutationMeta?: MutationMeta
}): Promise<Extract<MemoryLifecycleItem, { family: "structured" }> | null> {
	const collection = structuredMemCollection(params.db, params.prefix)
	const existing = await collection.findOne(
		structuredFilterFromHandle(params.handle),
	)
	if (!existing) {
		return null
	}
	await writeStructuredMemory({
		db: params.db,
		prefix: params.prefix,
		entry: structuredEntryFromDoc(existing, params.patch),
		embeddingMode: params.embeddingMode,
		client: params.client,
		actorRole: params.actorRole,
		mutationMeta: params.mutationMeta,
	})
	return getStructuredMemoryByHandle(params)
}

export async function invalidateStructuredMemoryByHandle(params: {
	db: Db
	prefix: string
	handle: MemoryStructuredStableHandle
	invalidatedBy?: Record<string, unknown>
	client?: MongoClient
	actorRole?: MemoryActorRole
	mutationMeta?: MutationMeta
}): Promise<Extract<MemoryLifecycleItem, { family: "structured" }> | null> {
	const collection = structuredMemCollection(params.db, params.prefix)
	const revisions = structuredMemRevisionsCollection(params.db, params.prefix)
	const filter = structuredFilterFromHandle(params.handle)
	const now = new Date()
	let oldSnapshot: Document | null = null
	let newSnapshot: Document | null = null
	let changed = false

	const persist = async (session?: ClientSession) => {
		const existing = await collection.findOne(
			filter,
			session ? { session } : undefined,
		)
		if (!existing) {
			return
		}
		oldSnapshot = existing
		if (structuredStateFromDoc(existing) === "invalidated") {
			newSnapshot = existing
			return
		}
		const currentRevision = structuredRevisionFromDoc(existing)
		const scope =
			typeof existing.scope === "string"
				? (existing.scope as MemoryScope)
				: params.handle.scope
		const scopeRef = String(existing.scopeRef ?? params.handle.scopeRef)
		await revisions.insertOne(
			buildRevisionDoc({ existing, scope, scopeRef, now }),
			session ? { session } : {},
		)
		await collection.updateOne(
			filter,
			{
				$set: {
					state: "invalidated",
					validTo: now,
					updatedAt: now,
					revision: currentRevision + 1,
					invalidatedBy: params.invalidatedBy ?? { reason: "lifecycle" },
				},
			},
			session ? { session } : {},
		)
		newSnapshot = await collection.findOne(
			filter,
			session ? { session } : undefined,
		)
		changed = true
	}

	if (params.client) {
		const session = params.client.startSession()
		try {
			await session.withTransaction(async () => {
				await persist(session)
			})
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err)
			log.warn(
				`structured lifecycle transaction unavailable, falling back to sequential writes: ${message}`,
			)
			await persist()
		} finally {
			await session.endSession()
		}
	} else {
		await persist()
	}

	if (!newSnapshot) {
		return null
	}
	if (changed) {
		recordMutation({
			db: params.db,
			prefix: params.prefix,
			mutation: {
				collectionName: "structured_mem",
				documentId: structuredHandleFromDoc(newSnapshot).id,
				operation: "invalidate",
				agentId: params.handle.agentId,
				oldValue: oldSnapshot,
				newValue: newSnapshot,
				changedFields: ["state", "validTo", "revision", "invalidatedBy"],
				actorRole: params.actorRole ?? "system",
				...(params.mutationMeta ? { meta: params.mutationMeta } : {}),
			},
		}).catch((err) => {
			log.warn("structured memory invalidate audit failed", { error: err })
		})
	}
	return structuredLifecycleItemFromDoc(newSnapshot)
}

export async function applyStructuredMemoryFeedbackByHandle(params: {
	db: Db
	prefix: string
	handle: MemoryStructuredStableHandle
	signal: MemoryFeedbackSignal
	patch?: StructuredMemoryLifecyclePatch
	invalidatedBy?: Record<string, unknown>
	note?: string
	embeddingMode: MemoryMongoDBEmbeddingMode
	client?: MongoClient
	actorRole?: MemoryActorRole
}): Promise<Extract<MemoryLifecycleItem, { family: "structured" }> | null> {
	const actorRole = params.actorRole ?? "user"
	const mutationMeta: MutationMeta = {
		source: "memory-feedback",
		signal: params.signal,
		...(typeof params.note === "string" && params.note.trim()
			? { note: params.note }
			: {}),
	}

	if (params.signal === "correct") {
		if (!params.patch || Object.keys(params.patch).length === 0) {
			throw new Error("correct feedback requires a structured patch")
		}
		return updateStructuredMemoryByHandle({
			db: params.db,
			prefix: params.prefix,
			handle: params.handle,
			patch: params.patch,
			embeddingMode: params.embeddingMode,
			client: params.client,
			actorRole,
			mutationMeta,
		})
	}

	if (params.signal === "irrelevant") {
		return invalidateStructuredMemoryByHandle({
			db: params.db,
			prefix: params.prefix,
			handle: params.handle,
			invalidatedBy:
				params.invalidatedBy ??
				({
					reason: "feedback",
					signal: "irrelevant",
					...(typeof params.note === "string" && params.note.trim()
						? { note: params.note }
						: {}),
				} as Record<string, unknown>),
			client: params.client,
			actorRole,
			mutationMeta,
		})
	}

	const collection = structuredMemCollection(params.db, params.prefix)
	const filter = structuredFilterFromHandle(params.handle)
	const now = new Date()
	const oldSnapshot = await collection.findOneAndUpdate(
		filter,
		{
			$set: {
				lastConfirmedAt: now,
				updatedAt: now,
			},
			$inc: {
				reinforcementCount: 1,
			},
		},
		{ returnDocument: "before" },
	)
	if (!oldSnapshot) {
		return null
	}
	const updated = applyStructuredConfirmationSnapshot(oldSnapshot, now)
	recordMutation({
		db: params.db,
		prefix: params.prefix,
		mutation: {
			collectionName: "structured_mem",
			documentId: structuredHandleFromDoc(updated).id,
			operation: "update",
			agentId: params.handle.agentId,
			oldValue: oldSnapshot,
			newValue: updated,
			changedFields: ["reinforcementCount", "lastConfirmedAt"],
			actorRole,
			meta: mutationMeta,
		},
	}).catch((err) => {
		log.warn("structured memory feedback audit failed", { error: err })
	})
	return structuredLifecycleItemFromDoc(updated)
}

export async function getStructuredMemoryHistoryByHandle(params: {
	db: Db
	prefix: string
	handle: MemoryStructuredStableHandle
	limit?: number
}): Promise<
	Array<
		Extract<MemoryLifecycleItem, { family: "structured" }> & {
			historyKind: "revision" | "current"
			supersededAt?: Date
		}
	>
> {
	const requested =
		typeof params.limit === "number" && Number.isFinite(params.limit)
			? params.limit
			: 50
	const maxItems = Math.max(1, Math.min(requested, 200))
	const filter = structuredFilterFromHandle(params.handle)
	const revisionLimit = Math.max(0, maxItems - 1)
	const revisionDocs =
		revisionLimit > 0
			? await structuredMemRevisionsCollection(params.db, params.prefix)
					.find(filter, { sort: { revision: -1 }, limit: revisionLimit })
					.toArray()
			: []
	const current = await structuredMemCollection(
		params.db,
		params.prefix,
	).findOne(filter)

	const entries: Array<
		Extract<MemoryLifecycleItem, { family: "structured" }> & {
			historyKind: "revision" | "current"
			supersededAt?: Date
		}
	> = revisionDocs
		.toSorted(
			(a, b) => structuredRevisionFromDoc(a) - structuredRevisionFromDoc(b),
		)
		.map((doc) => ({
			...structuredLifecycleItemFromDoc(doc),
			historyKind: "revision" as const,
			...(doc.supersededAt instanceof Date
				? { supersededAt: doc.supersededAt }
				: {}),
		}))
	if (current) {
		entries.push({
			...structuredLifecycleItemFromDoc(current),
			historyKind: "current" as const,
		})
	}
	return entries
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

function toStructuredResult(doc: Document): MemorySearchResult {
	const params = new URLSearchParams()
	if (typeof doc.scope === "string") {
		params.set("scope", doc.scope)
	}
	if (typeof doc.scopeRef === "string") {
		params.set("scopeRef", doc.scopeRef)
	}
	const locator = `structured:${doc.type ?? "unknown"}:${doc.key ?? ""}${
		params.size > 0 ? `?${params.toString()}` : ""
	}`
	return {
		path: locator,
		startLine: 0,
		endLine: 0,
		score: typeof doc.score === "number" ? Number(doc.score.toFixed(6)) : 0,
		snippet: typeof doc.value === "string" ? doc.value.slice(0, 700) : "",
		source: "structured",
		sourceType: "structured",
		...(typeof doc.sessionId === "string" ? { sessionId: doc.sessionId } : {}),
		...(doc.updatedAt instanceof Date ? { timestamp: doc.updatedAt } : {}),
		...(typeof doc.scope === "string"
			? { scope: doc.scope as MemoryScope }
			: {}),
		...(typeof doc.scopeRef === "string" ? { scopeRef: doc.scopeRef } : {}),
		...(typeof doc.state === "string" ? { state: doc.state } : {}),
		...(doc.provenance && typeof doc.provenance === "object"
			? {
					provenance: {
						...(doc.provenance as Record<string, unknown>),
						...(doc.artifact && typeof doc.artifact === "object"
							? { artifact: doc.artifact }
							: {}),
					},
				}
			: doc.artifact && typeof doc.artifact === "object"
				? { provenance: { artifact: doc.artifact } }
				: {}),
		...(Array.isArray(doc.sourceEventIds)
			? {
					sourceEventIds: doc.sourceEventIds.filter(
						(value): value is string => typeof value === "string",
					),
				}
			: Array.isArray(
						(doc.provenance as { sourceEventIds?: unknown[] } | undefined)
							?.sourceEventIds,
					)
				? {
						sourceEventIds: (
							doc.provenance as { sourceEventIds: unknown[] }
						).sourceEventIds.filter(
							(value): value is string => typeof value === "string",
						),
					}
				: {}),
		...(typeof doc.sourceReliability === "number"
			? { sourceReliability: doc.sourceReliability }
			: {}),
		...(typeof doc.reinforcementCount === "number"
			? { reinforcementCount: doc.reinforcementCount }
			: {}),
		...(doc.validFrom instanceof Date ? { validFrom: doc.validFrom } : {}),
		...(doc.validTo instanceof Date ? { validTo: doc.validTo } : {}),
		...(doc.reviewAt instanceof Date ? { reviewAt: doc.reviewAt } : {}),
		...(doc.lastConfirmedAt instanceof Date
			? { lastConfirmedAt: doc.lastConfirmedAt }
			: {}),
		...(typeof doc.confidence === "number"
			? { confidence: doc.confidence }
			: {}),
	}
}

export async function searchStructuredMemory(
	collection: Collection,
	query: string,
	queryVector: number[] | null,
	opts: {
		maxResults: number
		minScore?: number
		filter?: {
			type?: string
			tags?: string[]
			agentId?: string
			scope?: MemoryScope
			scopeRef?: string
			state?: StructuredMemoryState | StructuredMemoryState[]
			salience?: StructuredMemorySalience[]
			temporalScope?: StructuredMemoryTemporalScope[]
			currentOnly?: boolean
			asOf?: Date
		}
		capabilities: DetectedCapabilities
		vectorIndexName: string
		embeddingMode: MemoryMongoDBEmbeddingMode
		numCandidates?: number
		explain?: SearchExplainOptions
	},
): Promise<MemorySearchResult[]> {
	const minScore = opts.minScore ?? 0.1
	const canVector =
		opts.embeddingMode === "automated"
			? opts.capabilities.vectorSearch
			: queryVector != null && opts.capabilities.vectorSearch

	const numCandidates = Math.min(
		opts.numCandidates ?? Math.max(opts.maxResults * 20, 100),
		MONGODB_MAX_NUM_CANDIDATES,
	)
	const currentAsOf = opts.filter?.currentOnly
		? resolveTemporalAsOf(opts.filter.asOf)
		: undefined
	const buildSearchFilter = (): Document => {
		const filter: Document = {}
		if (opts.filter?.type) {
			filter.type = opts.filter.type
		}
		if (opts.filter?.tags?.length) {
			filter.tags = { $in: opts.filter.tags }
		}
		if (opts.filter?.agentId) {
			filter.agentId = opts.filter.agentId
		}
		if (opts.filter?.scope) {
			filter.scope = opts.filter.scope
		}
		if (opts.filter?.scopeRef) {
			filter.scopeRef = opts.filter.scopeRef
		}
		if (!opts.filter?.currentOnly && opts.filter?.state) {
			filter.state = Array.isArray(opts.filter.state)
				? { $in: opts.filter.state }
				: opts.filter.state
		}
		if (opts.filter?.salience?.length) {
			filter.salience = { $in: opts.filter.salience }
		}
		if (opts.filter?.temporalScope?.length) {
			filter.temporalScope = { $in: opts.filter.temporalScope }
		}
		if (!opts.filter?.currentOnly) {
			return filter
		}
		return mergeQueryClauses(
			filter,
			{ state: "active" },
			buildCurrentValidityClause({ asOf: currentAsOf }),
		)
	}

	// Try vector search (F5: uses shared buildVectorSearchStage)
	if (canVector) {
		try {
			const filter = buildSearchFilter()

			const vsStage = buildVectorSearchStage({
				queryVector,
				queryText: query,
				embeddingMode: opts.embeddingMode,
				indexName: opts.vectorIndexName,
				numCandidates,
				limit: opts.maxResults,
				filter: Object.keys(filter).length > 0 ? filter : undefined,
				textFieldPath: "value", // structured memory stores text in "value" field
			})

			if (vsStage) {
				const pipeline: Document[] = [
					{ $vectorSearch: vsStage },
					{ $limit: opts.maxResults },
					{
						$project: {
							_id: 0,
							type: 1,
							key: 1,
							value: 1,
							context: 1,
							confidence: 1,
							tags: 1,
							scope: 1,
							scopeRef: 1,
							state: 1,
							salience: 1,
							temporalScope: 1,
							sessionId: 1,
							updatedAt: 1,
							provenance: 1,
							sourceEventIds: 1,
							sourceReliability: 1,
							reinforcementCount: 1,
							validFrom: 1,
							validTo: 1,
							reviewAt: 1,
							lastConfirmedAt: 1,
							artifact: 1,
							score: { $meta: "vectorSearchScore" },
						},
					},
				]

				if (opts.explain?.enabled) {
					try {
						const cursor = collection.aggregate(pipeline) as unknown as {
							explain?: (verbosity?: string) => Promise<unknown>
						}
						if (typeof cursor.explain === "function") {
							const explained = await cursor.explain("executionStats")
							opts.explain.onArtifact?.({
								artifactType: "vectorExplain",
								summary: {
									source: "structured",
									...summarizeExplain(explained),
								},
								...(opts.explain.deep ? { rawExplain: explained } : {}),
							})
						}
					} catch (err) {
						log.warn("structured vector explain failed", { error: err })
					}
				}

				const docs = await runSearchAggregateWithRetry(collection, pipeline)
				const results = docs
					.map(toStructuredResult)
					.filter((r) => r.score >= minScore)
				if (results.length > 0) {
					return results
				}
			}
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err)
			log.warn(`structured memory vector search failed: ${msg}`)
		}
	}

	// $text fallback
	try {
		const matchFilter = mergeQueryClauses(
			{ $text: { $search: query } },
			buildSearchFilter(),
		)

		const docs = await collection
			.aggregate([
				{ $match: matchFilter },
				{
					$project: {
						_id: 0,
						type: 1,
						key: 1,
						value: 1,
						context: 1,
						confidence: 1,
						tags: 1,
						scope: 1,
						scopeRef: 1,
						state: 1,
						salience: 1,
						temporalScope: 1,
						sessionId: 1,
						updatedAt: 1,
						provenance: 1,
						sourceEventIds: 1,
						sourceReliability: 1,
						reinforcementCount: 1,
						validFrom: 1,
						validTo: 1,
						reviewAt: 1,
						lastConfirmedAt: 1,
						artifact: 1,
						score: { $meta: "textScore" },
					},
				},
				{ $sort: { score: { $meta: "textScore" } } },
				{ $limit: opts.maxResults },
			])
			.toArray()
		if (opts.explain?.enabled) {
			opts.explain.onArtifact?.({
				artifactType: "searchExplain",
				summary: { source: "structured", method: "$text" },
			})
		}
		return docs.map(toStructuredResult).filter((r) => r.score >= minScore)
	} catch {
		log.warn(
			"structured memory $text search fallback failed; returning empty results",
		)
		return []
	}
}

// ---------------------------------------------------------------------------
// Query by type
// ---------------------------------------------------------------------------

export async function getStructuredMemoryByType(
	db: Db,
	prefix: string,
	type: string,
	agentId?: string,
	limit?: number,
): Promise<
	Array<{
		type: string
		key: string
		value: string
		confidence: number
		updatedAt: Date
	}>
> {
	const collection = structuredMemCollection(db, prefix)
	const filter: Document = { type }
	if (agentId) {
		filter.agentId = agentId
	}
	const docs = await collection
		.find(filter, { sort: { updatedAt: -1 }, limit: limit ?? 50 })
		.toArray()

	return docs.map((doc: Record<string, unknown>) => ({
		type: doc.type as string,
		key: doc.key as string,
		value: doc.value as string,
		confidence: (doc.confidence as number) ?? 0.8,
		updatedAt: doc.updatedAt as Date,
	}))
}
