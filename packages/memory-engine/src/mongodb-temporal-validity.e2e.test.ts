/**
 * Bi-temporal valid-time proof (issue #32).
 *
 * Proves the two invariants that make bi-temporality real, against a live
 * MongoDB (not a mock):
 *   1. A structured write persists the supplied event/valid-time as `validFrom`,
 *      NOT the write clock — so ingesting a 2020 fact in 2026 records 2020.
 *   2. An "as of T" query (buildCurrentValidityClause, the same predicate the
 *      production read paths use) returns only facts believed valid at T:
 *      a fact is excluded before its validFrom and after its validTo.
 *
 * Run: bun run --filter @memongo/memory-engine test:e2e
 */
import { randomUUID } from "node:crypto"
import { type Db, MongoClient } from "mongodb"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { writeStructuredMemory } from "./mongodb-structured-memory.js"
import {
	ensureCollections,
	ensureStandardIndexes,
	structuredMemCollection,
} from "./mongodb-schema.js"
import { buildCurrentValidityClause } from "./mongodb-temporal.js"
import { resolvePreviewMongoTestUri } from "./test-helpers/preview-env.js"

const TEST_URI = resolvePreviewMongoTestUri(
	"mongodb://127.0.0.1:27019/?directConnection=true",
)
const TEST_DB = `memongo_temporal_${randomUUID().slice(0, 8)}`
const PREFIX = "temporal_"
const AGENT = `agent-${randomUUID().slice(0, 8)}`
const SCOPE = "agent" as const
const SCOPE_REF = `agent:${AGENT}`

// The write happens "now" (2026) but the fact was true starting in 2020.
const VALID_FROM_PAST = new Date("2020-01-01T00:00:00.000Z")
const VALID_TO = new Date("2022-01-01T00:00:00.000Z")

let client: MongoClient
let db: Db

async function asOfKeys(asOf: Date): Promise<string[]> {
	const filter = {
		agentId: AGENT,
		scope: SCOPE,
		scopeRef: SCOPE_REF,
		...buildCurrentValidityClause({ asOf }),
	}
	const rows = await structuredMemCollection(db, PREFIX)
		.find(filter, { projection: { key: 1, _id: 0 } })
		.toArray()
	return rows.map((r) => String(r.key))
}

describe("bi-temporal valid-time (live MongoDB)", () => {
	beforeAll(async () => {
		client = new MongoClient(TEST_URI)
		await client.connect()
		db = client.db(TEST_DB)
		await ensureCollections(db, PREFIX)
		await ensureStandardIndexes(db, PREFIX)

		// Open-ended fact valid since 2020.
		await writeStructuredMemory({
			db,
			prefix: PREFIX,
			embeddingMode: "automated",
			entry: {
				type: "fact",
				key: "fact-open",
				value: "The user has used MongoDB since 2020.",
				agentId: AGENT,
				scope: SCOPE,
				scopeRef: SCOPE_REF,
				validFrom: VALID_FROM_PAST,
			},
		})

		// Closed-window fact: valid 2020 → 2022 only.
		await writeStructuredMemory({
			db,
			prefix: PREFIX,
			embeddingMode: "automated",
			entry: {
				type: "fact",
				key: "fact-closed",
				value: "The user lived in Berlin.",
				agentId: AGENT,
				scope: SCOPE,
				scopeRef: SCOPE_REF,
				validFrom: VALID_FROM_PAST,
				validTo: VALID_TO,
			},
		})
	})

	afterAll(async () => {
		await db?.dropDatabase().catch(() => {})
		await client?.close()
	})

	it("persists the supplied valid-time, not the write clock", async () => {
		const doc = await structuredMemCollection(db, PREFIX).findOne({
			agentId: AGENT,
			key: "fact-open",
		})
		expect(doc?.validFrom).toBeInstanceOf(Date)
		expect((doc?.validFrom as Date).toISOString()).toBe(
			VALID_FROM_PAST.toISOString(),
		)
		// Sanity: the ingestion clock is far in the future of the valid-time,
		// proving the two are distinct.
		expect((doc?.updatedAt as Date).getTime()).toBeGreaterThan(
			VALID_FROM_PAST.getTime(),
		)
	})

	it("excludes a fact before its validFrom", async () => {
		const keys = await asOfKeys(new Date("2019-06-01T00:00:00.000Z"))
		expect(keys).not.toContain("fact-open")
		expect(keys).not.toContain("fact-closed")
	})

	it("includes both facts within their validity windows", async () => {
		const keys = await asOfKeys(new Date("2021-06-01T00:00:00.000Z"))
		expect(keys).toContain("fact-open")
		expect(keys).toContain("fact-closed")
	})

	it("excludes a superseded fact after its validTo but keeps the open one", async () => {
		const keys = await asOfKeys(new Date("2023-06-01T00:00:00.000Z"))
		expect(keys).toContain("fact-open")
		expect(keys).not.toContain("fact-closed")
	})
})
