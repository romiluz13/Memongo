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
import { recordMutation, type MutationMeta } from "./mongodb-mutations.js"
import { summarizeExplain } from "./mongodb-relevance.js"
import type { DetectedCapabilities } from "./mongodb-schema.js"
import {
	procedureRevisionsCollection,
	proceduresCollection,
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
	MemoryLifecycleItem,
	MemoryProcedureStableHandle,
	MemorySearchResult,
	MemorySourceAgent,
} from "./types.js"

const log = createSubsystemLogger("memory:mongodb:procedures")

export type ProcedureState = "active" | "invalidated" | "conflicted"

export type ProcedureEntry = {
	procedureId: string
	name: string
	intentTags?: string[]
	triggerQueries?: string[]
	steps: string[]
	successSignals?: string[]
	confidence?: number
	state?: ProcedureState
	provenance?: Record<string, unknown>
	sourceEventIds?: string[]
	agentId: string
	scope?: MemoryScope
	scopeRef?: string
	workspaceDir?: string
	sessionId?: string
	userId?: string
	tenantId?: string
	sourceAgent?: MemorySourceAgent
}

export type ProcedureLifecyclePatch = Partial<
	Pick<
		ProcedureEntry,
		| "name"
		| "intentTags"
		| "triggerQueries"
		| "steps"
		| "successSignals"
		| "confidence"
		| "provenance"
		| "sourceEventIds"
		| "sourceAgent"
	>
>

type ProcedureRevision = ProcedureEntry & {
	scope: MemoryScope
	scopeRef: string
	state: ProcedureState
	revision: number
	searchText: string
	validFrom: Date
	validTo: Date
	supersededAt: Date
	updatedAt: Date
}

function arraysEqual(
	left: string[] | undefined,
	right: string[] | undefined,
): boolean {
	const a = left ?? []
	const b = right ?? []
	return a.length === b.length && a.every((value, index) => value === b[index])
}

