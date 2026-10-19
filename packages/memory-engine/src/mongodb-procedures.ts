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
import {
	ErasureGateConflictError,
	withFencedWrite,
	type AdmissionToken,
} from "./mongodb-write-fence.js"
import {
	recordEmbeddingSpend,
	recordEmbeddingSpendInSession,
} from "./mongodb-cost-ledger.js"
import { bestEffort } from "./best-effort.js"
import { recordMutation, type MutationMeta } from "./mongodb-mutations.js"
import { invalidateQueryCache } from "./mongodb-query-cache.js"
import { summarizeExplain } from "./mongodb-relevance.js"
import type { DetectedCapabilities } from "./mongodb-schema.js"
import {
	procedureRevisionsCollection,
	proceduresCollection,
} from "./mongodb-schema.js"
import { resolveScopeRef } from "./mongodb-scope.js"
import {
	buildVectorSearchStage,
	freshnessRevalidationStages,
	isTextSearchTierAvailable,
	MONGODB_MAX_NUM_CANDIDATES,
	reportExplainFailure,
	runSearchAggregateWithRetry,
	type SearchExplainOptions,
	splitAtlasSearchFilter,
} from "./mongodb-search.js"
import {
	buildCurrentValidityClause,
	mergeQueryClauses,
	resolveTemporalAsOf,
} from "./mongodb-temporal.js"
import {
	MAJORITY_TRANSACTION_OPTIONS,
	typedTransactionError,
} from "./mongodb-transactions.js"
import type {
	MemoryActorRole,
	MemoryLifecycleItem,
	MemoryProcedureStableHandle,
	MemorySearchResult,
	MemorySourceAgent,
} from "./types.js"
import { MemoryLifecycleConflictError } from "./mongodb-structured-memory.js"
import {
	SearchLaneUnavailableError,
	type SearchTierOutcomeSink,
	toTypedSearchError,
} from "./search-outcomes.js"

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
		validTo:
			params.existing.state === "invalidated" &&
			params.existing.validTo instanceof Date &&
			params.existing.validTo <= params.now
				? params.existing.validTo
				: params.now,
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
	session?: ClientSession
	admission?: AdmissionToken
	transactionalSideEffects?: "defer" | "inline"
	actorRole?: MemoryActorRole
	mutationMeta?: MutationMeta
	eventReceiptIds?: string[]
	expectedRevision?: number
	/**
	 * #101: opt-in search barrier witness. Stamped in the same update as the
	 * content; a write that changes no content re-stamps it with a
	 * token-only $set.
	 */
	searchWriteToken?: string
}): Promise<{
	upserted: boolean
	id: string
	changed?: boolean
	pendingSideEffects?: () => Promise<void>
}> {
	const { admission, ...rest } = params
	if (admission) {
		if (params.session)
			throw new Error(
				"procedure admission cannot accompany an external session",
			)
		if (
			admission.kind !== "admission" ||
			admission.agentId !== params.entry.agentId
		)
			throw new ErasureGateConflictError(params.entry.agentId)
		return withProcedureRevisionCasRetry(() =>
			withFencedWrite({
				db: params.db,
				prefix: params.prefix,
				token: admission,
				fn: (session) =>
					writeProcedure({
						...rest,
						session,
						transactionalSideEffects: "inline",
					}),
			}),
		)
	}
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
		persistedSetDoc = {}
		const now = new Date()
		const witness =
			params.searchWriteToken !== undefined
				? { searchWriteToken: params.searchWriteToken }
				: {}
		const setDoc = {
			...buildProcedureSetDoc({
				entry,
				scope,
				scopeRef,
				searchText,
				updatedAt: now,
			}),
			...witness,
		}
		const restampUnchanged = async () => {
			if (params.searchWriteToken === undefined) return
			await collection.updateOne(
				identityFilter,
				{ $set: witness },
				session ? { session } : {},
			)
		}
		const existing = await collection.findOne(
			identityFilter,
			session ? { session } : undefined,
		)
		existingBeforeWrite = existing
		if (!existing) {
			if (params.expectedRevision !== undefined)
				throw new MemoryLifecycleConflictError({
					reason: "stale-revision",
					expectedRevision: params.expectedRevision,
					actualRevision: 0,
				})
			persistedSetDoc = {
				...setDoc,
				revision: 1,
				validFrom: now,
				createdAt: now,
				openedCount: 0,
				version: 1,
				successCount: 0,
				failCount: 0,
				evolutionHistory: [],
			}
			let result: Awaited<ReturnType<Collection["updateOne"]>>
			try {
				result = await collection.updateOne(
					identityFilter,
					{
						$setOnInsert: persistedSetDoc,
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
			await restampUnchanged()
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
		persistedSetDoc = {
			...buildProcedureSetDoc({
				entry: effectiveEntry,
				scope,
				scopeRef,
				searchText: effectiveSearchText,
				updatedAt: now,
			}),
			...witness,
		}

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
			await restampUnchanged()
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
				...(existing.state === "invalidated" &&
				persistedSetDoc.state === "active"
					? { $unset: { validTo: "", invalidatedBy: "" } }
					: {}),
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
	const outcome = params.session
		? await persist(params.session)
		: client
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
						throw typedTransactionError(err)
					} finally {
						await session.endSession()
					}
				})
			: await persist()
	if (!outcome.changed) {
		return { upserted: false, id: outcome.id, changed: false }
	}

	log.info(
		`procedure ${outcome.upserted ? "created" : "updated"}: id=${entry.procedureId} revision=${outcome.revision}`,
	)
	// C-017: a changed persist rewrites searchText, which the procedures
	// vector index embeds server-side (autoEmbed) in automated mode — one
	// indexing unit per changed write.
	const oldSnapshot = existingBeforeWrite
	const changedFields = computeChangedFields(oldSnapshot ?? {}, persistedSetDoc)
	const runSideEffects = async (session?: ClientSession): Promise<void> => {
		if (params.embeddingMode === "automated") {
			if (session) {
				await recordEmbeddingSpendInSession({
					db,
					prefix,
					agentId: entry.agentId,
					kind: "indexing",
					units: 1,
					session,
				})
			} else {
				recordEmbeddingSpend(db, prefix, entry.agentId, "indexing", 1)
			}
		}
		await invalidateQueryCache({
			db,
			prefix,
			agentId: entry.agentId,
			scope,
			scopeRef,
			...(session ? { session, throwOnError: true } : {}),
		})
		const audit = recordMutation({
			db,
			prefix,
			...(session ? { session } : {}),
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
		})
		if (session) {
			await audit
		} else {
			void bestEffort("procedure-audit", () => audit)
		}
	}
	if (params.session) {
		if (params.transactionalSideEffects === "inline") {
			await runSideEffects(params.session)
			return {
				upserted: outcome.upserted,
				id: outcome.id,
				changed: outcome.changed,
			}
		}
		return {
			upserted: outcome.upserted,
			id: outcome.id,
			changed: outcome.changed,
			pendingSideEffects: runSideEffects,
		}
	}
	await runSideEffects()
	return {
		upserted: outcome.upserted,
		id: outcome.id,
		changed: outcome.changed,
	}
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
	admission?: AdmissionToken
}): Promise<Extract<MemoryLifecycleItem, { family: "procedure" }> | null> {
	if (
		params.admission &&
		(params.admission.kind !== "admission" ||
			params.admission.agentId !== params.handle.agentId)
	)
		throw new ErasureGateConflictError(params.handle.agentId)
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
		admission: params.admission,
	})
	return getProcedureByHandle(params)
}

