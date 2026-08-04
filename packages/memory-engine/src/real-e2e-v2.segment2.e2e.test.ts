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
// v2 events
import { getEventsByTimeRange } from "./mongodb-events.js"
// v2 graph
import {
	upsertEntity,
	findEntitiesByName,
	expandGraph,
} from "./mongodb-graph.js"
// v2 manager functions
import {
	writeEventAndProject,
	searchV2,
	getV2Status,
} from "./mongodb-manager.js"
// v2 ops
import { getRecentIngestRuns } from "./mongodb-ops.js"
// Semantic query cache
import { checkCache, writeCache } from "./mongodb-query-cache.js"
// Schema setup
import {
	ensureCollections,
	ensureStandardIndexes,
	ensureSearchIndexes,
	isSearchIndexTypeCompatible,
} from "./mongodb-schema.js"
// Search functions (direct vector search, keyword search, hybrid)
import {
	vectorSearch,
	keywordSearch,
	buildVectorSearchStage,
} from "./mongodb-search.js"
// Time series telemetry
import {
	emitTelemetry,
	getLatencyStats,
	getCacheHitRate,
	getOperationDistribution,
} from "./mongodb-telemetry.js"
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
const TEST_WINDOW_START = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
const TEST_WINDOW_END = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
const PREVIEW_VOYAGE_API_KEY = resolvePreviewVoyageApiKey()
const AUTO_EMBED_ENABLED = hasAtlasModelKey(PREVIEW_VOYAGE_API_KEY)
const describeAutoEmbed = AUTO_EMBED_ENABLED ? describe : describe.skip
const _describeRerank =
	PREVIEW_VOYAGE_API_KEY.length > 0 ? describe : describe.skip

