/**
 * Real E2E Test: Memory v2 Architecture — Full Capability Validation
 *
 * Tests ALL v2 capabilities against a live MongoDB (atlas-local:preview)
 * with realistic multi-turn AI agent simulation data.
 *
 * Run: MONGODB_TEST_URI="mongodb://admin:admin@localhost:27017/memongo?authSource=admin&replicaSet=rs0&directConnection=true" \
 *      pnpm vitest run --config vitest.e2e.config.ts src/memory/real-e2e-v2.e2e.test.ts --reporter=verbose
 */

import { randomUUID } from "node:crypto"
import { MongoClient, type Db } from "mongodb"
import { describe, it, expect, beforeAll, afterAll } from "vitest"
import {
	RegexEntityExtractor,
	LLMEntityExtractor,
} from "./mongodb-entity-extractor.js"
// v2 graph
import { extractAndUpsertEntities } from "./mongodb-graph.js"
import { synthesizeProfile } from "./mongodb-profile.js"
import { rewriteQuery, expandSynonyms } from "./mongodb-query-rewriter.js"
import { crossEncoderRerank, type RerankConfig } from "./mongodb-reranker.js"
// Schema setup
import { ensureCollections, ensureStandardIndexes } from "./mongodb-schema.js"
import { resolveScopeRef } from "./mongodb-scope.js"
// Search functions (direct vector search, keyword search, hybrid)
import { vectorSearch } from "./mongodb-search.js"
import {
	hasAtlasModelKey,
	resolvePreviewMongoTestUri,
	resolvePreviewVoyageApiKey,
} from "./test-helpers/preview-env.js"
import type { MemorySearchResult } from "./types.js"

// ─── Constants ─────────────────────────────────────────────────────────────────

const TEST_URI = resolvePreviewMongoTestUri(
	"mongodb://admin:admin@localhost:27017/memongo?authSource=admin&replicaSet=rs0&directConnection=true",
)
// Isolated per run — see the note in production-readiness.e2e.test.ts. Both
// suites shared one "memongo" database and neither dropped it.
const TEST_DB = `memongo_realv2_${randomUUID().slice(0, 8)}`
const PREFIX = "memtest_"
const AGENT_ID = `agent-e2e-${randomUUID().slice(0, 8)}`
const _TEST_WINDOW_START = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
const _TEST_WINDOW_END = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
const PREVIEW_VOYAGE_API_KEY = resolvePreviewVoyageApiKey()
const AUTO_EMBED_ENABLED = hasAtlasModelKey(PREVIEW_VOYAGE_API_KEY)
const _describeAutoEmbed = AUTO_EMBED_ENABLED ? describe : describe.skip
const describeRerank =
	PREVIEW_VOYAGE_API_KEY.length > 0 ? describe : describe.skip

async function _waitForSearchIndexesReady(
	db: Db,
	{
		collectionName = `${PREFIX}chunks`,
		indexNames = [`${PREFIX}chunks_text`, `${PREFIX}chunks_vector`],
		timeoutMs = 180_000,
		pollMs = 2_000,
	}: {
		collectionName?: string
		indexNames?: string[]
		timeoutMs?: number
		pollMs?: number
	} = {},
): Promise<Array<{ name?: string; status?: string; type?: string }>> {
	const collection = db.collection(collectionName)
	const deadline = Date.now() + timeoutMs
	let lastIndexes: Array<{ name?: string; status?: string; type?: string }> = []

	while (Date.now() < deadline) {
		lastIndexes = await collection
			.aggregate([{ $listSearchIndexes: {} }])
			.toArray()

		const relevant = lastIndexes.filter((index) =>
			indexNames.includes(String(index.name ?? "")),
		)
		const ready = indexNames.every((name) =>
			relevant.some(
				(index) =>
					index.name === name &&
					String(index.status ?? "").toUpperCase() === "READY",
			),
		)
		if (ready) {
			return relevant
		}

		await new Promise((resolve) => setTimeout(resolve, pollMs))
	}

	return lastIndexes.filter((index) =>
		indexNames.includes(String(index.name ?? "")),
	)
}

