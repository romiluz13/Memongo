import fs from "node:fs/promises"
import path from "node:path"
import type {
	ClientSession,
	Collection,
	Db,
	Document,
	MongoClient,
} from "mongodb"
import {
	type MemoryMongoDBEmbeddingMode,
	createSubsystemLogger,
} from "@memongo/lib"
import {
	CHUNK_SCHEME_VERSION,
	buildFileEntry,
	chunkMarkdown,
	listMemoryFiles,
	type MemoryChunk,
	type MemoryFileEntry,
	runUnorderedBulkWriteCounted,
} from "./internal.js"
import type { AnyBulkWriteOperation } from "mongodb"
import type { EmbeddingStatus } from "./mongodb-embedding-retry.js"
import { chunksCollection, filesCollection } from "./mongodb-schema.js"
import { INDEX_AUTOEMBED_MODEL } from "./mongodb-schema-search-definitions.js"
import { resolveScopeRef } from "./mongodb-scope.js"
import {
	MAJORITY_TRANSACTION_OPTIONS,
	isTransactionTooLargeForCache,
	isTransactionUnsupported,
} from "./mongodb-transactions.js"
import { buildSessionEntry, listSessionFilesForAgent } from "./session-files.js"
import type {
	InternalMemoryStoredSource,
	MemorySyncProgressUpdate,
} from "./types.js"

const log = createSubsystemLogger("memory:mongodb:sync")

// Re-export chunk helpers from internal.ts
export { chunkMarkdown }

// ---------------------------------------------------------------------------
// File metadata operations
// ---------------------------------------------------------------------------

type SyncNamespace = {
	source: InternalMemoryStoredSource
	agentId?: string
	scope?: string
	scopeRef?: string
}

function buildNamespaceFilter(namespace: SyncNamespace): Document {
	const filter: Document = { source: namespace.source }
	if (namespace.agentId) {
		filter.agentId = namespace.agentId
	}
	if (namespace.scope) {
		filter.scope = namespace.scope
	}
	if (namespace.scopeRef) {
		filter.scopeRef = namespace.scopeRef
	}
	return filter
}

function buildStorageId(namespace: SyncNamespace, relPath: string): string {
	return [
		namespace.source,
		namespace.agentId ?? "_",
		namespace.scope ?? "_",
		namespace.scopeRef ?? "_",
		relPath,
	].join("::")
}

/** Stored per-file metadata needed by the sync loop. */
type StoredFileMeta = {
	hash: string
	mtime: number
	size: number
	/**
	 * W07: chunk identity scheme that wrote this file's stored chunks.
	 * Rows written before the ordinal discriminator carry no value (or a
	 * lower version) and must be re-chunked once even when the content hash
	 * is unchanged — a same-hash skip is only valid for current-scheme rows.
	 */
	chunkScheme: number
}

async function getStoredFiles(
	files: Collection,
	namespace: SyncNamespace,
): Promise<Map<string, StoredFileMeta>> {
	const docs = await files.find(buildNamespaceFilter(namespace)).toArray()
	const map = new Map<string, StoredFileMeta>()
	for (const doc of docs) {
		const relPath = typeof doc.path === "string" ? doc.path : String(doc._id)
		const scheme = doc.chunkScheme
		map.set(relPath, {
			hash: doc.hash as string,
			mtime: doc.mtime as number,
			size: doc.size as number,
			chunkScheme: typeof scheme === "number" ? scheme : 1,
		})
	}
	return map
}

/** Shape shared by memory file entries and session file entries. */
type SyncableFileEntry = {
	path: string
	hash: string
	mtimeMs: number
	size: number
}

async function upsertFileMetadata(
	files: Collection,
	entry: SyncableFileEntry,
	namespace: SyncNamespace,
	session?: ClientSession,
): Promise<void> {
	const update = {
		$set: {
			path: entry.path,
			source: namespace.source,
			...(namespace.agentId ? { agentId: namespace.agentId } : {}),
			...(namespace.scope ? { scope: namespace.scope } : {}),
			...(namespace.scopeRef ? { scopeRef: namespace.scopeRef } : {}),
			hash: entry.hash,
			mtime: entry.mtimeMs,
			size: entry.size,
			// W07: record the chunk identity scheme that wrote these chunks so
			// future syncs know a same-hash skip is valid for them.
			chunkScheme: CHUNK_SCHEME_VERSION,
			updatedAt: new Date(),
		},
	}
	const filter = { _id: buildStorageId(namespace, entry.path) } as Record<
		string,
		unknown
	>
	if (session) {
		await files.updateOne(filter, update, { upsert: true, session })
	} else {
		await files.updateOne(filter, update, { upsert: true })
	}
}

