import crypto from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import type { Db, MongoClient, ClientSession } from "mongodb"
import {
	type MemoryMongoDBEmbeddingMode,
	type MemoryScope,
	createSubsystemLogger,
} from "@memongo/lib"
import {
	chunkMarkdown,
	hashText,
	isDuplicateKeyError,
	runUnorderedBulkWriteCounted,
} from "./internal.js"
import type { EmbeddingStatus } from "./mongodb-embedding-retry.js"
import { invalidateQueryCache } from "./mongodb-query-cache.js"
import { kbCollection, kbChunksCollection } from "./mongodb-schema.js"
import { INDEX_AUTOEMBED_MODEL } from "./mongodb-schema-search-definitions.js"
import { resolveScopeRef } from "./mongodb-scope.js"
import {
	MAJORITY_TRANSACTION_OPTIONS,
	isTransactionUnsupported,
} from "./mongodb-transactions.js"

const log = createSubsystemLogger("memory:mongodb:kb")

// ---------------------------------------------------------------------------
// Tenant scoping (issue #27)
//
// KB documents and chunks are tagged with the resolved {agentId, scope,
// scopeRef} of the caller. `scopeRef` is the concrete isolation namespace
// (e.g. "agent:foo", "global") and is the key every read/write/delete path
// filters on, so tenants sharing one physical collection cannot observe or
// mutate each other's KB. Callers wanting a shared corpus use scope "global"
// or "tenant".
// ---------------------------------------------------------------------------

export type KBScope = {
	agentId: string
	scope?: MemoryScope
	scopeRef?: string
	// Companion ids required by non-agent scopes. Forwarded to resolveScopeRef so
	// user/tenant/session resolve correctly (and throw when missing) and workspace
	// does not silently fall back to workspace:${agentId}.
	userId?: string
	tenantId?: string
	sessionId?: string
	workspaceDir?: string
}

type ResolvedKBScope = { agentId: string; scope: MemoryScope; scopeRef: string }

