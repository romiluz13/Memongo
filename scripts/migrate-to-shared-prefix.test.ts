/**
 * Unit oracle for the W16 server-copy correction.
 *
 * The mock db models persisted state as raw BSON bytes and simulates the
 * server-side $merge (keepExisting/insert) at the byte level: rows are
 * addressed by their decoded `_id` only inside the mock (the real match
 * runs server-side on the stored bytes), and inserts land the source bytes
 * verbatim. The code under test must never decode a copied document: the
 * mock's find() only accepts raw:true options, so any decoded read on the
 * copy/verify path fails the test.
 *
 * Mock fidelity limits (covered natively by the e2e and the CLI probe):
 * byte-verbatim inserts are simulated, not observed from a server, and the
 * duplicate-digest rows used to exercise multiset counting could not exist
 * in a real plain collection (unique `_id`). The `_id` fixtures here avoid
 * shapes whose decode/re-encode is ambiguous; those shapes are covered by
 * the e2e fixtures.
 *
 * The ledger-discovery oracle describe drives the REAL schema initializer
 * (ensureCollections) against a recording mock Db and proves CLI discovery
 * covers every name the initializer creates — the expected set is recorded
 * from the implementation, never restated as a second copied allowlist.
 * The final describe block pins the CLI's public credential-safety surface
 * with serverless child-process regressions.
 */
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { BSON, type Db } from "mongodb"
import { describe, expect, it } from "vitest"
import { ensureCollections } from "../packages/memory-engine/src/mongodb-schema-validators.js"
import {
	type CollectionShape,
	discoverSources,
	migrateCollection,
	resolveCollectionShape,
	type SourceCollection,
	unsupportedShapeReason,
	verifyCollectionCopy,
} from "./migrate-to-shared-prefix.js"

type Row = { bytes: Buffer; idHex: string }

type CollectionBehavior = {
	rows: Row[]
	aggregateCalls: number
	listIndexesCalls: number
	findRawCalls: number
	mergeError?: Error
	/** insert-path rows allowed to land before mergeError surfaces */
	mergeFailAfter?: number
	findError?: Error
	yieldNonBuffer?: boolean
	listIndexesError?: Error
	/** Mirrors the driver's listIndexes rows; TTL detection reads name and
	 *  expireAfterSeconds only, so `key` stays optional fixture fidelity. */
	indexes?: Array<{
		name: string
		key?: Record<string, number>
		expireAfterSeconds?: number
	}>
}

const SOURCE: SourceCollection = {
	agentId: "demo",
	base: "events",
	sourceName: "probe_demo_events",
	targetName: "probe_events",
}

const PLAIN: CollectionShape = {
	type: "collection",
	capped: false,
	ttlIndexes: [],
}

function row(value: unknown): Row {
	const bytes = Buffer.from(BSON.serialize(value as Record<string, unknown>))
	// The mock's _id address: decoded only to simulate the server's match on
	// _id. Fixtures avoid _id shapes whose decode/re-encode is ambiguous.
	const id = BSON.deserialize(bytes)._id
	return {
		bytes,
		idHex: Buffer.from(BSON.serialize({ _id: id })).toString("hex"),
	}
}

function makeRawCursor(behavior: CollectionBehavior) {
	return {
		[Symbol.asyncIterator]() {
			return (async function* () {
				if (behavior.findError) {
					throw behavior.findError
				}
				if (behavior.yieldNonBuffer) {
					yield { decoded: "not stored bytes" }
				}
				for (const r of behavior.rows) {
					yield r.bytes
				}
			})()
		},
	}
}

function makeDb(collections: Map<string, CollectionBehavior>) {
	const dropped: string[] = []
	const applyMerge = (into: string, source: CollectionBehavior) => {
		const target = collections.get(into)
		if (!target) {
			throw new Error(`test mock: $merge into unknown collection ${into}`)
		}
		const failAfter =
			source.mergeError !== undefined
				? (source.mergeFailAfter ?? 0)
				: Number.POSITIVE_INFINITY
		let inserts = 0
		for (const r of source.rows) {
			if (target.rows.some((existing) => existing.idHex === r.idHex)) {
				continue // whenMatched: keepExisting
			}
			if (inserts >= failAfter) {
				throw source.mergeError
			}
			target.rows.push(r) // whenNotMatched: insert (bytes verbatim)
			inserts += 1
		}
		if (source.mergeError !== undefined) {
			throw source.mergeError
		}
	}
	const db = {
		collection: (name: string) => {
			const behavior = collections.get(name)
			if (!behavior) {
				throw new Error(`unexpected collection access: ${name}`)
			}
			return {
				find: (_filter: unknown, options?: { raw?: boolean }) => {
					if (options?.raw !== true) {
						throw new Error(
							"test mock: find must use raw:true (no decoded reads)",
						)
					}
					behavior.findRawCalls += 1
					return makeRawCursor(behavior)
				},
				aggregate: (pipeline: unknown[]) => {
					behavior.aggregateCalls += 1
					const merge = (pipeline as Array<{ $merge?: { into?: unknown } }>)[0]
						?.$merge
					if (!merge || typeof merge.into !== "string") {
						throw new Error("test mock: expected a $merge-only pipeline")
					}
					const into = merge.into
					return {
						toArray: async () => {
							applyMerge(into, behavior)
							return []
						},
					}
				},
				listIndexes: () => {
					behavior.listIndexesCalls += 1
					return {
						toArray: async () => {
							if (behavior.listIndexesError) {
								throw behavior.listIndexesError
							}
							return behavior.indexes ?? [{ name: "_id_", key: { _id: 1 } }]
						},
					}
				},
			}
		},
		dropCollection: async (name: string) => {
			dropped.push(name)
		},
	} as unknown as Db
	return { db, dropped }
}