// ---------------------------------------------------------------------------
// Chunk operations
// ---------------------------------------------------------------------------

function buildChunkId(
	storageId: string,
	startLine: number,
	endLine: number,
	ordinal: number,
): string {
	// W07: the ordinal disambiguates multiple segments of one long source
	// line, which all share {startLine, endLine}. Without it their ids
	// collided and the chunk bulkWrite silently overwrote all but the last
	// segment (last-write-wins upserts).
	return `${storageId}:${startLine}:${endLine}:${ordinal}`
}

function buildChunkOps(
	path: string,
	namespace: SyncNamespace,
	chunkList: MemoryChunk[],
	model: string,
	embeddings: number[][] | null,
	embeddingStatus: EmbeddingStatus,
): AnyBulkWriteOperation<Document>[] {
	return chunkList.map((chunk, index) => {
		const chunkId = buildChunkId(
			buildStorageId(namespace, path),
			chunk.startLine,
			chunk.endLine,
			chunk.ordinal,
		)
		const setDoc: Document = {
			path,
			source: namespace.source,
			...(namespace.agentId ? { agentId: namespace.agentId } : {}),
			...(namespace.scope ? { scope: namespace.scope } : {}),
			...(namespace.scopeRef ? { scopeRef: namespace.scopeRef } : {}),
			startLine: chunk.startLine,
			endLine: chunk.endLine,
			// W07: persist the emission ordinal (see buildChunkId).
			ordinal: chunk.ordinal,
			hash: chunk.hash,
			model,
			text: chunk.text,
			embeddingStatus,
			updatedAt: new Date(),
		}
		// Embeddings are generated by MongoDB automatically after write time.
		if (embeddings && embeddings[index]) {
			setDoc.embedding = embeddings[index]
		}
		return {
			updateOne: {
				filter: { _id: chunkId } as Record<string, unknown>,
				update: { $set: setDoc },
				upsert: true,
			},
		}
	})
}

type UpsertChunksResult = {
	applied: number
	failed: number
}

async function upsertChunks(
	chunks: Collection,
	path: string,
	namespace: SyncNamespace,
	chunkList: MemoryChunk[],
	model: string,
	embeddings: number[][] | null,
	embeddingStatus: EmbeddingStatus,
): Promise<UpsertChunksResult> {
	if (chunkList.length === 0) {
		return { applied: 0, failed: 0 }
	}

	const ops = buildChunkOps(
		path,
		namespace,
		chunkList,
		model,
		embeddings,
		embeddingStatus,
	)

	const { applied, writeErrors } = await runUnorderedBulkWriteCounted(() =>
		chunks.bulkWrite(ops, { ordered: false }),
	)
	if (writeErrors.length === 0) {
		return { applied, failed: 0 }
	}

	// Partial failure: retry every op individually (ordered, one by one) to
	// salvage what applies. Re-applying an op that already succeeded is
	// idempotent (updateOne upsert with the same $set doc). Ops that still fail
	// are reported so the caller can refuse to advance the file metadata hash —
	// otherwise the next sync would skip the file and the lost chunks would
	// never be retried (P0.3 silent recall gap).
	log.warn(
		`chunk bulkWrite partially failed for ${path}: ${writeErrors.length} of ${ops.length} ops rejected (${writeErrors[0]}); retrying individually`,
	)
	let stillFailed = 0
	for (const op of ops) {
		try {
			await chunks.bulkWrite([op], { ordered: true })
		} catch (err) {
			stillFailed++
			const msg = err instanceof Error ? err.message : String(err)
			log.warn(`chunk upsert still failing for ${path}: ${msg}`)
		}
	}
	return { applied: ops.length - stillFailed, failed: stillFailed }
}