function resolveKBScope(scope: KBScope): ResolvedKBScope {
	const resolvedScope = scope.scope ?? "agent"
	const scopeRef = resolveScopeRef({
		agentId: scope.agentId,
		scope: resolvedScope,
		scopeRef: scope.scopeRef,
		userId: scope.userId,
		tenantId: scope.tenantId,
		sessionId: scope.sessionId,
		workspaceDir: scope.workspaceDir,
	})
	return { agentId: scope.agentId, scope: resolvedScope, scopeRef }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type KBDocument = {
	title: string
	content: string
	source: {
		type: "file" | "url" | "manual" | "api"
		path?: string
		url?: string
		mimeType?: string
		originalName?: string
		importedBy: "wizard" | "cli" | "api" | "agent"
	}
	tags?: string[]
	category?: string
	hash: string
}

export type KBIngestResult = {
	documentsProcessed: number
	chunksCreated: number
	skipped: number
	errors: string[]
}

// ---------------------------------------------------------------------------
// Ingestion
// ---------------------------------------------------------------------------

export async function ingestToKB(params: {
	db: Db
	prefix: string
	scope: KBScope
	documents: KBDocument[]
	embeddingMode: MemoryMongoDBEmbeddingMode
	chunking?: { tokens: number; overlap: number }
	model?: string
	force?: boolean
	maxDocumentSize?: number
	client?: MongoClient
	progress?: (update: {
		completed: number
		total: number
		label: string
	}) => void
}): Promise<KBIngestResult> {
	const { db, prefix, documents, force, progress } = params
	const { agentId, scope: memoryScope, scopeRef } = resolveKBScope(params.scope)
	// Clamp under the 16 MiB BSON document limit with headroom for the KB
	// document's own metadata — a caller override above the ceiling would only
	// trade this guard's clear error for a raw driver failure at insertOne.
	const MAX_DOC_SIZE_CEILING = 15 * 1024 * 1024
	const maxDocSize = Math.min(
		params.maxDocumentSize ?? 10 * 1024 * 1024, // default 10MB
		MAX_DOC_SIZE_CEILING,
	)
	const chunking = params.chunking ?? { tokens: 600, overlap: 100 }
	const model = params.model ?? INDEX_AUTOEMBED_MODEL
	const kb = kbCollection(db, prefix)
	const kbChunks = kbChunksCollection(db, prefix)

	const result: KBIngestResult = {
		documentsProcessed: 0,
		chunksCreated: 0,
		skipped: 0,
		errors: [],
	}

	for (let i = 0; i < documents.length; i++) {
		const doc = documents[i]
		progress?.({ completed: i, total: documents.length, label: doc.title })

		try {
			// Size enforcement — reject documents that exceed maxDocumentSize.
			// Measured in UTF-8 bytes (what BSON stores), not UTF-16 code units:
			// .length undercounts non-ASCII content by up to 3×.
			const contentBytes = Buffer.byteLength(doc.content, "utf8")
			if (contentBytes > maxDocSize) {
				result.errors.push(
					`${doc.title}: document too large (${contentBytes} bytes > ${maxDocSize} limit)`,
				)
				result.skipped++
				continue
			}

			// F10: Dedup check by source.path first, then content hash.
			// If a document with the same path exists, replace it only if hash changed.
			// These dedup lookups are OUTSIDE the transaction body (read-only I/O).
			//
			// C2: a same-content parent only skips when it is COMPLETE
			// (chunksComplete === true). A parent whose chunk writes partially
			// failed — or a legacy parent written before the marker existed —
			// must be REPAIRED (chunks re-upserted, then flipped complete), not
			// skipped: skipping froze the KB with permanently missing chunks.
			let reIngestionOldId: string | null = null
			let reIngestionOldDocId: unknown = null
			let repairExistingDocId: string | null = null
			if (!force) {
				const sourcePath = doc.source.path ?? doc.title
				const existingByPath = await kb.findOne({
					"source.path": sourcePath,
					scopeRef,
				})
				if (existingByPath) {
					if (existingByPath.hash === doc.hash) {
						if (existingByPath.chunksComplete === true) {
							// Same content, fully persisted — skip
							result.skipped++
							continue
						}
						repairExistingDocId = String(existingByPath._id)
					} else {
						// Hash changed — mark for re-ingestion (delete old + insert new)
						reIngestionOldId = String(existingByPath._id)
						reIngestionOldDocId = existingByPath._id
					}
				} else {
					// No path match — check hash as fallback
					const existingByHash = await kb.findOne({ hash: doc.hash, scopeRef })
					if (existingByHash) {
						if (existingByHash.chunksComplete === true) {
							result.skipped++
							continue
						}
						repairExistingDocId = String(existingByHash._id)
					}
				}
			}

			// Chunk the document content — OUTSIDE transaction body (CPU-bound)
			const chunks = chunkMarkdown(doc.content, chunking)

			// Memongo uses MongoDB community automatic embeddings. KB chunks stay
			// embedding-free on write and rely on autoEmbed indexes at query time.
			const embeddingStatus: EmbeddingStatus = "pending"

			// Generate a document ID — or reuse the incomplete parent's id on a
			// C2 repair so the re-upserted chunks attach to the parent that
			// already owns the hash.
			const docId = repairExistingDocId ?? crypto.randomUUID()

			// Prepare force-mode dedup lookup OUTSIDE transaction
			let forceOldId: string | null = null
			let forceOldDocId: unknown = null
			if (force) {
				const existingDoc = await kb.findOne({ hash: doc.hash, scopeRef })
				if (existingDoc) {
					forceOldId = String(existingDoc._id)
					forceOldDocId = existingDoc._id
				}
			}

			// Build the chunk operation list (data prep, not DB I/O)
			const chunkOps = chunks.map((chunk) => {
				const chunkDoc: Record<string, unknown> = {
					docId,
					agentId,
					scope: memoryScope,
					scopeRef,
					path: doc.source.path ?? doc.title,
					source: "kb",
					startLine: chunk.startLine,
					endLine: chunk.endLine,
					hash: chunk.hash,
					model,
					text: chunk.text,
					embeddingStatus,
					updatedAt: new Date(),
				}
				return {
					updateOne: {
						filter: {
							scopeRef,
							path: doc.source.path ?? doc.title,
							startLine: chunk.startLine,
							endLine: chunk.endLine,
						},
						update: { $set: chunkDoc },
						upsert: true,
					},
				}
			})

			// The new KB document to insert. C2: parents are born INCOMPLETE and
			// are flipped to chunksComplete only after every chunk write lands
			// (transactional path flips inside the transaction, so a commit
			// always implies complete). If the process dies mid-write, the
			// leftover parent reads as incomplete and the next ingest repairs it
			// instead of skipping it.
			const newKBDoc: Record<string, unknown> = {
				_id: docId,
				agentId,
				scope: memoryScope,
				scopeRef,
				title: doc.title,
				content: doc.content,
				source: {
					...doc.source,
					importedAt: new Date(),
				},
				tags: doc.tags ?? [],
				// Omit category when absent — the KB validator types it as a
				// string, so writing an explicit null fails validation.
				...(doc.category ? { category: doc.category } : {}),
				hash: doc.hash,
				chunkCount: chunks.length,
				chunksComplete: false,
				updatedAt: new Date(),
			}

			// C2: run the chunk upserts and flip the parent complete only when
			// every chunk write lands. writeErrors (not the applied count) is
			// the completeness signal: re-upserting identical chunk content
			// matches without modifying, so a fully successful repair can
			// legitimately apply 0 writes.
			const persistChunksAndComplete = async (parentId: string) => {
				if (chunkOps.length === 0) {
					await kb.updateOne({ _id: parentId } as Record<string, unknown>, {
						$set: { chunksComplete: true },
					})
					return
				}
				const { applied, writeErrors } = await runUnorderedBulkWriteCounted(
					() => kbChunks.bulkWrite(chunkOps, { ordered: false }),
				)
				result.chunksCreated += applied
				if (writeErrors.length > 0) {
					result.errors.push(
						`${doc.title}: ${writeErrors.length} of ${chunkOps.length} chunk writes failed (${writeErrors[0]})`,
					)
					return
				}
				await kb.updateOne({ _id: parentId } as Record<string, unknown>, {
					$set: { chunksComplete: true },
				})
			}

			// Determine whether we need a transaction (re-ingestion involves delete + insert)
			const needsTransaction = reIngestionOldId !== null || forceOldId !== null
			const oldIdToDelete = reIngestionOldId ?? forceOldId
			const oldDocIdToDelete = reIngestionOldDocId ?? forceOldDocId

			if (repairExistingDocId) {
				// C2 repair: the parent already exists (incomplete) — do not
				// re-insert it (its hash owns the unique index); re-upsert the
				// chunks and flip complete when they all land.
				await persistChunksAndComplete(repairExistingDocId)
			} else if (needsTransaction && oldIdToDelete && oldDocIdToDelete) {
				// Re-ingestion path: wrap delete-old + insert-new in withTransaction()
				// for atomicity. Falls back to sequential on standalone topology.
				const chunksCreated = await reIngestAtomically({
					client: params.client,
					kb,
					kbChunks,
					oldDocId: oldIdToDelete,
					oldDocPk: oldDocIdToDelete,
					newKBDoc,
					chunkOps,
				})
				result.chunksCreated += chunksCreated
			} else {
				// Fresh ingestion: no delete needed, no transaction required.
				// P1-2: a concurrent ingest of the same content can win the
				// uq_kb_scope_hash race between our dedup check and this insert
				// — that is a successful dedup, not an error.
				try {
					await kb.insertOne(newKBDoc)
				} catch (err) {
					if (isDuplicateKeyError(err)) {
						result.skipped++
						continue
					}
					throw err
				}
				await persistChunksAndComplete(docId)
			}

			result.documentsProcessed++
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err)
			result.errors.push(`${doc.title}: ${msg}`)
			log.warn(`KB ingest failed for ${doc.title}: ${msg}`)
		}
	}

	progress?.({
		completed: documents.length,
		total: documents.length,
		label: "Done",
	})
	log.info(
		`KB ingest: processed=${result.documentsProcessed} chunks=${result.chunksCreated} skipped=${result.skipped} errors=${result.errors.length}`,
	)
	if (result.documentsProcessed > 0) {
		await invalidateQueryCache({
			db,
			prefix,
			agentId,
			scope: memoryScope,
			scopeRef,
		})
	}
	return result
}