function buildSearchText(entry: ProcedureEntry): string {
	return [
		entry.name,
		...(entry.intentTags ?? []),
		...(entry.triggerQueries ?? []),
		...entry.steps,
		...(entry.successSignals ?? []),
	]
		.map((part) => part.trim())
		.filter((part) => part.length > 0)
		.join("\n")
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

function applyProcedureOutcomeSnapshot(
	doc: Document,
	success: boolean,
	now: Date,
): Document {
	const updated = structuredClone(doc) as Document
	updated.updatedAt = now
	if (success) {
		updated.successCount = Number(updated.successCount ?? 0) + 1
		updated.lastSuccessAt = now
	} else {
		updated.failCount = Number(updated.failCount ?? 0) + 1
		updated.lastFailureAt = now
	}
	return updated
}

function escapeRegex(input: string): string {
	return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function hasProcedureChanged(
	existing: Document,
	entry: ProcedureEntry,
	searchText: string,
): boolean {
	return (
		String(existing.name ?? "") !== entry.name ||
		!arraysEqual(
			Array.isArray(existing.intentTags)
				? existing.intentTags.map((tag) => String(tag))
				: undefined,
			entry.intentTags,
		) ||
		!arraysEqual(
			Array.isArray(existing.triggerQueries)
				? existing.triggerQueries.map((value) => String(value))
				: undefined,
			entry.triggerQueries,
		) ||
		!arraysEqual(
			Array.isArray(existing.steps)
				? existing.steps.map((value) => String(value))
				: undefined,
			entry.steps,
		) ||
		!arraysEqual(
			Array.isArray(existing.successSignals)
				? existing.successSignals.map((value) => String(value))
				: undefined,
			entry.successSignals,
		) ||
		(typeof existing.confidence === "number"
			? existing.confidence
			: undefined) !== entry.confidence ||
		(typeof existing.state === "string" ? existing.state : "active") !==
			(entry.state ?? "active") ||
		JSON.stringify(existing.provenance ?? null) !==
			JSON.stringify(entry.provenance ?? null) ||
		!arraysEqual(
			Array.isArray(existing.sourceEventIds)
				? existing.sourceEventIds.map((value) => String(value))
				: undefined,
			entry.sourceEventIds,
		) ||
		String(existing.searchText ?? "") !== searchText
	)
}

function buildRevisionDoc(params: {
	existing: Document
	now: Date
	scope: MemoryScope
	scopeRef: string
}): ProcedureRevision {
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
		procedureId: String(params.existing.procedureId ?? ""),
		name: String(params.existing.name ?? ""),
		agentId: String(params.existing.agentId ?? ""),
		scope: params.scope,
		scopeRef: params.scopeRef,
		steps: Array.isArray(params.existing.steps)
			? params.existing.steps.map((value) => String(value))
			: [],
		state:
			typeof params.existing.state === "string"
				? (params.existing.state as ProcedureState)
				: "active",
		revision,
		searchText: String(params.existing.searchText ?? ""),
		validFrom,
		validTo: params.now,
		supersededAt: params.now,
		updatedAt:
			params.existing.updatedAt instanceof Date
				? params.existing.updatedAt
				: params.now,
		...(Array.isArray(params.existing.intentTags)
			? { intentTags: params.existing.intentTags.map((value) => String(value)) }
			: {}),
		...(Array.isArray(params.existing.triggerQueries)
			? {
					triggerQueries: params.existing.triggerQueries.map((value) =>
						String(value),
					),
				}
			: {}),
		...(Array.isArray(params.existing.successSignals)
			? {
					successSignals: params.existing.successSignals.map((value) =>
						String(value),
					),
				}
			: {}),
		...(typeof params.existing.confidence === "number"
			? { confidence: params.existing.confidence }
			: {}),
		...(params.existing.provenance &&
		typeof params.existing.provenance === "object"
			? { provenance: params.existing.provenance as Record<string, unknown> }
			: {}),
		...(Array.isArray(params.existing.sourceEventIds)
			? {
					sourceEventIds: params.existing.sourceEventIds.map((value) =>
						String(value),
					),
				}
			: {}),
		...(params.existing.createdAt instanceof Date
			? { createdAt: params.existing.createdAt }
			: {}),
	}
}

function procedureFilterFromHandle(
	handle: MemoryProcedureStableHandle,
): Document {
	return {
		procedureId: handle.procedure.procedureId,
		agentId: handle.agentId,
		scope: handle.scope,
		scopeRef: handle.scopeRef,
	}
}

function procedureRevisionFromDoc(doc: Document): number {
	return typeof doc.revision === "number" && Number.isFinite(doc.revision)
		? doc.revision
		: 1
}

function procedureStateFromDoc(doc: Document): ProcedureState {
	return doc.state === "invalidated" || doc.state === "conflicted"
		? doc.state
		: "active"
}

function procedureHandleFromDoc(doc: Document): MemoryProcedureStableHandle {
	const procedureId = String(doc.procedureId ?? "")
	const agentId = String(doc.agentId ?? "")
	const scope =
		typeof doc.scope === "string" ? (doc.scope as MemoryScope) : "agent"
	const scopeRef = String(doc.scopeRef ?? doc.agentId ?? "")
	return {
		family: "procedure",
		id: ["procedure", agentId, scope, scopeRef, procedureId]
			.map((value) => encodeURIComponent(value))
			.join(":"),
		agentId,
		scope,
		scopeRef,
		revision: procedureRevisionFromDoc(doc),
		state: procedureStateFromDoc(doc),
		procedure: { procedureId },
		...(doc.validFrom instanceof Date ? { validFrom: doc.validFrom } : {}),
		...(doc.validTo instanceof Date ? { validTo: doc.validTo } : {}),
		...(doc.updatedAt instanceof Date ? { updatedAt: doc.updatedAt } : {}),
	}
}

function procedureLifecycleItemFromDoc(
	doc: Document,
): Extract<MemoryLifecycleItem, { family: "procedure" }> {
	return {
		family: "procedure",
		handle: procedureHandleFromDoc(doc),
		data: {
			procedureId: String(doc.procedureId ?? ""),
			name: String(doc.name ?? ""),
			steps: Array.isArray(doc.steps)
				? doc.steps.map((value) => String(value))
				: [],
			...(Array.isArray(doc.intentTags)
				? { intentTags: doc.intentTags.map((value) => String(value)) }
				: {}),
			...(Array.isArray(doc.triggerQueries)
				? { triggerQueries: doc.triggerQueries.map((value) => String(value)) }
				: {}),
			...(Array.isArray(doc.successSignals)
				? { successSignals: doc.successSignals.map((value) => String(value)) }
				: {}),
			...(typeof doc.confidence === "number"
				? { confidence: doc.confidence }
				: {}),
			...(doc.provenance && typeof doc.provenance === "object"
				? { provenance: doc.provenance as Record<string, unknown> }
				: {}),
			...(Array.isArray(doc.sourceEventIds)
				? { sourceEventIds: doc.sourceEventIds.map((value) => String(value)) }
				: {}),
			...(typeof doc.successCount === "number"
				? { successCount: doc.successCount }
				: {}),
			...(typeof doc.failCount === "number"
				? { failCount: doc.failCount }
				: {}),
			...(doc.lastSuccessAt instanceof Date
				? { lastSuccessAt: doc.lastSuccessAt }
				: {}),
			...(doc.lastFailureAt instanceof Date
				? { lastFailureAt: doc.lastFailureAt }
				: {}),
			...(doc.sourceAgent && typeof doc.sourceAgent === "object"
				? { sourceAgent: doc.sourceAgent as MemorySourceAgent }
				: {}),
		},
		...(doc.createdAt instanceof Date ? { createdAt: doc.createdAt } : {}),
		...(doc.updatedAt instanceof Date ? { updatedAt: doc.updatedAt } : {}),
	}
}

function procedureEntryFromDoc(
	doc: Document,
	patch: ProcedureLifecyclePatch,
): ProcedureEntry {
	const entry: ProcedureEntry = {
		procedureId: String(doc.procedureId ?? ""),
		name: String(doc.name ?? ""),
		agentId: String(doc.agentId ?? ""),
		scope: typeof doc.scope === "string" ? (doc.scope as MemoryScope) : "agent",
		scopeRef: String(doc.scopeRef ?? doc.agentId ?? ""),
		steps: Array.isArray(doc.steps)
			? doc.steps.map((value) => String(value))
			: [],
		...(Array.isArray(doc.intentTags)
			? { intentTags: doc.intentTags.map((value) => String(value)) }
			: {}),
		...(Array.isArray(doc.triggerQueries)
			? { triggerQueries: doc.triggerQueries.map((value) => String(value)) }
			: {}),
		...(Array.isArray(doc.successSignals)
			? { successSignals: doc.successSignals.map((value) => String(value)) }
			: {}),
		...(typeof doc.confidence === "number"
			? { confidence: doc.confidence }
			: {}),
		...(typeof doc.state === "string"
			? { state: doc.state as ProcedureState }
			: {}),
		...(doc.provenance && typeof doc.provenance === "object"
			? { provenance: doc.provenance as Record<string, unknown> }
			: {}),
		...(Array.isArray(doc.sourceEventIds)
			? { sourceEventIds: doc.sourceEventIds.map((value) => String(value)) }
			: {}),
		...(doc.sourceAgent && typeof doc.sourceAgent === "object"
			? { sourceAgent: doc.sourceAgent as MemorySourceAgent }
			: {}),
	}
	return { ...entry, ...patch }
}

export async function writeProcedure(params: {
	db: Db
	prefix: string
	entry: ProcedureEntry
	embeddingMode: MemoryMongoDBEmbeddingMode
	client?: MongoClient
	actorRole?: MemoryActorRole
	mutationMeta?: MutationMeta
}): Promise<{ upserted: boolean; id: string }> {
	const { db, prefix, entry } = params
	void params.embeddingMode
	const collection = proceduresCollection(db, prefix)
	const revisions = procedureRevisionsCollection(db, prefix)
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
	const searchText = buildSearchText(entry)
	const state = entry.state ?? "active"
	const identityFilter = {
		procedureId: entry.procedureId,
		agentId: entry.agentId,
		scope,
		scopeRef,
	}
	const setDoc: Document = {
		procedureId: entry.procedureId,
		name: entry.name,
		agentId: entry.agentId,
		scope,
		scopeRef,
		steps: entry.steps,
		state,
		searchText,
		updatedAt: now,
	}
	if (entry.intentTags !== undefined) {
		setDoc.intentTags = entry.intentTags
	}
	if (entry.triggerQueries !== undefined) {
		setDoc.triggerQueries = entry.triggerQueries
	}
	if (entry.successSignals !== undefined) {
		setDoc.successSignals = entry.successSignals
	}
	if (entry.confidence !== undefined) {
		setDoc.confidence = entry.confidence
	}
	if (entry.provenance !== undefined) {
		setDoc.provenance = entry.provenance
	}
	if (entry.sourceEventIds !== undefined) {
		setDoc.sourceEventIds = entry.sourceEventIds
	}
	if (entry.sourceAgent !== undefined) {
		setDoc.sourceAgent = entry.sourceAgent
	}

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
					$set: { ...setDoc, revision: 1, validFrom: now },
					$setOnInsert: {
						createdAt: now,
						openedCount: 0,
						version: 1,
						successCount: 0,
						failCount: 0,
						evolutionHistory: [],
					},
				},
				{ upsert: true, ...(session ? { session } : {}) },
			)
			return {
				upserted: result.upsertedCount > 0,
				id: entry.procedureId,
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

		if (!hasProcedureChanged(existing, entry, searchText)) {
			await collection.updateOne(
				identityFilter,
				{
					$set: {
						...setDoc,
						revision: currentRevision,
						validFrom: currentValidFrom,
					},
				},
				session ? { session } : {},
			)
			return {
				upserted: false,
				id: entry.procedureId,
				revision: currentRevision,
			}
		}

		await revisions.insertOne(
			buildRevisionDoc({ existing, now, scope, scopeRef }),
			session ? { session } : {},
		)
		await collection.updateOne(
			identityFilter,
			{
				$set: {
					...setDoc,
					revision: currentRevision + 1,
					validFrom: now,
				},
				$setOnInsert: {
					createdAt:
						existing.createdAt instanceof Date ? existing.createdAt : now,
					openedCount:
						typeof existing.openedCount === "number" ? existing.openedCount : 0,
				},
			},
			{ upsert: true, ...(session ? { session } : {}) },
		)
		return {
			upserted: false,
			id: entry.procedureId,
			revision: currentRevision + 1,
		}
	}

	const client = params.client
	const outcome = client
		? await (async () => {
				const session = client.startSession()
				try {
					let result:
						| { upserted: boolean; id: string; revision: number }
						| undefined
					await session.withTransaction(async () => {
						result = await persist(session)
					})
					return (
						result ?? { upserted: false, id: entry.procedureId, revision: 1 }
					)
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err)
					log.warn(
						`procedure transaction unavailable, falling back to sequential writes: ${message}`,
					)
					return await persist()
				} finally {
					await session.endSession()
				}
			})()
		: await persist()

	log.info(
		`procedure ${outcome.upserted ? "created" : "updated"}: id=${entry.procedureId} revision=${outcome.revision}`,
	)

	const oldSnapshot = existingBeforeWrite
	const changedFields =
		oldSnapshot != null ? computeChangedFields(oldSnapshot, setDoc) : undefined
	recordMutation({
		db,
		prefix,
		mutation: {
			collectionName: "procedures",
			documentId: entry.procedureId,
			operation: oldSnapshot == null ? "create" : "update",
			agentId: entry.agentId,
			oldValue: oldSnapshot ?? null,
			newValue: setDoc,
			changedFields,
			actorRole: params.actorRole ?? "system",
			...(params.mutationMeta ? { meta: params.mutationMeta } : {}),
		},
	}).catch((err) => {
		log.warn("procedure audit failed", { error: err })
	})
	return { upserted: outcome.upserted, id: outcome.id }
}

