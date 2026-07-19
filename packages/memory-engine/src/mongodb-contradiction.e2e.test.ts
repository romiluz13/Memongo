/**
 * Contradiction-driven invalidation proof (issue #33).
 *
 * Exercises the full path against live MongoDB + a live LLM: a fact is promoted,
 * then a later contradicting fact is promoted; the stale fact must be expired
 * (state "invalidated", validTo set, invalidatedBy.reason "contradiction") and
 * excluded from an "as of now" recall. Skipped unless a provider is configured.
 *
 * Run (from packages/memory-engine):
 *   MEMONGO_ENRICHMENT_API_KEY=... MEMONGO_ENRICHMENT_BASE_URL=... \
 *   MEMONGO_ENRICHMENT_MODEL=... MEMONGO_ENRICHMENT_AUTH_STYLE=api-key \
 *   MEMONGO_ENRICHMENT_PROVIDER=openai-compatible \
 *   vitest run src/mongodb-contradiction.e2e.test.ts --testTimeout=240000
 */
import { randomUUID } from "node:crypto"
import { type Db, MongoClient } from "mongodb"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { promoteDerivedMemoryFromEvent } from "./mongodb-derived-memory.js"
import { resolveEnrichmentProvider } from "./mongodb-llm-enrichment.js"
import {
	ensureCollections,
	ensureStandardIndexes,
	structuredMemCollection,
} from "./mongodb-schema.js"
import { buildCurrentValidityClause } from "./mongodb-temporal.js"

const provider = (() => {
	try {
		return resolveEnrichmentProvider(process.env)
	} catch {
		return null
	}
})()
const model = process.env.MEMONGO_ENRICHMENT_MODEL?.trim() ?? ""

const TEST_URI = process.env.MEMONGO_TEST_MONGODB_URI?.trim()
	? process.env.MEMONGO_TEST_MONGODB_URI.trim()
	: "mongodb://127.0.0.1:27019/?directConnection=true"
const TEST_DB = `memongo_contradiction_${randomUUID().slice(0, 8)}`
const PREFIX = "contra_"
const AGENT = `agent-${randomUUID().slice(0, 8)}`
const SCOPE_REF = `agent:${AGENT}`

let client: MongoClient
let db: Db

async function activeAsOfNow(): Promise<Array<{ key: string; value: string }>> {
	const filter = {
		agentId: AGENT,
		scope: "agent",
		scopeRef: SCOPE_REF,
		state: "active",
		...buildCurrentValidityClause({ asOf: new Date() }),
	}
	const rows = await structuredMemCollection(db, PREFIX)
		.find(filter, { projection: { key: 1, value: 1, _id: 0 } })
		.toArray()
	return rows.map((r) => ({ key: String(r.key), value: String(r.value ?? "") }))
}

async function promote(eventId: string, body: string, when: Date) {
	await promoteDerivedMemoryFromEvent({
		db,
		prefix: PREFIX,
		embeddingMode: "automated",
		provider,
		model,
		event: {
			eventId,
			agentId: AGENT,
			role: "user",
			body,
			timestamp: when,
			scope: "agent",
			scopeRef: SCOPE_REF,
		},
	})
}

describe.skipIf(!provider)(
	"contradiction-driven invalidation (live Mongo + LLM)",
	() => {
		beforeAll(async () => {
			client = new MongoClient(TEST_URI)
			await client.connect()
			db = client.db(TEST_DB)
			await ensureCollections(db, PREFIX)
			await ensureStandardIndexes(db, PREFIX)

			await promote(
				`evt-a-${randomUUID().slice(0, 8)}`,
				"Remember: The user lives in Berlin.",
				new Date("2023-01-01T00:00:00.000Z"),
			)
			await promote(
				`evt-b-${randomUUID().slice(0, 8)}`,
				"Remember: The user moved to London and no longer lives in Berlin.",
				new Date("2026-01-01T00:00:00.000Z"),
			)
		}, 240000)

		afterAll(async () => {
			await db?.dropDatabase().catch(() => {})
			await client?.close()
		})

		it("expires the contradicted fact with contradiction provenance", async () => {
			const berlin = await structuredMemCollection(db, PREFIX).findOne({
				agentId: AGENT,
				value: "The user lives in Berlin.",
			})
			expect(berlin).toBeTruthy()
			console.log(
				"berlin fact ->",
				JSON.stringify({
					state: berlin?.state,
					validTo: berlin?.validTo,
					invalidatedBy: berlin?.invalidatedBy,
				}),
			)
			expect(berlin?.state).toBe("invalidated")
			expect(berlin?.validTo).toBeInstanceOf(Date)
			expect((berlin?.invalidatedBy as Record<string, unknown>)?.reason).toBe(
				"contradiction",
			)
		})

		it("excludes the stale fact from an 'as of now' recall and keeps the new one", async () => {
			const active = await activeAsOfNow()
			const values = active.map((a) => a.value.toLowerCase())
			expect(
				values.some((v) => v.includes("berlin") && !v.includes("london")),
			).toBe(false)
			expect(values.some((v) => v.includes("london"))).toBe(true)
		})
	},
)