// ---------------------------------------------------------------------------
// Atomic re-ingestion helper (withTransaction + standalone fallback)
// ---------------------------------------------------------------------------

/**
 * Atomically re-ingest a KB document: delete old chunks + doc, insert new doc + chunks.
 * Uses withTransaction() when client is provided. Falls back to sequential writes
 * on standalone topology (same pattern as mongodb-sync.ts).
 *
 * Metadata writes and the chunk bulkWrite share ONE transaction. They must not
 * be split across nested transactions: a session can have at most one open
 * transaction, so opening a second one inside the callback throws
 * MongoTransactionError('Transaction already in progress') on every re-ingest.
 *
 * Returns the number of chunks created.
 */
async function reIngestAtomically(params: {
	client?: MongoClient
	kb: import("mongodb").Collection
	kbChunks: import("mongodb").Collection
	oldDocId: string
	oldDocPk: unknown
	newKBDoc: Record<string, unknown>
	chunkOps: Array<{
		updateOne: {
			filter: Record<string, unknown>
			update: Record<string, unknown>
			upsert: boolean
		}
	}>
}): Promise<number> {
	const { client, kb, kbChunks, oldDocId, oldDocPk, newKBDoc, chunkOps } =
		params

	// Metadata writes (delete old chunks, delete old doc, insert new doc). Kept
	// small so they never hit TransactionTooLargeForCache.
	async function performMetadataWrites(session?: ClientSession): Promise<void> {
		if (session) {
			await kbChunks.deleteMany({ docId: oldDocId }, { session })
			await kb.deleteOne({ _id: oldDocPk } as Record<string, unknown>, {
				session,
			})
			await kb.insertOne(newKBDoc, { session })
		} else {
			await kbChunks.deleteMany({ docId: oldDocId })
			await kb.deleteOne({ _id: oldDocPk } as Record<string, unknown>)
			await kb.insertOne(newKBDoc)
		}
	}

	// Run a chunk batch, returning the number of chunks upserted/modified.
	async function runChunkBatch(
		batch: typeof chunkOps,
		session?: ClientSession,
	): Promise<number> {
		if (batch.length === 0) return 0
		const writeResult = session
			? await kbChunks.bulkWrite(batch, { ordered: false, session })
			: await kbChunks.bulkWrite(batch, { ordered: false })
		return writeResult.upsertedCount + writeResult.modifiedCount
	}

	// Try transactional path if client is available
	if (client) {
		try {
			const session = client.startSession()
			try {
				let chunksCreated = 0
				await session.withTransaction(async () => {
					// withTransaction may re-run this callback on a transient error,
					// so the count is reset per attempt rather than accumulated.
					chunksCreated = 0
					await performMetadataWrites(session)
					chunksCreated = await runChunkBatch(chunkOps, session)
					// C2: a commit implies every chunk persisted — flip the parent
					// complete inside the same transaction.
					await kb.updateOne(
						{ _id: newKBDoc._id } as Record<string, unknown>,
						{ $set: { chunksComplete: true } },
						{ session },
					)
				}, MAJORITY_TRANSACTION_OPTIONS)
				return chunksCreated
			} finally {
				await session.endSession()
			}
		} catch (err) {
			// Standalone or no replica set — fall through to sequential
			if (isTransactionUnsupported(err)) {
				log.info(
					"transactions not supported for KB re-ingestion, falling back to direct writes",
				)
			} else {
				throw err
			}
		}
	}

	// Sequential fallback (no transaction)
	await performMetadataWrites()
	const chunksCreated = await runChunkBatch(chunkOps)
	// C2: reaching here means every chunk write landed (runChunkBatch throws
	// on partial failure, leaving the parent incomplete for a repair retry).
	await kb.updateOne({ _id: newKBDoc._id } as Record<string, unknown>, {
		$set: { chunksComplete: true },
	})
	return chunksCreated
}