// ---------------------------------------------------------------------------
// Lifecycle ergonomics
// ---------------------------------------------------------------------------

export async function getProcedureByHandle(params: {
	db: Db
	prefix: string
	handle: MemoryProcedureStableHandle
}): Promise<Extract<MemoryLifecycleItem, { family: "procedure" }> | null> {
	const doc = await proceduresCollection(params.db, params.prefix).findOne(
		procedureFilterFromHandle(params.handle),
	)
	return doc ? procedureLifecycleItemFromDoc(doc) : null
}

export async function updateProcedureByHandle(params: {
	db: Db
	prefix: string
	handle: MemoryProcedureStableHandle
	patch: ProcedureLifecyclePatch
	embeddingMode: MemoryMongoDBEmbeddingMode
	client?: MongoClient
	actorRole?: MemoryActorRole
	mutationMeta?: MutationMeta
}): Promise<Extract<MemoryLifecycleItem, { family: "procedure" }> | null> {
	const collection = proceduresCollection(params.db, params.prefix)
	const existing = await collection.findOne(
		procedureFilterFromHandle(params.handle),
	)
	if (!existing) {
		return null
	}
	await writeProcedure({
		db: params.db,
		prefix: params.prefix,
		entry: procedureEntryFromDoc(existing, params.patch),
		embeddingMode: params.embeddingMode,
		client: params.client,
		actorRole: params.actorRole,
		mutationMeta: params.mutationMeta,
	})
	return getProcedureByHandle(params)
}

