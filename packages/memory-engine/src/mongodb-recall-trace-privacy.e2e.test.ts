/**
 * RET-21 e2e: recall-trace query privacy against a real MongoDB with the
 * recall_traces schema validator applied. The audit's leak — Hebrew query
 * text persisted verbatim because the redaction class was ASCII-only — is
 * proven fixed at the persistence boundary, in all three privacy modes.
 *
 * Run manually (same deployment as the other e2e suites):
 *   MONGODB_TEST_URI="mongodb://admin:admin@localhost:27017/memongo?authSource=admin&replicaSet=rs0&directConnection=true" \
 *     bun run --cwd packages/memory-engine test:e2e src/mongodb-recall-trace-privacy.e2e.test.ts
 */
import { MongoClient, type Db } from "mongodb"
import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { getRecallTrace, recordRecallTrace } from "./mongodb-recall-traces.js"
import {
	ensureCollections,
	ensureSchemaValidation,
	recallTracesCollection,
} from "./mongodb-schema.js"
import { resolvePreviewMongoTestUri } from "./test-helpers/preview-env.js"

const TEST_URI = resolvePreviewMongoTestUri(
	"mongodb://admin:admin@localhost:27017/memongo?authSource=admin&replicaSet=rs0&directConnection=true",
)
const TEST_DB = "memongo_e2e_recall_privacy"
const TEST_PREFIX = "rp_"

let client: MongoClient
let db: Db

beforeAll(async () => {
	client = new MongoClient(TEST_URI, {
		serverSelectionTimeoutMS: 5_000,
		connectTimeoutMS: 5_000,
	})
	await client.connect()
	await client.db("admin").command({ ping: 1 })
	db = client.db(TEST_DB)
	await db.dropDatabase()
	await ensureCollections(db, TEST_PREFIX)
	// Apply the recall_traces validator — the relaxed schema (optional
	// query, new queryHash/scope/scopeRef) must accept every privacy mode.
	await ensureSchemaValidation(db, TEST_PREFIX)
})

afterAll(async () => {
	if (db) {
		await db.dropDatabase()
	}
	if (client) {
		await client.close()
	}
})

const HEBREW_QUERY = "סוד ההשקה של המערכת"

describe("E2E: recall-trace query privacy (RET-21)", () => {
	it("persists redacted text and a hash for a Hebrew query in redacted-hash mode", async () => {
		const traceId = await recordRecallTrace({
			db,
			prefix: TEST_PREFIX,
			privacyMode: "redacted-hash",
			trace: {
				agentId: "agent-1",
				query: HEBREW_QUERY,
				scope: "user",
				scopeRef: "user:u1",
				lanesUsed: ["hybrid"],
				totalHits: 3,
			},
		})

		const stored = await recallTracesCollection(db, TEST_PREFIX).findOne({
			traceId,
		})
		expect(stored).not.toBeNull()
		// The audit's leak: the old ASCII-only class left this verbatim.
		// Past the ASCII placeholder, no letter of the original survives.
		expect(stored?.query).toBeDefined()
		expect(String(stored?.query).replace(/x/g, "")).not.toMatch(/\p{L}/u)
		expect(String(stored?.query).length).toBeGreaterThan(0)
		expect(stored?.queryHash).toMatch(/^[a-f0-9]{64}$/)
		expect(stored?.scope).toBe("user")
		expect(stored?.scopeRef).toBe("user:u1")
	})

	it("persists no query and no hash in none mode (validator accepts the doc)", async () => {
		const traceId = await recordRecallTrace({
			db,
			prefix: TEST_PREFIX,
			privacyMode: "none",
			trace: {
				agentId: "agent-1",
				query: HEBREW_QUERY,
				lanesUsed: ["hybrid"],
				totalHits: 0,
			},
		})

		const stored = await getRecallTrace({
			db,
			prefix: TEST_PREFIX,
			traceId,
		})
		expect(stored).not.toBeNull()
		expect(stored).not.toHaveProperty("query")
		expect(stored).not.toHaveProperty("queryHash")
	})

	it("persists the verbatim query plus hash in raw mode", async () => {
		const traceId = await recordRecallTrace({
			db,
			prefix: TEST_PREFIX,
			privacyMode: "raw",
			trace: {
				agentId: "agent-1",
				query: HEBREW_QUERY,
				lanesUsed: ["hybrid"],
				totalHits: 1,
			},
		})

		const stored = await getRecallTrace({
			db,
			prefix: TEST_PREFIX,
			traceId,
		})
		expect(stored?.query).toBe(HEBREW_QUERY)
		expect(stored?.queryHash).toMatch(/^[a-f0-9]{64}$/)
	})
})