// ---------------------------------------------------------------------------
// File ingestion
// ---------------------------------------------------------------------------

const SUPPORTED_EXTENSIONS = new Set([".md", ".txt"])

async function walkDirForKB(
	dir: string,
	files: string[],
	recursive: boolean,
): Promise<void> {
	const entries = await fs.readdir(dir, { withFileTypes: true })
	for (const entry of entries) {
		const full = path.join(dir, entry.name)
		if (entry.isSymbolicLink()) {
			continue
		}
		if (entry.isDirectory() && recursive) {
			await walkDirForKB(full, files, recursive)
			continue
		}
		if (!entry.isFile()) {
			continue
		}
		const ext = path.extname(entry.name).toLowerCase()
		if (SUPPORTED_EXTENSIONS.has(ext)) {
			files.push(full)
		}
	}
}

export async function ingestFilesToKB(params: {
	db: Db
	prefix: string
	scope: KBScope
	paths: string[]
	recursive?: boolean
	tags?: string[]
	category?: string
	importedBy: "wizard" | "cli" | "api" | "agent"
	embeddingMode: MemoryMongoDBEmbeddingMode
	chunking?: { tokens: number; overlap: number }
	model?: string
	force?: boolean
	progress?: (update: {
		completed: number
		total: number
		label: string
	}) => void
}): Promise<KBIngestResult> {
	const { paths, recursive = true, tags, category, importedBy } = params

	// Collect all files
	const filePaths: string[] = []
	for (const inputPath of paths) {
		try {
			const stat = await fs.lstat(inputPath)
			if (stat.isSymbolicLink()) {
				continue
			}
			if (stat.isDirectory()) {
				await walkDirForKB(inputPath, filePaths, recursive)
			} else if (stat.isFile()) {
				const ext = path.extname(inputPath).toLowerCase()
				if (SUPPORTED_EXTENSIONS.has(ext)) {
					filePaths.push(inputPath)
				}
			}
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err)
			log.warn(`KB file scan failed for ${inputPath}: ${msg}`)
		}
	}

	// Build KBDocument objects from files
	const documents: KBDocument[] = []
	for (const filePath of filePaths) {
		try {
			const content = await fs.readFile(filePath, "utf-8")
			const ext = path.extname(filePath).toLowerCase()
			const mimeType = ext === ".md" ? "text/markdown" : "text/plain"
			documents.push({
				title: path.basename(filePath),
				content,
				source: {
					type: "file",
					path: filePath,
					mimeType,
					originalName: path.basename(filePath),
					importedBy,
				},
				tags,
				category,
				hash: hashText(content),
			})
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err)
			log.warn(`KB file read failed for ${filePath}: ${msg}`)
		}
	}

	return ingestToKB({
		...params,
		documents,
	})
}

