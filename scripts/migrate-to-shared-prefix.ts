import { createHash } from "node:crypto"
import { type Collection, type Db, type Document, MongoClient } from "mongodb"

/**
 * P2.1 migration: consolidate per-agent `memongo_<agent>_*` collection sets
 * into the shared `memongo_*` collection set (MongoDB's collection-per-tenant
 * -> shared-collection multitenancy pattern). Documents already carry agentId,
 * so the tenant field travels with the data and no rewriting is needed.
 *
 * Defaults to a dry run. Usage:
 *
 *   MEMONGO_MONGODB_URI=... bun scripts/migrate-to-shared-prefix.ts
 *   MEMONGO_MONGODB_URI=... bun scripts/migrate-to-shared-prefix.ts --apply
 *   MEMONGO_MONGODB_URI=... bun scripts/migrate-to-shared-prefix.ts --apply --drop
 *
 * Flags:
 *   --apply            execute the copy (default: dry-run report only)
 *   --drop             drop each source collection after its copy verifies
 *                      (requires --apply)
 *   --agent <id>       migrate only this agent prefix (repeatable)
 *   --batch <n>        docs per verification cursor batch (default 500)
 *
 * Env:
 *   MEMONGO_MONGODB_URI             (required)
 *   MEMONGO_MONGODB_DATABASE        (default "memongo")
 *   MEMONGO_MONGODB_TARGET_PREFIX   (default "memongo_")
 *
 * Copy mechanism: a single server-side aggregation stage
 * `{ $merge: { on: "_id", whenMatched: "keepExisting", whenNotMatched: "insert" } }`
 * copies each source collection into the shared target entirely inside
 * MongoDB. No document is decoded, re-serialized, or rewritten by this
 * client, so persisted BSON details a JS round trip cannot preserve (regex
 * flags x/l/u, non-canonical field order, DBRef subdocument order, literal
 * `$date` subdocuments) are copied as stored bytes. `keepExisting` makes a
 * retried run idempotent: rows that already exist are kept byte-for-byte,
 * and a same-`_id` row holding different content is kept as-is and flagged
 * by verification instead of being overwritten.
 *
 * Verification is cryptographic digest comparison over the complete
 * persisted bytes of every source document (`_id` included): raw cursors
 * (`raw: true`) return the stored bytes without deserialization, each
 * document is SHA-256 digested, and every source digest must be consumed
 * by a byte-identical target row (multiset counts cover multiplicity;
 * extra shared-target rows from other agents are allowed). This is digest
 * comparison, not literal pairwise byte comparison, and it reports a single
 * `unmatched` count: without decoding documents there is no identity
 * address that could honestly distinguish a missing row from a mismatched
 * one. Scan cost is O(source + shared target) per collection with O(source)
 * digest storage; no sorter, migration framework, custom BSON parser, or
 * extra dependency is involved.
 *
 * Any failure retains the source: an aggregate error (uncertain copy
 * outcome — a partial $merge may already have landed rows), a verification
 * read error, a non-buffer row, or unmatched content all block the drop and
 * make the run exit nonzero.
 *
 * Supported shapes: plain collections only. Views and time-series
 * collections are rejected on either side (duplicate and missing `_id`
 * values are legal there, so an `_id`-keyed copy cannot certify identity,
 * content, and multiplicity), and so are capped collections (server-side
 * eviction can silently remove rows after verification). Collections with
 * an active TTL index (`expireAfterSeconds`) on either side are rejected
 * too, as an intermediate safety guard: TTL expiry can delete rows between
 * verification and the source drop with no observable error, and no final
 * count closes that window. This guard means normal TTL-enabled migration
 * inputs are rejected rather than mishandled; an operable
 * retention-maintenance path for them is pending and owned separately.
 *
 * Operating precondition: run `--apply` inside a maintenance window that
 * quiesces BOTH the source and the target collections — application
 * writes, DDL (including the `_id` unique index `$merge` matches on), and
 * background mutation. Digest verification is exact at verification time
 * but cannot fence a mutation that happens after it: a target write or
 * deletion after verification can invalidate the comparison before the
 * source drop. The window is the fence.
 */