/**
 * W15: hash sentinel marking a stored metadata row as must-rechunk. Written
 * BEFORE any non-transactional replacement of a file's chunks so a crash at
 * any later point leaves a hash that never matches real content — the next
 * sync re-processes the file instead of skipping it with missing chunks.
 * (Real hashes are hex sha256 digests, so this value can never collide.)
 */
const INVALIDATED_HASH = "__invalidated__"

async function invalidateStoredHash(
	files: Collection,
	relPath: string,
	namespace: SyncNamespace,
): Promise<void> {
	const filter = { _id: buildStorageId(namespace, relPath) } as Record<
		string,
		unknown
	>
	try {
		// No upsert: a path with no stored row needs no invalidation (the
		// absence of a row already forces a full sync).
		await files.updateOne(filter, { $set: { hash: INVALIDATED_HASH } })
	} catch (err) {
		// Invalidation is a safety net; a failure here must not mask the
		// chunk writes that follow. The completing metadata write is what
		// actually guards the next sync, and it is written last.
		log.warn(
			`sync: could not invalidate stored hash for ${relPath}: ${err instanceof Error ? err.message : String(err)}`,
		)
	}
}

async function deleteChunksForPath(
	chunks: Collection,
	path: string,
	namespace: SyncNamespace,
	session?: ClientSession,
): Promise<number> {
	const filter = { ...buildNamespaceFilter(namespace), path }
	const result = session
		? await chunks.deleteMany(filter, { session })
		: await chunks.deleteMany(filter)
	return result.deletedCount
}

async function deleteStaleChunks(
	chunks: Collection,
	namespace: SyncNamespace,
	validPaths: Set<string>,
	session?: ClientSession,
): Promise<number> {
	const namespaceFilter = buildNamespaceFilter(namespace)
	const allPaths = session
		? await chunks.distinct("path", namespaceFilter, { session })
		: await chunks.distinct("path", namespaceFilter)
	const stalePaths = allPaths.filter((p) => !validPaths.has(p))
	if (stalePaths.length === 0) {
		return 0
	}

	const filter = { ...namespaceFilter, path: { $in: stalePaths } }
	const result = session
		? await chunks.deleteMany(filter, { session })
		: await chunks.deleteMany(filter)
	return result.deletedCount
}

// ---------------------------------------------------------------------------
// Atomic file sync
// ---------------------------------------------------------------------------

/**
 * W15: non-transactional replacement ordering. Invalidate the stored hash
 * FIRST, then replace chunks, then write the completing metadata. A crash at
 * any point leaves the stored hash at the sentinel, so the next sync always
 * re-processes the file — chunks can never be silently missing while the
 * metadata says "up to date".
 */
async function syncFileNonTransactional(params: {
	chunksCol: Collection
	filesCol: Collection
	entry: SyncableFileEntry
	namespace: SyncNamespace
	chunks: MemoryChunk[]
	model: string
	embeddings: number[][] | null
	embeddingStatus: EmbeddingStatus
}): Promise<{ upserted: number; failed: boolean }> {
	const { chunksCol, filesCol, entry, namespace, chunks, model } = params
	await invalidateStoredHash(filesCol, entry.path, namespace)
	await deleteChunksForPath(chunksCol, entry.path, namespace)
	const result = await upsertChunks(
		chunksCol,
		entry.path,
		namespace,
		chunks,
		model,
		params.embeddings,
		params.embeddingStatus,
	)
	if (result.failed > 0) {
		// Chunks were lost — do NOT write the completing metadata. The row
		// still holds the sentinel hash, so the next sync re-attempts this
		// file instead of skipping it (P0.3 silent recall gap).
		log.warn(
			`sync: ${result.failed} chunk writes failed for ${entry.path}; keeping invalidated metadata hash so next sync retries`,
		)
		return { upserted: result.applied, failed: true }
	}
	await upsertFileMetadata(filesCol, entry, namespace)
	return { upserted: result.applied, failed: false }
}