// ---------------------------------------------------------------------------
// Management functions
// ---------------------------------------------------------------------------

export async function listKBDocuments(
	db: Db,
	prefix: string,
	opts: {
		scope: KBScope
		category?: string
		tags?: string[]
		source?: string
	},
): Promise<
	Array<{
		_id: string
		title: string
		source: Record<string, unknown>
		tags: string[]
		category?: string
		chunkCount: number
		updatedAt: Date
	}>
> {
	const kb = kbCollection(db, prefix)
	const { scopeRef } = resolveKBScope(opts.scope)
	const query: Record<string, unknown> = { scopeRef }
	if (opts.category) {
		query.category = opts.category
	}
	if (opts.tags?.length) {
		query.tags = { $all: opts.tags }
	}
	if (opts.source) {
		query["source.type"] = opts.source
	}

	const docs = await kb.find(query, { sort: { updatedAt: -1 } }).toArray()
	return docs.map((doc: Record<string, unknown>) => ({
		_id: String(doc._id),
		title: doc.title as string,
		source: doc.source as Record<string, unknown>,
		tags: (doc.tags as string[]) ?? [],
		category: doc.category as string | undefined,
		chunkCount: (doc.chunkCount as number) ?? 0,
		updatedAt: doc.updatedAt as Date,
	}))
}