function behavior(rows: Row[], extra: Partial<CollectionBehavior> = {}) {
	return {
		rows,
		aggregateCalls: 0,
		listIndexesCalls: 0,
		findRawCalls: 0,
		...extra,
	}
}

// Raw-BSON fixtures for the lossy-client-copy failures this correction
// exists for: regex flags x/l/u (F1), non-canonical DBRef/numeric-key order
// and UUID _ids (F2), plus typed numerics that default promotion erases.
function problematicRows(): Row[] {
	return [
		row({ _id: "rx", v: new BSON.BSONRegExp("alpha-", "x") }),
		row({ _id: "ri", v: new BSON.BSONRegExp("beta", "i") }),
		row({ _id: "rl", v: new BSON.BSONRegExp("epsilon-", "l") }),
		row({ _id: "ru", v: new BSON.BSONRegExp("zeta-", "u") }),
		row({
			_id: "db",
			d: new Map<string, unknown>([
				["$id", new BSON.ObjectId()],
				["$ref", "entities"],
			]),
		}),
		row({
			_id: "nkq",
			sub: new Map([
				["a", 1],
				["0", 2],
			]),
		}),
		row(
			new Map<string, unknown>([
				["_id", new BSON.UUID()],
				["v", new BSON.BSONRegExp("gamma-", "x")],
			]),
		),
	]
}

function typedRows(): Row[] {
	return [
		row({ _id: "t-long", v: BSON.Long.fromNumber(1) }),
		row({ _id: "t-double", v: new BSON.Double(1) }),
		row({ _id: "t-negzero", v: new BSON.Double(-0) }),
		row({ _id: "t-int", v: new BSON.Int32(7) }),
		row({ _id: "t-biglong", v: BSON.Long.fromString("9223372036854775807") }),
		row({ _id: "t-dec", v: BSON.Decimal128.fromString("9.99") }),
	]
}

async function runMigration(params: {
	sourceRows: Row[]
	targetRows?: Row[]
	sourceShape?: CollectionShape
	targetShape?: CollectionShape
	drop?: boolean
	sourceExtra?: Partial<CollectionBehavior>
	targetExtra?: Partial<CollectionBehavior>
}) {
	const source = behavior(params.sourceRows, params.sourceExtra)
	const target = behavior(params.targetRows ?? [], params.targetExtra)
	const { db, dropped } = makeDb(
		new Map([
			[SOURCE.sourceName, source],
			[SOURCE.targetName, target],
		]),
	)
	const report = await migrateCollection({
		db,
		source: SOURCE,
		sourceShape: params.sourceShape ?? PLAIN,
		targetShape: params.targetShape ?? PLAIN,
		batchSize: 500,
		drop: params.drop ?? true,
	})
	return { report, dropped, source, target }
}