/**
 * W15: replace one source file's chunks + metadata.
 *
 * Transactional path: delete, chunk upserts, and metadata land in ONE
 * withTransaction — all-or-nothing, no crash window with chunks missing while
 * the hash still says current.
 *
 * Fallbacks (standalone server, or a transaction too large for the WiredTiger
 * cache): the transaction aborted, so nothing from it is visible. We then run
 * the invalidation-first non-transactional ordering, which keeps every crash
 * window self-healing.
 *
 * Unifies the former syncFileAtomically + syncSessionFileAtomically — memory
 * files and session transcripts share the exact same durability contract.
 */
async function syncSourceFileAtomically(params: {
	client: MongoClient | undefined
	useTransactions: boolean
	chunksCol: Collection
	filesCol: Collection
	entry: SyncableFileEntry
	namespace: SyncNamespace
	chunks: MemoryChunk[]
	model: string
	embeddings: number[][] | null
	embeddingStatus: EmbeddingStatus
}): Promise<{
	upserted: number
	disableTransactions: boolean
	failed: boolean
}> {
	const {
		client,
		chunksCol,
		filesCol,
		entry,
		namespace,
		chunks,
		model,
		embeddings,
		embeddingStatus,
	} = params

	if (!client || !params.useTransactions) {
		const result = await syncFileNonTransactional({
			chunksCol,
			filesCol,
			entry,
			namespace,
			chunks,
			model,
			embeddings,
			embeddingStatus,
		})
		return {
			upserted: result.upserted,
			disableTransactions: false,
			failed: result.failed,
		}
	}

	const session = client.startSession()
	try {
		// W15: everything in ONE transaction. Chunk writes are limited to one
		// file's chunks (bounded by chunking + maxSessionChunks), so a
		// TransactionTooLargeForCache here falls back below instead of
		// pre-splitting the work across transactions (which reintroduced the
		// crash window this fix closes).
		let upserted = 0
		await session.withTransaction(async () => {
			await deleteChunksForPath(chunksCol, entry.path, namespace, session)
			const chunkOps = buildChunkOps(
				entry.path,
				namespace,
				chunks,
				model,
				embeddings,
				embeddingStatus,
			)
			// Inside a transaction a write error aborts the whole batch, so
			// there is no partial-count handling here — the transaction is
			// all-or-nothing.
			const result = await chunksCol.bulkWrite(chunkOps, {
				ordered: false,
				session,
			})
			upserted = result.upsertedCount + result.modifiedCount
			await upsertFileMetadata(filesCol, entry, namespace, session)
		}, MAJORITY_TRANSACTION_OPTIONS)
		return { upserted, disableTransactions: false, failed: false }
	} catch (err) {
		if (isTransactionTooLargeForCache(err) || isTransactionUnsupported(err)) {
			if (isTransactionUnsupported(err)) {
				log.info(
					"transactions not supported (standalone), falling back for file sync",
				)
			} else {
				log.warn(
					"transaction too large for cache, falling back to invalidation-first ordering",
				)
			}
			// The transaction aborted — nothing from it is visible. Replace
			// the file non-transactionally with crash-window-safe ordering.
			const result = await syncFileNonTransactional({
				chunksCol,
				filesCol,
				entry,
				namespace,
				chunks,
				model,
				embeddings,
				embeddingStatus,
			})
			return {
				upserted: result.upserted,
				// Only a standalone server keeps needing the fallback; a
				// too-large transaction is per-file, so keep transactions on.
				disableTransactions: isTransactionUnsupported(err),
				failed: result.failed,
			}
		}
		throw err
	} finally {
		await session.endSession()
	}
}

// ---------------------------------------------------------------------------
// Main sync function
// ---------------------------------------------------------------------------

export type SyncResult = {
	filesProcessed: number
	chunksUpserted: number
	staleDeleted: number
	sessionFilesProcessed: number
	sessionChunksUpserted: number
	/** Files whose chunk writes failed even after individual retry; their
	 * metadata hash was NOT advanced so the next sync re-attempts them. */
	filesFailed: number
	/**
	 * W14: true only when BOTH enumerations (memory dir + session transcripts)
	 * and every per-file read succeeded. Stale cleanup is skipped whenever this
	 * is false — deleting stale paths requires knowing the full valid-path set,
	 * and an enumeration failure would otherwise read as "everything is stale"
	 * and delete every stored chunk.
	 */
	enumerationComplete: boolean
}