export async function invalidateProcedureByHandle(params: {
	db: Db
	prefix: string
	handle: MemoryProcedureStableHandle
	invalidatedBy?: Record<string, unknown>
	client?: MongoClient
	actorRole?: MemoryActorRole
	mutationMeta?: MutationMeta
}): Promise<Extract<MemoryLifecycleItem, { family: "procedure" }> | null> {
	const collection = proceduresCollection(params.db, params.prefix)
	const revisions = procedureRevisionsCollection(params.db, params.prefix)
	const filter = procedureFilterFromHandle(params.handle)
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
		if (procedureStateFromDoc(existing) === "invalidated") {
			newSnapshot = existing
			return
		}
		const currentRevision = procedureRevisionFromDoc(existing)
		const scope =
			typeof existing.scope === "string"
				? (existing.scope as MemoryScope)
				: params.handle.scope
		const scopeRef = String(existing.scopeRef ?? params.handle.scopeRef)
		await revisions.insertOne(
			buildRevisionDoc({ existing, now, scope, scopeRef }),
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
				`procedure lifecycle transaction unavailable, falling back to sequential writes: ${message}`,
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
				collectionName: "procedures",
				documentId: procedureHandleFromDoc(newSnapshot).id,
				operation: "invalidate",
				agentId: params.handle.agentId,
				oldValue: oldSnapshot,
				newValue: newSnapshot,
				changedFields: ["state", "validTo", "revision", "invalidatedBy"],
				actorRole: params.actorRole ?? "system",
				...(params.mutationMeta ? { meta: params.mutationMeta } : {}),
			},
		}).catch((err) => {
			log.warn("procedure invalidate audit failed", { error: err })
		})
	}
	return procedureLifecycleItemFromDoc(newSnapshot)
}