async function _waitForVectorResults(
	db: Db,
	queryText: string,
	{
		maxResults = 5,
		minScore = 0.0,
		indexName = `${PREFIX}chunks_vector`,
		timeoutMs = 180_000,
		pollMs = 2_000,
	}: {
		maxResults?: number
		minScore?: number
		indexName?: string
		timeoutMs?: number
		pollMs?: number
	} = {},
): Promise<MemorySearchResult[]> {
	const chunks = db.collection(`${PREFIX}chunks`)
	const deadline = Date.now() + timeoutMs
	let lastResults: MemorySearchResult[] = []

	// atlas-local auto-embedding completes in background after ingest; poll until the
	// vector index starts returning semantic hits or the test timeout expires.
	while (Date.now() < deadline) {
		try {
			lastResults = await vectorSearch(chunks, null, {
				maxResults,
				minScore,
				indexName,
				queryText,
				embeddingMode: "automated",
			})
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err)
			if (
				message.includes("NOT_STARTED") ||
				message.includes("INITIAL_SYNC") ||
				message.includes("BUILDING")
			) {
				await new Promise((resolve) => setTimeout(resolve, pollMs))
				continue
			}
			throw err
		}
		if (lastResults.length > 0) {
			return lastResults
		}
		await new Promise((resolve) => setTimeout(resolve, pollMs))
	}

	return lastResults
}

// ─── Realistic conversation data ───────────────────────────────────────────────

// Simulates a multi-day AI coding assistant helping a developer build a startup
const _CONVERSATION_DAY1_SESSION1 = [
	// Morning: project kickoff
	{
		role: "user",
		body: "Hey, I'm @romiluz and I'm building a SaaS product called DataVault. It's a #data-pipeline tool for small teams. Can you help me architect it?",
	},
	{
		role: "assistant",
		body: "Of course! DataVault sounds like an exciting project. For a data pipeline tool targeting small teams, I'd recommend a modular architecture. Let me outline the key components:\n\n1. **Ingestion Layer** - Handle multiple data sources (APIs, databases, file uploads)\n2. **Transform Engine** - Apply user-defined transformations using a DAG model\n3. **Storage Layer** - Use a combination of object storage (S3) and a metadata database\n4. **Orchestration** - A scheduler for pipeline runs\n5. **UI Dashboard** - Real-time monitoring\n\nShould we start with the ingestion layer or the overall system design?",
	},
	{
		role: "user",
		body: "Let's start with the overall design. I want to use TypeScript for the backend, React for the frontend, and MongoDB as the main database. The project repo is at https://github.com/romiluz/datavault",
	},
	{
		role: "assistant",
		body: "Great tech stack! Here's my recommended project structure for DataVault:\n\n```\ndatavault/\n├── packages/\n│   ├── core/          # Pipeline engine, DAG execution\n│   ├── api/           # REST + WebSocket API (Express/Fastify)\n│   ├── web/           # React dashboard\n│   ├── connectors/    # Data source connectors\n│   └── shared/        # Shared types, utils\n├── docker/\n│   └── mongodb/       # Local dev MongoDB setup\n└── docs/\n    └── architecture/  # ADRs and design docs\n```\n\nFor MongoDB, I'd recommend:\n- `pipelines` collection for pipeline definitions\n- `runs` collection for execution history\n- `connectors` collection for data source configs\n- `users` collection for auth\n\nWant me to create the initial project structure?",
	},
	{
		role: "user",
		body: 'Yes! Also, I want to mention that @sarah-chen from my team will handle the frontend. She\'s really good with React and "Sarah Chen" knows the design system well. We also need to integrate with #Stripe for billing.',
	},
	{
		role: "assistant",
		body: "Got it! I'll note that Sarah Chen (@sarah-chen) owns the frontend/React dashboard, and we need Stripe billing integration. Let me set up the initial structure...\n\nI've created the workspace. Key decisions so far:\n- TypeScript monorepo with pnpm workspaces\n- MongoDB for persistence\n- Stripe for billing\n- Team: you (backend/architecture) and Sarah (frontend)\n\nNext, should we define the pipeline data model or set up the API layer first?",
	},
]