export async function invalidateProcedureByHandle(params: {
	db: Db
	prefix: string
	handle: MemoryProcedureStableHandle
	invalidatedBy?: Record<string, unknown>
	client?: MongoClient
	session?: ClientSession
	transactionalSideEffects?: "defer" | "inline"
	actorRole?: MemoryActorRole
	mutationMeta?: MutationMeta
	admission?: AdmissionToken
}): Promise<Extract<MemoryLifecycleItem, { family: "procedure" }> | null> {
	const { admission, ...rest } = params
	if (admission) {
		if (params.session)
			throw new Error(
				"admitted procedure invalidation cannot use an external session",
			)
		if (
			admission.kind !== "admission" ||
			admission.agentId !== params.handle.agentId
		)
			throw new ErasureGateConflictError(params.handle.agentId)
		return withProcedureRevisionCasRetry(() =>
			withFencedWrite({
				db: params.db,
				prefix: params.prefix,
				token: admission,
				fn: (session) =>
					invalidateProcedureByHandle({
						...rest,
						session,
						transactionalSideEffects: "inline",
					}),
			}),
		)
	}
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

	if (params.session) {
		await persist(params.session)
	} else if (params.client) {
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
				throw typedTransactionError(err)
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
	const persistedSnapshot = newSnapshot
	if (changed) {
		const runSideEffects = async (session?: ClientSession): Promise<void> => {
			await invalidateQueryCache({
				db: params.db,
				prefix: params.prefix,
				agentId: params.handle.agentId,
				scope: params.handle.scope,
				scopeRef: params.handle.scopeRef,
				...(session ? { session, throwOnError: true } : {}),
			})
			const audit = recordMutation({
				db: params.db,
				prefix: params.prefix,
				...(session ? { session } : {}),
				mutation: {
					collectionName: "procedures",
					documentId: procedureHandleFromDoc(persistedSnapshot).id,
					operation: "invalidate",
					agentId: params.handle.agentId,
					oldValue: oldSnapshot,
					newValue: persistedSnapshot,
					changedFields: ["state", "validTo", "revision", "invalidatedBy"],
					actorRole: params.actorRole ?? "system",
					severity: "warning",
					...(params.mutationMeta ? { meta: params.mutationMeta } : {}),
				},
			})
			if (session) {
				await audit
			} else {
				void bestEffort("procedure-invalidate-audit", () => audit)
			}
		}
		if (params.session && params.transactionalSideEffects === "inline") {
			await runSideEffects(params.session)
		} else if (!params.session) {
			await runSideEffects()
		}
	}
	return procedureLifecycleItemFromDoc(persistedSnapshot)
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
		void bestEffort("procedure-outcome-audit", () =>
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
			}),
		)
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
	admission?: AdmissionToken
}): Promise<Extract<MemoryLifecycleItem, { family: "procedure" }> | null> {
	const { admission } = params
	if (
		admission &&
		(admission.kind !== "admission" ||
			admission.agentId !== params.handle.agentId)
	)
		throw new ErasureGateConflictError(params.handle.agentId)
	const persistOutcome = async (session?: ClientSession) => {
		const collection = proceduresCollection(params.db, params.prefix)
		const filter = procedureFilterFromHandle(params.handle)
		const now = new Date()
		const oldSnapshot = await collection.findOneAndUpdate(
			filter,
			{
				$inc: params.success ? { successCount: 1 } : { failCount: 1 },
				$set: params.success ? { lastSuccessAt: now } : { lastFailureAt: now },
			},
			{ returnDocument: "before", ...(session ? { session } : {}) },
		)
		if (!oldSnapshot) {
			return null
		}
		const updated = applyProcedureOutcomeSnapshot(
			oldSnapshot,
			params.success,
			now,
		)
		if (session) {
			await invalidateQueryCache({
				db: params.db,
				prefix: params.prefix,
				agentId: params.handle.agentId,
				scope: params.handle.scope,
				scopeRef: params.handle.scopeRef,
				session,
				throwOnError: true,
			})
		}
		const audit = recordMutation({
			db: params.db,
			prefix: params.prefix,
			...(session ? { session } : {}),
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
		})
		if (session) {
			await audit
		} else {
			void bestEffort("procedure-outcome-audit", () => audit)
		}
		return procedureLifecycleItemFromDoc(updated)
	}
	return admission
		? withFencedWrite({
				db: params.db,
				prefix: params.prefix,
				token: admission,
				fn: persistOutcome,
			})
		: persistOutcome()
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
		// RET-09: procedures are agent-distilled playbooks (mixed-turn
		// summaries), never user-authored spans.
		derivation: "derived",
		...(typeof doc.sessionId === "string" ? { sessionId: doc.sessionId } : {}),
		...(doc.updatedAt instanceof Date ? { timestamp: doc.updatedAt } : {}),
		...(typeof doc.confidence === "number"
			? { confidence: doc.confidence }
			: {}),
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

/**
 * Exact procedure name or trigger-query match: `$search` `equals` on the
 * `name` and `triggerQueries` token fields, which the manifest indexes with
 * the lowercase normalizer. The match is the full value, case-insensitive;
 * a prefix, a superset or a mid-word substring does not match.
 *
 * The Search stage only selects candidates. The full filter (owner, scope,
 * state, validity window) is applied again to the hydrated document before
 * the limit, so a procedure that changed after it was indexed cannot return.
 * A Search failure or budget denial is a typed throw, never a different
 * lookup.
 */
export async function findExactProcedureMatches(
	collection: Collection,
	query: string,
	opts: {
		maxResults: number
		/** The Search index that serves `equals` on name and triggerQueries. */
		textIndexName: string
		filter?: {
			agentId?: string
			scope?: MemoryScope
			scopeRef?: string
			state?: ProcedureState
			intentTags?: string[]
			currentOnly?: boolean
			asOf?: Date
		}
		onTierOutcome?: SearchTierOutcomeSink
	},
): Promise<MemorySearchResult[]> {
	const trimmed = query.trim()
	if (!trimmed) {
		opts.onTierOutcome?.({
			stage: "exact-match",
			outcome: "not-applicable",
			reason: "empty-query",
		})
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
	const canonicalFilter = mergeQueryClauses(
		filter,
		opts.filter?.currentOnly ? buildCurrentValidityClause({ asOf }) : undefined,
	)
	const { compoundFilter } = splitAtlasSearchFilter(canonicalFilter)
	const pipeline: Document[] = [
		{
			$search: {
				index: opts.textIndexName,
				compound: {
					should: [
						{ equals: { path: "name", value: trimmed } },
						{ equals: { path: "triggerQueries", value: trimmed } },
					],
					minimumShouldMatch: 1,
					...(compoundFilter ? { filter: compoundFilter } : {}),
				},
			},
		},
		// The compound filter runs against the indexed copy, which can lag the
		// latest write; revalidate the whole filter on the hydrated document.
		...freshnessRevalidationStages(canonicalFilter),
		{ $sort: { updatedAt: -1 } },
		{ $limit: opts.maxResults },
		{
			$project: {
				_id: 0,
				procedureId: 1,
				searchText: 1,
				sessionId: 1,
				// RET-09: surface the stored confidence for the
				// provenance classifier.
				confidence: 1,
				updatedAt: 1,
				state: 1,
				scope: 1,
				scopeRef: 1,
				provenance: 1,
				sourceEventIds: 1,
				validFrom: 1,
				validTo: 1,
			},
		},
	]
	let docs: Document[]
	try {
		docs = await runSearchAggregateWithRetry(collection, pipeline, {
			stage: "exact-match",
		})
	} catch (err) {
		throw toTypedSearchError(err, "exact-match")
	}

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
		onTierOutcome?: SearchTierOutcomeSink
	},
): Promise<MemorySearchResult[]> {
	const minScore = opts.minScore ?? 0.1
	const canVector = opts.capabilities.vectorSearch
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

	// #101 / matrix 1e: the vector tier, then — only after a SUCCESSFUL zero
	// hit — the procedures_text $search tier. Classic $text is gone. An error
	// or a budget denial is a typed throw at its tier; a lane with neither
	// tier available is a typed lane-unavailable failure, never a silent [].
	const canText = isTextSearchTierAvailable(
		opts.capabilities,
		opts.textIndexName,
	)
	if (!canVector && !canText) {
		throw new SearchLaneUnavailableError()
	}
	const report = (stage: "vector" | "atlas-search", count: number): void => {
		opts.onTierOutcome?.({
			stage,
			outcome: count > 0 ? "ok" : "ok-empty",
			...(count > 0 ? {} : { reason: "zero-hits" as const }),
			resultCount: count,
		})
	}
	const textTierAbsent = (): MemorySearchResult[] => {
		opts.onTierOutcome?.({
			stage: "atlas-search",
			outcome: "not-applicable",
			reason: "capability-absent",
		})
		return []
	}
	const projection = {
		_id: 0,
		procedureId: 1,
		searchText: 1,
		sessionId: 1,
		// RET-09: surface the stored confidence for the provenance classifier.
		confidence: 1,
		updatedAt: 1,
		state: 1,
		scope: 1,
		scopeRef: 1,
		provenance: 1,
		sourceEventIds: 1,
		validFrom: 1,
		validTo: 1,
	}

	if (!canVector) {
		opts.onTierOutcome?.({
			stage: "vector",
			outcome: "not-applicable",
			reason: "capability-absent",
		})
	} else {
		const filter = buildFilter()
		const vsStage = buildVectorSearchStage({
			queryVector,
			queryText: query,
			embeddingMode: opts.embeddingMode,
			model: opts.queryEmbeddingModel,
			indexName: opts.vectorIndexName,
			numCandidates,
			limit: opts.maxResults,
			filter: Object.keys(filter).length > 0 ? filter : undefined,
			textFieldPath: "searchText",
			// Authoritative serving hydrates the full current document from
			// mongod (the documented default); storedSource may return stale
			// data and would defeat the post-stage freshness $match below.
			returnStoredSource: false,
			stage: "vector",
		})
		if (!vsStage) {
			opts.onTierOutcome?.({
				stage: "vector",
				outcome: "not-applicable",
				reason: "empty-query",
			})
		} else {
			const pipeline: Document[] = [
				{ $vectorSearch: vsStage },
				// Re-validate the full filter against the hydrated document —
				// the ANN prefilter runs against the indexed copy, which can
				// lag the latest write.
				...freshnessRevalidationStages(filter),
				{ $limit: opts.maxResults },
				{
					$project: { ...projection, score: { $meta: "vectorSearchScore" } },
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
					reportExplainFailure(err, opts.onTierOutcome)
				}
			}
			let docs: Document[]
			try {
				docs = await runSearchAggregateWithRetry(collection, pipeline, {
					stage: "vector",
				})
			} catch (err) {
				throw toTypedSearchError(err, "vector")
			}
			const results = docs
				.map(toProcedureResult)
				.filter((result) => result.score >= minScore)
			report("vector", results.length)
			if (results.length > 0) {
				if (!canText) {
					textTierAbsent()
				}
				return results
			}
		}
		if (!canText) {
			return textTierAbsent()
		}
	}

	if (!query.trim()) {
		opts.onTierOutcome?.({
			stage: "atlas-search",
			outcome: "not-applicable",
			reason: "empty-query",
		})
		return []
	}
	const textFilter = buildFilter()
	const { compoundFilter } = splitAtlasSearchFilter(textFilter)
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
		// Re-validate the full filter against the hydrated document — the
		// compound filter runs against the indexed copy, which can lag the
		// latest write.
		...freshnessRevalidationStages(textFilter),
		{ $limit: opts.maxResults * 4 },
		{ $project: { ...projection, score: { $meta: "searchScore" } } },
	]
	if (opts.explain?.enabled) {
		opts.explain.onArtifact?.({
			artifactType: "searchExplain",
			summary: { source: "procedure", method: "atlas-search" },
		})
	}
	let docs: Document[]
	try {
		docs = await runSearchAggregateWithRetry(collection, pipeline, {
			stage: "atlas-search",
		})
	} catch (err) {
		throw toTypedSearchError(err, "atlas-search")
	}
	const results = docs
		.map(toProcedureResult)
		.filter((result) => result.score >= minScore)
	report("atlas-search", results.length)
	return results
}