// Discovery suffixes: every persisted collection the schema initializer
// creates (ensureCollections in packages/memory-engine
// mongodb-schema-validators.ts), the two diagnostics time-series it
// maintains, and the optional feature-gated memory_evidence so a
// mirror-enabled deployment's per-agent evidence collections are
// discovered too. The unit oracle in migrate-to-shared-prefix.test.ts
// drives the real ensureCollections against a recording mock and proves
// every name it creates is discoverable here, so this list cannot drift
// silently. Matching is endsWith-based over `_`-suffixed candidates: a
// longer base whose name ends with a shorter base must appear EARLIER in
// this list (access_events before events; session_chunks and kb_chunks
// before chunks) so the most specific base matches first.
const BASE_COLLECTIONS = [
	"structured_mem_revisions",
	"relevance_regressions",
	"procedure_revisions",
	"consolidation_runs",
	"relevance_artifacts",
	"memory_quarantine",
	"projection_runs",
	"memory_mutations",
	"memory_cost_ledger",
	"relevance_runs",
	"memory_telemetry",
	"session_chunks",
	"knowledge_base",
	"lane_coverage",
	"recall_traces",
	"access_events",
	"entity_links",
	"memory_jobs",
	"structured_mem",
	"kb_chunks",
	"procedures",
	"query_cache",
	"episodes",
	"relations",
	"entities",
	"chunks",
	"events",
	"files",
	"meta",
	"memory_evidence",
	"ingest_runs",
]

const AGENT_SEGMENT = /^[a-z0-9-]+$/

export type SourceCollection = {
	agentId: string
	base: string
	sourceName: string
	targetName: string
}

export type CopyReport = {
	sourceName: string
	targetName: string
	/** source documents digested during verification */
	scanned: number
	/** source digests not consumed by a byte-identical target row */
	unmatched: number
	unsupported?: string
	uncertain?: string
	verified: boolean
	dropped: boolean
}

function readArgValues(flag: string): string[] {
	const values: string[] = []
	for (let i = 0; i < process.argv.length - 1; i++) {
		if (process.argv[i] === flag) {
			values.push(process.argv[i + 1] as string)
		}
	}
	return values
}

function hasFlag(flag: string): boolean {
	return process.argv.includes(flag)
}

/**
 * Map the database's collection names onto per-agent migration sources.
 * Exported as the import-safe seam the discovery oracle tests against;
 * the suffix list it matches is proven against the real schema
 * initializer there.
 */
export function discoverSources(
	collectionNames: string[],
	targetPrefix: string,
	agents: Set<string> | null,
): SourceCollection[] {
	const sources: SourceCollection[] = []
	for (const name of collectionNames) {
		if (!name.startsWith(targetPrefix)) {
			continue
		}
		const rest = name.slice(targetPrefix.length)
		if ((BASE_COLLECTIONS as string[]).includes(rest)) {
			// Already a shared target collection.
			continue
		}
		const base = BASE_COLLECTIONS.find((candidate) =>
			rest.endsWith(`_${candidate}`),
		)
		if (!base) {
			continue
		}
		const agentId = rest.slice(0, rest.length - base.length - 1)
		if (!AGENT_SEGMENT.test(agentId)) {
			continue
		}
		if (agents && !agents.has(agentId)) {
			continue
		}
		sources.push({
			agentId,
			base,
			sourceName: name,
			targetName: `${targetPrefix}${base}`,
		})
	}
	return sources.toSorted((a, b) => a.sourceName.localeCompare(b.sourceName))
}

export type CollectionListInfo = {
	name: string
	type?: string
	options?: Document
}

export type CollectionShape = {
	/** undefined: absent collection (created plain by $merge) or a plain collection on servers that do not report a type */
	type: string | undefined
	capped: boolean
	/** names of indexes carrying an active TTL expiry (`expireAfterSeconds`) */
	ttlIndexes: string[]
}

/**
 * Resolve the safety-relevant shape of one collection from its
 * listCollections entry. An absent collection resolves to the plain shape
 * ($merge creates a plain collection on first write). Views and time-series
 * collections skip index inspection: the shape gate rejects them on type,
 * and listIndexes is not meaningful on views. Any inspection error is thrown
 * to the caller, which fails closed.
 */
export async function resolveCollectionShape(params: {
	db: Db
	name: string
	info: CollectionListInfo | undefined
}): Promise<CollectionShape> {
	const { db, name, info } = params
	if (info === undefined) {
		return { type: undefined, capped: false, ttlIndexes: [] }
	}
	if (info.type !== undefined && info.type !== "collection") {
		return {
			type: info.type,
			capped: info.options?.capped === true,
			ttlIndexes: [],
		}
	}
	const ttlIndexes: string[] = []
	for (const index of await db.collection(name).listIndexes().toArray()) {
		if (index.expireAfterSeconds !== undefined) {
			ttlIndexes.push(String(index.name))
		}
	}
	return { type: info.type, capped: info.options?.capped === true, ttlIndexes }
}