export async function syncToMongoDB(params: {
	client?: MongoClient
	db: Db
	prefix: string
	agentId?: string
	sessionMemoryEnabled?: boolean
	workspaceDir: string
	extraPaths?: string[]
	embeddingMode: MemoryMongoDBEmbeddingMode
	chunking?: { tokens: number; overlap: number }
	model?: string
	reason?: string
	force?: boolean
	maxSessionChunks?: number
	progress?: (update: MemorySyncProgressUpdate) => void
}): Promise<SyncResult> {
	const { db, prefix, embeddingMode, progress } = params
	const model = params.model ?? INDEX_AUTOEMBED_MODEL
	const chunking = params.chunking ?? { tokens: 400, overlap: 80 }
	const memoryNamespace: SyncNamespace = {
		source: "conversation",
		...(params.agentId ? { agentId: params.agentId } : {}),
		scope: "workspace",
		scopeRef: resolveScopeRef({
			scope: "workspace",
			agentId: params.agentId ?? "__workspace__",
			workspaceDir: params.workspaceDir,
		}),
	}
	// Track whether transactions are available (disabled on first standalone error)
	let useTransactions = !!params.client

	const chunksCol = chunksCollection(db, prefix)
	const filesCol = filesCollection(db, prefix)

	// 2. Get stored file metadata from MongoDB
	const storedFiles = await getStoredFiles(filesCol, memoryNamespace)

	// =========================================================================
	// Phase A: Memory files (source="memory")
	// =========================================================================

	// 1. List memory files on disk (returns absolute paths)
	// W14: an enumeration failure must not read as "no memory files" — the
	// stale cleanup below would then delete every stored chunk. Mark the
	// enumeration incomplete and skip stale cleanup instead.
	let diskPaths: string[] = []
	let memoryEnumerationComplete = true
	try {
		diskPaths = await listMemoryFiles(params.workspaceDir, params.extraPaths)
	} catch (err) {
		memoryEnumerationComplete = false
		log.warn(
			`sync: memory file enumeration failed; skipping stale cleanup (${err instanceof Error ? err.message : String(err)})`,
		)
	}
	log.info(
		`sync: found ${diskPaths.length} memory files on disk (reason=${params.reason ?? "manual"})`,
	)

	// Build file entries with hash, mtime, size
	let filesProcessed = 0
	let filesFailed = 0
	let totalChunksUpserted = 0
	const diskFiles: MemoryFileEntry[] = []
	for (const absPath of diskPaths) {
		try {
			const entry = await buildFileEntry(absPath, params.workspaceDir)
			if (entry) {
				diskFiles.push(entry)
			}
		} catch (err) {
			// W14: a file we listed but could not read is neither processed nor
			// valid for stale accounting — count it failed and keep stale
			// cleanup off (its stored chunks must not be treated as stale).
			memoryEnumerationComplete = false
			filesFailed++
			const msg = err instanceof Error ? err.message : String(err)
			log.warn(`sync: failed to read ${absPath}: ${msg}`)
		}
	}

	// Determine which files need re-indexing
	const filesToProcess: MemoryFileEntry[] = []
	const validPaths = new Set<string>()

	for (const file of diskFiles) {
		validPaths.add(file.path)
		const stored = storedFiles.get(file.path)
		// W07: also re-chunk legacy rows whose chunks were written by a
		// pre-ordinal identity scheme — a same-hash skip is only valid for
		// current-scheme chunks.
		if (
			params.force ||
			!stored ||
			stored.hash !== file.hash ||
			stored.chunkScheme !== CHUNK_SCHEME_VERSION
		) {
			filesToProcess.push(file)
		}
	}

	log.info(
		`sync: ${filesToProcess.length}/${diskPaths.length} memory files need re-indexing`,
	)
	progress?.({
		completed: 0,
		total: filesToProcess.length,
		label: "Syncing memory files",
	})

	// Process each changed memory file
	for (const file of filesToProcess) {
		try {
			const content = await fs.readFile(file.absPath, "utf-8")
			const chunks = chunkMarkdown(content, chunking)

			// Text-only write path — embeddings are generated by MongoDB automatically
			const embeddingStatus: EmbeddingStatus = "pending"
			const embeddings: number[][] | null = null

			const { upserted, disableTransactions, failed } =
				await syncSourceFileAtomically({
					client: params.client,
					useTransactions,
					chunksCol,
					filesCol,
					entry: file,
					namespace: memoryNamespace,
					chunks,
					model,
					embeddings,
					embeddingStatus,
				})
			totalChunksUpserted += upserted
			if (disableTransactions) {
				useTransactions = false
			}

			if (failed) {
				filesFailed++
			} else {
				filesProcessed++
			}
			progress?.({
				completed: filesProcessed + filesFailed,
				total: filesToProcess.length,
				label: file.path,
			})
		} catch (err) {
			// W14: count per-file failures so the caller (dirty-flag gating in
			// the manager) can refuse to treat this sync as clean.
			filesFailed++
			const msg = err instanceof Error ? err.message : String(err)
			log.warn(`sync: failed to process ${file.path}: ${msg}`)
		}
	}

	// =========================================================================
	// Phase B: Session transcript files (runtime conversation history)
	// =========================================================================

	let sessionFilesProcessed = 0
	let sessionChunksUpserted = 0
	let sessionStaleDeleted = 0
	let sessionEnumerationComplete = true

	if (params.agentId && params.sessionMemoryEnabled !== false) {
		try {
			const sessionResult = await syncSessionFiles({
				client: params.client,
				useTransactions,
				agentId: params.agentId,
				chunksCol,
				filesCol,
				storedFiles: await getStoredFiles(filesCol, {
					source: "sessions",
					agentId: params.agentId,
					scope: "agent",
					scopeRef: resolveScopeRef({
						scope: "agent",
						agentId: params.agentId,
					}),
				}),
				validPaths,
				embeddingMode,
				chunking,
				model,
				force: params.force,
				maxSessionChunks: params.maxSessionChunks,
				progress,
			})
			sessionFilesProcessed = sessionResult.filesProcessed
			sessionChunksUpserted = sessionResult.chunksUpserted
			sessionStaleDeleted = sessionResult.staleDeleted
			filesFailed += sessionResult.filesFailed
			sessionEnumerationComplete = sessionResult.enumerationComplete
			// Propagate standalone detection from session sync to stale cleanup
			if (!sessionResult.useTransactions) {
				useTransactions = false
			}
		} catch (err) {
			// W14: a session-sync-level failure leaves the valid-path set
			// incomplete for the sessions namespace — stale cleanup must not
			// run on partial knowledge.
			sessionEnumerationComplete = false
			const msg = err instanceof Error ? err.message : String(err)
			log.warn(`session sync failed: ${msg}`)
		}
	}

	// =========================================================================
	// Phase C: Stale cleanup (covers markdown paths and active conversation paths)
	// =========================================================================

	// W14: stale deletion is only sound with a COMPLETE valid-path set. Any
	// enumeration or per-file read failure (memory or sessions) means stored
	// chunks we could not account for — deleting "stale" paths then risks
	// mass-deleting live data, so skip the whole phase and let the next
	// successful sync do the cleanup.
	const enumerationComplete =
		memoryEnumerationComplete && sessionEnumerationComplete

	let staleDeleted = 0
	if (!enumerationComplete) {
		log.warn(
			"sync: skipping stale cleanup — source enumeration incomplete (W14 guard)",
		)
	} else {
		// Compute stale paths OUTSIDE any transaction (avoid read pressure inside txn)
		const staleFileIds: string[] = []
		for (const [storedPath] of storedFiles) {
			if (!validPaths.has(storedPath)) {
				staleFileIds.push(buildStorageId(memoryNamespace, storedPath))
			}
		}

		if (params.client && useTransactions) {
			let session: ClientSession | undefined
			try {
				session = params.client.startSession()
				await session.withTransaction(async () => {
					staleDeleted = await deleteStaleChunks(
						chunksCol,
						memoryNamespace,
						validPaths,
						session,
					)
					if (staleFileIds.length > 0) {
						await filesCol.deleteMany(
							{ _id: { $in: staleFileIds } } as Record<string, unknown>,
							{
								session,
							},
						)
					}
				}, MAJORITY_TRANSACTION_OPTIONS)
			} catch (err) {
				if (isTransactionUnsupported(err)) {
					// Fallback: non-transactional stale cleanup
					staleDeleted = await deleteStaleChunks(
						chunksCol,
						memoryNamespace,
						validPaths,
					)
					if (staleFileIds.length > 0) {
						await filesCol.deleteMany({
							_id: { $in: staleFileIds },
						} as Record<string, unknown>)
					}
				} else {
					throw err
				}
			} finally {
				await session?.endSession()
			}
		} else {
			staleDeleted = await deleteStaleChunks(
				chunksCol,
				memoryNamespace,
				validPaths,
			)
			if (staleFileIds.length > 0) {
				await filesCol.deleteMany({
					_id: { $in: staleFileIds },
				} as Record<string, unknown>)
			}
		}
	}

	if (staleDeleted > 0) {
		log.info(`sync: removed ${staleDeleted} stale chunks`)
	}
	if (sessionStaleDeleted > 0) {
		log.info(`sync: removed ${sessionStaleDeleted} stale session chunks`)
	}

	log.info(
		`sync complete: memory=${filesProcessed} conversation=${sessionFilesProcessed} chunks=${totalChunksUpserted + sessionChunksUpserted} stale=${staleDeleted + sessionStaleDeleted} failed=${filesFailed} enumerationComplete=${enumerationComplete}`,
	)

	return {
		filesProcessed,
		chunksUpserted: totalChunksUpserted,
		staleDeleted: staleDeleted + sessionStaleDeleted,
		sessionFilesProcessed,
		sessionChunksUpserted,
		filesFailed,
		enumerationComplete,
	}
}

