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
	CHUNK_SCHEME_VERSION,
	chunkMarkdown,
	hashText,
	isDuplicateKeyError,
	runUnorderedBulkWriteCounted,
} from "./internal.js"
import {
	recordEmbeddingSpend,
	recordEmbeddingSpendInSession,
} from "./mongodb-cost-ledger.js"
import type { EmbeddingStatus } from "./mongodb-embedding-retry.js"
import { invalidateQueryCache } from "./mongodb-query-cache.js"
import { kbCollection, kbChunksCollection } from "./mongodb-schema.js"
import { INDEX_AUTOEMBED_MODEL } from "./mongodb-schema-search-definitions.js"
import { resolveScopeRef } from "./mongodb-scope.js"
import {
	MAJORITY_TRANSACTION_OPTIONS,
	isTransactionUnsupported,
} from "./mongodb-transactions.js"
import {
	isErasureGateConflictError,
	withFencedWrite,
	type AdmissionToken,
} from "./mongodb-write-fence.js"

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
//
// Two read semantics coexist by design (C-035/S-6):
// - scopeRef-partitioned reads — listKBDocuments, getKBStats,
//   removeKBDocument, and searchKB filter on scopeRef only. `agentId` is
//   tagged but intentionally NOT filtered here: under scope "global" or
//   "tenant" the corpus is shared, so any agent resolving that scopeRef may
//   list, search, stat, or (for admins) remove documents in it. This is the
//   documented shared-global KB semantic.
// - identity-strict reads — the readFile kb locator returns FULL document
//   content, so it filters on all three tags {agentId, scope, scopeRef} of
//   the caller's resolved identity (mongodb-manager-read.ts, C-035). A
//   global-scope document is readable there only by the agent that ingested
//   it, via an explicit `?scope=global` on the path; cross-agent shared
//   corpus reads go through the scopeRef-partitioned search/list paths
//   above, which return snippets and metadata, not full content.
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
// Admission fence (plan e5ec10dc §2/§3 S2)
//
// Ordinary per-document failure types for the admission branch. They are NOT
// gate conflicts: a KBAdmissionError/KBForeignOwnerError/KBParentVanishedError
// fails that one document closed (error recorded, no mutation, no skip claim);
// only ErasureGateConflictError aborts the whole attempt (C2).
// ---------------------------------------------------------------------------

export class KBAdmissionError extends Error {
	constructor(message: string) {
		super(message)
		this.name = "KBAdmissionError"
	}
}

export class KBForeignOwnerError extends Error {
	constructor(message: string) {
		super(message)
		this.name = "KBForeignOwnerError"
	}
}

export class KBParentVanishedError extends Error {
	constructor(message: string) {
		super(message)
		this.name = "KBParentVanishedError"
	}
}

/**
 * §2.1 admission precondition, enforced at BOTH entries before any work.
 * Absent admission is a no-op. Present admission requires kind "admission",
 * the caller's own agentId, and the canonical agent scope derivation
 * (`agent:${agentId}` with no override) — it validates the supplied
 * identity; it does not capture or refresh an epoch.
 */