/**
 * Shape gate. Only plain collections can certify per-document identity,
 * content, and multiplicity by `_id`: time-series collections accept
 * duplicate and missing `_id` values, and views are not durable sources.
 * Capped collections are rejected because server-side eviction can remove
 * rows after verification without any observable error. Collections with
 * an active TTL index are rejected as an intermediate safety guard (see
 * the header): retention maintenance for TTL-enabled migration is a
 * separate, pending mechanism, and refusing the input is safer than
 * pretending a final count closes the expiry window.
 */
export function unsupportedShapeReason(
	source: CollectionShape,
	target: CollectionShape,
): string | undefined {
	const unsupportedType = (shape: CollectionShape) =>
		shape.type !== undefined && shape.type !== "collection"
	if (unsupportedType(source)) {
		return `source is a ${source.type} collection; _id-keyed copy cannot certify identity/content/multiplicity`
	}
	if (unsupportedType(target)) {
		return `target is a ${target.type} collection; _id-keyed copy cannot certify identity/content/multiplicity`
	}
	if (source.capped) {
		return "source is a capped collection; server-side eviction can remove rows after verification without any observable error"
	}
	if (target.capped) {
		return "target is a capped collection; server-side eviction can remove rows after verification without any observable error"
	}
	if (source.ttlIndexes.length > 0) {
		return `source has active TTL index(es) ${source.ttlIndexes.join(",")}; TTL expiry can delete rows between verification and the source drop; retention-maintenance path pending, so this tool refuses TTL-enabled migration (intermediate guard)`
	}
	if (target.ttlIndexes.length > 0) {
		return `target has active TTL index(es) ${target.ttlIndexes.join(",")}; TTL expiry can delete rows between verification and the source drop; retention-maintenance path pending, so this tool refuses TTL-enabled migration (intermediate guard)`
	}
	return undefined
}

function sha256(bytes: Buffer): string {
	return createHash("sha256").update(bytes).digest("hex")
}

/**
 * Raw cursor rows must be the stored document bytes. The driver returns a
 * Buffer per document; anything else means the read contract broke, and
 * verification must fail closed rather than digest an unknown value.
 */
function rawDocBytes(doc: unknown, collectionName: string): Buffer {
	if (Buffer.isBuffer(doc)) {
		return doc
	}
	if (doc instanceof Uint8Array) {
		return Buffer.from(doc)
	}
	throw new Error(
		`raw cursor on ${collectionName} yielded a ${typeof doc} instead of stored document bytes; verification fails closed`,
	)
}

export type VerificationResult = {
	scanned: number
	unmatched: number
}

/**
 * Cryptographic digest verification over complete persisted bytes. Every
 * source document (including its `_id`) is read raw and SHA-256 digested
 * into a multiset; a full scan of the shared target then consumes one
 * occurrence per byte-identical row. Verification passes only when every
 * source occurrence is consumed (`unmatched === 0`); extra target rows
 * from other agents are allowed by design. No document is deserialized,
 * so no decoded value participates in the verdict, and there is no decoded
 * `_id` correlation to reorder or misaddress. Any read error or non-buffer
 * row throws, and the caller retains the source.
 */
export async function verifyCollectionCopy(params: {
	source: Collection
	target: Collection
	batchSize: number
}): Promise<VerificationResult> {
	const { source, target, batchSize } = params
	const digests = new Map<string, number>()
	let scanned = 0
	for await (const doc of source.find({}, { raw: true, batchSize })) {
		const digest = sha256(rawDocBytes(doc, source.collectionName))
		digests.set(digest, (digests.get(digest) ?? 0) + 1)
		scanned += 1
	}
	for await (const doc of target.find({}, { raw: true, batchSize })) {
		const digest = sha256(rawDocBytes(doc, target.collectionName))
		const remaining = digests.get(digest)
		if (remaining !== undefined && remaining > 0) {
			digests.set(digest, remaining - 1)
		}
	}
	let unmatched = 0
	for (const remaining of digests.values()) {
		unmatched += remaining
	}
	return { scanned, unmatched }
}

/**
 * Static diagnostic for connection-string parse failures: driver and
 * parser messages quote the offending URI (whole or fragment), so no part
 * of such a message is safe to render. Detection is name-based — two
 * distinct MongoParseError classes exist (the connection-string parser
 * and the driver) — and both are thrown while interpreting
 * MEMONGO_MONGODB_URI, before any connection attempt.
 */