describe("migrateCollection server $merge copy + digest verification", () => {
	it("copies regex x/i/l/u, DBRef order, embedded numeric-key order, UUID _id, and typed numerics byte-exactly and drops", async () => {
		const sourceRows = [...problematicRows(), ...typedRows()]
		const { report, dropped, target } = await runMigration({ sourceRows })
		expect(report.scanned).toBe(sourceRows.length)
		expect(report.unmatched).toBe(0)
		expect(report.uncertain).toBeUndefined()
		expect(report.verified).toBe(true)
		expect(report.dropped).toBe(true)
		expect(dropped).toEqual([SOURCE.sourceName])
		const targetBytes = target.rows.map((r) => r.bytes).toSorted(Buffer.compare)
		const sourceBytes = sourceRows.map((r) => r.bytes).toSorted(Buffer.compare)
		expect(targetBytes).toHaveLength(sourceRows.length)
		for (const [i, bytes] of targetBytes.entries()) {
			expect(bytes.equals(sourceBytes[i])).toBe(true)
		}
	})

	it("accepts a genuinely matching interrupted retry and drops (merge still runs)", async () => {
		const sourceRows = problematicRows()
		const { report, dropped, source, target } = await runMigration({
			sourceRows,
			targetRows: sourceRows.map((r) => ({ ...r })),
		})
		expect(report.scanned).toBe(sourceRows.length)
		expect(report.unmatched).toBe(0)
		expect(report.verified).toBe(true)
		expect(report.dropped).toBe(true)
		expect(dropped).toEqual([SOURCE.sourceName])
		// The retry executes $merge again; keepExisting added nothing.
		expect(source.aggregateCalls).toBe(1)
		expect(target.rows).toHaveLength(sourceRows.length)
	})

	it("keeps a wrong same-_id target payload, reports unmatched, and retains the source", async () => {
		const sourceRows = [
			row({
				_id: "same-id",
				eventId: "source-intent",
				body: "source payload requiring preservation",
			}),
		]
		const targetRows = [
			row({
				_id: "same-id",
				eventId: "different-intent",
				body: "different target payload",
			}),
		]
		const { report, dropped, target } = await runMigration({
			sourceRows,
			targetRows,
		})
		expect(report.scanned).toBe(1)
		expect(report.unmatched).toBe(1)
		expect(report.verified).toBe(false)
		expect(report.dropped).toBe(false)
		expect(dropped).toEqual([])
		// keepExisting left the wrong target row untouched.
		expect(target.rows[0]?.bytes.equals(targetRows[0].bytes)).toBe(true)
	})

	it("distinguishes persisted numeric types: int32 source vs int64 target", async () => {
		const { report, dropped, target } = await runMigration({
			sourceRows: [row({ _id: "tc", v: 1 })],
			targetRows: [row({ _id: "tc", v: BSON.Long.fromNumber(1) })],
		})
		expect(report.unmatched).toBe(1)
		expect(report.verified).toBe(false)
		expect(dropped).toEqual([])
		// The int64 target row survives untouched.
		expect(target.rows).toHaveLength(1)
	})

	it("distinguishes a literal $date subdocument from Date(0) though Extended JSON cannot", async () => {
		// Pins the official limitation (manual: "Field Names with Periods and
		// Dollar Signs", Import and Export Concerns): a literal {$date: ...}
		// subdocument does not survive an Extended JSON round trip — parsing
		// its own Extended JSON reinterprets it as a Date — so EJSON cannot
		// be the comparator; the persisted bytes differ and the digest sees it.
		const roundTripped = BSON.EJSON.parse(
			BSON.EJSON.stringify({ v: { $date: { $numberLong: "0" } } }),
		)
		expect(roundTripped.v).toBeInstanceOf(Date)
		expect(BSON.EJSON.stringify(roundTripped)).toBe(
			BSON.EJSON.stringify({ v: new Date(0) }),
		)
		const { report, dropped } = await runMigration({
			sourceRows: [row({ _id: "lw", v: { $date: { $numberLong: "0" } } })],
			targetRows: [row({ _id: "lw", v: new Date(0) })],
		})
		expect(report.unmatched).toBe(1)
		expect(report.verified).toBe(false)
		expect(dropped).toEqual([])
	})

	it("allows extra shared-target rows from other agents and still verifies", async () => {
		const extra = row({ _id: "other-agent-row", body: "keep me" })
		const { report, dropped, target } = await runMigration({
			sourceRows: [
				row({ _id: "a", body: "one" }),
				row({ _id: "b", body: "two" }),
			],
			targetRows: [extra],
		})
		expect(report.unmatched).toBe(0)
		expect(report.verified).toBe(true)
		expect(report.dropped).toBe(true)
		expect(dropped).toEqual([SOURCE.sourceName])
		expect(target.rows).toHaveLength(3)
		expect(target.rows[0]?.bytes.equals(extra.bytes)).toBe(true)
	})

	it("consumes equal-content rows with distinct _ids (multiplicity)", async () => {
		const { report, dropped, target } = await runMigration({
			sourceRows: [
				row({ _id: "id-1", body: "equal content" }),
				row({ _id: "id-2", body: "equal content" }),
			],
		})
		expect(report.scanned).toBe(2)
		expect(report.unmatched).toBe(0)
		expect(report.verified).toBe(true)
		expect(dropped).toEqual([SOURCE.sourceName])
		expect(target.rows).toHaveLength(2)
	})

	it("retains the source when the aggregate fails before any insert (non-_id unique conflict)", async () => {
		const { report, dropped, target } = await runMigration({
			sourceRows: [
				row({ _id: "trace-1", traceId: "t-1", body: "payload" }),
				row({ _id: "trace-2", traceId: "t-1", body: "payload" }),
			],
			sourceExtra: {
				mergeError: new Error(
					'E11000 duplicate key error collection: db.probe_events index: uq_traceid dup key: { traceId: "t-1" }',
				),
				mergeFailAfter: 0,
			},
		})
		expect(report.uncertain).toMatch(/copy aggregate outcome unknown/)
		expect(report.unmatched).toBe(2)
		expect(report.verified).toBe(false)
		expect(dropped).toEqual([])
		expect(target.rows).toHaveLength(0)
	})

	it("retains the source on an uncertain aggregate outcome even when every row landed", async () => {
		const { report, dropped, target } = await runMigration({
			sourceRows: [
				row({ _id: "a", body: "one" }),
				row({ _id: "b", body: "two" }),
			],
			sourceExtra: {
				mergeError: new Error("connection reset by peer"),
				mergeFailAfter: 2,
			},
		})
		expect(report.uncertain).toMatch(/copy aggregate outcome unknown/)
		expect(report.unmatched).toBe(0)
		expect(report.verified).toBe(false)
		expect(dropped).toEqual([])
		// The rows did land; the receipt reflects durable state and still
		// refuses to drop on an uncertain copy outcome.
		expect(target.rows).toHaveLength(2)
	})

	it("retains the source when a partial $merge landed", async () => {
		const { report, dropped, target } = await runMigration({
			sourceRows: [
				row({ _id: "a", body: "one" }),
				row({ _id: "b", body: "two" }),
			],
			sourceExtra: {
				mergeError: new Error("connection reset by peer"),
				mergeFailAfter: 1,
			},
		})
		expect(report.uncertain).toMatch(/copy aggregate outcome unknown/)
		expect(report.unmatched).toBe(1)
		expect(report.verified).toBe(false)
		expect(dropped).toEqual([])
		expect(target.rows).toHaveLength(1)
	})

	it("retains the source on a verification read error (source stream)", async () => {
		const { report, dropped } = await runMigration({
			sourceRows: [row({ _id: "a", body: "one" })],
			sourceExtra: { findError: new Error("connection reset by peer") },
		})
		expect(report.uncertain).toMatch(/verification read failed/)
		expect(report.verified).toBe(false)
		expect(dropped).toEqual([])
	})

	it("retains the source on a verification read error (target stream)", async () => {
		const { report, dropped } = await runMigration({
			sourceRows: [row({ _id: "a", body: "one" })],
			targetExtra: { findError: new Error("connection reset by peer") },
		})
		// The scan count is only recorded for a completed verification: the
		// target read aborted it, so the receipt reports no count and the
		// uncertain message carries the failure.
		expect(report.scanned).toBe(0)
		expect(report.uncertain).toMatch(/verification read failed/)
		expect(report.verified).toBe(false)
		expect(dropped).toEqual([])
	})

	it("fails closed when a raw cursor yields a non-buffer row", async () => {
		const { report, dropped } = await runMigration({
			sourceRows: [row({ _id: "a", body: "one" })],
			sourceExtra: { yieldNonBuffer: true },
		})
		expect(report.uncertain).toMatch(/instead of stored document bytes/)
		expect(report.verified).toBe(false)
		expect(dropped).toEqual([])
	})

	it("refuses unsupported shapes before any aggregate runs", async () => {
		const cases: Array<{
			source: CollectionShape
			target: CollectionShape
			reason: RegExp
		}> = [
			{
				source: { type: "timeseries", capped: false, ttlIndexes: [] },
				target: PLAIN,
				reason: /source is a timeseries collection/,
			},
			{
				source: PLAIN,
				target: { type: "view", capped: false, ttlIndexes: [] },
				reason: /target is a view collection/,
			},
			{
				source: { type: "collection", capped: true, ttlIndexes: [] },
				target: PLAIN,
				reason: /source is a capped collection/,
			},
			{
				source: PLAIN,
				target: { type: "collection", capped: true, ttlIndexes: [] },
				reason: /target is a capped collection/,
			},
			{
				source: {
					type: "collection",
					capped: false,
					ttlIndexes: ["ttl_purge"],
				},
				target: PLAIN,
				reason: /source has active TTL index\(es\) ttl_purge/,
			},
			{
				source: PLAIN,
				target: {
					type: "collection",
					capped: false,
					ttlIndexes: ["ttl_purge"],
				},
				reason: /target has active TTL index\(es\) ttl_purge/,
			},
		]
		for (const testCase of cases) {
			const { report, dropped, source, target } = await runMigration({
				sourceRows: [row({ _id: "a", body: "one" })],
				sourceShape: testCase.source,
				targetShape: testCase.target,
			})
			expect(report.unsupported).toMatch(testCase.reason)
			expect(report.verified).toBe(false)
			expect(report.dropped).toBe(false)
			expect(dropped).toEqual([])
			expect(source.aggregateCalls).toBe(0)
			expect(target.findRawCalls).toBe(0)
		}
	})
})