const _CONVERSATION_DAY1_SESSION2 = [
	// Afternoon: deep dive into data model
	{
		role: "user",
		body: "Let's define the data model. A pipeline has stages, each stage has a transformer. The file /packages/core/src/pipeline.ts should define this.",
	},
	{
		role: "assistant",
		body: "Here's the pipeline data model I'd recommend for `/packages/core/src/pipeline.ts`:\n\n```typescript\nexport interface Pipeline {\n  id: string;\n  name: string;\n  description?: string;\n  stages: PipelineStage[];\n  schedule?: CronSchedule;\n  status: 'draft' | 'active' | 'paused' | 'archived';\n  createdBy: string;\n  createdAt: Date;\n  updatedAt: Date;\n}\n\nexport interface PipelineStage {\n  id: string;\n  name: string;\n  type: 'source' | 'transform' | 'sink';\n  config: Record<string, unknown>;\n  dependsOn: string[];  // DAG edges\n}\n```\n\nThe `dependsOn` array creates the DAG structure. For MongoDB, we'd use a single document per pipeline with embedded stages — this works well since stages are always accessed with their pipeline.",
	},
	{
		role: "user",
		body: "Good, but I also need error handling. When a stage fails, the pipeline should pause and alert. @mike-ops manages our alerting through PagerDuty.",
	},
	{
		role: "assistant",
		body: "I'll add error handling to the pipeline model. Key additions:\n\n1. **Stage-level error tracking**: Each stage gets `lastError`, `retryCount`, `status`\n2. **Pipeline-level circuit breaker**: Pause on N consecutive failures\n3. **Alerting integration**: PagerDuty webhook via Mike (@mike-ops)\n\nThe error handling config goes in `/packages/core/src/error-handler.ts`. I'll also add a `PipelineRun` type that tracks each execution with per-stage results.\n\nFor PagerDuty integration, we should create a connector in `/packages/connectors/src/pagerduty.ts` that Mike can configure with his API keys.",
	},
]

const _CONVERSATION_DAY2_SESSION1 = [
	// Next day: discussing deployment and a bug
	{
		role: "user",
		body: "I found a bug — the pipeline scheduler is skipping every other run. The cron expression '*/5 * * * *' should fire every 5 minutes but it's firing every 10. Check /packages/core/src/scheduler.ts",
	},
	{
		role: "assistant",
		body: 'Looking at `/packages/core/src/scheduler.ts` — I found the issue! The scheduler uses `setInterval` with the cron-parsed interval, but there\'s a race condition:\n\n```typescript\n// BUG: lastRunTime is set BEFORE the run completes\nthis.lastRunTime = Date.now();\nawait this.executePipeline(pipeline);\n```\n\nThe fix: move `lastRunTime` to AFTER execution:\n```typescript\nawait this.executePipeline(pipeline);\nthis.lastRunTime = Date.now();\n```\n\nThis was causing the next interval check to think a run was still "recent" and skip it. Classic async timing bug.',
	},
	{
		role: "user",
		body: "Nice catch! Also, I want to deploy to AWS. We'll use ECS for the API, CloudFront for the web app, and DocumentDB (MongoDB-compatible) for the database. The deployment config is at /infrastructure/terraform/",
	},
	{
		role: "assistant",
		body: "For AWS deployment with DocumentDB, a few important notes:\n\n1. **DocumentDB compatibility**: It's MongoDB 5.0 compatible but lacks some features like change streams (partially supported) and certain aggregation operators. We should test our pipeline queries against DocumentDB specifically.\n\n2. **Terraform structure** for `/infrastructure/terraform/`:\n```\nterraform/\n├── modules/\n│   ├── vpc/\n│   ├── ecs/\n│   ├── documentdb/\n│   └── cloudfront/\n├── environments/\n│   ├── dev/\n│   ├── staging/\n│   └── prod/\n└── main.tf\n```\n\n3. **Key decision**: Should we use DocumentDB's built-in backups or implement our own backup strategy with S3? Given DataVault handles customer data pipelines, I'd recommend both.\n\n4. The #deployment pipeline itself should be a DataVault pipeline — using its own memory pipeline!",
	},
]