export async function getProcedureHistoryByHandle(params: {
	db: Db
	prefix: string
	handle: MemoryProcedureStableHandle
	limit?: number
}): Promise<
	Array<
		Extract<MemoryLifecycleItem, { family: "procedure" }> & {
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
	const filter = procedureFilterFromHandle(params.handle)
	const revisionLimit = Math.max(0, maxItems - 1)
	const revisionDocs =
		revisionLimit > 0
			? await procedureRevisionsCollection(params.db, params.prefix)
					.find(filter, { sort: { revision: -1 }, limit: revisionLimit })
					.toArray()
			: []
	const current = await proceduresCollection(params.db, params.prefix).findOne(
		filter,
	)
	const entries: Array<
		Extract<MemoryLifecycleItem, { family: "procedure" }> & {
			historyKind: "revision" | "current"
			supersededAt?: Date
		}
	> = revisionDocs
		.toSorted(
			(a, b) => procedureRevisionFromDoc(a) - procedureRevisionFromDoc(b),
		)
		.map((doc) => ({
			...procedureLifecycleItemFromDoc(doc),
			historyKind: "revision" as const,
			...(doc.supersededAt instanceof Date
				? { supersededAt: doc.supersededAt }
				: {}),
		}))
	if (current) {
		entries.push({
			...procedureLifecycleItemFromDoc(current),
			historyKind: "current" as const,
		})
	}
	return entries
}