describe("verifyCollectionCopy digest multiset", () => {
	const makePair = (sourceRows: Row[], targetRows: Row[]) => {
		const source = behavior(sourceRows)
		const target = behavior(targetRows)
		const { db } = makeDb(
			new Map([
				[SOURCE.sourceName, source],
				[SOURCE.targetName, target],
			]),
		)
		return {
			db,
			result: verifyCollectionCopy({
				source: db.collection(SOURCE.sourceName),
				target: db.collection(SOURCE.targetName),
				batchSize: 500,
			}),
		}
	}

	it("counts duplicate identical rows as separate occurrences", async () => {
		// A plain collection cannot hold two identical rows (unique _id);
		// this exercises the multiset counting logic directly.
		const one = row({ _id: "dup", body: "same" })
		const { result } = makePair([one, { ...one }], [one])
		const verification = await result
		expect(verification.scanned).toBe(2)
		expect(verification.unmatched).toBe(1)
	})

	it("accepts extra target occurrences", async () => {
		const one = row({ _id: "dup", body: "same" })
		const { result } = makePair([one], [one, { ...one }, { ...one }])
		const verification = await result
		expect(verification.scanned).toBe(1)
		expect(verification.unmatched).toBe(0)
	})

	it("distinguishes a single flipped byte", async () => {
		const one = row({ _id: "x", v: 1 })
		const flipped = { bytes: Buffer.from(one.bytes), idHex: one.idHex }
		flipped.bytes[flipped.bytes.length - 2] ^= 0x01
		const { result } = makePair([one], [flipped])
		const verification = await result
		expect(verification.unmatched).toBe(1)
	})

	it("consumes every source occurrence when contents match exactly", async () => {
		const rows = typedRows()
		const { result } = makePair(
			rows,
			rows.map((r) => ({ ...r })),
		)
		const verification = await result
		expect(verification.scanned).toBe(rows.length)
		expect(verification.unmatched).toBe(0)
	})
})

describe("resolveCollectionShape", () => {
	const makeShapeDb = (
		name: string,
		extra: Partial<CollectionBehavior> = {},
	) => {
		const b = behavior([], extra)
		const { db } = makeDb(new Map([[name, b]]))
		return { db, b }
	}

	it("resolves an absent collection to the plain shape without index inspection", async () => {
		const { db, b } = makeShapeDb(SOURCE.targetName)
		const shape = await resolveCollectionShape({
			db,
			name: SOURCE.targetName,
			info: undefined,
		})
		expect(shape).toEqual({ type: undefined, capped: false, ttlIndexes: [] })
		expect(b.listIndexesCalls).toBe(0)
	})

	it("collects active TTL index names (expireAfterSeconds present, including 0)", async () => {
		const { db } = makeShapeDb(SOURCE.sourceName, {
			indexes: [
				{ name: "_id_", key: { _id: 1 } },
				{ name: "purge_at", key: { purgeAt: 1 }, expireAfterSeconds: 3600 },
				{ name: "zero_ttl", key: { t: 1 }, expireAfterSeconds: 0 },
			],
		})
		const shape = await resolveCollectionShape({
			db,
			name: SOURCE.sourceName,
			info: { name: SOURCE.sourceName, type: "collection" },
		})
		expect(shape).toEqual({
			type: "collection",
			capped: false,
			ttlIndexes: ["purge_at", "zero_ttl"],
		})
	})

	it("marks capped collections from listCollections options", async () => {
		const { db } = makeShapeDb(SOURCE.sourceName)
		const shape = await resolveCollectionShape({
			db,
			name: SOURCE.sourceName,
			info: {
				name: SOURCE.sourceName,
				type: "collection",
				options: { capped: true, size: 4096 },
			},
		})
		expect(shape.capped).toBe(true)
		expect(shape.ttlIndexes).toEqual([])
	})

	it("skips index inspection for views and time-series (type gate first)", async () => {
		for (const type of ["view", "timeseries"]) {
			const { db, b } = makeShapeDb(SOURCE.sourceName)
			const shape = await resolveCollectionShape({
				db,
				name: SOURCE.sourceName,
				info: { name: SOURCE.sourceName, type },
			})
			expect(shape.type).toBe(type)
			expect(shape.ttlIndexes).toEqual([])
			expect(b.listIndexesCalls).toBe(0)
		}
	})

	it("fails closed when index inspection errors", async () => {
		const { db } = makeShapeDb(SOURCE.sourceName, {
			listIndexesError: new Error("index inspection failed"),
		})
		await expect(
			resolveCollectionShape({
				db,
				name: SOURCE.sourceName,
				info: { name: SOURCE.sourceName, type: "collection" },
			}),
		).rejects.toThrow(/index inspection failed/)
	})
})

