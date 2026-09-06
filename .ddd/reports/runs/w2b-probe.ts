/**
 * Wave 2b live probe — W07 chunk ordinal identity, W14 enumeration guards,
 * W15 invalidation-first ordering, against the live memongo-preview MongoDB
 * (replica set), using PRODUCTION syncToMongoDB / ingestToKB /
 * ensureStandardIndexes / hashText on a disposable scratch database.
 *
 * W07 (identity): a memory file whose single source line spans many chunk
 * segments keeps every segment — distinct emission ordinals (the global
 * 0-based chunk-list index, per the fix design §W07.1), distinct chunk ids,
 * each segment individually queryable by {path, startLine, endLine,
 * ordinal}; the KB path lands the same segment set behind the REAL widened
 * unique index uq_kbchunks_scope_path_lines_v2 (with the old 4-field index
 * pre-created, the migration drops it and recreates the 5-field key).
 * Legacy rows (chunkScheme 1 / absent, or a pre-ordinal damaged chunk set)
 * are re-chunked once on a same-hash sync instead of skipped.
 * W15 (crash window): a stored row left at the "__invalidated__" sentinel
 * with its chunks deleted (the post-crash state of the non-transactional
 * replacement) heals on the next non-forced sync — chunks restored, real
 * hash rewritten. The sentinel can never equal a real sha256 hex digest.
 * W14 (enumeration): an unreadable memory dir (EACCES on readdir) or an
 * unreadable memory file (EACCES on read) marks the sync
 * enumeration-incomplete and skips stale cleanup — stored chunks that a
 * pre-W14 sync would have mass-deleted survive. Stale cleanup itself is
 * proven live first (a removed file's chunks ARE deleted when enumeration
 * completes).
 *
 * The transactional sync path (client passed, forced re-sync) is exercised
 * end-to-end; TransactionTooLargeForCache fallback and bulkWrite partial
 * failures are failure-injection territory covered by the unit suites
 * (mongodb-sync / mongodb-manager-sync), not live-probeable on a healthy
 * server.
 *
 * Exit 0 = all assertions pass; any failure prints and exits 1.
 */

import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync, chmodSync, unlinkSync, writeFileSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { MongoClient } from "mongodb"
import { ensureStandardIndexes } from "../../../packages/memory-engine/src/mongodb-schema.ts"
import {
	chunksCollection,
	filesCollection,
	kbChunksCollection,
	kbCollection,
} from "../../../packages/memory-engine/src/mongodb-schema-collections.ts"
import { syncToMongoDB } from "../../../packages/memory-engine/src/mongodb-sync.ts"
import { ingestToKB } from "../../../packages/memory-engine/src/mongodb-kb.ts"
import { hashText } from "../../../packages/memory-engine/src/internal.ts"

const database = `ddd_w2b_${randomUUID().replaceAll("-", "")}`
const PREFIX = "probe_"
const URI = "mongodb://127.0.0.1:27019/?directConnection=true"
const client = new MongoClient(URI, { serverSelectionTimeoutMS: 5000 })

const INVALIDATED = "__invalidated__"
// One source line of 12,000 chars — far past the 400-token chunk budget, so
// it must be emitted as several segments sharing {startLine, endLine}.
const LONG_LINE = "w2btoken".repeat(1500)
const LONG_DOC = [
	"# W2b long-line probe",
	"",
	"Intro paragraph line.",
	"",
	LONG_LINE,
	"",
	"Outro paragraph line.",
].join("\n")
const LONG_LINE_NO = 5 // 1-based line number of LONG_LINE in LONG_DOC

const KB_AGENT = "w2b-agent"
const KB_SCOPE_REF = `agent:${KB_AGENT}`
const KB_PATH = "w2b/kb-long.md"
const KB_CONTENT = ["# W2b KB long-line doc", "", LONG_LINE, "", "Tail line."].join("\n")
const KB_HASH = hashText(KB_CONTENT)
const KB_LONG_LINE_NO = 3 // 1-based line number of LONG_LINE in KB_CONTENT