function assertKBAdmission(scope: KBScope, admission?: AdmissionToken): void {
	if (!admission) {
		return
	}
	const resolved = resolveKBScope(scope)
	if (
		admission.kind !== "admission" ||
		admission.agentId !== resolved.agentId ||
		resolved.scope !== "agent" ||
		resolved.scopeRef !== `agent:${resolved.agentId}`
	) {
		throw new KBAdmissionError(
			"admission requires its owner's canonical agent scope",
		)
	}
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
	/** Admission token (plan e5ec10dc §3 S2): present → the fenced, fail-closed
	 * write boundary; absent → every current path byte-preserved. */
	admission?: AdmissionToken
	progress?: (update: {
		completed: number
		total: number
		label: string
	}) => void
}): Promise<KBIngestResult> {
	// §2.1: the guard fires before collections, dedup or chunking.
	assertKBAdmission(params.scope, params.admission)
	const { db, prefix, documents, force, progress, admission } = params
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
			// §2.2 owner-checked dedup results: with admission, every hit
			// must carry this caller's identity (agentId/scope/scopeRef);
			// without admission the wrapper returns the hit unchanged
			// (byte-preserved semantics). A foreign unique-key collision is
			// NOT successful dedup.
			const requireOwned = (
				hit: Record<string, unknown> | null,
				via: string,
			): Record<string, unknown> | null => {
				if (
					admission &&
					hit &&
					(hit.agentId !== agentId ||
						hit.scope !== memoryScope ||
						hit.scopeRef !== scopeRef)
				) {
					throw new KBForeignOwnerError(
						`${doc.title}: ${via} matched a parent owned by ${String(hit.agentId)}`,
					)
				}
				return hit
			}
			let reIngestionOldId: string | null = null
			let reIngestionOldDocId: unknown = null
			let repairExistingDocId: string | null = null
			if (!force) {
				const sourcePath = doc.source.path ?? doc.title
				const existingByPath = requireOwned(
					await kb.findOne({
						"source.path": sourcePath,
						scopeRef,
					}),
					"path dedup",
				)
				if (existingByPath) {
					if (existingByPath.hash === doc.hash) {
						// W07: a same-hash skip is only valid when the stored
						// chunks were written by the current identity scheme.
						// Legacy pre-ordinal rows fall through to the repair
						// path (clean-replace chunks, re-flag the parent).
						const schemeCurrent =
							existingByPath.chunkScheme === CHUNK_SCHEME_VERSION
						if (existingByPath.chunksComplete === true && schemeCurrent) {
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
					const existingByHash = requireOwned(
						await kb.findOne({ hash: doc.hash, scopeRef }),
						"hash dedup",
					)
					if (existingByHash) {
						const schemeCurrent =
							existingByHash.chunkScheme === CHUNK_SCHEME_VERSION
						if (existingByHash.chunksComplete === true && schemeCurrent) {
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
				const existingDoc = requireOwned(
					await kb.findOne({ hash: doc.hash, scopeRef }),
					"force dedup",
				)
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
					// W07: emission ordinal — segments of one long source line
					// share {startLine, endLine}, so the ordinal is what keeps
					// their unique-key identities distinct.
					ordinal: chunk.ordinal,
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
							ordinal: chunk.ordinal,
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
				// W07: identity scheme of the chunks this parent owns; a same-hash
				// skip is only valid when this matches CHUNK_SCHEME_VERSION.
				chunkScheme: CHUNK_SCHEME_VERSION,
				updatedAt: new Date(),
			}

			// C2: run the chunk upserts and flip the parent complete only when
			// every chunk write lands. writeErrors (not the applied count) is
			// the completeness signal: re-upserting identical chunk content
			// matches without modifying, so a fully successful repair can
			// legitimately apply 0 writes. Returns the applied write count —
			// each applied write re-embeds its text server-side (C-017).
			const persistChunksAndComplete = async (
				parentId: string,
			): Promise<number> => {
				if (chunkOps.length === 0) {
					await kb.updateOne({ _id: parentId } as Record<string, unknown>, {
						$set: {
							chunksComplete: true,
							chunkScheme: CHUNK_SCHEME_VERSION,
							chunkCount: 0,
						},
					})
					return 0
				}
				// W07: clean-replace this parent's previously written chunks
				// before re-upserting. The repair path used to re-upsert without
				// deleting, so chunks left behind by an earlier partial write —
				// or written with the pre-ordinal identity — survived alongside
				// the new set. Deleting by docId first makes the parent's chunk
				// set exactly what this ingest computed.
				await kbChunks.deleteMany({ docId: parentId })
				const { applied, writeErrors } = await runUnorderedBulkWriteCounted(
					() => kbChunks.bulkWrite(chunkOps, { ordered: false }),
				)
				result.chunksCreated += applied
				if (writeErrors.length > 0) {
					result.errors.push(
						`${doc.title}: ${writeErrors.length} of ${chunkOps.length} chunk writes failed (${writeErrors[0]})`,
					)
					return applied
				}
				await kb.updateOne({ _id: parentId } as Record<string, unknown>, {
					$set: {
						chunksComplete: true,
						chunkScheme: CHUNK_SCHEME_VERSION,
						chunkCount: chunkOps.length,
					},
				})
				return applied
			}

			// Determine whether we need a transaction (re-ingestion involves delete + insert)
			const needsTransaction = reIngestionOldId !== null || forceOldId !== null
			const oldIdToDelete = reIngestionOldId ?? forceOldId
			const oldDocIdToDelete = reIngestionOldDocId ?? forceOldDocId

			if (!admission) {
				// C-017: chunks that actually landed this document (0 on skip,
				// dedup, or no-op repair re-upserts). Billed after the persist path
				// returns — past the transaction commit on the re-ingest path.
				let appliedChunks = 0
				if (repairExistingDocId) {
					// C2 repair: the parent already exists (incomplete) — do not
					// re-insert it (its hash owns the unique index); re-upsert the
					// chunks and flip complete when they all land.
					appliedChunks = await persistChunksAndComplete(repairExistingDocId)
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
					appliedChunks = chunksCreated
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
					appliedChunks = await persistChunksAndComplete(docId)
				}

				// C-017: every applied chunk write embeds its text server-side
				// (autoEmbed) in automated mode — one indexing unit per landed
				// chunk, billed after the persist path (and any transaction)
				// completed.
				if (params.embeddingMode === "automated" && appliedChunks > 0) {
					recordEmbeddingSpend(db, prefix, agentId, "indexing", appliedChunks)
				}
				result.documentsProcessed++
			} else {
				// §3 S2 admission branch: ONE fence per document; every
				// operation on the fence session (driver rule: an operation
				// without an explicit session is NOT in the transaction); raw
				// errors (§2.5); callback-local counts (the driver may
				// re-run the callback, and a failed attempt must not leave
				// counted work); the ledger AWAITED in the SAME document
				// transaction. reIngestAtomically is NOT called here — it manages its
				// own session/withTransaction and standalone fallback, which
				// would nest transactions (C4).
				const owned = { agentId, scope: memoryScope, scopeRef }
				const ownedChunkOps = chunkOps.map(({ updateOne }) => ({
					updateOne: {
						...updateOne,
						filter: { ...updateOne.filter, ...owned },
					},
				}))
				const appliedChunks = await withFencedWrite({
					db,
					prefix,
					token: admission,
					fn: async (session): Promise<number> => {
						// §2.3 in-fence identity+ownership revalidation —
						// the pre-fence lookup is only a plan.
						const revalidate = async (
							id: unknown,
							what: string,
						): Promise<void> => {
							const current = await kb.findOne(
								{ _id: id, ...owned } as Record<string, unknown>,
								{ session },
							)
							if (!current) {
								throw new KBParentVanishedError(
									`${doc.title}: ${what} parent ${String(id)} is missing or no longer owned`,
								)
							}
						}
						const requireOwnedChildren = async (
							parentId: string,
						): Promise<void> => {
							const foreign = await kbChunks.findOne(
								{
									docId: parentId,
									$or: [
										{ agentId: { $ne: agentId } },
										{ scope: { $ne: memoryScope } },
										{ scopeRef: { $ne: scopeRef } },
									],
								},
								{ session, projection: { _id: 1 } },
							)
							if (foreign) {
								throw new KBForeignOwnerError(
									`${doc.title}: foreign child under ${parentId}`,
								)
							}
						}
						if (repairExistingDocId) {
							await revalidate(repairExistingDocId, "repair")
						}
						if (oldIdToDelete !== null) {
							await revalidate(oldDocIdToDelete, "replacement")
							await requireOwnedChildren(oldIdToDelete)
						}
						await requireOwnedChildren(docId)
						if (oldIdToDelete !== null) {
							await kbChunks.deleteMany(
								{ docId: oldIdToDelete, ...owned },
								{ session },
							)
							const removed = await kb.deleteOne(
								{ _id: oldDocIdToDelete, ...owned } as Record<string, unknown>,
								{ session },
							)
							if (removed.deletedCount !== 1) {
								throw new KBParentVanishedError(
									`${doc.title}: replacement parent disappeared`,
								)
							}
						}
						if (!repairExistingDocId) {
							// §2.5: a raw duplicate error aborts — a foreign
							// parent may hold uq_kb_scope_hash; this is NOT a
							// skip on this branch.
							await kb.insertOne(newKBDoc, { session })
						}
						// W07 clean-replace + RAW bulkWrite — no
						// runUnorderedBulkWriteCounted swallow inside the fn
						// (internal.ts catches MongoBulkWriteError; the driver
						// forbids silent handlers in withTransaction
						// callbacks). Clean owned chunks even for zero new
						// chunks, so fenced repair completion always describes
						// the exact chunk set.
						await kbChunks.deleteMany({ docId, ...owned }, { session })
						let applied = 0
						if (ownedChunkOps.length > 0) {
							const writeResult = await kbChunks.bulkWrite(ownedChunkOps, {
								ordered: false,
								session,
							})
							applied = writeResult.upsertedCount + writeResult.modifiedCount
						}
						const completed = await kb.updateOne(
							{ _id: docId, ...owned } as Record<string, unknown>,
							{
								$set: {
									chunksComplete: true,
									chunkScheme: CHUNK_SCHEME_VERSION,
									chunkCount: chunkOps.length,
								},
							},
							{ session },
						)
						if (completed.matchedCount !== 1) {
							throw new KBParentVanishedError(
								`${doc.title}: completion parent disappeared`,
							)
						}
						// Ledger AWAITED in the SAME document transaction
						// (no-op for applied <= 0, cost-ledger).
						if (params.embeddingMode === "automated") {
							await recordEmbeddingSpendInSession({
								db,
								prefix,
								agentId,
								kind: "indexing",
								units: applied,
								session,
							})
						}
						return applied
					},
				})
				// Acknowledged success — only now does the attempt claim work.
				result.chunksCreated += appliedChunks
				result.documentsProcessed++
			}
		} catch (err) {
			if (admission && isErasureGateConflictError(err)) {
				// C2 settled: an original-token gate conflict aborts the whole
				// attempt — no further documents, no cache fence, no
				// successful marker.
				throw err
			}
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
		if (admission) {
			// C3 settled: ONE separate post-primary cache fence under the
			// SAME original token; throwOnError inside the transaction (no
			// swallowed operation errors, driver rule); after the fence
			// settles, gate conflicts propagate (abort per C2) and any other
			// error is a best-effort warn — the documents are already
			// committed and cache invalidation stays best-effort.
			try {
				await withFencedWrite({
					db,
					prefix,
					token: admission,
					fn: async (session) => {
						await invalidateQueryCache({
							db,
							prefix,
							agentId,
							scope: memoryScope,
							scopeRef,
							session,
							throwOnError: true,
						})
					},
				})
			} catch (err) {
				if (isErasureGateConflictError(err)) {
					throw err
				}
				log.warn(`KB cache invalidation fence failed: ${String(err)}`)
			}
		} else {
			await invalidateQueryCache({
				db,
				prefix,
				agentId,
				scope: memoryScope,
				scopeRef,
			})
		}
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
					// C2 + W07: a commit implies every chunk persisted — flip the
					// parent complete (stamped with the chunk identity scheme)
					// inside the same transaction.
					await kb.updateOne(
						{ _id: newKBDoc._id } as Record<string, unknown>,
						{
							$set: {
								chunksComplete: true,
								chunkScheme: CHUNK_SCHEME_VERSION,
								chunkCount: chunkOps.length,
							},
						},
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
	// W07: stamp the completing write with the chunk identity scheme.
	await kb.updateOne({ _id: newKBDoc._id } as Record<string, unknown>, {
		$set: {
			chunksComplete: true,
			chunkScheme: CHUNK_SCHEME_VERSION,
			chunkCount: chunkOps.length,
		},
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
	/** Admission token (plan e5ec10dc §3 S2): forwarded verbatim to
	 * ingestToKB by the {...params} spread below; present — the fenced,
	 * fail-closed write boundary, absent — byte-preserved paths. */
	admission?: AdmissionToken
}): Promise<KBIngestResult> {
	// §2.1: the guard fires before any filesystem work at this entry.
	assertKBAdmission(params.scope, params.admission)
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