// ---------------------------------------------------------------------------
// Procedure evolution (version tracking + outcome recording)
// ---------------------------------------------------------------------------

/**
 * Record a success or failure outcome on an existing procedure.
 * Uses atomic $inc for counters and $set for timestamp.
 * Returns false if procedure not found (no upsert).
 */
export async function recordProcedureOutcome(params: {
	db: Db
	prefix: string
	procedureId: string
	agentId: string
	scope: MemoryScope
	scopeRef?: string
	success: boolean
	actorRole?: MemoryActorRole
	mutationMeta?: MutationMeta
}): Promise<boolean> {
	const {
		db,
		prefix,
		procedureId,
		agentId,
		scope,
		scopeRef,
		success,
		actorRole,
		mutationMeta,
	} = params
	const collection = proceduresCollection(db, prefix)
	const now = new Date()
	const filter: Document = { procedureId, agentId, scope }
	if (scopeRef !== undefined) {
		filter.scopeRef = scopeRef
	}
	try {
		const update: Document = {
			$inc: success ? { successCount: 1 } : { failCount: 1 },
			$set: success
				? { lastSuccessAt: now, updatedAt: now }
				: { lastFailureAt: now, updatedAt: now },
		}
		const oldSnapshot = await collection.findOneAndUpdate(filter, update, {
			returnDocument: "before",
		})
		if (!oldSnapshot) {
			log.warn(`recordProcedureOutcome: procedure not found: ${procedureId}`)
			return false
		}
		const updated = applyProcedureOutcomeSnapshot(oldSnapshot, success, now)
		recordMutation({
			db,
			prefix,
			mutation: {
				collectionName: "procedures",
				documentId: procedureHandleFromDoc(updated).id,
				operation: "update",
				agentId,
				oldValue: oldSnapshot,
				newValue: updated,
				changedFields: success
					? ["successCount", "lastSuccessAt"]
					: ["failCount", "lastFailureAt"],
				actorRole: actorRole ?? "system",
				...(mutationMeta ? { meta: mutationMeta } : {}),
			},
		}).catch((error) => {
			log.warn("recordProcedureOutcome audit failed", { error })
		})
		return true
	} catch (err) {
		log.error("recordProcedureOutcome failed", { procedureId, error: err })
		throw err
	}
}

export async function reportProcedureOutcomeByHandle(params: {
	db: Db
	prefix: string
	handle: MemoryProcedureStableHandle
	success: boolean
	note?: string
	actorRole?: MemoryActorRole
}): Promise<Extract<MemoryLifecycleItem, { family: "procedure" }> | null> {
	const collection = proceduresCollection(params.db, params.prefix)
	const filter = procedureFilterFromHandle(params.handle)
	const now = new Date()
	const oldSnapshot = await collection.findOneAndUpdate(
		filter,
		{
			$inc: params.success ? { successCount: 1 } : { failCount: 1 },
			$set: params.success
				? { lastSuccessAt: now, updatedAt: now }
				: { lastFailureAt: now, updatedAt: now },
		},
		{ returnDocument: "before" },
	)
	if (!oldSnapshot) {
		return null
	}
	const updated = applyProcedureOutcomeSnapshot(
		oldSnapshot,
		params.success,
		now,
	)
	recordMutation({
		db: params.db,
		prefix: params.prefix,
		mutation: {
			collectionName: "procedures",
			documentId: procedureHandleFromDoc(updated).id,
			operation: "update",
			agentId: params.handle.agentId,
			oldValue: oldSnapshot,
			newValue: updated,
			changedFields: params.success
				? ["successCount", "lastSuccessAt"]
				: ["failCount", "lastFailureAt"],
			actorRole: params.actorRole ?? "user",
			meta: {
				source: "procedure-outcome",
				success: params.success,
				...(typeof params.note === "string" && params.note.trim()
					? { note: params.note }
					: {}),
			},
		},
	}).catch((error) => {
		log.warn("procedure outcome audit failed", { error })
	})
	return procedureLifecycleItemFromDoc(updated)
}