// ---------------------------------------------------------------------------
// Session file sync
// ---------------------------------------------------------------------------

async function syncSessionFiles(params: {
	client?: MongoClient
	useTransactions: boolean
	agentId: string
	chunksCol: Collection
	filesCol: Collection
	storedFiles: Map<string, StoredFileMeta>
	validPaths: Set<string>
	embeddingMode: MemoryMongoDBEmbeddingMode
	chunking: { tokens: number; overlap: number }
	model: string
	force?: boolean
	maxSessionChunks?: number
	progress?: (update: MemorySyncProgressUpdate) => void
}): Promise<{
	filesProcessed: number
	chunksUpserted: number
	staleDeleted: number
	useTransactions: boolean
	filesFailed: number
	enumerationComplete: boolean
}> {
	const sessionNamespace: SyncNamespace = {
		source: "sessions",
		agentId: params.agentId,
		scope: "agent",
		scopeRef: resolveScopeRef({ scope: "agent", agentId: params.agentId }),
	}
	// W14: enumeration failures must not read as "no session files" — the
	// stale cleanup below would then delete every stored transcript chunk.
	let sessionPaths: string[] = []
	let enumerationComplete = true
	try {
		sessionPaths = await listSessionFilesForAgent(params.agentId)
	} catch (err) {
		enumerationComplete = false
		log.warn(
			`sync: session file enumeration failed; skipping session stale cleanup (${err instanceof Error ? err.message : String(err)})`,
		)
	}
	if (sessionPaths.length === 0) {
		return {
			filesProcessed: 0,
			chunksUpserted: 0,
			staleDeleted: 0,
			useTransactions: params.useTransactions,
			filesFailed: 0,
			enumerationComplete,
		}
	}

	log.info(`sync: found ${sessionPaths.length} session files`)
	let filesProcessed = 0
	let filesFailed = 0
	let chunksUpserted = 0
	let useTransactions = params.useTransactions
	params.progress?.({
		completed: 0,
		total: sessionPaths.length,
		label: "Syncing MongoDB conversation transcripts…",
	})

	for (const absPath of sessionPaths) {
		try {
			const entry = await buildSessionEntry(absPath)
			if (!entry) {
				// W14: confirmed-missing file — legitimately stale; keep it out
				// of validPaths so cleanup removes its stored data.
				params.progress?.({
					completed: filesProcessed,
					total: sessionPaths.length,
					label: `Skipping missing conversation transcript (${path.basename(absPath)})`,
				})
				continue
			}
			if (!entry.content) {
				params.progress?.({
					completed: filesProcessed,
					total: sessionPaths.length,
					label: `Skipping empty conversation transcript (${path.basename(absPath)})`,
				})
				continue
			}

			// Track this session path as valid (for stale cleanup)
			params.validPaths.add(entry.path)

			// Check if already indexed with same hash
			const stored = params.storedFiles.get(entry.path)
			// W07: re-chunk legacy pre-ordinal rows once even on same hash.
			if (
				!params.force &&
				stored?.hash === entry.hash &&
				stored?.chunkScheme === CHUNK_SCHEME_VERSION
			) {
				params.progress?.({
					completed: filesProcessed,
					total: sessionPaths.length,
					label: `Conversation transcript already indexed (${path.basename(absPath)})`,
				})
				continue
			}

			// Chunk the session content (same as memory files)
			let chunks = chunkMarkdown(entry.content, params.chunking)

			// Cap session chunks at maxSessionChunks — keep last N (most recent) chunks
			if (
				params.maxSessionChunks &&
				params.maxSessionChunks > 0 &&
				chunks.length > params.maxSessionChunks
			) {
				log.info(
					`session ${entry.path}: truncating ${chunks.length} chunks to last ${params.maxSessionChunks}`,
				)
				chunks = chunks.slice(-params.maxSessionChunks)
			}

			// Session chunks follow the same text-only write path as memory files.
			const embeddingStatus: EmbeddingStatus = "pending"
			const embeddings: number[][] | null = null

			// Atomic write: delete + upsert + metadata in one transaction (W15)
			const { upserted, disableTransactions, failed } =
				await syncSourceFileAtomically({
					client: params.client,
					useTransactions,
					chunksCol: params.chunksCol,
					filesCol: params.filesCol,
					entry,
					namespace: sessionNamespace,
					chunks,
					model: params.model,
					embeddings,
					embeddingStatus,
				})
			chunksUpserted += upserted
			if (disableTransactions) {
				useTransactions = false
			}
			if (failed) {
				filesFailed++
			} else {
				filesProcessed++
			}
			params.progress?.({
				completed: filesProcessed + filesFailed,
				total: sessionPaths.length,
				label: `Indexed conversation transcript ${filesProcessed + filesFailed}/${sessionPaths.length}`,
			})
		} catch (err) {
			// W14: a transient per-file failure must count (dirty-flag gating)
			// and must keep stale cleanup off — the file's path never made it
			// into validPaths, so its stored chunks are not accounted for.
			filesFailed++
			enumerationComplete = false
			const msg = err instanceof Error ? err.message : String(err)
			log.warn(`session sync failed for ${absPath}: ${msg}`)
			params.progress?.({
				completed: filesProcessed,
				total: sessionPaths.length,
				label: `Conversation transcript sync failed (${path.basename(absPath)})`,
			})
		}
	}

	// W14: stale deletion needs the complete valid-path set for this agent.
	let staleDeleted = 0
	if (!enumerationComplete) {
		log.warn(
			"sync: skipping session stale cleanup — enumeration incomplete (W14 guard)",
		)
	} else {
		const staleSessionPaths = Array.from(params.storedFiles.keys()).filter(
			(storedPath) => !params.validPaths.has(storedPath),
		)
		if (staleSessionPaths.length > 0) {
			staleDeleted = await deleteStaleChunks(
				params.chunksCol,
				sessionNamespace,
				new Set(params.validPaths),
			)
			await params.filesCol.deleteMany({
				_id: {
					$in: staleSessionPaths.map((storedPath) =>
						buildStorageId(sessionNamespace, storedPath),
					),
				},
			} as Record<string, unknown>)
		}
	}

	log.info(
		`sync: sessions processed=${filesProcessed} chunks=${chunksUpserted} stale=${staleDeleted} failed=${filesFailed} enumerationComplete=${enumerationComplete}`,
	)
	return {
		filesProcessed,
		chunksUpserted,
		staleDeleted,
		useTransactions,
		filesFailed,
		enumerationComplete,
	}
}