describe("unsupportedShapeReason", () => {
	it("accepts plain shapes and absent collections", () => {
		expect(unsupportedShapeReason(PLAIN, PLAIN)).toBeUndefined()
		expect(
			unsupportedShapeReason(
				{ type: undefined, capped: false, ttlIndexes: [] },
				{ type: undefined, capped: false, ttlIndexes: [] },
			),
		).toBeUndefined()
	})

	it("rejects view and time-series shapes on either side", () => {
		expect(
			unsupportedShapeReason(
				{ type: "timeseries", capped: false, ttlIndexes: [] },
				PLAIN,
			),
		).toMatch(/source is a timeseries/)
		expect(
			unsupportedShapeReason(PLAIN, {
				type: "view",
				capped: false,
				ttlIndexes: [],
			}),
		).toMatch(/target is a view/)
	})

	it("rejects capped collections on either side", () => {
		expect(
			unsupportedShapeReason(
				{ type: "collection", capped: true, ttlIndexes: [] },
				PLAIN,
			),
		).toMatch(/source is a capped collection/)
		expect(
			unsupportedShapeReason(PLAIN, {
				type: "collection",
				capped: true,
				ttlIndexes: [],
			}),
		).toMatch(/target is a capped collection/)
	})

	it("rejects active TTL indexes naming the indexes and the intermediate guard", () => {
		expect(
			unsupportedShapeReason(
				{ type: "collection", capped: false, ttlIndexes: ["purge_at"] },
				PLAIN,
			),
		).toMatch(/source has active TTL index\(es\) purge_at.*intermediate guard/)
		expect(
			unsupportedShapeReason(PLAIN, {
				type: "collection",
				capped: false,
				ttlIndexes: ["purge_at"],
			}),
		).toMatch(/target has active TTL index\(es\) purge_at.*intermediate guard/)
	})

	it("prefers the type message when several unsupported properties combine", () => {
		expect(
			unsupportedShapeReason(
				{ type: "timeseries", capped: true, ttlIndexes: ["ttl"] },
				PLAIN,
			),
		).toMatch(/source is a timeseries/)
	})
})

/**
 * W16 ledger-discovery oracle. The defect: discovery's suffix list omitted
 * memory_cost_ledger even though the schema initializer creates it
 * (C-017), so `shared_alice_memory_cost_ledger` was invisible to the CLI.
 *
 * The expected discovery set is obtained from the actual schema
 * initialization path: the real ensureCollections runs against a
 * recording mock Db, and every name it passes to createCollection must be
 * discoverable. Nothing here copies BASE_COLLECTIONS or the initializer's
 * `needed` list into the test — the mock records what the implementation
 * asks for, so an initializer change that discovery does not cover fails
 * this test. The two length counts are drift tripwires pinning today's
 * initializer output size (28 plain + 2 ordinary diagnostics, plus
 * memory_evidence when the mirror gate is on); they catch silent
 * shrinkage, which per-name coverage alone would miss.
 */