/**
 * Evolve a procedure: bump version, update steps, and record in
 * bounded evolutionHistory ($push + $slice: -20).
 * Throws if procedure not found.
 */
export async function evolveProcedure(params: {
	db: Db
	prefix: string
	procedureId: string
	agentId: string
	scope: MemoryScope
	scopeRef?: string
	newSteps: string[]
	changeType: string
	changeDescription: string
}): Promise<{ newVersion: number }> {
	const {
		db,
		prefix,
		procedureId,
		agentId,
		scope,
		scopeRef,
		newSteps,
		changeType,
		changeDescription,
	} = params
	const collection = proceduresCollection(db, prefix)
	const now = new Date()
	const filter: Document = { procedureId, agentId, scope }
	if (scopeRef !== undefined) {
		filter.scopeRef = scopeRef
	}
	try {
		// Read current version to record in history entry
		const existing = await collection.findOne(filter)
		if (!existing) {
			throw new Error(`Procedure not found: ${procedureId}`)
		}
		const currentVersion =
			typeof existing.version === "number" && Number.isFinite(existing.version)
				? existing.version
				: 1

		const historyEntry = {
			version: currentVersion,
			changeType,
			changeDescription,
			timestamp: now,
		}

		const update: Document = {
			$inc: { version: 1 },
			$set: { steps: newSteps, updatedAt: now },
			$push: {
				evolutionHistory: {
					$each: [historyEntry],
					$slice: -20,
				},
			},
		}

		await collection.updateOne(filter, update)
		const newVersion = currentVersion + 1
		log.info(
			`evolveProcedure: ${procedureId} v${currentVersion} -> v${newVersion}`,
		)
		return { newVersion }
	} catch (err) {
		if (err instanceof Error && err.message.startsWith("Procedure not found")) {
			throw err
		}
		log.error("evolveProcedure failed", { procedureId, error: err })
		throw err
	}
}

function toProcedureResult(doc: Document): MemorySearchResult {
	return {
		path: `procedure:${String(doc.procedureId ?? "")}`,
		canonicalId: `procedure:${String(doc.procedureId ?? "")}`,
		startLine: 0,
		endLine: 0,
		score: typeof doc.score === "number" ? Number(doc.score.toFixed(6)) : 0,
		snippet:
			typeof doc.searchText === "string" ? doc.searchText.slice(0, 700) : "",
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
			? { provenance: doc.provenance as Record<string, unknown> }
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
		...(doc.validFrom instanceof Date ? { validFrom: doc.validFrom } : {}),
		...(doc.validTo instanceof Date ? { validTo: doc.validTo } : {}),
		...(typeof doc.confidence === "number"
			? { confidence: doc.confidence }
			: {}),
	}
}

export async function findExactProcedureMatches(
	collection: Collection,
	query: string,
	opts: {
		maxResults: number
		filter?: {
			agentId?: string
			scope?: MemoryScope
			scopeRef?: string
			state?: ProcedureState
			intentTags?: string[]
			currentOnly?: boolean
			asOf?: Date
		}
	},
): Promise<MemorySearchResult[]> {
	const trimmed = query.trim()
	if (!trimmed) {
		return []
	}

	const asOf = opts.filter?.currentOnly
		? resolveTemporalAsOf(opts.filter.asOf)
		: undefined
	const filter: Document = {}
	if (opts.filter?.agentId) {
		filter.agentId = opts.filter.agentId
	}
	if (opts.filter?.scope) {
		filter.scope = opts.filter.scope
	}
	if (opts.filter?.scopeRef) {
		filter.scopeRef = opts.filter.scopeRef
	}
	if (opts.filter?.state) {
		filter.state = opts.filter.state
	}
	if (opts.filter?.intentTags?.length) {
		filter.intentTags = { $in: opts.filter.intentTags }
	}
	const exactAlias = new RegExp(`^${escapeRegex(trimmed)}$`, "i")
	const exactAliasFilter = {
		$or: [{ name: exactAlias }, { triggerQueries: exactAlias }],
	}
	const docs = await collection
		.find(
			mergeQueryClauses(
				filter,
				opts.filter?.currentOnly
					? buildCurrentValidityClause({ asOf })
					: undefined,
				exactAliasFilter,
			),
			{
				projection: {
					_id: 0,
					procedureId: 1,
					searchText: 1,
					sessionId: 1,
					updatedAt: 1,
					state: 1,
					scope: 1,
					scopeRef: 1,
					provenance: 1,
					sourceEventIds: 1,
					validFrom: 1,
					validTo: 1,
				},
				sort: { updatedAt: -1 },
				limit: opts.maxResults,
			},
		)
		.toArray()

	return docs.map((doc) =>
		toProcedureResult({
			...doc,
			score: typeof doc.score === "number" ? doc.score : 1,
		}),
	)
}