let failures = 0
let total = 0
function check(label: string, actual: unknown, expected: unknown) {
	total++
	const ok = JSON.stringify(actual) === JSON.stringify(expected)
	if (!ok) {
		failures++
		console.error(
			`FAIL ${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
		)
	} else {
		console.log(`ok   ${label} === ${JSON.stringify(expected)}`)
	}
}

const ws1 = mkdtempSync(join(tmpdir(), "w2b-ws1-"))
const ws2 = mkdtempSync(join(tmpdir(), "w2b-ws2-"))

try {
	await client.connect()
	const db = client.db(database)
	const chunks = chunksCollection(db, PREFIX)
	const files = filesCollection(db, PREFIX)
	const kbChunks = kbChunksCollection(db, PREFIX)
	const kb = kbCollection(db, PREFIX)

	// ------------------------------------------------------------------
	// W07 — real index migration: the old 4-field unique indexes are
	// dropped and replaced by the ordinal-widened tenant key
	// ------------------------------------------------------------------
	await kbChunks.createIndex(
		{ scopeRef: 1, path: 1, startLine: 1, endLine: 1 },
		{ name: "uq_kbchunks_scope_path_lines", unique: true },
	)
	await kbChunks.createIndex(
		{ path: 1, startLine: 1, endLine: 1 },
		{ name: "uq_kbchunks_path_lines", unique: true },
	)
	await ensureStandardIndexes(db, PREFIX)
	console.log(`probe database ${database}; production indexes ensured`)
	const indexes = await kbChunks.listIndexes().toArray()
	const v2 = indexes.find((i) => i.name === "uq_kbchunks_scope_path_lines_v2")
	check("v2 unique index created", v2 !== undefined, true)
	check(
		"v2 key widened with ordinal",
		v2?.key,
		{ scopeRef: 1, path: 1, startLine: 1, endLine: 1, ordinal: 1 },
	)
	check("v2 index is unique", v2?.unique, true)
	check(
		"old 4-field tenant index dropped",
		indexes.some((i) => i.name === "uq_kbchunks_scope_path_lines"),
		false,
	)
	check(
		"ancient global path+lines index dropped",
		indexes.some((i) => i.name === "uq_kbchunks_path_lines"),
		false,
	)

	// ------------------------------------------------------------------
	// W07 — long-line memory file sync: every segment of the long line
	// keeps a distinct ordinal identity (non-transactional path first)
	// ------------------------------------------------------------------
	mkdirSync(join(ws1, "memory"), { recursive: true })
	writeFileSync(join(ws1, "memory", "long.md"), LONG_DOC, "utf-8")

	const segDocs = (lineNo: number) =>
		chunks
			.find(
				{ path: "memory/long.md", startLine: lineNo, endLine: lineNo },
				{ projection: { _id: 0, ordinal: 1 } },
			)
			.sort({ ordinal: 1 })
			.toArray()
	const filesRow = () =>
		files.findOne(
			{ path: "memory/long.md" },
			{ projection: { _id: 1, hash: 1, chunkScheme: 1 } },
		)

	const r1 = await syncToMongoDB({
		db,
		prefix: PREFIX,
		workspaceDir: ws1,
		embeddingMode: "automated",
	})
	check("first sync processes the file", r1.filesProcessed, 1)
	check("first sync enumerates completely", r1.enumerationComplete, true)
	const segs1 = await segDocs(LONG_LINE_NO)
	console.log(`long line emitted ${segs1.length} segments`)
	check("long line split into multiple segments", segs1.length >= 2, true)
	const longOrdinals = segs1.map((d) => d.ordinal)
	check(
		"long-line ordinals distinct, contiguous, strictly increasing",
		longOrdinals.every((o, i) => i === 0 || o === longOrdinals[i - 1]! + 1),
		true,
	)
	const allOrdinals = await chunks
		.find({ path: "memory/long.md" }, { projection: { _id: 0, ordinal: 1 } })
		.sort({ ordinal: 1 })
		.toArray()
	check(
		"file chunk ordinals are the global emission sequence 0..N-1 (design §W07.1)",
		allOrdinals.map((d) => d.ordinal),
		allOrdinals.map((_, i) => i),
	)
	const allIds = await chunks
		.find({ path: "memory/long.md" }, { projection: { _id: 1 } })
		.toArray()
	check(
		"chunk ids all distinct (no last-write-wins collisions)",
		new Set(allIds.map((d) => String(d._id))).size,
		allIds.length,
	)
	let individuallyFound = 0
	for (const o of longOrdinals) {
		const one = await chunks.findOne({
			path: "memory/long.md",
			startLine: LONG_LINE_NO,
			endLine: LONG_LINE_NO,
			ordinal: o,
		})
		if (one) individuallyFound++
	}
	check(
		"every long-line segment queryable by {path,startLine,endLine,ordinal}",
		individuallyFound,
		segs1.length,
	)
	const row1 = await filesRow()
	check("files row records chunkScheme 2", row1?.chunkScheme, 2)
	check("files row hash matches content hash", row1?.hash, hashText(LONG_DOC))
	const fullCount = allIds.length
	const fullOrdinals = [...longOrdinals]

	const r2 = await syncToMongoDB({
		db,
		prefix: PREFIX,
		workspaceDir: ws1,
		embeddingMode: "automated",
	})
	check("same-hash current-scheme sync skips the file", r2.filesProcessed, 0)
	check("steady-state sync deletes nothing stale", r2.staleDeleted, 0)

	const r3 = await syncToMongoDB({
		client,
		db,
		prefix: PREFIX,
		workspaceDir: ws1,
		embeddingMode: "automated",
		force: true,
	})
	check("forced transactional resync processes the file", r3.filesProcessed, 1)
	check(
		"transactional path restores the identical chunk set",
		await chunks.countDocuments({ path: "memory/long.md" }),
		fullCount,
	)

	// ------------------------------------------------------------------
	// W07 — legacy scheme damage: stored row at chunkScheme 1 with the
	// same hash and a last-write-wins remnant is re-chunked on a
	// NON-forced sync, then skips again once current
	// ------------------------------------------------------------------
	const lastLongOrdinal = longOrdinals[longOrdinals.length - 1]!
	const delLegacy = await chunks.deleteMany({
		path: "memory/long.md",
		startLine: LONG_LINE_NO,
		endLine: LONG_LINE_NO,
		ordinal: { $lt: lastLongOrdinal },
	})
	check("legacy damage: all but last segment removed", delLegacy.deletedCount, segs1.length - 1)
	await files.updateOne({ _id: row1?._id }, { $set: { chunkScheme: 1 } })

	const r4 = await syncToMongoDB({
		db,
		prefix: PREFIX,
		workspaceDir: ws1,
		embeddingMode: "automated",
	})
	check("legacy-scheme row re-chunked despite same hash", r4.filesProcessed >= 1, true)
	const segs4 = await segDocs(LONG_LINE_NO)
	check("re-chunk restores every segment ordinal", segs4.map((d) => d.ordinal), fullOrdinals)
	check(
		"re-chunk restores the full chunk set",
		await chunks.countDocuments({ path: "memory/long.md" }),
		fullCount,
	)
	const row4 = await filesRow()
	check("re-chunked row is scheme 2 again", row4?.chunkScheme, 2)
	check("re-chunked row carries the real hash (not the sentinel)", row4?.hash, hashText(LONG_DOC))

	const r5 = await syncToMongoDB({
		db,
		prefix: PREFIX,
		workspaceDir: ws1,
		embeddingMode: "automated",
	})
	check("post-repair same-hash sync skips again", r5.filesProcessed, 0)

	// ------------------------------------------------------------------
	// W15 — invalidation crash window: a row left at the sentinel with
	// its chunks deleted (post-crash state) heals on the next sync
	// ------------------------------------------------------------------
	await files.updateOne({ _id: row4?._id }, { $set: { hash: INVALIDATED } })
	const delCrash = await chunks.deleteMany({ path: "memory/long.md" })
	check("crash window: all chunks removed", delCrash.deletedCount, fullCount)

	const r6 = await syncToMongoDB({
		db,
		prefix: PREFIX,
		workspaceDir: ws1,
		embeddingMode: "automated",
	})
	check("sentinel row re-processed on non-forced sync", r6.filesProcessed >= 1, true)
	check(
		"crash-window sync restores the full chunk set",
		await chunks.countDocuments({ path: "memory/long.md" }),
		fullCount,
	)
	const row6 = await filesRow()
	check("healed row hash is the real digest again", row6?.hash, hashText(LONG_DOC))
	check("healed row is scheme 2", row6?.chunkScheme, 2)
	check(
		"the sentinel can never equal a real sha256 hex digest",
		/^[0-9a-f]{64}$/.test(INVALIDATED),
		false,
	)

	// ------------------------------------------------------------------
	// W14 — enumeration guards. Stale cleanup is proven live first (it
	// DOES delete when enumeration completes), then made to fail.
	// ------------------------------------------------------------------
	mkdirSync(join(ws2, "memory"), { recursive: true })
	writeFileSync(join(ws2, "memory", "a.md"), "Alpha memory content.", "utf-8")
	writeFileSync(join(ws2, "memory", "b.md"), "Beta memory content.", "utf-8")
	const bChunks = () => chunks.countDocuments({ path: "memory/b.md" })
	const bRow = () => files.findOne({ path: "memory/b.md" }, { projection: { _id: 1 } })

	const s1 = await syncToMongoDB({
		db,
		prefix: PREFIX,
		workspaceDir: ws2,
		embeddingMode: "automated",
	})
	check("ws2 first sync processes both files", s1.filesProcessed, 2)
	unlinkSync(join(ws2, "memory", "a.md"))
	const s2 = await syncToMongoDB({
		db,
		prefix: PREFIX,
		workspaceDir: ws2,
		embeddingMode: "automated",
	})
	check("stale cleanup is live when enumeration completes", s2.staleDeleted >= 1, true)
	check("removed file's chunks deleted", await chunks.countDocuments({ path: "memory/a.md" }), 0)
	check("surviving file keeps its chunks", (await bChunks()) >= 1, true)

	// W14a: unreadable memory dir — readdir EACCES must read as
	// "enumeration incomplete", never as "no memory files"
	chmodSync(join(ws2, "memory"), 0o000)
	const s3 = await syncToMongoDB({
		db,
		prefix: PREFIX,
		workspaceDir: ws2,
		embeddingMode: "automated",
	})
	chmodSync(join(ws2, "memory"), 0o755)
	check("unreadable dir: enumeration marked incomplete", s3.enumerationComplete, false)
	check("unreadable dir: nothing processed", s3.filesProcessed, 0)
	check("unreadable dir: stale cleanup skipped", s3.staleDeleted, 0)
	check("unreadable dir: stored chunks NOT mass-deleted", (await bChunks()) >= 1, true)
	check("unreadable dir: stored files row retained", (await bRow()) !== null, true)

	// W14b: unreadable memory file — a listed-but-unreadable file is
	// failed, not silently absent from the valid-path set
	chmodSync(join(ws2, "memory", "b.md"), 0o000)
	const s4 = await syncToMongoDB({
		db,
		prefix: PREFIX,
		workspaceDir: ws2,
		embeddingMode: "automated",
	})
	chmodSync(join(ws2, "memory", "b.md"), 0o644)
	check("unreadable file: counted as failed", s4.filesFailed, 1)
	check("unreadable file: enumeration marked incomplete", s4.enumerationComplete, false)
	check("unreadable file: stale cleanup skipped", s4.staleDeleted, 0)
	check("unreadable file: its chunks NOT deleted", (await bChunks()) >= 1, true)
	check("unreadable file: its files row retained", (await bRow()) !== null, true)

	const s5 = await syncToMongoDB({
		db,
		prefix: PREFIX,
		workspaceDir: ws2,
		embeddingMode: "automated",
	})
	check("restored permissions: enumeration complete again", s5.enumerationComplete, true)
	check("restored permissions: no failures", s5.filesFailed, 0)

	// ------------------------------------------------------------------
	// W07 KB — long-line document behind the real widened unique index,
	// then repair / legacy-scheme / clean-replace behaviors
	// ------------------------------------------------------------------
	const kbDoc = {
		title: "W2b KB long-line doc",
		content: KB_CONTENT,
		source: { type: "file", path: KB_PATH, importedBy: "agent" },
		hash: KB_HASH,
	}
	const kbSegDocs = (parentId: unknown) =>
		kbChunks
			.find(
				{ docId: parentId, startLine: KB_LONG_LINE_NO, endLine: KB_LONG_LINE_NO },
				{ projection: { _id: 0, ordinal: 1 } },
			)
			.sort({ ordinal: 1 })
			.toArray()
	const kbParent = () => kb.findOne({ hash: KB_HASH, scopeRef: KB_SCOPE_REF })

	const k1 = await ingestToKB({
		db,
		prefix: PREFIX,
		documents: [kbDoc],
		embeddingMode: "automated",
		scope: { agentId: KB_AGENT, scope: "agent" },
	})
	check("KB ingest processes the document", k1.documentsProcessed, 1)
	check("KB ingest reports no errors", k1.errors.length, 0)
	const p1 = await kbParent()
	check("KB parent exists", p1 !== null, true)
	check("KB parent is complete", p1?.chunksComplete, true)
	check("KB parent is scheme 2", p1?.chunkScheme, 2)
	const kbSegs1 = await kbSegDocs(p1?._id)
	console.log(`KB long line emitted ${kbSegs1.length} segments`)
	check("KB long line split into multiple segments", kbSegs1.length >= 2, true)
	const kbLongOrdinals = kbSegs1.map((d) => d.ordinal)
	check(
		"KB long-line ordinals distinct, contiguous, strictly increasing",
		kbLongOrdinals.every((o, i) => i === 0 || o === kbLongOrdinals[i - 1]! + 1),
		true,
	)
	const kbAllOrdinals = await kbChunks
		.find({ docId: p1?._id }, { projection: { _id: 0, ordinal: 1 } })
		.sort({ ordinal: 1 })
		.toArray()
	check(
		"KB doc ordinals are the global emission sequence 0..N-1 (design §W07.1)",
		kbAllOrdinals.map((d) => d.ordinal),
		kbAllOrdinals.map((_, i) => i),
	)
	const kbChunkCount = await kbChunks.countDocuments({ docId: p1?._id })
	check("KB parent chunkCount matches stored chunks", p1?.chunkCount, kbChunkCount)

	const k2 = await ingestToKB({
		db,
		prefix: PREFIX,
		documents: [kbDoc],
		embeddingMode: "automated",
		scope: { agentId: KB_AGENT, scope: "agent" },
	})
	check("complete current-scheme KB re-ingest skips", k2.skipped, 1)
	check("skipped KB re-ingest processes nothing", k2.documentsProcessed, 0)

	// C2 + W07 repair: an incomplete parent with a missing segment AND a
	// leftover chunk from an earlier partial write is clean-replaced
	await kb.updateOne({ _id: p1?._id }, { $set: { chunksComplete: false } })
	await kbChunks.deleteOne({
		docId: p1?._id,
		startLine: KB_LONG_LINE_NO,
		endLine: KB_LONG_LINE_NO,
		ordinal: 0,
	})
	const leftoverTpl = await kbChunks.findOne({ docId: p1?._id })
	const { _id: _tplId, ...leftoverRest } = leftoverTpl ?? {}
	const { insertedId: leftoverId } = await kbChunks.insertOne({
		...leftoverRest,
		ordinal: 999,
		text: "leftover from an earlier partial write",
	})
	const k3 = await ingestToKB({
		db,
		prefix: PREFIX,
		documents: [kbDoc],
		embeddingMode: "automated",
		scope: { agentId: KB_AGENT, scope: "agent" },
	})
	check("incomplete KB parent is repaired, not skipped", k3.documentsProcessed, 1)
	check("KB repair reports no errors", k3.errors.length, 0)
	const p3 = await kbParent()
	check("repaired KB parent is complete again", p3?.chunksComplete, true)
	const kbSegs3 = await kbSegDocs(p3?._id)
	check("KB repair restores every segment ordinal", kbSegs3.map((d) => d.ordinal), kbLongOrdinals)
	check(
		"KB clean-replace removes the leftover chunk",
		await kbChunks.findOne({ _id: leftoverId }),
		null,
	)
	check(
		"KB repair leaves exactly the computed chunk set",
		await kbChunks.countDocuments({ docId: p3?._id }),
		p3?.chunkCount,
	)

	// W07 legacy scheme: a complete parent written by the pre-ordinal
	// scheme is re-chunked on a same-hash ingest, not skipped
	await kb.updateOne({ _id: p3?._id }, { $set: { chunkScheme: 1 } })
	const { insertedId: leftover2Id } = await kbChunks.insertOne({
		...leftoverRest,
		ordinal: 998,
		text: "leftover from the pre-ordinal scheme era",
	})
	const k4 = await ingestToKB({
		db,
		prefix: PREFIX,
		documents: [kbDoc],
		embeddingMode: "automated",
		scope: { agentId: KB_AGENT, scope: "agent" },
	})
	check("legacy-scheme KB parent is re-chunked, not skipped", k4.documentsProcessed, 1)
	const p4 = await kbParent()
	check("re-chunked KB parent is scheme 2 again", p4?.chunkScheme, 2)
	check("re-chunked KB parent is complete", p4?.chunksComplete, true)
	const kbSegs4 = await kbSegDocs(p4?._id)
	check("KB legacy re-chunk restores every ordinal", kbSegs4.map((d) => d.ordinal), kbLongOrdinals)
	check(
		"KB legacy re-chunk clean-replaces leftovers too",
		await kbChunks.findOne({ _id: leftover2Id }),
		null,
	)

	const k5 = await ingestToKB({
		db,
		prefix: PREFIX,
		documents: [kbDoc],
		embeddingMode: "automated",
		scope: { agentId: KB_AGENT, scope: "agent" },
	})
	check("current-scheme KB skip gating intact after repairs", k5.skipped, 1)

	console.log(
		failures === 0
			? `PASS: ${total}/${total} assertions`
			: `FAIL: ${failures} of ${total} assertions`,
	)
} finally {
	await client.db(database).dropDatabase()
	console.log(`cleanup: dropped scratch database ${database}`)
	await client.close()
	rmSync(ws1, { recursive: true, force: true })
	rmSync(ws2, { recursive: true, force: true })
}

process.exit(failures === 0 ? 0 : 1)