describe("discoverSources vs the real schema initializer", () => {
	type RecordedCreate = { name: string; options: unknown }

	// Mock Db surface for ensureCollections: listCollections in both forms
	// the current initializer uses — the unfiltered chainable map/toArray
	// listing, and the W13 filtered listCollections({ name }, { nameOnly:
	// false }).toArray() lookup — plus the collection handles through which
	// ensureOrdinaryDiagnosticCollection reads indexes (listIndexes) and
	// installs the diagnostic TTL policy (createIndex), admin().command
	// (buildInfo version gate), createCollection (the recorded call), and
	// command (collMod in ensureSchemaValidation). Collections this mock
	// creates are all ordinary, matching the accepted W13 initializer:
	// fresh diagnostic sinks are ordinary collections with a TTL index on
	// `ts`, not time-series.
	const makeRecordingDb = () => {
		const existing: string[] = []
		const created: RecordedCreate[] = []
		const indexes = new Map<
			string,
			Array<{
				key: Record<string, number>
				expireAfterSeconds?: number
			}>
		>()
		const visible = (filter?: { name?: string }) =>
			filter?.name === undefined
				? existing
				: existing.filter((n) => n === filter.name)
		const db = {
			listCollections: (filter?: { name?: string }) => ({
				map: (f: (c: { name: string }) => string) => ({
					toArray: async () => visible(filter).map((n) => f({ name: n })),
				}),
				toArray: async () =>
					visible(filter).map((name) => ({ name, type: "collection" })),
			}),
			admin: () => ({
				command: async () => ({ versionArray: [8, 1, 0, 0] }),
			}),
			createCollection: async (name: string, options?: unknown) => {
				created.push({ name, options })
				existing.push(name)
				return {}
			},
			collection: (name: string) => ({
				listIndexes: () => ({
					toArray: async () => indexes.get(name) ?? [],
				}),
				createIndex: async (
					key: Record<string, number>,
					options?: { expireAfterSeconds?: number },
				) => {
					const list = indexes.get(name) ?? []
					list.push({ key, expireAfterSeconds: options?.expireAfterSeconds })
					indexes.set(name, list)
					return `${Object.keys(key).join("_")}_1`
				},
			}),
			command: async () => ({ ok: 1 }),
		}
		return { db: db as unknown as Db, created }
	}

	const recordInitializerBases = async (
		evidenceMirror: boolean,
	): Promise<string[]> => {
		const previous = process.env.MEMONGO_EVIDENCE_MIRROR_MODE
		if (evidenceMirror) {
			process.env.MEMONGO_EVIDENCE_MIRROR_MODE = "enabled"
		} else {
			delete process.env.MEMONGO_EVIDENCE_MIRROR_MODE
		}
		try {
			const { db, created } = makeRecordingDb()
			await ensureCollections(db, "probe_")
			return created.map((c) => c.name.slice("probe_".length))
		} finally {
			if (previous === undefined) {
				delete process.env.MEMONGO_EVIDENCE_MIRROR_MODE
			} else {
				process.env.MEMONGO_EVIDENCE_MIRROR_MODE = previous
			}
		}
	}

	it("the real initializer persists the cost ledger (defect pin, derived not restated)", async () => {
		const bases = await recordInitializerBases(false)
		expect(bases).toContain("memory_cost_ledger")
	})

	it("discovers every collection the real initializer creates, for every agent", async () => {
		const bases = await recordInitializerBases(false)
		// Drift tripwire (see the describe header): today's initializer
		// creates 28 plain collections + 2 ordinary diagnostics (W13
		// routes fresh diagnostic sinks to ordinary collections).
		expect(bases).toHaveLength(30)
		const agents = ["alice", "bob"]
		const names = bases.flatMap((base) => [
			...agents.map((agent) => `probe_${agent}_${base}`),
			// The already-shared target exists alongside the sources and must
			// never itself be discovered as one.
			`probe_${base}`,
		])
		const sources = discoverSources(names, "probe_", null)
		const bySourceName = new Map(sources.map((s) => [s.sourceName, s]))
		for (const base of bases) {
			for (const agent of agents) {
				const sourceName = `probe_${agent}_${base}`
				const source = bySourceName.get(sourceName)
				expect(
					source,
					`${sourceName} (created by the real initializer) must be discoverable`,
				).toBeDefined()
				expect(source?.agentId).toBe(agent)
				expect(source?.base).toBe(base)
				expect(source?.targetName).toBe(`probe_${base}`)
			}
			expect(bySourceName.has(`probe_${base}`)).toBe(false)
		}
		// Exactly the per-agent sources are discovered — nothing more. The
		// diagnostics collections are discovered too; the shape gate, not
		// discovery, owns refusing them at migration time (their active
		// TTL index, since W13 made fresh sinks ordinary).
		expect(sources).toHaveLength(bases.length * agents.length)
	})

	it("discovers the cost ledger for a filtered agent and excludes other agents", () => {
		const sources = discoverSources(
			[
				"probe_alice_memory_cost_ledger",
				"probe_bob_memory_cost_ledger",
				"probe_memory_cost_ledger",
			],
			"probe_",
			new Set(["alice"]),
		)
		expect(sources).toEqual([
			{
				agentId: "alice",
				base: "memory_cost_ledger",
				sourceName: "probe_alice_memory_cost_ledger",
				targetName: "probe_memory_cost_ledger",
			},
		])
	})

	it("handles the feature-gated memory_evidence explicitly, gate off and gate on", async () => {
		const gateOff = await recordInitializerBases(false)
		expect(gateOff).not.toContain("memory_evidence")
		const gateOn = await recordInitializerBases(true)
		expect(gateOn).toContain("memory_evidence")
		// Drift tripwire: 30 default + memory_evidence.
		expect(gateOn).toHaveLength(31)
		// Deliberate discover-if-present: a mirror-enabled deployment's
		// per-agent evidence collections are discovered even though a
		// default deployment's initializer never creates the shared one.
		const discovered = discoverSources(
			["probe_alice_memory_evidence", "probe_memory_evidence"],
			"probe_",
			null,
		)
		expect(discovered).toEqual([
			{
				agentId: "alice",
				base: "memory_evidence",
				sourceName: "probe_alice_memory_evidence",
				targetName: "probe_memory_evidence",
			},
		])
	})

	it("ignores collections outside the initialized product set", () => {
		expect(
			discoverSources(
				[
					"probe_alice_not_a_product",
					"probe_stray",
					"otherprefix_events",
					"memory_cost_ledger",
				],
				"probe_",
				null,
			),
		).toEqual([])
	})
})