export async function searchProcedures(
	collection: Collection,
	query: string,
	queryVector: number[] | null,
	opts: {
		maxResults: number
		minScore?: number
		filter?: {
			agentId?: string
			scope?: MemoryScope
			scopeRef?: string
			state?: ProcedureState
			intentTags?: string[]
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
	const buildFilter = (): Document => {
		const filter: Document = {}
		if (opts.filter?.agentId) {
			filter.agentId = opts.filter.agentId
		}
		if (opts.filter?.scope) {
			filter.scope = opts.filter.scope
		}
		if (opts.filter?.scopeRef) {
			filter.scopeRef = opts.filter.scopeRef
		}
		if (opts.filter?.state) {
			filter.state = opts.filter.state
		}
		if (opts.filter?.intentTags?.length) {
			filter.intentTags = { $in: opts.filter.intentTags }
		}
		if (!opts.filter?.currentOnly) {
			return filter
		}
		return mergeQueryClauses(
			filter,
			buildCurrentValidityClause({ asOf: currentAsOf }),
		)
	}

	if (canVector) {
		try {
			const vsStage = buildVectorSearchStage({
				queryVector,
				queryText: query,
				embeddingMode: opts.embeddingMode,
				indexName: opts.vectorIndexName,
				numCandidates,
				limit: opts.maxResults,
				filter:
					Object.keys(buildFilter()).length > 0 ? buildFilter() : undefined,
				textFieldPath: "searchText",
			})
			if (vsStage) {
				const pipeline: Document[] = [
					{ $vectorSearch: vsStage },
					{ $limit: opts.maxResults },
					{
						$project: {
							_id: 0,
							procedureId: 1,
							searchText: 1,
							sessionId: 1,
							updatedAt: 1,
							state: 1,
							scope: 1,
							scopeRef: 1,
							provenance: 1,
							sourceEventIds: 1,
							validFrom: 1,
							validTo: 1,
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
									source: "procedure",
									...summarizeExplain(explained),
								},
								...(opts.explain.deep ? { rawExplain: explained } : {}),
							})
						}
					} catch (err) {
						log.warn("procedure vector explain failed", { error: err })
					}
				}
				const docs = await runSearchAggregateWithRetry(collection, pipeline)
				const results = docs
					.map(toProcedureResult)
					.filter((result) => result.score >= minScore)
				if (results.length > 0) {
					return results
				}
			}
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err)
			log.warn(`procedure vector search failed: ${msg}`)
		}
	}

	try {
		const matchFilter: Document = {
			$text: { $search: query },
			...buildFilter(),
		}
		const docs = await collection
			.aggregate([
				{ $match: matchFilter },
				{
					$project: {
						_id: 0,
						procedureId: 1,
						searchText: 1,
						sessionId: 1,
						updatedAt: 1,
						state: 1,
						scope: 1,
						scopeRef: 1,
						provenance: 1,
						sourceEventIds: 1,
						validFrom: 1,
						validTo: 1,
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
				summary: { source: "procedure", method: "$text" },
			})
		}
		return docs
			.map(toProcedureResult)
			.filter((result) => result.score >= minScore)
	} catch {
		log.warn("procedure $text search fallback failed; returning empty results")
		return []
	}
}