const _CONVERSATION_DAY3_SESSION1 = [
	// Day 3: performance and scaling discussion
	{
		role: "user",
		body: "We're seeing slow queries on the runs collection. The query to get recent runs for a pipeline takes 3 seconds. We have 500K documents in runs.",
	},
	{
		role: "assistant",
		body: "3 seconds for a runs query with 500K docs indicates a missing index. Let me diagnose:\n\nThe slow query is likely: `db.runs.find({ pipelineId: X }).sort({ startedAt: -1 }).limit(20)`\n\nFix: Create a compound index:\n```javascript\ndb.runs.createIndex({ pipelineId: 1, startedAt: -1 }, { name: 'idx_runs_pipeline_time' })\n```\n\nThis index covers both the filter and the sort, eliminating the need for an in-memory sort. Should drop the query to <10ms.\n\nAlso consider:\n1. **TTL index** on old runs: `{ startedAt: 1 }, { expireAfterSeconds: 7776000 }` (90 days)\n2. **Archival strategy**: Move runs older than 30 days to a `runs_archive` collection\n3. **Partial index** if most queries filter by status: `{ pipelineId: 1, startedAt: -1 }, { partialFilterExpression: { status: 'completed' } }`",
	},
	{
		role: "user",
		body: "The compound index fixed it! Now @sarah-chen needs help with the dashboard. She wants real-time pipeline status updates. Should we use WebSockets or Server-Sent Events?",
	},
	{
		role: "assistant",
		body: "For real-time pipeline status in the DataVault dashboard, I recommend **Server-Sent Events (SSE)** over WebSockets:\n\n**Why SSE:**\n1. Unidirectional data flow (server → client) matches our use case perfectly\n2. Built-in reconnection and event ID tracking\n3. Works through HTTP/2 with multiplexing\n4. Simpler server implementation in our Express/Fastify API\n5. No need for a WebSocket library on the frontend\n\n**Implementation:**\n- Backend: `/api/pipelines/:id/events` SSE endpoint\n- Watch MongoDB change stream on `runs` collection → push status events\n- Frontend: `EventSource` API with React hook `usePipelineStatus(id)`\n\nSarah can use the `usePipelineStatus` hook like:\n```tsx\nconst { status, lastRun, error } = usePipelineStatus(pipelineId);\n```\n\nThe only case for WebSockets would be if we need bidirectional communication (e.g., user triggers a run from the dashboard), but that can use regular REST POST calls.",
	},
]

// ─── Test Suite ────────────────────────────────────────────────────────────────