describe("migrate-to-shared-prefix process surface (serverless)", () => {
	// The repo pins Bun 1.4.2 (root package.json packageManager). Where the
	// PATH Bun differs from the pin and cannot import the CLI's mongodb
	// dependency, export BUN_BIN with the pinned binary's absolute path
	// (the public migration guide's convention).
	const bunBin = process.env.BUN_BIN ?? "bun"

	const script = fileURLToPath(
		new URL("./migrate-to-shared-prefix.ts", import.meta.url),
	)

	// The child environment never inherits an ambient MEMONGO_MONGODB_URI:
	// each case sets exactly the URI surface it exercises.
	const baseEnv = Object.fromEntries(
		Object.entries(process.env).filter(
			([key]) => key !== "MEMONGO_MONGODB_URI",
		),
	) as NodeJS.ProcessEnv

	function runCli(uri: string | undefined) {
		const result = spawnSync(bunBin, [script], {
			env: {
				...baseEnv,
				...(uri === undefined ? {} : { MEMONGO_MONGODB_URI: uri }),
			},
			encoding: "utf8",
			// External timeout: a hung CLI run must not hang the suite.
			timeout: 60_000,
		})
		return {
			status: result.status,
			signal: result.signal,
			stdout: result.stdout ?? "",
			stderr: result.stderr ?? "",
		}
	}

	/**
	 * The public non-echo contract: neither channel may carry the URI value,
	 * its userinfo fragment, or any standalone credential fragment (raw or
	 * percent-encoded), no matter which layer produced the failure.
	 */
	function expectNoCredentialEcho(
		result: { stdout: string; stderr: string },
		uri: string,
		fragments: string[],
	) {
		const schemeAt = uri.indexOf("://")
		const userinfo = uri.includes("@")
			? uri.slice(schemeAt + 3, uri.indexOf("@") + 1)
			: ""
		for (const channel of [result.stdout, result.stderr]) {
			expect(channel).not.toContain(uri)
			if (userinfo !== "") expect(channel).not.toContain(userinfo)
			for (const fragment of fragments) {
				expect(channel).not.toContain(fragment)
			}
		}
	}

	it("never echoes a URI whose host list is empty", () => {
		const uri = "mongodb://synthetic-w16-user:synthetic-w16-password@"
		const result = runCli(uri)
		expect(result.status).toBe(1)
		expectNoCredentialEcho(result, uri, [])
	}, 60_000)

	it("never echoes a URI with an empty host and an encoded password", () => {
		const uri = "mongodb://synthetic-w16-user:synthetic%40w16%2Fpassword@"
		const result = runCli(uri)
		expect(result.status).toBe(1)
		expectNoCredentialEcho(result, uri, ["synthetic@w16/password"])
	}, 60_000)

	it("never echoes a standalone username with unescaped characters", () => {
		const uri = "mongodb://syn/user:synthetic-w16-password@127.0.0.1:1"
		const result = runCli(uri)
		expect(result.status).toBe(1)
		// The parser failure quotes only the offending username, not the
		// whole URI, so the fragment list carries it explicitly.
		expectNoCredentialEcho(result, uri, ["syn/user"])
	}, 60_000)

	it("never echoes a URI with whitespace in the password and an empty host", () => {
		const uri = "mongodb://synthetic-w16-user:synthetic w16-password@"
		const result = runCli(uri)
		expect(result.status).toBe(1)
		expectNoCredentialEcho(result, uri, [])
	}, 60_000)

	it("prints a single-line failure when MEMONGO_MONGODB_URI is missing", () => {
		const result = runCli(undefined)
		expect(result.status).toBe(1)
		const combined = `${result.stdout}\n${result.stderr}`
		expect(combined).toContain("MEMONGO_MONGODB_URI is required")
		// A guarded entry renders one prefixed line — never a raw dump: no
		// stack frames, no source code frames, no file positions.
		expect(combined).not.toMatch(/^\s*at /m)
		expect(combined).not.toMatch(/:\d+:\d+/)
		expect(combined).not.toContain("throw new Error")
	}, 60_000)

	it("still surfaces credential-free host diagnostics on a refused connection", () => {
		const uri =
			"mongodb://holduser:holdpass@127.0.0.1:1/?directConnection=true&serverSelectionTimeoutMS=2000&connectTimeoutMS=2000"
		const result = runCli(uri)
		expect(result.status).toBe(1)
		expectNoCredentialEcho(result, uri, [])
		// Redaction must not swallow the host-only diagnostic.
		expect(`${result.stdout}\n${result.stderr}`).toContain("ECONNREFUSED")
	}, 60_000)
})

/**
 * Receipt-error rendering: the credential-safe funnel behind every
 * migration receipt (errorMessage -> static parse diagnostic or
 * scrubMessage). Synthetic URIs only; the in-memory mock Db means no
 * database and no network. Every case that needs MEMONGO_MONGODB_URI
 * sets it through withEnvUri, which restores the prior value (the
 * restoration contract is pinned by the final test).
 */