const PARSE_FAILURE =
	"MEMONGO_MONGODB_URI is not a valid MongoDB connection string (MongoParseError); the value is never echoed"

/**
 * Strip credential material an arbitrary message may carry: the exact env
 * URI value first, then any quote-delimited mongodb/mongodb+srv scheme
 * string (driver diagnostics quote the URI they reject, including
 * whitespace-bearing variants). Truncation happens only after scrubbing
 * so a long message cannot smuggle a credential tail past the cap.
 */
function scrubMessage(message: string): string {
	const uri = process.env.MEMONGO_MONGODB_URI?.trim()
	let scrubbed = uri ? message.split(uri).join("<mongodb-uri>") : message
	scrubbed = scrubbed.replace(/"mongodb(\+srv)?:\/\/[^"]*"/g, '"<mongodb-uri>"')
	return scrubbed.length > 300 ? `${scrubbed.slice(0, 300)}…` : scrubbed
}

/**
 * The single safe-rendering funnel for operator-facing error text: parse
 * failures get the static diagnostic, every other message is scrubbed.
 * Receipt text and the guarded entry both render through here.
 */
function errorMessage(err: unknown): string {
	if (err instanceof Error && err.name === "MongoParseError") {
		return PARSE_FAILURE
	}
	return scrubMessage(err instanceof Error ? err.message : String(err))
}

export async function migrateCollection(params: {
	db: Db
	source: SourceCollection
	sourceShape: CollectionShape
	targetShape: CollectionShape
	batchSize: number
	drop: boolean
}): Promise<CopyReport> {
	const { db, source, sourceShape, targetShape, batchSize, drop } = params
	const report: CopyReport = {
		sourceName: source.sourceName,
		targetName: source.targetName,
		scanned: 0,
		unmatched: 0,
		verified: false,
		dropped: false,
	}
	const unsupported = unsupportedShapeReason(sourceShape, targetShape)
	if (unsupported) {
		report.unsupported = unsupported
		return report
	}

	const sourceColl = db.collection(source.sourceName)
	const targetColl = db.collection(source.targetName)
	let copyComplete = false
	try {
		// Server-side copy. keepExisting makes retries idempotent and leaves
		// a conflicting same-_id target row untouched (verification flags
		// it); insert adds only rows the target lacks. Any error leaves the
		// outcome uncertain — a partial $merge may already have landed — and
		// this run never drops the source.
		await sourceColl
			.aggregate([
				{
					$merge: {
						into: source.targetName,
						on: "_id",
						whenMatched: "keepExisting",
						whenNotMatched: "insert",
					},
				},
			])
			.toArray()
		copyComplete = true
	} catch (err) {
		report.uncertain = `copy aggregate outcome unknown: ${errorMessage(err)}`
	}

	// Verify durable state regardless of the copy outcome so the report
	// reflects what is actually stored; `uncertain` still blocks the drop.
	try {
		const verification = await verifyCollectionCopy({
			source: sourceColl,
			target: targetColl,
			batchSize,
		})
		report.scanned = verification.scanned
		report.unmatched = verification.unmatched
	} catch (err) {
		const message = `verification read failed: ${errorMessage(err)}`
		report.uncertain =
			report.uncertain === undefined
				? message
				: `${report.uncertain}; ${message}`
	}

	report.verified =
		copyComplete && report.uncertain === undefined && report.unmatched === 0
	if (drop && report.verified) {
		await db.dropCollection(source.sourceName)
		report.dropped = true
	}
	return report
}