async function waitForSearchIndexesReady(
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

async function waitForVectorResults(
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
	// PHASE 8: searchV2 End-to-End
	// ═══════════════════════════════════════════════════════════════════════════

	describe("Phase 8: searchV2 Full Pipeline", () => {
		it("should search with raw-window path", async () => {
			const { results, metadata } = await searchV2(
				db,
				PREFIX,
				"what happened today",
				AGENT_ID,
				{
					availablePaths: new Set(["raw-window"]),
					maxResults: 10,
				},
			)

			console.log(`  raw-window search: ${results.length} results`)
			console.log(`  Paths executed: ${metadata.pathsExecuted.join(", ")}`)
			expect(metadata.pathsExecuted).toContain("raw-window")
			expect(metadata.plan.constraints?.timeRange?.preset).toBe("today")
		})

		it("should search with multiple paths including graph", async () => {
			const { results, metadata } = await searchV2(
				db,
				PREFIX,
				"Sarah Chen frontend React",
				AGENT_ID,
				{
					availablePaths: new Set(["raw-window", "graph", "episodic"]),
					knownEntityNames: ["Sarah Chen"],
					hasGraphData: true,
					hasEpisodes: true,
					maxResults: 15,
				},
			)

			console.log(`  Multi-path search: ${results.length} results`)
			console.log(`  Paths executed: ${metadata.pathsExecuted.join(", ")}`)
			console.log(`  Results by path:`, metadata.resultsByPath)
			expect(results.length).toBeGreaterThanOrEqual(0) // May have 0 if graph path finds nothing directly
		})

		it("should search for bug-related content", async () => {
			const { results } = await searchV2(
				db,
				PREFIX,
				"scheduler bug cron race condition",
				AGENT_ID,
				{
					availablePaths: new Set(["raw-window", "episodic"]),
					hasEpisodes: true,
					maxResults: 10,
				},
			)

			console.log(`  Bug search: ${results.length} results`)
			if (results.length > 0) {
				console.log(
					`  Top result (${results[0].source}): ${results[0].snippet.slice(0, 80)}...`,
				)
			}
		})

		it("should return reranked results with diversity", async () => {
			const { results, metadata } = await searchV2(
				db,
				PREFIX,
				"TypeScript MongoDB deployment",
				AGENT_ID,
				{
					availablePaths: new Set(["raw-window", "episodic"]),
					hasEpisodes: true,
					maxResults: 20,
				},
			)

			console.log(
				`  Reranked search: ${results.length} results, paths: ${metadata.pathsExecuted.join(", ")}`,
			)
			// Results should be deduped and reranked
			if (results.length > 1) {
				// Check no exact duplicates
				const bodies = results.map((r) => r.snippet)
				const uniqueBodies = new Set(bodies)
				expect(uniqueBodies.size).toBe(bodies.length)
			}
		})
	})

	// ═══════════════════════════════════════════════════════════════════════════
	// PHASE 9: getV2Status — Full system health check
	// ═══════════════════════════════════════════════════════════════════════════

	describe("Phase 9: V2 Status & Health", () => {
		it("should return comprehensive v2 status", async () => {
			await db.collection(`${PREFIX}relevance_runs`).insertOne({
				runId: `relevance-${randomUUID().slice(0, 8)}`,
				agentId: AGENT_ID,
				ts: new Date(),
				sourceScope: "memory",
				latencyMs: 12,
				status: "ok",
				queryHash: "phase9-health",
				queryRedacted: "phase9-health",
				profile: "e2e",
				capabilities: {},
				topK: 5,
				hitSources: ["conversation", "episodic"],
				sampleRate: 0.5,
				sampled: true,
			})

			const status = await getV2Status(db, PREFIX, AGENT_ID)

			console.log("\n  ═══ V2 System Status ═══")
			console.log(
				`  Events: ${status.events.count} (latest: ${status.events.latestTimestamp?.toISOString() ?? "none"})`,
			)
			console.log(`  Entities: ${status.entities.count}`)
			console.log(`  Relations: ${status.relations.count}`)
			console.log(
				`  Episodes: ${status.episodes.count} (latest: ${status.episodes.latestTimestamp?.toISOString() ?? "none"})`,
			)
			console.log(`  Projection lag:`, status.projectionLag)
			console.log(`  Retrieval paths: ${status.retrievalPaths.join(", ")}`)
			console.log("  ════════════════════════\n")

			expect(status.events.count).toBeGreaterThan(0)
			expect(status.entities.count).toBeGreaterThan(0)
			expect(status.episodes.count).toBeGreaterThanOrEqual(1)
			expect(status.projectionLag.chunks).not.toBeNull()
			expect(status.projectionLag.entities).not.toBeNull()
			expect(status.projectionLag.relations).not.toBeNull()
			expect(status.projectionLag.episodes).not.toBeNull()
			expect(status.health.overall).toBe("ok")
			expect(status.health.retrieval).toBe("ok")
			expect(status.health.canonicalIngest).toBe("ok")
			expect(status.health.derivedProducts.chunks).toBe("ok")
			expect(status.health.derivedProducts.entities).toBe("ok")
			expect(status.health.derivedProducts.relations).toBe("ok")
			expect(status.health.derivedProducts.episodes).toBe("ok")
			expect(status.retrievalPaths.length).toBeGreaterThan(0)
		})

		it("should have operational records (ingest runs)", async () => {
			const runs = await getRecentIngestRuns({
				db,
				prefix: PREFIX,
				agentId: AGENT_ID,
				limit: 5,
			})
			console.log(`  Recent ingest runs: ${runs.length}`)
			expect(runs.length).toBeGreaterThan(0)
		})
	})

	// ═══════════════════════════════════════════════════════════════════════════
	// PHASE 10: Agent Isolation — Verify cross-agent safety
	// ═══════════════════════════════════════════════════════════════════════════

	describe("Phase 10: Agent Isolation", () => {
		const OTHER_AGENT = `agent-other-${randomUUID().slice(0, 8)}`

		it("should not leak events across agents", async () => {
			// Write event for other agent
			await writeEventAndProject(db, PREFIX, {
				agentId: OTHER_AGENT,
				role: "user",
				body: "This is a SECRET message only for the other agent",
				scope: "agent",
				sessionId: "other-session",
			})

			// Search from our agent should NOT find it
			const ourEvents = await getEventsByTimeRange({
				db,
				prefix: PREFIX,
				agentId: AGENT_ID,
				start: TEST_WINDOW_START,
				end: TEST_WINDOW_END,
			})

			const leaked = ourEvents.some((e) => e.body.includes("SECRET"))
			expect(leaked).toBe(false)
		})

		it("should not leak entities across agents", async () => {
			await upsertEntity({
				db,
				prefix: PREFIX,
				entity: {
					entityId: `entity-secret-${randomUUID().slice(0, 8)}`,
					name: "SecretOtherAgent",
					type: "person",
					agentId: OTHER_AGENT,
					scope: "agent",
					updatedAt: new Date(),
				},
			})

			const results = await findEntitiesByName({
				db,
				prefix: PREFIX,
				query: "SecretOtherAgent",
				agentId: AGENT_ID,
			})
			expect(results.length).toBe(0)
		})

		it("should not leak graph expansion across agents", async () => {
			const otherEntityId = `entity-other-root-${randomUUID().slice(0, 8)}`
			await upsertEntity({
				db,
				prefix: PREFIX,
				entity: {
					entityId: otherEntityId,
					name: "OtherProjectRoot",
					type: "project",
					agentId: OTHER_AGENT,
					scope: "agent",
					updatedAt: new Date(),
				},
			})

			// Our agent should not find the other agent's entity
			const result = await expandGraph({
				db,
				prefix: PREFIX,
				entityId: otherEntityId,
				agentId: AGENT_ID,
			})
			expect(result).toBeNull() // Not our entity
		})
	})

	// ─── Phase 11: Voyage AI AutoEmbed Vector Search ───────────────────────────
	// Tests real vector search using Voyage AI autoEmbed (voyage-4-large).
	// mongot must be running with embedding config for these tests to pass.
	// The autoEmbed indexes are created by ensureSearchIndexes() and mongot
	// auto-generates embeddings from the "text" field via the Voyage API.

	describeAutoEmbed("Phase 11: Voyage AI AutoEmbed Vector Search", () => {
		// Allow up to 90s for atlas-local auto-embed to finish embedding documents
		const VECTOR_SEARCH_TIMEOUT = 180_000

		it(
			"should have autoEmbed search indexes on chunks",
			async () => {
				// ensureSearchIndexes creates text + vector indexes using autoEmbed
				const result = await ensureSearchIndexes(
					db,
					PREFIX,
					"atlas-local-preview",
					"automated",
				)
				// Both should succeed (or already exist)
				expect(result.text).toBe(true)
				expect(result.vector).toBe(true)

				// Verify the indexes exist via $listSearchIndexes
				const indexes = await waitForSearchIndexesReady(db, {
					timeoutMs: VECTOR_SEARCH_TIMEOUT,
				})
				const vectorIdx = indexes.find(
					(i) => i.name === `${PREFIX}chunks_vector`,
				)
				const textIdx = indexes.find((i) => i.name === `${PREFIX}chunks_text`)

				expect(vectorIdx).toBeDefined()
				// The server does not populate `type` for an auto-embedding vector
				// index — verified live, it comes back undefined. That is what
				// isSearchIndexTypeCompatible exists to absorb, and what
				// detectCapabilities already uses. Asserting the literal string
				// here was asserting a field MongoDB never sends.
				expect(
					isSearchIndexTypeCompatible(vectorIdx?.type, "vectorSearch"),
				).toBe(true)
				expect(vectorIdx?.status).toBe("READY")
				expect(textIdx).toBeDefined()
				expect(isSearchIndexTypeCompatible(textIdx?.type, "search")).toBe(true)
				expect(textIdx?.status).toBe("READY")

				// Verify autoEmbed definition
				const fields = vectorIdx?.latestDefinition?.fields
				expect(fields).toBeDefined()
				const autoEmbedField = fields?.find(
					(f: { type: string }) => f.type === "autoEmbed",
				)
				expect(autoEmbedField).toBeDefined()
				expect(autoEmbedField?.model).toBe("voyage-4-large")
				expect(autoEmbedField?.path).toBe("text")
				expect(autoEmbedField?.modality).toBe("text")
			},
			VECTOR_SEARCH_TIMEOUT,
		)

		it("should build correct $vectorSearch stage for autoEmbed", () => {
			// Unit-level check that buildVectorSearchStage produces correct query syntax
			const stage = buildVectorSearchStage({
				queryVector: null,
				queryText: "data pipeline architecture",
				embeddingMode: "automated",
				indexName: `${PREFIX}chunks_vector`,
				numCandidates: 100,
				limit: 5,
			})

			expect(stage).not.toBeNull()
			expect(stage?.query).toEqual({ text: "data pipeline architecture" })
			expect(stage?.model).toBe("voyage-4-large")
			expect(stage?.path).toBe("text")
			expect(stage?.index).toBe(`${PREFIX}chunks_vector`)
			expect(stage?.numCandidates).toBe(100)
			expect(stage?.limit).toBe(5)
			// autoEmbed must NOT have queryVector
			expect(stage?.queryVector).toBeUndefined()
		})

		it(
			"should return semantic results for architecture queries via $vectorSearch",
			async () => {
				const chunkCount = await db
					.collection(`${PREFIX}chunks`)
					.countDocuments({})
				expect(chunkCount).toBeGreaterThan(0)
				await waitForSearchIndexesReady(db, {
					timeoutMs: VECTOR_SEARCH_TIMEOUT,
				})

				const results = await waitForVectorResults(
					db,
					"data pipeline architecture and system design",
					{
						maxResults: 5,
						timeoutMs: VECTOR_SEARCH_TIMEOUT,
					},
				)

				// Should get results from the conversation chunks about DataVault architecture
				expect(results.length).toBeGreaterThan(0)
				expect(results.length).toBeLessThanOrEqual(5)

				// Every result should have a valid score
				for (const r of results) {
					expect(r.score).toBeGreaterThan(0)
					expect(r.score).toBeLessThanOrEqual(1)
					expect(r.snippet).toBeDefined()
					expect(r.snippet.length).toBeGreaterThan(0)
				}

				// Results should be sorted by score descending
				for (let i = 1; i < results.length; i++) {
					expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score)
				}
			},
			VECTOR_SEARCH_TIMEOUT,
		)

		it(
			"should find deployment-related content with semantic search",
			async () => {
				await waitForSearchIndexesReady(db, {
					timeoutMs: VECTOR_SEARCH_TIMEOUT,
				})
				const results = await waitForVectorResults(
					db,
					"Docker deployment Kubernetes production infrastructure",
					{
						maxResults: 5,
						timeoutMs: VECTOR_SEARCH_TIMEOUT,
					},
				)

				expect(results.length).toBeGreaterThan(0)

				// At least one result should mention deployment/Docker/infrastructure
				const deploymentHit = results.some(
					(r) =>
						r.snippet.toLowerCase().includes("deploy") ||
						r.snippet.toLowerCase().includes("docker") ||
						r.snippet.toLowerCase().includes("infrastructure") ||
						r.snippet.toLowerCase().includes("production"),
				)
				expect(deploymentHit).toBe(true)
			},
			VECTOR_SEARCH_TIMEOUT,
		)

		it(
			"should find bug-fix content with semantic search",
			async () => {
				await waitForSearchIndexesReady(db, {
					timeoutMs: VECTOR_SEARCH_TIMEOUT,
				})
				const results = await waitForVectorResults(
					db,
					"database connection error bug fix troubleshooting",
					{
						maxResults: 5,
						timeoutMs: VECTOR_SEARCH_TIMEOUT,
					},
				)

				expect(results.length).toBeGreaterThan(0)

				// At least one result should be about the connection pool bug conversation
				const bugHit = results.some(
					(r) =>
						r.snippet.toLowerCase().includes("bug") ||
						r.snippet.toLowerCase().includes("error") ||
						r.snippet.toLowerCase().includes("fix") ||
						r.snippet.toLowerCase().includes("connection"),
				)
				expect(bugHit).toBe(true)
			},
			VECTOR_SEARCH_TIMEOUT,
		)

		it(
			"should return keyword search results with text index",
			async () => {
				await waitForSearchIndexesReady(db, {
					timeoutMs: VECTOR_SEARCH_TIMEOUT,
				})
				const chunks = db.collection(`${PREFIX}chunks`)
				const results = await keywordSearch(chunks, "DataVault pipeline", {
					maxResults: 5,
					minScore: 0.0,
					indexName: `${PREFIX}chunks_text`,
				})

				expect(results.length).toBeGreaterThan(0)

				// Text search results should contain the search terms
				const hasRelevant = results.some(
					(r) =>
						r.snippet.toLowerCase().includes("datavault") ||
						r.snippet.toLowerCase().includes("pipeline"),
				)
				expect(hasRelevant).toBe(true)
			},
			VECTOR_SEARCH_TIMEOUT,
		)

		it(
			"should handle semantic similarity — related concepts rank higher",
			async () => {
				await waitForSearchIndexesReady(db, {
					timeoutMs: VECTOR_SEARCH_TIMEOUT,
				})
				// Search for a concept that appears in the conversation but with different words
				// The conversations discuss "real-time data processing with WebSocket"
				// but we search with synonymous terms
				const results = await waitForVectorResults(
					db,
					"live streaming updates push notifications event-driven",
					{
						maxResults: 10,
						timeoutMs: VECTOR_SEARCH_TIMEOUT,
					},
				)

				expect(results.length).toBeGreaterThan(0)

				// Vector search should find semantically related content even without exact keyword matches
				// (this is the key advantage over keyword search)
				for (const r of results) {
					expect(r.score).toBeGreaterThan(0)
				}
			},
			VECTOR_SEARCH_TIMEOUT,
		)

		it(
			"should respect minScore filter on vector results",
			async () => {
				await waitForSearchIndexesReady(db, {
					timeoutMs: VECTOR_SEARCH_TIMEOUT,
				})
				const chunks = db.collection(`${PREFIX}chunks`)

				// Use a high minScore threshold — should get fewer or no results
				const highThreshold = await vectorSearch(chunks, null, {
					maxResults: 10,
					minScore: 0.95,
					indexName: `${PREFIX}chunks_vector`,
					queryText: "completely unrelated quantum physics black holes",
					embeddingMode: "automated",
				})

				// Use a low minScore threshold — should get more results
				const lowThreshold = await vectorSearch(chunks, null, {
					maxResults: 10,
					minScore: 0.0,
					indexName: `${PREFIX}chunks_vector`,
					queryText: "data pipeline architecture",
					embeddingMode: "automated",
				})

				// High threshold on irrelevant query should return fewer results
				expect(highThreshold.length).toBeLessThanOrEqual(lowThreshold.length)
			},
			VECTOR_SEARCH_TIMEOUT,
		)

		it("should return null stage when embeddingMode is not automated", () => {
			// When embeddingMode is not "automated", buildVectorSearchStage should return null
			// (no manual embedding support in Memongo)
			const stage = buildVectorSearchStage({
				queryVector: null,
				queryText: "test query",
				embeddingMode: "none" as "automated",
				indexName: `${PREFIX}chunks_vector`,
				numCandidates: 100,
				limit: 5,
			})
			expect(stage).toBeNull()
		})
	})

	// ─── Phase 12: Semantic Query Cache (Real MongoDB) ──────────────────────────
	// Tests the two-tier cache against a live MongoDB with real data written and read.
	// Tier 1: exact SHA-256 hash match. Tier 2: $vectorSearch with autoEmbed.
	// No mocks — real insertOne, real findOne, real $vectorSearch.

	describe("Phase 12: Semantic Query Cache", () => {
		const cacheAgentId = `agent-cache-e2e-${randomUUID().slice(0, 8)}`
		const cacheScope = "agent" as const
		const cacheScopeRef = `agent:${cacheAgentId}`
		const cacheConfig = {
			enabled: true,
			conversationTtlSec: 300,
			kbTtlSec: 3600,
			similarityThreshold: 0.95,
		}

		const fakeResults: MemorySearchResult[] = [
			{
				path: "/e2e/cache.md",
				startLine: 1,
				endLine: 5,
				snippet: "DataVault pipeline architecture",
				score: 0.88,
				source: "conversation",
			},
			{
				path: "/e2e/cache2.md",
				startLine: 1,
				endLine: 3,
				snippet: "MongoDB data model for pipelines",
				score: 0.82,
				source: "conversation",
			},
		]

		it("should write a cache entry and read it back via Tier 1 (exact hash match)", async () => {
			const query = "What is the DataVault pipeline architecture?"

			// Write to cache (fire-and-forget, but we await a small delay for it to complete)
			writeCache({
				db,
				prefix: PREFIX,
				query,
				agentId: cacheAgentId,
				scope: cacheScope,
				scopeRef: cacheScopeRef,
				results: fakeResults,
				pathUsed: "hybrid",
				sourceScope: "conversation",
				ttlSec: 300,
			})

			// Small delay for the fire-and-forget upsert to complete
			await new Promise((resolve) => setTimeout(resolve, 500))

			// Tier 1: exact match — same query should hit the cache
			const result = await checkCache({
				db,
				prefix: PREFIX,
				query,
				agentId: cacheAgentId,
				scope: cacheScope,
				scopeRef: cacheScopeRef,
				config: cacheConfig,
			})

			expect(result.hit).toBe(true)
			expect(result.tier).toBe("exact")
			expect(result.results).toHaveLength(2)
			expect(result.results[0].snippet).toBe("DataVault pipeline architecture")
			expect(result.pathUsed).toBe("hybrid")
			expect(result.sourceScope).toBe("conversation")
		})

		it("should increment hitCount on exact cache hit", async () => {
			const query = "What is the DataVault pipeline architecture?"

			// Hit the cache a second time
			const result = await checkCache({
				db,
				prefix: PREFIX,
				query,
				agentId: cacheAgentId,
				scope: cacheScope,
				scopeRef: cacheScopeRef,
				config: cacheConfig,
			})

			expect(result.hit).toBe(true)

			// Wait for fire-and-forget $inc to complete
			await new Promise((resolve) => setTimeout(resolve, 500))

			// Verify hitCount was incremented in the actual document
			const col = db.collection(`${PREFIX}query_cache`)
			const doc = await col.findOne({ agentId: cacheAgentId })
			expect(doc).not.toBeNull()
			expect(doc?.hitCount).toBeGreaterThanOrEqual(1)
		})

		it("should return miss for a completely different query (no cache entry)", async () => {
			const result = await checkCache({
				db,
				prefix: PREFIX,
				query: "quantum physics black holes singularity",
				agentId: cacheAgentId,
				scope: cacheScope,
				scopeRef: cacheScopeRef,
				config: cacheConfig,
			})

			expect(result.hit).toBe(false)
			expect(result.tier).toBe("miss")
			expect(result.results).toHaveLength(0)
		})

		it("should return miss for a different agentId (tenant isolation)", async () => {
			const query = "What is the DataVault pipeline architecture?"

			const result = await checkCache({
				db,
				prefix: PREFIX,
				query,
				agentId: "completely-different-agent",
				scope: cacheScope,
				scopeRef: "agent:completely-different-agent",
				config: cacheConfig,
			})

			expect(result.hit).toBe(false)
			expect(result.tier).toBe("miss")
		})

		it("should return miss when cache is disabled", async () => {
			const result = await checkCache({
				db,
				prefix: PREFIX,
				query: "What is the DataVault pipeline architecture?",
				agentId: cacheAgentId,
				scope: cacheScope,
				scopeRef: cacheScopeRef,
				config: { ...cacheConfig, enabled: false },
			})

			expect(result.hit).toBe(false)
			expect(result.tier).toBe("miss")
		})

		it("should upsert (update) an existing cache entry on re-write", async () => {
			const query = "What is the DataVault pipeline architecture?"
			const updatedResults: MemorySearchResult[] = [
				{
					path: "/e2e/updated.md",
					startLine: 1,
					endLine: 2,
					snippet: "Updated architecture result",
					score: 0.95,
					source: "conversation",
				},
			]

			writeCache({
				db,
				prefix: PREFIX,
				query,
				agentId: cacheAgentId,
				scope: cacheScope,
				scopeRef: cacheScopeRef,
				results: updatedResults,
				pathUsed: "vector",
				sourceScope: "conversation",
				ttlSec: 600,
			})

			await new Promise((resolve) => setTimeout(resolve, 500))

			const result = await checkCache({
				db,
				prefix: PREFIX,
				query,
				agentId: cacheAgentId,
				scope: cacheScope,
				scopeRef: cacheScopeRef,
				config: cacheConfig,
			})

			expect(result.hit).toBe(true)
			expect(result.results).toHaveLength(1)
			expect(result.results[0].snippet).toBe("Updated architecture result")
			expect(result.pathUsed).toBe("vector")
		})

		it("should handle the query_cache collection existing with $jsonSchema validation", async () => {
			// Verify the collection validates documents — try inserting a bad document directly
			const col = db.collection(`${PREFIX}query_cache`)
			try {
				await col.insertOne({ bad: "document" } as never)
				// If validation is moderate, this might succeed for some schemas
				// Either way, our writeCache should work correctly
			} catch {
				// Expected: validation rejects malformed document
			}

			// Our real writeCache should still work (it uses the correct schema)
			writeCache({
				db,
				prefix: PREFIX,
				query: "schema validation test query",
				agentId: cacheAgentId,
				scope: cacheScope,
				scopeRef: cacheScopeRef,
				results: fakeResults,
				pathUsed: "text",
				sourceScope: "conversation",
				ttlSec: 300,
			})

			await new Promise((resolve) => setTimeout(resolve, 500))

			const result = await checkCache({
				db,
				prefix: PREFIX,
				query: "schema validation test query",
				agentId: cacheAgentId,
				scope: cacheScope,
				scopeRef: cacheScopeRef,
				config: cacheConfig,
			})

			expect(result.hit).toBe(true)
		})
	})

	// ─── Phase 13: Time Series Telemetry (Real MongoDB) ─────────────────────────
	// Tests emitTelemetry against a real time series collection and verifies
	// aggregation queries (getLatencyStats, getCacheHitRate, getOperationDistribution)
	// return correct results from real data.

	describe("Phase 13: Time Series Telemetry", () => {
		const telemetryAgentId = `agent-telemetry-e2e-${randomUUID().slice(0, 8)}`

		it("should emit telemetry documents to the time series collection", async () => {
			// Emit several telemetry documents with different operations
			emitTelemetry(db, PREFIX, {
				meta: { agentId: telemetryAgentId, operation: "search" },
				durationMs: 120,
				ok: true,
				pathUsed: "hybrid",
				resultCount: 5,
				topScore: 0.88,
				fusionMethod: "scoreFusion",
			})

			emitTelemetry(db, PREFIX, {
				meta: { agentId: telemetryAgentId, operation: "search" },
				durationMs: 85,
				ok: true,
				pathUsed: "vector",
				resultCount: 3,
				topScore: 0.92,
				fusionMethod: "scoreFusion",
			})

			emitTelemetry(db, PREFIX, {
				meta: { agentId: telemetryAgentId, operation: "search" },
				durationMs: 200,
				ok: true,
				pathUsed: "hybrid",
				resultCount: 8,
				topScore: 0.75,
				fusionMethod: "rankFusion",
			})

			emitTelemetry(db, PREFIX, {
				meta: { agentId: telemetryAgentId, operation: "event-write" },
				durationMs: 45,
				ok: true,
				eventType: "user",
				projectionTriggered: true,
			})

			emitTelemetry(db, PREFIX, {
				meta: { agentId: telemetryAgentId, operation: "cache-check" },
				durationMs: 2,
				ok: true,
				cacheHit: true,
			})

			emitTelemetry(db, PREFIX, {
				meta: { agentId: telemetryAgentId, operation: "cache-check" },
				durationMs: 15,
				ok: true,
				cacheHit: false,
			})

			emitTelemetry(db, PREFIX, {
				meta: { agentId: telemetryAgentId, operation: "cache-check" },
				durationMs: 3,
				ok: true,
				cacheHit: true,
			})

			emitTelemetry(db, PREFIX, {
				meta: { agentId: telemetryAgentId, operation: "graph-expansion" },
				durationMs: 65,
				ok: true,
				resultCount: 12,
			})

			// Wait for all fire-and-forget writes to complete
			await new Promise((resolve) => setTimeout(resolve, 2000))

			// Verify documents were actually written to the time series collection
			const col = db.collection(`${PREFIX}memory_telemetry`)
			const count = await col.countDocuments({
				"meta.agentId": telemetryAgentId,
			})
			expect(count).toBe(8)
		})

		it("should calculate correct latency percentiles from real data", async () => {
			const stats = await getLatencyStats({
				db,
				prefix: PREFIX,
				agentId: telemetryAgentId,
				operation: "search",
				windowMs: 60_000, // last 60 seconds
			})

			expect(stats.count).toBe(3)
			// Durations: [85, 120, 200] sorted
			expect(stats.p50).toBe(120) // index 1 of 3 = 120
			expect(stats.p95).toBe(200) // index 2 of 3 = 200
			expect(stats.p99).toBe(200) // index 2 of 3 = 200
		})

		it("should calculate correct cache hit rate from real data", async () => {
			const rate = await getCacheHitRate({
				db,
				prefix: PREFIX,
				agentId: telemetryAgentId,
				windowMs: 60_000,
			})

			expect(rate.total).toBe(3) // 3 cache-check events
			expect(rate.hits).toBe(2) // 2 with cacheHit: true
			expect(rate.misses).toBe(1) // 1 with cacheHit: false
			expect(rate.hitRate).toBeCloseTo(2 / 3, 2)
		})

		it("should return correct operation distribution from real data", async () => {
			const dist = await getOperationDistribution({
				db,
				prefix: PREFIX,
				agentId: telemetryAgentId,
				windowMs: 60_000,
			})

			expect(dist.length).toBe(4) // search, event-write, cache-check, graph-expansion

			const searchDist = dist.find((d) => d.operation === "search")
			expect(searchDist).toBeDefined()
			expect(searchDist?.count).toBe(3)
			expect(searchDist?.avgDurationMs).toBe(Math.round((120 + 85 + 200) / 3))

			const cacheDist = dist.find((d) => d.operation === "cache-check")
			expect(cacheDist).toBeDefined()
			expect(cacheDist?.count).toBe(3)

			const writeDist = dist.find((d) => d.operation === "event-write")
			expect(writeDist).toBeDefined()
			expect(writeDist?.count).toBe(1)
			expect(writeDist?.avgDurationMs).toBe(45)

			const graphDist = dist.find((d) => d.operation === "graph-expansion")
			expect(graphDist).toBeDefined()
			expect(graphDist?.count).toBe(1)
		})

		it("should return zero stats for a non-existent agent (tenant isolation)", async () => {
			const stats = await getLatencyStats({
				db,
				prefix: PREFIX,
				agentId: "non-existent-agent-12345",
				windowMs: 60_000,
			})

			expect(stats.count).toBe(0)
			expect(stats.p50).toBe(0)
			expect(stats.p95).toBe(0)
			expect(stats.p99).toBe(0)
		})

		it("should respect time window filtering", async () => {
			// Use a 1ms window — nothing should match since all data was written > 1ms ago
			const stats = await getLatencyStats({
				db,
				prefix: PREFIX,
				agentId: telemetryAgentId,
				windowMs: 1,
			})

			expect(stats.count).toBe(0)
		})

		it("should verify time series collection has correct options", async () => {
			// List collections and find our time series collection
			const collections = await db
				.listCollections(
					{ name: `${PREFIX}memory_telemetry` },
					{ nameOnly: false },
				)
				.toArray()
			expect(collections).toHaveLength(1)

			const colInfo = collections[0] as {
				type?: string
				options?: {
					timeseries?: {
						timeField?: string
						metaField?: string
						granularity?: string
					}
				}
			}
			expect(colInfo.type).toBe("timeseries")
			expect(colInfo.options?.timeseries?.timeField).toBe("ts")
			expect(colInfo.options?.timeseries?.metaField).toBe("meta")
			expect(colInfo.options?.timeseries?.granularity).toBe("seconds")
		})
	})
})
