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
import { invalidateContradictedFacts } from "./mongodb-contradiction.js"
import { promoteDerivedMemoryFromEvent } from "./mongodb-derived-memory.js"
import type { EnrichmentProvider } from "./mongodb-llm-enrichment.js"
import { resolveEnrichmentProvider } from "./mongodb-llm-enrichment.js"
import {
	ensureCollections,
	ensureStandardIndexes,
	structuredMemCollection,
} from "./mongodb-schema.js"
import { writeStructuredMemory } from "./mongodb-structured-memory.js"
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

// Deterministic tenant-isolation regression (Mongo only, no live LLM): a mock
// provider flags EVERY candidate it is shown as contradicted, so if the
// candidate query ever reached another tenant's fact it would be wrongly
// invalidated. This locks the #31-class cross-tenant guarantee for #33.
describe("contradiction invalidation tenant isolation (live Mongo, mocked LLM)", () => {
	const ISO_DB = `memongo_contra_iso_${randomUUID().slice(0, 8)}`
	const ISO_PREFIX = "shared_"
	const ISO_AGENT = `agent-${randomUUID().slice(0, 8)}`
	let isoClient: MongoClient
	let isoDb: Db

	// Flags every existing fact key present in the prompt as contradicted.
	const flagEverythingProvider: EnrichmentProvider = {
		name: "mock-flag-all",
		chatCompletion: async ({ messages }) => {
			const userMsg = messages.find((m) => m.role === "user")?.content ?? ""
			const keys = [...userMsg.matchAll(/key=(\S+):/g)].map((m) => m[1])
			return {
				content: JSON.stringify({
					contradictions: keys.map((key) => ({ key, rationale: "mock" })),
				}),
			}
		},
	}

	beforeAll(async () => {
		isoClient = new MongoClient(TEST_URI)
		await isoClient.connect()
		isoDb = isoClient.db(ISO_DB)
		await ensureCollections(isoDb, ISO_PREFIX)
		await ensureStandardIndexes(isoDb, ISO_PREFIX)

		// Same agent, two DIFFERENT scopeRefs (two tenants sharing a collection).
		for (const ref of ["user:alice", "user:bob"]) {
			await writeStructuredMemory({
				db: isoDb,
				prefix: ISO_PREFIX,
				embeddingMode: "automated",
				entry: {
					type: "fact",
					key: "fact-berlin",
					value: "The user lives in Berlin.",
					agentId: ISO_AGENT,
					scope: "user",
					scopeRef: ref,
				},
			})
		}
	}, 60000)

	afterAll(async () => {
		await isoDb?.dropDatabase().catch(() => {})
		await isoClient?.close()
	})

	it("only invalidates the contradicted fact within the acting tenant", async () => {
		const invalidated = await invalidateContradictedFacts({
			db: isoDb,
			prefix: ISO_PREFIX,
			provider: flagEverythingProvider,
			model: "mock",
			agentId: ISO_AGENT,
			scope: "user",
			scopeRef: "user:alice",
			newFacts: [{ key: "fact-london", value: "The user lives in London." }],
		})
		expect(invalidated).toBe(1)

		const alice = await structuredMemCollection(isoDb, ISO_PREFIX).findOne({
			agentId: ISO_AGENT,
			scopeRef: "user:alice",
			key: "fact-berlin",
		})
		const bob = await structuredMemCollection(isoDb, ISO_PREFIX).findOne({
			agentId: ISO_AGENT,
			scopeRef: "user:bob",
			key: "fact-berlin",
		})
		// Acting tenant's fact is expired; the sibling tenant's identical fact is
		// completely untouched.
		expect(alice?.state).toBe("invalidated")
		expect(bob?.state).toBe("active")
	})
})