async function main() {
	const uri = process.env.MEMONGO_MONGODB_URI?.trim()
	if (!uri) {
		throw new Error("MEMONGO_MONGODB_URI is required")
	}
	const database = process.env.MEMONGO_MONGODB_DATABASE?.trim() || "memongo"
	const targetPrefix =
		process.env.MEMONGO_MONGODB_TARGET_PREFIX?.trim() || "memongo_"
	const apply = hasFlag("--apply")
	const drop = hasFlag("--drop")
	const agentFilter = readArgValues("--agent")
	const batchArg = readArgValues("--batch")[0]
	const batchSize = batchArg ? Number(batchArg) : 500
	if (!Number.isInteger(batchSize) || batchSize <= 0) {
		throw new Error("--batch must be a positive integer")
	}
	if (drop && !apply) {
		throw new Error("--drop requires --apply")
	}

	const client = new MongoClient(uri, {
		appName: "memongo-migrate-shared-prefix",
		serverSelectionTimeoutMS: 10_000,
	})
	await client.connect()
	try {
		const db = client.db(database)
		const collectionInfos = await db.listCollections().toArray()
		const infoByName = new Map(
			collectionInfos.map((info) => [info.name, info] as const),
		)
		const sources = discoverSources(
			collectionInfos.map((info) => info.name),
			targetPrefix,
			agentFilter.length > 0 ? new Set(agentFilter) : null,
		)
		if (sources.length === 0) {
			console.log(
				`migrate-shared-prefix: no per-agent ${targetPrefix}<agent>_* collections found in db=${database}`,
			)
			return
		}
		const agents = [...new Set(sources.map((s) => s.agentId))].toSorted()
		console.log(
			`migrate-shared-prefix: mode=${apply ? "apply" : "dry-run"} db=${database} target=${targetPrefix}* agents=${agents.join(",")} collections=${sources.length}`,
		)
		console.log(
			"migrate-shared-prefix: precondition — maintenance window quiescing BOTH source and target collections: application writes, DDL (including the _id unique index $merge matches on), and background mutation; digest verification is exact at verification time but cannot fence a later mutation",
		)

		const reports: CopyReport[] = []
		for (const source of sources) {
			let reason: string | undefined
			let sourceShape: CollectionShape | undefined
			let targetShape: CollectionShape | undefined
			try {
				sourceShape = await resolveCollectionShape({
					db,
					name: source.sourceName,
					info: infoByName.get(source.sourceName),
				})
				targetShape = await resolveCollectionShape({
					db,
					name: source.targetName,
					info: infoByName.get(source.targetName),
				})
				reason = unsupportedShapeReason(sourceShape, targetShape)
			} catch (err) {
				// Fail closed: without an established shape there is no copy.
				reason = `could not inspect collection shape: ${errorMessage(err)}`
			}
			const sourceCount = await db
				.collection(source.sourceName)
				.estimatedDocumentCount()
			if (!apply) {
				console.log(
					`dry-run ${source.sourceName} -> ${source.targetName} docs=${sourceCount}${reason ? ` UNSUPPORTED: ${reason}` : ""}`,
				)
				continue
			}
			if (
				reason !== undefined ||
				sourceShape === undefined ||
				targetShape === undefined
			) {
				const report: CopyReport = {
					sourceName: source.sourceName,
					targetName: source.targetName,
					scanned: 0,
					unmatched: 0,
					unsupported: reason,
					verified: false,
					dropped: false,
				}
				reports.push(report)
				console.log(
					`skip ${report.sourceName}: unsupported — ${report.unsupported}`,
				)
				continue
			}
			const report = await migrateCollection({
				db,
				source,
				sourceShape,
				targetShape,
				batchSize,
				drop,
			})
			reports.push(report)
			if (report.unsupported) {
				console.log(
					`skip ${report.sourceName}: unsupported — ${report.unsupported}`,
				)
			} else {
				console.log(
					`copy ${report.sourceName} -> ${report.targetName} scanned=${report.scanned} unmatched=${report.unmatched} verified=${report.verified}${report.dropped ? " dropped" : ""}${report.uncertain ? ` uncertain="${report.uncertain}"` : ""}`,
				)
			}
		}

		if (apply) {
			const failed = reports.filter((report) => !report.verified)
			const totals = reports.reduce(
				(acc, report) => ({
					scanned: acc.scanned + report.scanned,
					unmatched: acc.unmatched + report.unmatched,
				}),
				{ scanned: 0, unmatched: 0 },
			)
			console.log(
				`migrate-shared-prefix: total scanned=${totals.scanned} unmatched=${totals.unmatched} collections=${reports.length} dropped=${reports.filter((r) => r.dropped).length}`,
			)
			if (failed.length > 0) {
				console.error(
					`migrate-shared-prefix: FAILED verification for: ${failed.map((r) => r.sourceName).join(",")}`,
				)
				process.exitCode = 1
			}
		} else {
			console.log(
				"migrate-shared-prefix: dry-run only — re-run with --apply to copy, --apply --drop to also remove source collections",
			)
		}
	} finally {
		await client.close()
	}
}

if (import.meta.main) {
	try {
		await main()
	} catch (err) {
		// One prefixed line on stderr, never a raw dump (no stack, no
		// source frame): this guard is the last chance to keep a
		// credential-bearing driver diagnostic off both channels.
		console.error(`migrate-shared-prefix: ${errorMessage(err)}`)
		process.exitCode = 1
	}
}
