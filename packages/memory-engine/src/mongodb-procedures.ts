import type {
	ClientSession,
	Collection,
	Db,
	Document,
	MongoClient,
} from "mongodb"
import {
	type MemoryMongoDBEmbeddingMode,
	type MemoryMongoDBQueryEmbeddingModel,
	type MemoryScope,
	createSubsystemLogger,
} from "@memongo/lib"
import { isDuplicateKeyError } from "./internal.js"
import { recordEmbeddingSpend } from "./mongodb-cost-ledger.js"
import { recordMutation, type MutationMeta } from "./mongodb-mutations.js"
import { invalidateQueryCache } from "./mongodb-query-cache.js"
import { summarizeExplain } from "./mongodb-relevance.js"
import { splitAtlasSearchFilter } from "./mongodb-search.js"
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
import {
	MAJORITY_TRANSACTION_OPTIONS,
	isTransactionUnsupported,
} from "./mongodb-transactions.js"
import type {
	MemoryActorRole,
	MemoryLifecycleItem,
	MemoryProcedureStableHandle,
	MemorySearchResult,
	MemorySourceAgent,
} from "./types.js"
import { MemoryLifecycleConflictError } from "./mongodb-structured-memory.js"

const log = createSubsystemLogger("memory:mongodb:procedures")

class ProcedureRevisionConflictError extends Error {
	constructor(message: string) {
		super(message)
		this.name = "ProcedureRevisionConflictError"
	}
}

const MAX_REVISION_CAS_ATTEMPTS = 3

async function withProcedureRevisionCasRetry<T>(
	operation: () => Promise<T>,
): Promise<T> {
	for (let attempt = 1; ; attempt++) {
		try {
			return await operation()
		} catch (err) {
			if (
				err instanceof ProcedureRevisionConflictError &&
				attempt < MAX_REVISION_CAS_ATTEMPTS
			) {
				continue
			}
			throw err
		}
	}
}

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
	_id: string
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

function memorySourceAgentFromValue(
	value: unknown,
): MemorySourceAgent | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return undefined
	}
	const candidate = value as Record<string, unknown>
	if (
		typeof candidate.id !== "string" ||
		typeof candidate.name !== "string" ||
		(candidate.runId !== undefined && typeof candidate.runId !== "string")
	) {
		return undefined
	}
	return {
		id: candidate.id,
		name: candidate.name,
		...(typeof candidate.runId === "string" ? { runId: candidate.runId } : {}),
	}
}