describe("Real E2E: Memory v2 Full Capability Test", () => {
	let client: MongoClient
	let db: Db

	// Track IDs for cross-test assertions
	const _eventIds: string[] = []
	const _entityIds: string[] = []

	beforeAll(async () => {
		client = new MongoClient(TEST_URI, {
			connectTimeoutMS: 10_000,
			serverSelectionTimeoutMS: 10_000,
		})
		await client.connect()
		db = client.db(TEST_DB)

		// Setup fresh collections and indexes
		await ensureCollections(db, PREFIX)
		await ensureStandardIndexes(db, PREFIX, {
			memoryTtlDays: 0,
			relevanceRetentionDays: 14,
		})

		// Clean any leftover data for our agent
		const allCollections = await db.listCollections().toArray()
		for (const col of allCollections) {
			if (col.name.startsWith(PREFIX)) {
				await db.collection(col.name).deleteMany({ agentId: AGENT_ID })
			}
		}
	})

	afterAll(async () => {
		await client
			?.db(TEST_DB)
			.dropDatabase()
			.catch(() => {})
		await client?.close()
	})

	// ═══════════════════════════════════════════════════════════════════════════
	// PHASE 14: Profile Synthesis — Aggregate agent profile from 5 collections
	// ═══════════════════════════════════════════════════════════════════════════

	describe("Phase 14: Profile Synthesis", () => {
		it("should synthesize a complete profile from real conversation data", async () => {
			const scopeRef = resolveScopeRef({ scope: "agent", agentId: AGENT_ID })
			const profile = await synthesizeProfile({
				db,
				prefix: PREFIX,
				agentId: AGENT_ID,
				scope: "agent",
				scopeRef,
			})

			expect(profile.agentId).toBe(AGENT_ID)
			expect(profile.synthesizedAt).toBeInstanceOf(Date)

			// Activity patterns from the 18+ events written in Phase 1
			expect(profile.activityPatterns.totalEvents).toBeGreaterThanOrEqual(10)
			expect(
				profile.activityPatterns.roleDistribution.user,
			).toBeGreaterThanOrEqual(1)
			expect(
				profile.activityPatterns.roleDistribution.assistant,
			).toBeGreaterThanOrEqual(1)
			expect(profile.activityPatterns.lastActive).toBeInstanceOf(Date)

			// Entities from Phase 2 extraction (romiluz, sarah, DataVault, etc.)
			expect(profile.topEntities.length).toBeGreaterThanOrEqual(1)
			console.log(
				`  Profile entities: ${profile.topEntities.map((e) => `${e.name}(${e.relationCount})`).join(", ")}`,
			)

			// Episodes from Phase 4 materialization
			expect(profile.recentEpisodes).toBeDefined()
			if (profile.recentEpisodes.length > 0) {
				console.log(
					`  Profile episodes: ${profile.recentEpisodes.map((e) => e.title).join(", ")}`,
				)
			}

			console.log(
				`  Activity: ${profile.activityPatterns.totalEvents} events, roles: ${JSON.stringify(profile.activityPatterns.roleDistribution)}`,
			)
		})

		it("should return empty profile for non-existent agent (no crash)", async () => {
			const emptyProfile = await synthesizeProfile({
				db,
				prefix: PREFIX,
				agentId: `nonexistent-${randomUUID().slice(0, 8)}`,
				scope: "agent",
				scopeRef: "agent:nonexistent",
			})

			expect(emptyProfile.preferences).toEqual([])
			expect(emptyProfile.topEntities).toEqual([])
			expect(emptyProfile.activityPatterns.totalEvents).toBe(0)
		})
	})

	// ═══════════════════════════════════════════════════════════════════════════
	// PHASE 15: Cross-Encoder Re-ranking — Real Voyage rerank-2.5 API
	// ═══════════════════════════════════════════════════════════════════════════

	describeRerank("Phase 15: Cross-Encoder Re-ranking (Voyage API)", () => {
		// Reranker auto-routes based on key prefix (same as Python SDK):
		// al-... → ai.mongodb.com/v1/rerank (Atlas proxy)
		// pa-... → api.voyageai.com/v1/rerank (direct)
		// Rerank-only tests may use either family. MongoDB auto-embedding still requires al-....
		const RERANK_KEY = PREVIEW_VOYAGE_API_KEY

		it("should rerank search results via Voyage rerank-2.5 with instruction-following", async () => {
			// Create results that mimic what searchV2 would return from the conversation data
			const results: MemorySearchResult[] = [
				{
					path: "events/1",
					startLine: 0,
					endLine: 0,
					score: 0.5,
					snippet: "Python is a programming language for data science",
					source: "conversation",
				},
				{
					path: "events/2",
					startLine: 0,
					endLine: 0,
					score: 0.8,
					snippet:
						"MongoDB is a document database. We chose it for DataVault because it handles flexible schemas and pipeline metadata well.",
					source: "conversation",
				},
				{
					path: "events/3",
					startLine: 0,
					endLine: 0,
					score: 0.3,
					snippet:
						"TypeScript provides strong typing for the DataVault backend codebase",
					source: "conversation",
				},
			]

			const config: RerankConfig = {
				enabled: true,
				model: "rerank-2.5",
				topN: 10,
				minScore: 0,
				voyageApiKey: RERANK_KEY,
				instruction:
					"This is agent memory for a coding assistant building DataVault. Prioritize database and architecture decisions.",
			}

			const result = await crossEncoderRerank({
				db,
				prefix: PREFIX,
				agentId: AGENT_ID,
				query: "What database does DataVault use and why?",
				results,
				config,
			})

			expect(result.reranked).toBe(true)
			expect(result.latencyMs).toBeGreaterThan(0)
			expect(result.results.length).toBe(3)

			// MongoDB doc should rank highest for this database query
			expect(result.results[0].snippet).toContain("MongoDB")
			expect(result.results[0].score).toBeGreaterThan(0)
			expect(result.results[0].score).toBeLessThanOrEqual(1)

			console.log(`  Rerank latency: ${result.latencyMs}ms`)
			console.log(
				`  Reranked: ${result.results.map((r) => `${r.path}:${r.score.toFixed(4)}`).join(", ")}`,
			)
		})

		it("should fall back gracefully with invalid API key", async () => {
			const results: MemorySearchResult[] = [
				{
					path: "events/1",
					startLine: 0,
					endLine: 0,
					score: 0.5,
					snippet: "Test doc 1",
					source: "conversation",
				},
				{
					path: "events/2",
					startLine: 0,
					endLine: 0,
					score: 0.8,
					snippet: "Test doc 2",
					source: "conversation",
				},
			]

			const result = await crossEncoderRerank({
				db,
				prefix: PREFIX,
				agentId: AGENT_ID,
				query: "test",
				results,
				config: {
					enabled: true,
					model: "rerank-2.5",
					topN: 10,
					minScore: 0,
					voyageApiKey: "invalid-key-xxx",
				},
			})

			expect(result.reranked).toBe(false)
			expect(result.results.length).toBe(2)
			expect(result.results[0].path).toBe("events/1") // original order preserved
		})
	})

	// ═══════════════════════════════════════════════════════════════════════════
	// PHASE 16: Query Rewriting — Synonym expansion for better recall
	// ═══════════════════════════════════════════════════════════════════════════

	describe("Phase 16: Query Rewriting", () => {
		it("should expand abbreviations and synonyms for domain queries", () => {
			const expanded = expandSynonyms("auth db perf config")
			expect(expanded).toContain("auth")
			expect(expanded).toContain("authentication")
			expect(expanded).toContain("database")
			expect(expanded).toContain("performance")
		})

		it("should emit telemetry for query rewrite operations", async () => {
			const result = await rewriteQuery({
				db,
				prefix: PREFIX,
				agentId: AGENT_ID,
				query: "auth config deploy",
				config: { enabled: true, method: "synonym-expansion", maxTokens: 128 },
			})

			expect(result.rewritten).toBe(true)
			expect(result.rewrittenQuery).toContain("authentication")
			expect(
				result.rewrittenQuery.split(/\s+/).filter(Boolean).length,
			).toBeLessThanOrEqual(9)
			expect(result.method).toBe("synonym-expansion")
			expect(result.originalQuery).toBe("auth config deploy")
		})

		it("should preserve original query when disabled", async () => {
			const result = await rewriteQuery({
				db,
				prefix: PREFIX,
				agentId: AGENT_ID,
				query: "MongoDB pipeline",
				config: { enabled: false, method: "synonym-expansion", maxTokens: 128 },
			})

			expect(result.rewritten).toBe(false)
			expect(result.rewrittenQuery).toBe("MongoDB pipeline")
		})
	})

	// ═══════════════════════════════════════════════════════════════════════════
	// PHASE 17: Pluggable Entity Extraction — RegexExtractor + LLM fallback
	// ═══════════════════════════════════════════════════════════════════════════

	describe("Phase 17: Pluggable Entity Extraction", () => {
		it("should extract entities using RegexEntityExtractor on real conversation data", async () => {
			const extractor = new RegexEntityExtractor()
			const testAgentId = `pluggable-e2e-${randomUUID().slice(0, 8)}`

			// Use realistic conversation content from our DataVault simulation
			const result = await extractAndUpsertEntities({
				db,
				prefix: PREFIX,
				agentId: testAgentId,
				eventContent:
					'@alice and @bob discussed #mongodb optimization and visited https://docs.mongodb.com/manual. They quoted "Performance Guide" as reference.',
				scope: "agent",
				sourceEventId: `evt-pluggable-${randomUUID().slice(0, 8)}`,
				extractor,
			})

			expect(result.entities.length).toBeGreaterThanOrEqual(3)
			expect(result.relationsCreated).toBeGreaterThanOrEqual(1)

			// Verify entity types
			const types = result.entities.map((e) => e.type)
			expect(types).toContain("person") // alice, bob
			expect(types).toContain("topic") // mongodb
			expect(types).toContain("document") // URL

			console.log(
				`  Extracted ${result.entities.length} entities: ${result.entities.map((e) => `${e.name}(${e.type})`).join(", ")}`,
			)
			console.log(`  Created ${result.relationsCreated} relations`)
		})

		it("should fall back to regex when LLM times out", async () => {
			const slowLlm = () => new Promise<string>(() => {}) // never resolves
			const extractor = new LLMEntityExtractor(slowLlm, 100) // 100ms timeout
			const testAgentId = `llm-timeout-e2e-${randomUUID().slice(0, 8)}`

			const result = await extractAndUpsertEntities({
				db,
				prefix: PREFIX,
				agentId: testAgentId,
				eventContent: "@charlie works on #typescript with @dave",
				scope: "agent",
				extractor,
			})

			// Should fall back to regex and still extract entities
			expect(result.entities.length).toBeGreaterThanOrEqual(2)
			const names = result.entities.map((e) => e.name)
			expect(names).toContain("charlie")
			expect(names).toContain("typescript")
		})

		it("should produce identical results to inline extraction (backward compatibility)", async () => {
			const testAgentId = `compat-e2e-${randomUUID().slice(0, 8)}`
			const content =
				'@romiluz discussed #DataVault architecture with "Sarah Chen"'

			// With explicit RegexEntityExtractor
			const withExtractor = await extractAndUpsertEntities({
				db,
				prefix: PREFIX,
				agentId: testAgentId,
				eventContent: content,
				scope: "agent",
				extractor: new RegexEntityExtractor(),
			})

			// Without extractor (uses default)
			const testAgentId2 = `compat-default-${randomUUID().slice(0, 8)}`
			const withDefault = await extractAndUpsertEntities({
				db,
				prefix: PREFIX,
				agentId: testAgentId2,
				eventContent: content,
				scope: "agent",
			})

			// Both should extract the same entities
			expect(withExtractor.entities.length).toBe(withDefault.entities.length)
			const extractorNames = withExtractor.entities
				.map((e) => e.name)
				.toSorted()
			const defaultNames = withDefault.entities.map((e) => e.name).toSorted()
			expect(extractorNames).toEqual(defaultNames)
		})
	})
})