/**
 * F11: Remove a KB document and its chunks, wrapped in a transaction when possible.
 * Uses withTransaction for automatic retry of TransientTransactionError.
 * Falls back to sequential writes on standalone topologies (no replica set).
 */
export async function removeKBDocument(
	db: Db,
	prefix: string,
	docId: string,
	scope: KBScope,
	client?: MongoClient,
): Promise<boolean> {
	const kb = kbCollection(db, prefix)
	const kbChunks = kbChunksCollection(db, prefix)
	const { agentId, scope: memoryScope, scopeRef } = resolveKBScope(scope)
	// scopeRef in every filter: a tenant can only delete its own KB documents.
	const docFilter = { _id: docId, scopeRef } as Record<string, unknown>
	const chunkFilter = { docId, scopeRef }

	// Try transaction-wrapped removal (requires replica set)
	if (client) {
		try {
			const session = client.startSession()
			let deleted = false
			try {
				await session.withTransaction(async () => {
					// Delete the owned document first; if nothing matched the
					// tenant filter, leave chunks untouched (cross-tenant guard).
					const result = await kb.deleteOne(docFilter, { session })
					deleted = result.deletedCount > 0
					if (deleted) {
						await kbChunks.deleteMany(chunkFilter, { session })
					}
				}, MAJORITY_TRANSACTION_OPTIONS)
				if (deleted) {
					await invalidateQueryCache({
						db,
						prefix,
						agentId,
						scope: memoryScope,
						scopeRef,
					})
				}
				return deleted
			} finally {
				await session.endSession()
			}
		} catch (err) {
			if (!isTransactionUnsupported(err)) {
				throw err
			}
			log.info(
				"transactions not supported for removeKBDocument, falling back to direct writes",
			)
		}
	}

	// Standalone fallback: sequential writes without transaction
	const result = await kb.deleteOne(docFilter)
	if (result.deletedCount > 0) {
		await kbChunks.deleteMany(chunkFilter)
		await invalidateQueryCache({
			db,
			prefix,
			agentId,
			scope: memoryScope,
			scopeRef,
		})
		return true
	}
	return false
}

export async function getKBStats(
	db: Db,
	prefix: string,
	opts: { scope: KBScope },
): Promise<{
	documents: number
	chunks: number
	categories: string[]
	sources: Record<string, number>
}> {
	const kb = kbCollection(db, prefix)
	const kbChunks = kbChunksCollection(db, prefix)
	const { scopeRef } = resolveKBScope(opts.scope)

	const documents = await kb.countDocuments({ scopeRef })
	const chunks = await kbChunks.countDocuments({ scopeRef })

	// Get distinct categories
	const categories = (await kb.distinct("category", { scopeRef })).filter(
		(c): c is string => typeof c === "string",
	)

	// Get source type counts
	const sourcePipeline = [
		{ $match: { scopeRef } },
		{ $group: { _id: "$source.type", count: { $sum: 1 } } },
	]
	const sourceResults = await kb.aggregate(sourcePipeline).toArray()
	const sources: Record<string, number> = {}
	for (const s of sourceResults) {
		sources[String(s._id)] = s.count as number
	}

	return { documents, chunks, categories, sources }
}