function sourceAgentsEqual(left: unknown, right: unknown): boolean {
	const a = memorySourceAgentFromValue(left)
	const b = memorySourceAgentFromValue(right)
	if (!a || !b) {
		return a === b
	}
	return a.id === b.id && a.name === b.name && a.runId === b.runId
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
	existing: Document,
	sourceEventIds: string[],
): string[] {
	return Array.from(
		new Set([
			...(Array.isArray(existing.sourceEventIds)
				? existing.sourceEventIds.map((value) => String(value))
				: []),
			...sourceEventIds,
		]),
	)
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

function buildProcedureSetDoc(params: {
	entry: ProcedureEntry
	scope: MemoryScope
	scopeRef: string
	searchText: string
	updatedAt: Date
}): Document {
	const { entry, scope, scopeRef, searchText, updatedAt } = params
	return {
		procedureId: entry.procedureId,
		name: entry.name,
		agentId: entry.agentId,
		scope,
		scopeRef,
		steps: entry.steps,
		state: entry.state ?? "active",
		searchText,
		updatedAt,
		...(entry.intentTags !== undefined ? { intentTags: entry.intentTags } : {}),
		...(entry.triggerQueries !== undefined
			? { triggerQueries: entry.triggerQueries }
			: {}),
		...(entry.successSignals !== undefined
			? { successSignals: entry.successSignals }
			: {}),
		...(entry.confidence !== undefined ? { confidence: entry.confidence } : {}),
		...(entry.provenance !== undefined ? { provenance: entry.provenance } : {}),
		...(entry.sourceEventIds !== undefined
			? { sourceEventIds: entry.sourceEventIds }
			: {}),
		...(entry.sourceAgent !== undefined
			? { sourceAgent: entry.sourceAgent }
			: {}),
	}
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
		!sourceAgentsEqual(existing.sourceAgent, entry.sourceAgent) ||
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
	const sourceAgent = memorySourceAgentFromValue(params.existing.sourceAgent)

	return {
		_id: `${[
			"procedure",
			String(params.existing.agentId ?? ""),
			params.scope,
			params.scopeRef,
			String(params.existing.procedureId ?? ""),
		]
			.map((part) => encodeURIComponent(part))
			.join(":")}:r${revision}`,
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
		...(sourceAgent ? { sourceAgent } : {}),
		...(params.existing.createdAt instanceof Date
			? { createdAt: params.existing.createdAt }
			: {}),
	}
}

async function ensureProcedureRevisionSnapshot(
	revisions: Collection,
	doc: ProcedureRevision,
	session?: ClientSession,
): Promise<void> {
	try {
		await revisions.updateOne(
			{ _id: doc._id } as unknown as Document,
			{ $setOnInsert: doc as unknown as Document },
			{ upsert: true, ...(session ? { session } : {}) },
		)
	} catch (err) {
		if (!isDuplicateKeyError(err)) {
			throw err
		}
		throw new ProcedureRevisionConflictError(
			`procedure revision snapshot raced on ${doc.procedureId} at revision ${doc.revision}`,
		)
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

function procedureRevisionCasFilter(
	identityFilter: Document,
	existing: Document,
): Document {
	return {
		...identityFilter,
		revision: Object.hasOwn(existing, "revision")
			? existing.revision
			: { $exists: false },
	}
}

function procedureStateFromDoc(doc: Document): ProcedureState {
	return doc.state === "invalidated" || doc.state === "conflicted"
		? doc.state
		: "active"
}

function enforceableHandleRevision(revision: number): boolean {
	return Number.isInteger(revision) && revision >= 1
}

function enforceProcedureHandleFreshness(params: {
	handle: MemoryProcedureStableHandle
	existing: Document
	rejectInvalidated: boolean
}): number {
	const currentRevision = procedureRevisionFromDoc(params.existing)
	if (
		params.rejectInvalidated &&
		procedureStateFromDoc(params.existing) === "invalidated"
	) {
		throw new MemoryLifecycleConflictError({ reason: "invalidated" })
	}
	if (
		enforceableHandleRevision(params.handle.revision) &&
		params.handle.revision !== currentRevision
	) {
		throw new MemoryLifecycleConflictError({
			reason: "stale-revision",
			expectedRevision: params.handle.revision,
			actualRevision: currentRevision,
		})
	}
	return currentRevision
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
	eventReceiptIds?: string[]
	expectedRevision?: number
}): Promise<{ upserted: boolean; id: string }> {
	const { db, prefix, entry } = params
	const collection = proceduresCollection(db, prefix)
	const revisions = procedureRevisionsCollection(db, prefix)
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
	const identityFilter = {
		procedureId: entry.procedureId,
		agentId: entry.agentId,
		scope,
		scopeRef,
	}

	let existingBeforeWrite: Document | null = null
	let persistedSetDoc: Document = {}

	const persistOnce = async (
		session?: ClientSession,
	): Promise<{
		upserted: boolean
		id: string
		revision: number
		changed: boolean
	}> => {
		const now = new Date()
		const setDoc = buildProcedureSetDoc({
			entry,
			scope,
			scopeRef,
			searchText,
			updatedAt: now,
		})
		const existing = await collection.findOne(
			identityFilter,
			session ? { session } : undefined,
		)
		existingBeforeWrite = existing
		if (!existing) {
			let result: Awaited<ReturnType<Collection["updateOne"]>>
			try {
				result = await collection.updateOne(
					identityFilter,
					{
						$setOnInsert: {
							...setDoc,
							revision: 1,
							validFrom: now,
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
			} catch (err) {
				if (!isDuplicateKeyError(err)) {
					throw err
				}
				throw new ProcedureRevisionConflictError(
					`procedure creation raced on ${entry.procedureId}`,
				)
			}
			if (result.upsertedCount === 0) {
				throw new ProcedureRevisionConflictError(
					`procedure creation raced on ${entry.procedureId}`,
				)
			}
			return {
				upserted: true,
				id: entry.procedureId,
				revision: 1,
				changed: true,
			}
		}
		if (hasProcessedSourceEvents(existing, params.eventReceiptIds)) {
			return {
				upserted: false,
				id: entry.procedureId,
				revision: typeof existing.revision === "number" ? existing.revision : 1,
				changed: false,
			}
		}
		const effectiveEntry = procedureEntryFromDoc(existing, {
			...entry,
			...(entry.sourceEventIds
				? {
						sourceEventIds: mergeSourceEventIds(existing, entry.sourceEventIds),
					}
				: {}),
		})
		const effectiveSearchText = buildSearchText(effectiveEntry)
		persistedSetDoc = buildProcedureSetDoc({
			entry: effectiveEntry,
			scope,
			scopeRef,
			searchText: effectiveSearchText,
			updatedAt: now,
		})

		const currentRevision =
			typeof existing.revision === "number" &&
			Number.isFinite(existing.revision)
				? existing.revision
				: 1
		if (
			params.expectedRevision !== undefined &&
			currentRevision !== params.expectedRevision
		) {
			throw new MemoryLifecycleConflictError({
				reason: "stale-revision",
				expectedRevision: params.expectedRevision,
				actualRevision: currentRevision,
			})
		}
		if (!hasProcedureChanged(existing, effectiveEntry, effectiveSearchText)) {
			return {
				upserted: false,
				id: entry.procedureId,
				revision: currentRevision,
				changed: false,
			}
		}

		await ensureProcedureRevisionSnapshot(
			revisions,
			buildRevisionDoc({ existing, now, scope, scopeRef }),
			session,
		)
		const updateResult = await collection.updateOne(
			procedureRevisionCasFilter(identityFilter, existing),
			{
				$set: {
					...persistedSetDoc,
					revision: currentRevision + 1,
					validFrom: now,
				},
			},
			session ? { session } : {},
		)
		if (updateResult.matchedCount === 0) {
			throw new ProcedureRevisionConflictError(
				`procedure update raced on ${entry.procedureId} at revision ${currentRevision}`,
			)
		}
		return {
			upserted: false,
			id: entry.procedureId,
			revision: currentRevision + 1,
			changed: true,
		}
	}

	const persist = async (
		session?: ClientSession,
	): Promise<Awaited<ReturnType<typeof persistOnce>>> => {
		if (session) {
			return persistOnce(session)
		}
		return withProcedureRevisionCasRetry(() => persistOnce())
	}

	const client = params.client
	const outcome = client
		? await withProcedureRevisionCasRetry(async () => {
				const session = client.startSession()
				try {
					let result:
						| {
								upserted: boolean
								id: string
								revision: number
								changed: boolean
						  }
						| undefined
					await session.withTransaction(async () => {
						result = await persist(session)
					}, MAJORITY_TRANSACTION_OPTIONS)
					return (
						result ?? {
							upserted: false,
							id: entry.procedureId,
							revision: 1,
							changed: false,
						}
					)
				} catch (err) {
					if (!isTransactionUnsupported(err)) {
						throw err
					}
					log.info(
						"transactions not supported for procedure writes, falling back to direct writes",
					)
					return await persist()
				} finally {
					await session.endSession()
				}
			})
		: await persist()
	if (!outcome.changed) {
		return { upserted: false, id: outcome.id }
	}

	log.info(
		`procedure ${outcome.upserted ? "created" : "updated"}: id=${entry.procedureId} revision=${outcome.revision}`,
	)
	// C-017: a changed persist rewrites searchText, which the procedures
	// vector index embeds server-side (autoEmbed) in automated mode — one
	// indexing unit per changed write.
	if (params.embeddingMode === "automated") {
		recordEmbeddingSpend(db, prefix, entry.agentId, "indexing", 1)
	}
	await invalidateQueryCache({
		db,
		prefix,
		agentId: entry.agentId,
		scope,
		scopeRef,
	})

	const oldSnapshot = existingBeforeWrite
	const changedFields =
		oldSnapshot != null
			? computeChangedFields(oldSnapshot, persistedSetDoc)
			: undefined
	recordMutation({
		db,
		prefix,
		mutation: {
			collectionName: "procedures",
			documentId: entry.procedureId,
			operation: oldSnapshot == null ? "create" : "update",
			agentId: entry.agentId,
			oldValue: oldSnapshot ?? null,
			newValue: persistedSetDoc,
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
	const currentRevision = enforceProcedureHandleFreshness({
		handle: params.handle,
		existing,
		rejectInvalidated: true,
	})
	await writeProcedure({
		db: params.db,
		prefix: params.prefix,
		entry: procedureEntryFromDoc(existing, params.patch),
		embeddingMode: params.embeddingMode,
		client: params.client,
		actorRole: params.actorRole,
		mutationMeta: params.mutationMeta,
		expectedRevision: currentRevision,
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
	let oldSnapshot: Document | null = null
	let newSnapshot: Document | null = null
	let changed = false

	const persistOnce = async (session?: ClientSession) => {
		const existing = await collection.findOne(
			filter,
			session ? { session } : undefined,
		)
		if (!existing) {
			return
		}
		oldSnapshot = existing
		const currentRevision = enforceProcedureHandleFreshness({
			handle: params.handle,
			existing,
			rejectInvalidated: false,
		})
		if (procedureStateFromDoc(existing) === "invalidated") {
			newSnapshot = existing
			return
		}
		const now = new Date()
		const scope =
			typeof existing.scope === "string"
				? (existing.scope as MemoryScope)
				: params.handle.scope
		const scopeRef = String(existing.scopeRef ?? params.handle.scopeRef)
		await ensureProcedureRevisionSnapshot(
			revisions,
			buildRevisionDoc({ existing, now, scope, scopeRef }),
			session,
		)
		const updateResult = await collection.updateOne(
			procedureRevisionCasFilter(filter, existing),
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
		if (updateResult.matchedCount === 0) {
			throw new ProcedureRevisionConflictError(
				`procedure invalidation raced on ${params.handle.procedure.procedureId} at revision ${currentRevision}`,
			)
		}
		newSnapshot = await collection.findOne(
			filter,
			session ? { session } : undefined,
		)
		changed = true
	}

	const persist = async (session?: ClientSession): Promise<void> => {
		if (session) {
			return persistOnce(session)
		}
		return withProcedureRevisionCasRetry(() => persistOnce())
	}

	if (params.client) {
		await withProcedureRevisionCasRetry(async () => {
			const session = params.client?.startSession()
			if (!session) {
				return persist()
			}
			try {
				await session.withTransaction(async () => {
					await persist(session)
				}, MAJORITY_TRANSACTION_OPTIONS)
			} catch (err) {
				if (!isTransactionUnsupported(err)) {
					throw err
				}
				log.info(
					"transactions not supported for procedure lifecycle, falling back to direct writes",
				)
				await persist()
			} finally {
				await session.endSession()
			}
		})
	} else {
		await persist()
	}

	if (!newSnapshot) {
		return null
	}
	if (changed) {
		await invalidateQueryCache({
			db: params.db,
			prefix: params.prefix,
			agentId: params.handle.agentId,
			scope: params.handle.scope,
			scopeRef: params.handle.scopeRef,
		})
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
				severity: "warning",
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
 * Outcome fields are current operational metrics, not semantic procedure
 * content: they do not advance revision or semantic updatedAt.
 * Uses atomic $inc for counters and $set for the outcome timestamp.
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
			$set: success ? { lastSuccessAt: now } : { lastFailureAt: now },
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
			$set: params.success ? { lastSuccessAt: now } : { lastFailureAt: now },
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
	const revisions = procedureRevisionsCollection(db, prefix)
	const filter: Document = { procedureId, agentId, scope }
	if (scopeRef !== undefined) {
		filter.scopeRef = scopeRef
	}
	try {
		const newVersion = await withProcedureRevisionCasRetry(async () => {
			const now = new Date()
			const existing = await collection.findOne(filter)
			if (!existing) {
				throw new Error(`Procedure not found: ${procedureId}`)
			}
			const currentVersion =
				typeof existing.version === "number" &&
				Number.isFinite(existing.version)
					? existing.version
					: 1
			const currentRevision = procedureRevisionFromDoc(existing)
			const persistedScope =
				typeof existing.scope === "string"
					? (existing.scope as MemoryScope)
					: scope
			const persistedScopeRef = String(
				existing.scopeRef ?? scopeRef ?? `agent:${agentId}`,
			)
			const evolvedEntry = procedureEntryFromDoc(existing, { steps: newSteps })
			const historyEntry = {
				version: currentVersion,
				changeType,
				changeDescription,
				timestamp: now,
			}

			await ensureProcedureRevisionSnapshot(
				revisions,
				buildRevisionDoc({
					existing,
					now,
					scope: persistedScope,
					scopeRef: persistedScopeRef,
				}),
			)
			const update: Document = {
				$set: {
					steps: newSteps,
					searchText: buildSearchText(evolvedEntry),
					version: currentVersion + 1,
					revision: currentRevision + 1,
					validFrom: now,
					updatedAt: now,
				},
				$push: {
					evolutionHistory: {
						$each: [historyEntry],
						$slice: -20,
					},
				},
			}
			const updateResult = await collection.updateOne(
				{
					...procedureRevisionCasFilter(
						{
							...filter,
							scope: persistedScope,
							scopeRef: persistedScopeRef,
						},
						existing,
					),
					version: Object.hasOwn(existing, "version")
						? existing.version
						: { $exists: false },
				},
				update,
			)
			if (updateResult.matchedCount === 0) {
				throw new ProcedureRevisionConflictError(
					`procedure evolution raced on ${procedureId} at revision ${currentRevision}`,
				)
			}
			return currentVersion + 1
		})
		await invalidateQueryCache({
			db,
			prefix,
			agentId,
			scope,
			scopeRef: scopeRef ?? `agent:${agentId}`,
		})
		log.info(`evolveProcedure: ${procedureId} evolved to v${newVersion}`)
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
		textIndexName?: string
		embeddingMode: MemoryMongoDBEmbeddingMode
		queryEmbeddingModel?: MemoryMongoDBQueryEmbeddingModel
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
				model: opts.queryEmbeddingModel,
				indexName: opts.vectorIndexName,
				numCandidates,
				limit: opts.maxResults,
				filter:
					Object.keys(buildFilter()).length > 0 ? buildFilter() : undefined,
				textFieldPath: "searchText",
				returnStoredSource: opts.capabilities.storedSource,
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

	// Atlas Search tier — uses the procedures_text Atlas Search index that is
	// created and maintained by mongodb-schema.ts but was previously unused.
	// Gated on capabilities.textSearch so it only runs where Atlas Search is
	// available; falls through to $text on Community / unsupported deployments.
	const canText = opts.capabilities.textSearch
	if (canText && opts.textIndexName) {
		try {
			const textFilter = buildFilter()
			const { compoundFilter, postMatch } = splitAtlasSearchFilter(textFilter)
			const pipeline: Document[] = [
				{
					$search: {
						index: opts.textIndexName,
						compound: {
							must: [{ text: { query, path: "searchText" } }],
							...(compoundFilter ? { filter: compoundFilter } : {}),
						},
					},
				},
				...(postMatch ? [{ $match: postMatch }] : []),
				{ $limit: opts.maxResults * 4 },
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
						score: { $meta: "searchScore" },
					},
				},
			]
			if (opts.explain?.enabled) {
				opts.explain.onArtifact?.({
					artifactType: "searchExplain",
					summary: { source: "procedure", method: "atlas-search" },
				})
			}
			const docs = await runSearchAggregateWithRetry(collection, pipeline)
			const results = docs
				.map(toProcedureResult)
				.filter((result) => result.score >= minScore)
			if (results.length > 0) {
				return results
			}
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err)
			log.warn(`procedure Atlas Search failed: ${msg}`)
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