describe("migrate-to-shared-prefix receipt error rendering", () => {
	const withEnvUri = async <T>(
		uri: string | undefined,
		fn: () => Promise<T>,
	) => {
		const previous = process.env.MEMONGO_MONGODB_URI
		if (uri === undefined) {
			delete process.env.MEMONGO_MONGODB_URI
		} else {
			process.env.MEMONGO_MONGODB_URI = uri
		}
		try {
			return await fn()
		} finally {
			if (previous === undefined) {
				delete process.env.MEMONGO_MONGODB_URI
			} else {
				process.env.MEMONGO_MONGODB_URI = previous
			}
		}
	}

	// Exact env-URI layer: the URI rides the message UNQUOTED, so the
	// quoted-shape regex cannot mask a broken exact-match replacement.
	const ENV_URI =
		"mongodb://receipt-user-xyz:receipt-pass-xyz@receipt-host-xyz.example:27017/"

	it("removes the exact env URI from a copy receipt when the message carries it unquoted", async () => {
		const { report, dropped } = await withEnvUri(ENV_URI, () =>
			runMigration({
				sourceRows: [row({ _id: "a", body: "one" })],
				sourceExtra: {
					mergeError: new Error(
						`merge aborted mid-batch: ${ENV_URI} (pool cycle detected)`,
					),
				},
			}),
		)
		expect(report.uncertain).toMatch(/copy aggregate outcome unknown/)
		expect(report.uncertain).toContain("<mongodb-uri>")
		expect(report.uncertain).not.toContain(ENV_URI)
		expect(report.uncertain).not.toContain("receipt-user-xyz:receipt-pass-xyz@")
		expect(report.verified).toBe(false)
		expect(report.dropped).toBe(false)
		expect(dropped).toEqual([])
	})

	it("removes the exact env URI from a verification receipt when the message carries it unquoted", async () => {
		const { report, dropped } = await withEnvUri(ENV_URI, () =>
			runMigration({
				sourceRows: [row({ _id: "a", body: "one" })],
				sourceExtra: {
					findError: new Error(
						`cursor died: ${ENV_URI} (connection interrupted)`,
					),
				},
			}),
		)
		expect(report.uncertain).toMatch(/verification read failed/)
		expect(report.uncertain).toContain("<mongodb-uri>")
		expect(report.uncertain).not.toContain(ENV_URI)
		expect(report.uncertain).not.toContain("receipt-user-xyz:receipt-pass-xyz@")
		expect(report.verified).toBe(false)
		expect(report.dropped).toBe(false)
		expect(dropped).toEqual([])
	})

	it("removes a quoted mongodb URI that differs from the env value", async () => {
		const envUri = "mongodb://env-user-aa:env-pass-aa@env-host-aa.example/"
		const messageUri =
			"mongodb://msg-user-bb:msg-pass-bb@msg-host-bb.example/?tls=true"
		const { report, dropped } = await withEnvUri(envUri, () =>
			runMigration({
				sourceRows: [row({ _id: "a", body: "one" })],
				sourceExtra: {
					mergeError: new Error(
						`topology ping rejected "${messageUri}" after 3 attempts`,
					),
				},
			}),
		)
		// The env value never appears in the message, so only the
		// quoted-shape layer can have removed the message URI.
		expect(report.uncertain).toContain("<mongodb-uri>")
		expect(report.uncertain).not.toContain(messageUri)
		expect(report.uncertain).not.toContain("msg-user-bb:msg-pass-bb@")
		expect(report.verified).toBe(false)
		expect(dropped).toEqual([])
	})

	it("removes quoted mongodb and mongodb+srv URIs when the env URI is absent", async () => {
		const { report, dropped } = await withEnvUri(undefined, () =>
			runMigration({
				sourceRows: [row({ _id: "a", body: "one" })],
				sourceExtra: {
					mergeError: new Error(
						'resolve rejected "mongodb+srv://alt-user-cc:alt-pass-cc@rs-cc.example/" and "mongodb://alt2-user-dd:alt2-pass-dd@host-dd.example/" before connect',
					),
				},
			}),
		)
		const replacements = report.uncertain?.match(/<mongodb-uri>/g) ?? []
		expect(replacements).toHaveLength(2)
		expect(report.uncertain).not.toContain("alt-user-cc:alt-pass-cc@")
		expect(report.uncertain).not.toContain("alt2-user-dd:alt2-pass-dd@")
		expect(report.uncertain).not.toContain("mongodb://")
		expect(report.uncertain).not.toContain("mongodb+srv://")
		expect(report.verified).toBe(false)
		expect(dropped).toEqual([])
	})

	it("renders the static parse-failure diagnostic for MongoParseError-named receipt errors", async () => {
		const parseError = new Error(
			"parse failed near mongodb://parse-user-ee:parse-pass-ee@parse-host-ee.example/ (unquoted)",
		)
		parseError.name = "MongoParseError"
		const { report, dropped } = await withEnvUri(undefined, () =>
			runMigration({
				sourceRows: [row({ _id: "a", body: "one" })],
				sourceExtra: { mergeError: parseError },
			}),
		)
		expect(report.uncertain).toContain(
			"MEMONGO_MONGODB_URI is not a valid MongoDB connection string (MongoParseError); the value is never echoed",
		)
		expect(report.uncertain).not.toContain("parse-user-ee")
		expect(report.uncertain).not.toContain("mongodb://")
		expect(report.verified).toBe(false)
		expect(dropped).toEqual([])
	})

	it("scrubs before truncating: a URI straddling the 300-char cap is fully replaced and a past-cap suffix survives", async () => {
		// 92-char URI whose credentials straddle the 300-char cutoff: the
		// scheme and username start before char 300 and the password and
		// host run past it, so truncating first would retain
		// `mongodb://straddle-u` and drop the suffix entirely.
		const straddleUri =
			"mongodb://straddle-user-abcdef:straddle-pass-12345678@straddle-host.example:27017/straddledb"
		const message =
			"x".repeat(280) +
			straddleUri +
			"; RETRY_POLICY_DECISION=deferred; consult server logs"
		const { report, dropped } = await withEnvUri(straddleUri, () =>
			runMigration({
				sourceRows: [row({ _id: "a", body: "one" })],
				sourceExtra: { mergeError: new Error(message) },
			}),
		)
		expect(report.uncertain).toContain("<mongodb-uri>")
		// This suffix fragment sits past raw char 300: it can only be
		// present if the replacement shrank the message before the cap.
		expect(report.uncertain).toContain("; RETR")
		expect(report.uncertain).not.toContain("straddle")
		expect(report.uncertain).not.toContain("mongodb://")
		// Order discriminator: the capped, scrubbed text ends 7 chars into
		// the suffix (slice(0, 300) + ellipsis), never inside the URI.
		expect(report.uncertain?.endsWith("<mongodb-uri>; RETRY…")).toBe(true)
		expect(report.verified).toBe(false)
		expect(dropped).toEqual([])
	})

	it("restores MEMONGO_MONGODB_URI after each receipt-error case", async () => {
		const sentinel =
			"mongodb://restore-sentinel-user:restore-sentinel-pass@restore.example/"
		process.env.MEMONGO_MONGODB_URI = sentinel
		await withEnvUri("mongodb://temporary.example/", () => {
			expect(process.env.MEMONGO_MONGODB_URI).toBe(
				"mongodb://temporary.example/",
			)
			return Promise.resolve()
		})
		expect(process.env.MEMONGO_MONGODB_URI).toBe(sentinel)
		await withEnvUri(undefined, () => {
			expect(process.env.MEMONGO_MONGODB_URI).toBeUndefined()
			return Promise.resolve()
		})
		expect(process.env.MEMONGO_MONGODB_URI).toBe(sentinel)
		delete process.env.MEMONGO_MONGODB_URI
		await withEnvUri("mongodb://temporary.example/", () => {
			expect(process.env.MEMONGO_MONGODB_URI).toBe(
				"mongodb://temporary.example/",
			)
			return Promise.resolve()
		})
		expect(process.env.MEMONGO_MONGODB_URI).toBeUndefined()
	})
})
