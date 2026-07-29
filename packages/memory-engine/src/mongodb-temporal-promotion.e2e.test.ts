/**
 * End-to-end valid-time promotion proof (issue #32).
 *
 * Exercises the FULL wired path against live MongoDB + a live LLM:
 *   event ("...since 2021") → promoteDerivedMemoryFromEvent(provider) →
 *   mergeStructuredCandidates → refineCandidatesValidTime → persist
 * and asserts the stored structured memory carries an LLM-EXTRACTED validFrom
 * (year 2021, provenance validTimeSource "extracted") rather than the write
 * clock. Skipped unless a live enrichment provider is configured.
 *
 * Run (from packages/memory-engine):
 *   MEMONGO_ENRICHMENT_API_KEY=... MEMONGO_ENRICHMENT_BASE_URL=... \
 *   MEMONGO_ENRICHMENT_MODEL=... MEMONGO_ENRICHMENT_AUTH_STYLE=api-key \
 *   MEMONGO_ENRICHMENT_PROVIDER=openai-compatible \
 *   vitest run src/mongodb-temporal-promotion.e2e.test.ts --testTimeout=180000
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
import { resolvePreviewMongoTestUri } from "./test-helpers/preview-env.js"

const provider = (() => {
	try {
		return resolveEnrichmentProvider(process.env)
	} catch {
		return null
	}
})()
const model = process.env.MEMONGO_ENRICHMENT_MODEL?.trim() ?? ""

const TEST_URI = resolvePreviewMongoTestUri(
	"mongodb://127.0.0.1:27019/?directConnection=true",
)
const TEST_DB = `memongo_temporal_promo_${randomUUID().slice(0, 8)}`
const PREFIX = "promo_"
const AGENT = `agent-${randomUUID().slice(0, 8)}`

// Ingested "now" (2026), but the fact states it has been true since 2021.
const EVENT_TIME = new Date("2026-07-19T12:00:00.000Z")

let client: MongoClient
let db: Db

describe.skipIf(!provider)("valid-time promotion (live Mongo + LLM)", () => {
	beforeAll(async () => {
		client = new MongoClient(TEST_URI)
		await client.connect()
		db = client.db(TEST_DB)
		await ensureCollections(db, PREFIX)
		await ensureStandardIndexes(db, PREFIX)

		await promoteDerivedMemoryFromEvent({
			db,
			prefix: PREFIX,
			embeddingMode: "automated",
			provider,
			model,
			event: {
				eventId: `evt-${randomUUID().slice(0, 8)}`,
				agentId: AGENT,
				role: "user",
				body: "Remember: I have used MongoDB as my primary database since 2021.",
				timestamp: EVENT_TIME,
				scope: "agent",
				scopeRef: `agent:${AGENT}`,
			},
		})
	})

	afterAll(async () => {
		await db?.dropDatabase().catch(() => {})
		await client?.close()
	})

	it("stores an LLM-extracted validFrom (2021), distinct from the 2026 write clock", async () => {
		const doc = await structuredMemCollection(db, PREFIX).findOne({
			agentId: AGENT,
			type: "fact",
		})
		expect(doc).toBeTruthy()
		console.log(
			"promoted fact ->",
			JSON.stringify({
				value: doc?.value,
				validFrom: doc?.validFrom,
				validTimeSource: (doc?.provenance as Record<string, unknown>)
					?.validTimeSource,
			}),
		)
		expect(doc?.validFrom).toBeInstanceOf(Date)
		// The headline invariant: valid-time is the extracted 2021, NOT the 2026
		// ingestion clock.
		expect((doc?.validFrom as Date).getUTCFullYear()).toBe(2021)
		expect((doc?.provenance as Record<string, unknown>)?.validTimeSource).toBe(
			"extracted",
		)
	})
})
