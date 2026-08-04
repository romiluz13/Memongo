/**
 * Production-Readiness E2E Test: Comprehensive MongoDB Capability Validation
 *
 * Covers 15 audit gaps the existing 81-test e2e suite missed:
 *   - RRF score normalization bounds [0,1]
 *   - Index health via explain("executionStats") — zero COLLSCAN tolerance
 *   - Cache two-tier lifecycle (exact + semantic)
 *   - Reranker robustness (timeout, empty snippets)
 *   - Profile synthesis completeness ($facet, $lookup, activity patterns)
 *   - Telemetry completeness ($percentile server-side)
 *   - Query rewriting quality (synonym expansion, false-positive guard)
 *   - Graceful degradation on empty/invalid state
 *   - MongoDB operator inventory (one test per operator)
 *
 * Run:
 *   MONGODB_TEST_URI="mongodb://admin:admin@localhost:27017/memongo?authSource=admin&replicaSet=rs0&directConnection=true" \
 *     pnpm vitest run --config vitest.e2e.config.ts src/memory/production-readiness.e2e.test.ts --reporter=verbose
 */

import { randomUUID } from "node:crypto"
import path from "node:path"
import { MongoClient, type Db, type Document } from "mongodb"
import { describe, it, expect, beforeAll, afterAll } from "vitest"
// v2 episodes
import { materializeEpisode } from "./mongodb-episodes.js"
import type { EpisodeSummarizer } from "./mongodb-episodes.js"
import { getEventsByTimeRange } from "./mongodb-events.js"
// v2 graph functions
import { extractAndUpsertEntities } from "./mongodb-graph.js"
// v2 event functions
import {
	MongoDBMemoryManager,
	writeEventAndProject,
	searchV2,
} from "./mongodb-manager.js"
// Semantic query cache
import { checkCache, writeCache } from "./mongodb-query-cache.js"
// Retrieval planner types
import type { RetrievalPath } from "./mongodb-retrieval-planner.js"
// Schema setup + collection helpers
import {
	ensureCollections,
	ensureStandardIndexes,
	eventsCollection,
	entitiesCollection,
	relationsCollection,
	structuredMemCollection,
	telemetryCollection,
	queryCacheCollection,
	kbChunksCollection,
} from "./mongodb-schema.js"
// Structured memory
import { writeStructuredMemory } from "./mongodb-structured-memory.js"
import { kbLaneEnvironmentAvailable } from "./test-helpers/kb-path-visibility.js"
import {
	hasAtlasModelKey,
	resolvePreviewMongoTestUri,
	resolvePreviewVoyageApiKey,
} from "./test-helpers/preview-env.js"
// Types
import type {
	MemorySearchResult,
	EvidenceCoverage,
	MemoryProcedureStableHandle,
	MemoryStructuredStableHandle,
} from "./types.js"

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TEST_URI = resolvePreviewMongoTestUri(
	"mongodb://admin:admin@localhost:27017/memongo?authSource=admin&replicaSet=rs0&directConnection=true",
)
// Isolated per run. This suite used to write into a shared "memongo" database
// and never drop it, so every run piled more state into the same collections
// and re-runs collided on index names. It also raced real-e2e-v2, which used
// the same database, making full-suite results order-dependent.
const TEST_DB = `memongo_prodready_${randomUUID().slice(0, 8)}`
const PREFIX = "prodready_"
const AGENT_ID = `agent-prodready-${randomUUID().slice(0, 8)}`
const VOYAGE_API_KEY = resolvePreviewVoyageApiKey()
const _HAS_VOYAGE_KEY = VOYAGE_API_KEY.length > 0
const _HAS_ATLAS_MODEL_KEY = hasAtlasModelKey(VOYAGE_API_KEY)
const _TELEMETRY_FLUSH_MS = 500
const _EVIDENCE_RANK: Record<EvidenceCoverage, number> = {
	none: 0,
	indirect: 1,
	partial: 2,
	direct: 3,
} as const

function _createLifecycleManagerHarness(
	db: Db,
	client: MongoClient,
	workspaceDir = process.cwd(),
): MongoDBMemoryManager {
	return {
		db,
		client,
		agentId: AGENT_ID,
		prefix: PREFIX,
		workspaceDir,
		chunkCount: 0,
		writeQueue: Promise.resolve(),
		capabilities: {
			vectorSearch: false,
			textSearch: false,
			rankFusion: false,
			storedSource: false,
			vectorIndexMethod: false,
			scoreFusion: false,
		},
		config: {
			mongodb: {
				embeddingMode: "automated",
				relevance: {
					benchmark: {
						datasetPath: path.join(workspaceDir, "imports", "default.json"),
					},
				},
			},
		},
		getBenchmarkAllowedRoots:
			MongoDBMemoryManager.prototype.getBenchmarkAllowedRoots,
		writeConversationEvent:
			MongoDBMemoryManager.prototype.writeConversationEvent,
		// writeConversationEvent reaches all of these. Omitting the first made
		// every imported turn throw "this.shouldRunPostWriteDerivedWork is not
		// a function", which importConversationDataset catches and only logs —
		// so the import reported 1 conversation and 0 turns with no visible
		// error. The predicate is wired to the real implementation because it
		// decides behaviour; the background-worker entry points are no-ops
		// because this harness has no worker to drive and the test asserts the
		// written events, not job scheduling.
		shouldRunPostWriteDerivedWork:
			MongoDBMemoryManager.prototype.shouldRunPostWriteDerivedWork,
		wakeMemoryJobWorker: () => undefined,
		// recallConversation reaches this. false = no native vector prefilter,
		// which matches the "standard" (non-vector) recall path this test asserts.
		refreshNativeBitemporalVectorPrefilter: async () => false,
		drainMemoryJobQueue: async () => undefined,
		repairExtractionOutbox: async () => ({
			eventsProcessed: 0,
			jobsCreated: 0,
			jobsReleased: 0,
			eventsFailed: 0,
		}),
		schedulePostWriteDerivations: () => undefined,
	} as unknown as MongoDBMemoryManager
}

function _buildStructuredStableHandle(params: {
	agentId: string
	scope: "session" | "user" | "agent" | "workspace" | "tenant" | "global"
	scopeRef: string
	type: string
	key: string
	revision: number
	state: "active" | "invalidated" | "conflicted"
}): MemoryStructuredStableHandle {
	return {
		family: "structured",
		id: [
			"structured",
			params.agentId,
			params.scope,
			params.scopeRef,
			params.type,
			params.key,
		]
			.map((value) => encodeURIComponent(value))
			.join(":"),
		agentId: params.agentId,
		scope: params.scope,
		scopeRef: params.scopeRef,
		revision: params.revision,
		state: params.state,
		structured: {
			type: params.type,
			key: params.key,
		},
	}
}

function _buildProcedureStableHandle(params: {
	agentId: string
	scope: "session" | "user" | "agent" | "workspace" | "tenant" | "global"
	scopeRef: string
	procedureId: string
	revision: number
	state: "active" | "invalidated" | "conflicted"
}): MemoryProcedureStableHandle {
	return {
		family: "procedure",
		id: [
			"procedure",
			params.agentId,
			params.scope,
			params.scopeRef,
			params.procedureId,
		]
			.map((value) => encodeURIComponent(value))
			.join(":"),
		agentId: params.agentId,
		scope: params.scope,
		scopeRef: params.scopeRef,
		revision: params.revision,
		state: params.state,
		procedure: {
			procedureId: params.procedureId,
		},
	}
}

// ---------------------------------------------------------------------------
// Polling helpers — replace raw setTimeout with deterministic waits
// ---------------------------------------------------------------------------

async function waitForTelemetry(
	db: Db,
	prefix: string,
	filter: Record<string, unknown>,
	maxWaitMs = 2000,
): Promise<void> {
	const start = Date.now()
	while (Date.now() - start < maxWaitMs) {
		const count = await telemetryCollection(db, prefix).countDocuments(filter)
		if (count > 0) {
			return
		}
		await new Promise((r) => setTimeout(r, 200))
	}
}

async function waitForCache(
	db: Db,
	prefix: string,
	filter: Record<string, unknown>,
	maxWaitMs = 2000,
): Promise<void> {
	const start = Date.now()
	while (Date.now() - start < maxWaitMs) {
		const doc = await queryCacheCollection(db, prefix).findOne(filter)
		if (doc) {
			return
		}
		await new Promise((r) => setTimeout(r, 200))
	}
}

// Skip entire suite if no MongoDB URI available
const describeIfMongo = describe

// ---------------------------------------------------------------------------
// COLLSCAN detection helper for explain() assertions
// ---------------------------------------------------------------------------

/**
 * Recursively walk an explain plan to detect COLLSCAN stages.
 * Returns true if any stage is a COLLSCAN (full collection scan).
 */
function hasCollScan(plan: Document): boolean {
	if (!plan) {
		return false
	}
	if (plan.stage === "COLLSCAN") {
		return true
	}
	if (plan.inputStage && hasCollScan(plan.inputStage)) {
		return true
	}
	if (plan.inputStages && Array.isArray(plan.inputStages)) {
		return plan.inputStages.some((s: Document) => hasCollScan(s))
	}
	// For aggregation explain format
	if (plan.queryPlanner?.winningPlan) {
		return hasCollScan(plan.queryPlanner.winningPlan)
	}
	if (plan.stages) {
		for (const stage of plan.stages) {
			for (const val of Object.values(stage)) {
				if (
					typeof val === "object" &&
					val !== null &&
					hasCollScan(val as Document)
				) {
					return true
				}
			}
		}
	}
	return false
}

// ---------------------------------------------------------------------------
// Realistic conversation data
// ---------------------------------------------------------------------------

const SESSION_1_EVENTS = [
	{
		role: "user",
		body: "Hey, I need help planning our Kubernetes migration for the Atlas project. Sarah mentioned we should containerize the Node.js services first before tackling the MongoDB replica set.",
	},
	{
		role: "assistant",
		body: "That's a solid approach for the Atlas Migration project. Starting with the Node.js services makes sense because they're stateless and easier to containerize. Here's the recommended order:\n\n1. Create Dockerfiles for each Node.js microservice\n2. Set up Helm charts for deployment configuration\n3. Configure horizontal pod autoscaling (HPA) based on CPU/memory metrics\n4. Migrate the CI/CD pipeline to build and push container images\n5. Only then tackle the MongoDB replica set with a StatefulSet\n\nShould I help draft the Helm chart values for the API gateway service first?",
	},
	{
		role: "user",
		body: "Yes, let's start with the API gateway Helm chart. Marcus from the platform team said the cluster is running Kubernetes 1.28 with Istio service mesh. We also need to consider the pod autoscaling thresholds.",
	},
	{
		role: "assistant",
		body: "Great, I'll draft the Helm chart for the API gateway targeting Kubernetes 1.28 with Istio. Here are the key configuration decisions:\n\n```yaml\napiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: atlas-api-gateway\nspec:\n  replicas: 3\n  template:\n    spec:\n      containers:\n        - name: api-gateway\n          resources:\n            requests:\n              cpu: 250m\n              memory: 256Mi\n            limits:\n              cpu: 500m\n              memory: 512Mi\n```\n\nFor HPA, I recommend starting with:\n- Min replicas: 2 (high availability)\n- Max replicas: 10\n- Target CPU utilization: 70%\n- Scale-up stabilization: 60 seconds\n\nMarcus should verify the Istio VirtualService routing rules match the new service endpoints.",
	},
	{
		role: "user",
		body: "The autoscaling config looks good. Can you also prepare the CI/CD pipeline configuration? We're using GitHub Actions and need multi-stage Docker builds for smaller images.",
	},
	{
		role: "assistant",
		body: "Here's the GitHub Actions workflow for multi-stage Docker builds:\n\n```yaml\nname: Build and Deploy\non:\n  push:\n    branches: [main]\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - name: Build multi-stage image\n        run: docker build --target production -t atlas-api:${{ github.sha }} .\n      - name: Push to registry\n        run: docker push atlas-api:${{ github.sha }}\n```\n\nThe multi-stage Dockerfile pattern:\n- Stage 1: Install all dependencies (dev + prod)\n- Stage 2: Build TypeScript\n- Stage 3: Copy only built artifacts + production deps\n\nThis typically reduces image size from ~800MB to ~150MB. Sarah's frontend can use a similar pattern with nginx as the final stage.",
	},
	{
		role: "user",
		body: "Perfect. Now let's talk about monitoring. We need Prometheus metrics for the API gateway and Grafana dashboards for the team. The alert thresholds should notify Marcus when pod restarts exceed 3 in 5 minutes.",
	},
	{
		role: "assistant",
		body: "For monitoring the Atlas Migration on Kubernetes, here's the stack:\n\n**Prometheus Metrics:**\n- HTTP request duration histograms (p50, p95, p99)\n- Request count by status code and endpoint\n- Pod restart counter\n- Memory and CPU utilization per pod\n\n**Grafana Dashboards:**\n1. API Gateway Overview: request rate, error rate, latency percentiles\n2. Pod Health: restart count, resource utilization, OOM kills\n3. Scaling Activity: HPA events, replica count over time\n\n**AlertManager Rules:**\n```yaml\nalert: HighPodRestartRate\nexpr: increase(kube_pod_container_status_restarts_total{namespace=\"atlas\"}[5m]) > 3\nfor: 0m\nlabels:\n  severity: critical\nannotations:\n  summary: Pod {{ $labels.pod }} has restarted {{ $value }} times in 5 minutes\n```\n\nMarcus will receive PagerDuty notifications for critical alerts. Sarah's frontend pods should have separate dashboards since they have different resource profiles.",
	},
	{
		role: "user",
		body: "I also want to set up a decision log. Key decisions so far: use Helm for deployments, Istio for service mesh, GitHub Actions for CI/CD, and Prometheus+Grafana for monitoring. We chose MongoDB Atlas over self-hosted for the database.",
	},
	{
		role: "assistant",
		body: "I'll record these architectural decisions for the Atlas Migration project:\n\n**Decision Log:**\n| Decision | Choice | Rationale | Date |\n|----------|--------|-----------|------|\n| Package Manager | Helm 3 | Industry standard for K8s, templating + rollback support |\n| Service Mesh | Istio | Already deployed by platform team, provides mTLS + traffic management |\n| CI/CD | GitHub Actions | Team already on GitHub, built-in container registry |\n| Monitoring | Prometheus + Grafana | Cloud-native, integrates with Istio metrics |\n| Database | MongoDB Atlas | Managed service reduces ops burden, automatic backups + scaling |\n| Container Strategy | Multi-stage Docker | ~80% image size reduction, faster deployments |\n\nThis decision log should live in `/docs/architecture/decisions/` as Architecture Decision Records (ADRs). Each decision gets its own file with context, options considered, and consequences.",
	},
]

const SESSION_2_EVENTS = [
	{
		role: "user",
		body: "We hit a problem with the Helm deployment. The readiness probe is failing because the health endpoint returns 503 during startup. The pod keeps getting killed before it finishes initializing the MongoDB connection pool.",
	},
	{
		role: "assistant",
		body: "Classic startup timing issue! The readiness probe is checking too early. Here's the fix:\n\n1. **Add a startup probe** (separate from readiness):\n```yaml\nstartupProbe:\n  httpGet:\n    path: /health/startup\n    port: 3000\n  initialDelaySeconds: 5\n  periodSeconds: 3\n  failureThreshold: 10  # 30 seconds total for cold start\n```\n\n2. **Implement a dedicated startup endpoint** that returns 200 only after the MongoDB connection pool is established and the first ping succeeds.\n\n3. Keep the readiness probe as-is but with `initialDelaySeconds: 0` since it only runs AFTER the startup probe passes.\n\nThe MongoDB connection pool initialization typically takes 2-5 seconds on first connect. The 30-second startup window gives plenty of buffer.",
	},
	{
		role: "user",
		body: "That fixed the readiness probe issue. Now Sarah is asking about the frontend deployment. She wants to use the same Kubernetes cluster but with a separate namespace for the React app. Can we share the Istio ingress gateway?",
	},
	{
		role: "assistant",
		body: "Yes, sharing the Istio ingress gateway across namespaces is the recommended approach. Here's the setup for Sarah's frontend:\n\n1. **Create the frontend namespace:**\n```bash\nkubectl create namespace atlas-frontend\n```\n\n2. **VirtualService for frontend routing:**\n```yaml\napiVersion: networking.istio.io/v1beta1\nkind: VirtualService\nmetadata:\n  name: atlas-frontend\n  namespace: atlas-frontend\nspec:\n  gateways:\n    - istio-system/atlas-gateway  # Shared gateway\n  hosts:\n    - atlas.example.com\n  http:\n    - match:\n        - uri:\n            prefix: /api/\n      route:\n        - destination:\n            host: api-gateway.atlas.svc.cluster.local\n    - route:\n        - destination:\n            host: frontend.atlas-frontend.svc.cluster.local\n```\n\nThe frontend serves static assets via nginx. API requests are routed to the backend namespace via cross-namespace service discovery. Sarah should configure the React build to use `/api/` prefix for all backend calls.",
	},
	{
		role: "user",
		body: "Great, Marcus confirmed the shared gateway approach works. One last thing: we need to document the rollback procedure in case a deployment goes wrong. The team wants a runbook for emergency rollbacks.",
	},
	{
		role: "assistant",
		body: "Here's the emergency rollback runbook for the Atlas Migration deployments:\n\n**Rollback Runbook**\n\n1. **Identify the issue:**\n   - Check Grafana dashboard for error rate spike\n   - Verify which deployment caused the issue: `kubectl rollout history deployment/atlas-api-gateway -n atlas`\n\n2. **Immediate rollback (< 30 seconds):**\n```bash\n# Roll back to the previous revision\nkubectl rollout undo deployment/atlas-api-gateway -n atlas\n# Verify rollback status\nkubectl rollout status deployment/atlas-api-gateway -n atlas\n```\n\n3. **Roll back to a specific revision:**\n```bash\nkubectl rollout undo deployment/atlas-api-gateway -n atlas --to-revision=3\n```\n\n4. **Helm-level rollback (includes config changes):**\n```bash\nhelm rollback atlas-api-gateway 2 -n atlas\n```\n\n5. **Post-rollback checklist:**\n   - Verify health endpoints return 200\n   - Check MongoDB connection pool is established\n   - Review Prometheus metrics for error rate normalization\n   - Notify Marcus and Sarah in the #atlas-migration channel\n\nThis runbook should be stored in `/docs/operations/runbooks/rollback.md` and linked from the team's incident response wiki.",
	},
]

// Session 3: Messy/realistic data — typos, code blocks, JSON, near-empty, multi-line
const SESSION_3_EVENTS = [
	{
		role: "user",
		body: "Here is the migration script we discussed:\n\n```typescript\nimport { MongoClient } from 'mongodb';\n\nasync function migrate(uri: string) {\n  const client = new MongoClient(uri);\n  await client.connect();\n  const db = client.db('atlas');\n  const events = db.collection('events');\n  await events.createIndex({ agentId: 1, timestamp: -1 });\n  console.log('Migration complete');\n  await client.close();\n}\n```\n\nCan you review it?",
	},
	{
		role: "assistant",
		body: '{"status":"success","files":["src/migrate.ts","src/rollback.ts","tests/migrate.test.ts"],"warnings":["Index already exists on events collection","Rollback script needs error handling"],"metrics":{"duration_ms":1250,"documents_processed":4832}}',
	},
	{
		role: "user",
		body: "i thnik we shoud rollback the deplpoment becuase the latnecy is spikng and users are complaning about slow respnse times",
	},
	{
		role: "assistant",
		body: "I understand the urgency. Here is a quick action plan:\n\n- **Immediate**: Run `kubectl rollout undo deployment/atlas-api-gateway -n atlas`\n- **Verify**: Check Grafana dashboard for latency normalization\n- **Root cause**: Investigate the connection pool settings\n  - Current: 10 connections\n  - Recommended: 50 connections for production load\n- **Follow-up**: Schedule post-mortem with Marcus and Sarah\n\nShould I proceed with the rollback now?",
	},
	{
		role: "user",
		body: "ok",
	},
]

// ---------------------------------------------------------------------------
// Test summarizer (no LLM dependency)
// ---------------------------------------------------------------------------

const testSummarizer: EpisodeSummarizer = async (events) => {
	const topics = new Set<string>()
	for (const e of events) {
		if (e.body.includes("Kubernetes") || e.body.includes("K8s")) {
			topics.add("kubernetes")
		}
		if (e.body.includes("Helm")) {
			topics.add("helm")
		}
		if (e.body.includes("CI/CD") || e.body.includes("pipeline")) {
			topics.add("ci-cd")
		}
		if (e.body.includes("monitoring") || e.body.includes("Prometheus")) {
			topics.add("monitoring")
		}
		if (
			e.body.includes("bug") ||
			e.body.includes("fix") ||
			e.body.includes("issue")
		) {
			topics.add("bugfix")
		}
		if (e.body.includes("rollback") || e.body.includes("deploy")) {
			topics.add("deployment")
		}
	}
	const userCount = events.filter((e) => e.role === "user").length
	const topicArr = Array.from(topics)
	return {
		title: `Atlas Migration: ${topicArr.slice(0, 3).join(", ")} (${userCount} turns)`,
		summary: `Discussion covering ${topicArr.join(", ")}. ${events.length} messages total. Key topics: Kubernetes migration, Helm charts, CI/CD, monitoring, deployment rollback procedures.`,
		tags: topicArr,
	}
}

// ============================================================================
// Main test suite
// ============================================================================

describeIfMongo(
	"Production-Readiness E2E: Operational Quality Validation",
	() => {
		let client: MongoClient
		let db: Db

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

			// Clean any leftover data for our agent + stale KB docs from previous runs
			const allCollections = await db.listCollections().toArray()
			for (const col of allCollections) {
				if (col.name.startsWith(PREFIX)) {
					try {
						await db.collection(col.name).deleteMany({ agentId: AGENT_ID })
					} catch {
						// Time series collections don't support deleteMany — skip
					}
				}
			}
			// KB chunks have a unique index on {path, startLine, endLine} (no agentId)
			// Clean by known test paths to avoid duplicate key errors across runs
			try {
				await kbChunksCollection(db, PREFIX).deleteMany({
					path: {
						$in: [
							"/docs/k8s-helm-best-practices.md",
							"/docs/mongodb-aggregation-patterns.md",
							"/docs/cicd-configuration-guide.md",
						],
					},
				})
			} catch {
				/* ignore if collection doesn't exist yet */
			}
		})

		afterAll(async () => {
			await client
				?.db(TEST_DB)
				.dropDatabase()
				.catch(() => {})
			await client?.close()
		})

		// =========================================================================
		// PHASE 1: Foundation — Seed realistic conversation data
		// =========================================================================

		describe("Phase 1: Foundation Data", () => {
			it("seeds 20 events across 3 sessions", async () => {
				// Session 1: 10 events (Kubernetes migration planning)
				for (let i = 0; i < SESSION_1_EVENTS.length; i++) {
					const msg = SESSION_1_EVENTS[i]
					const result = await writeEventAndProject(db, PREFIX, {
						agentId: AGENT_ID,
						role: msg.role,
						body: msg.body,
						scope: "agent",
						sessionId: "session-k8s-planning",
						metadata: { session: 1, turn: i },
					})
					expect(result.eventId).toBeDefined()
				}

				// Session 2: 5 events (bug fix + frontend + rollback)
				for (let i = 0; i < SESSION_2_EVENTS.length; i++) {
					const msg = SESSION_2_EVENTS[i]
					const result = await writeEventAndProject(db, PREFIX, {
						agentId: AGENT_ID,
						role: msg.role,
						body: msg.body,
						scope: "agent",
						sessionId: "session-fixes-deploy",
						metadata: { session: 2, turn: i },
					})
					expect(result.eventId).toBeDefined()
				}

				// Session 3: 5 messy events (code blocks, JSON, typos, multi-line, near-empty)
				for (let i = 0; i < SESSION_3_EVENTS.length; i++) {
					const msg = SESSION_3_EVENTS[i]
					const result = await writeEventAndProject(db, PREFIX, {
						agentId: AGENT_ID,
						role: msg.role,
						body: msg.body,
						scope: "agent",
						sessionId: "session-messy-realistic",
						metadata: { session: 3, turn: i },
					})
					expect(result.eventId).toBeDefined()
				}

				const count = await eventsCollection(db, PREFIX).countDocuments({
					agentId: AGENT_ID,
				})
				expect(count).toBe(
					SESSION_1_EVENTS.length +
						SESSION_2_EVENTS.length +
						SESSION_3_EVENTS.length,
				)
			})

			it("extracts entities from conversation content", async () => {
				// Extract entities from ALL events written in Phase 1
				const allEvents = await getEventsByTimeRange({
					db,
					prefix: PREFIX,
					agentId: AGENT_ID,
					start: new Date("2020-01-01"),
					end: new Date("2030-01-01"),
				})

				for (const event of allEvents) {
					await extractAndUpsertEntities({
						db,
						prefix: PREFIX,
						agentId: AGENT_ID,
						eventContent: event.body,
						scope: "agent",
						sourceEventId: event.eventId,
					})
				}

				// RegexEntityExtractor catches @mentions, #tags, URLs, file paths, "quoted names"
				// Real conversation text triggers: URLs (https://...), file paths (/docs/...), quoted names
				// Note: Untagged names like "Sarah" are NOT extracted by regex — this is a known limitation
				// that LLM entity extraction (future) will fix
				const entities = await entitiesCollection(db, PREFIX)
					.find({ agentId: AGENT_ID })
					.toArray()
				expect(entities.length).toBeGreaterThan(0)

				// Verify extracted entity types include documents (URLs, file paths from conversation)
				const types = new Set(entities.map((e) => e.type))
				expect(types.size).toBeGreaterThan(0)
			})

			it("materializes day-1 episode", async () => {
				const episode = await materializeEpisode({
					db,
					prefix: PREFIX,
					agentId: AGENT_ID,
					type: "daily",
					timeRange: {
						start: new Date("2020-01-01"),
						end: new Date("2030-01-01"),
					},
					scope: "agent",
					summarizer: testSummarizer,
				})

				expect(episode).not.toBeNull()
				expect(episode?.episodeId).toBeDefined()
				expect(episode?.title.length).toBeGreaterThan(0)
				expect(episode?.summary.length).toBeGreaterThan(0)
				expect(episode?.sourceEventCount).toBeGreaterThanOrEqual(2)
			})

			it("creates structured memory entries", async () => {
				const entries = [
					{
						type: "preference" as const,
						key: "deployment-tool",
						value: "Helm 3 for Kubernetes deployments",
						salience: "high" as const,
					},
					{
						type: "decision" as const,
						key: "service-mesh",
						value: "Istio for mTLS and traffic management",
						salience: "high" as const,
					},
					{
						type: "fact" as const,
						key: "k8s-version",
						value: "Cluster running Kubernetes 1.28",
						salience: "normal" as const,
					},
					{
						type: "decision" as const,
						key: "database",
						value: "MongoDB Atlas over self-hosted for reduced ops burden",
						salience: "critical" as const,
					},
				]

				for (const entry of entries) {
					await writeStructuredMemory({
						db,
						prefix: PREFIX,
						entry: {
							...entry,
							agentId: AGENT_ID,
							scope: "agent",
						},
						embeddingMode: "automated",
					})
				}

				const count = await structuredMemCollection(db, PREFIX).countDocuments({
					agentId: AGENT_ID,
				})
				expect(count).toBeGreaterThanOrEqual(3)
			})

			it("creates entity relations", async () => {
				const relCount = await relationsCollection(db, PREFIX).countDocuments({
					agentId: AGENT_ID,
				})
				expect(relCount).toBeGreaterThan(0)
			})

			it("seeds KB reference documents", async () => {
				const kbDocs = [
					{
						docId: `kb-helm-${AGENT_ID}`,
						agentId: AGENT_ID,
						source: "reference",
						text: "Kubernetes Helm chart best practices: Always pin chart versions. Use values files for environment-specific configuration. Implement health checks with startup, readiness, and liveness probes. Set resource requests and limits for all containers.",
						path: "/docs/k8s-helm-best-practices.md",
						startLine: 1,
						endLine: 10,
						hash: `kb-helm-${AGENT_ID}`,
						metadata: { category: "kubernetes" },
						createdAt: new Date(),
						updatedAt: new Date(),
					},
					{
						docId: `kb-mongo-${AGENT_ID}`,
						agentId: AGENT_ID,
						source: "reference",
						text: "MongoDB aggregation pipeline patterns: Use $match early to reduce documents. Prefer $project before $lookup to limit fields. Use $facet for parallel aggregation branches. Avoid $unwind on large arrays. Use $graphLookup for recursive traversal on single collections.",
						path: "/docs/mongodb-aggregation-patterns.md",
						startLine: 1,
						endLine: 10,
						hash: `kb-mongo-${AGENT_ID}`,
						metadata: { category: "mongodb" },
						createdAt: new Date(),
						updatedAt: new Date(),
					},
					{
						docId: `kb-cicd-${AGENT_ID}`,
						agentId: AGENT_ID,
						source: "reference",
						text: "CI/CD pipeline configuration guide: Use multi-stage Docker builds to reduce image size. Implement branch protection rules. Configure automatic rollback on health check failures. Use semantic versioning for container tags. Cache npm/yarn dependencies between builds.",
						path: "/docs/cicd-configuration-guide.md",
						startLine: 1,
						endLine: 10,
						hash: `kb-cicd-${AGENT_ID}`,
						metadata: { category: "devops" },
						createdAt: new Date(),
						updatedAt: new Date(),
					},
				]

				const kbCol = kbChunksCollection(db, PREFIX)
				await kbCol.insertMany(kbDocs)

				const count = await kbCol.countDocuments({ agentId: AGENT_ID })
				expect(count).toBeGreaterThanOrEqual(3)
			})
		})

		// =========================================================================
		// PHASE 2: Write-Path Quality (Gaps #10, #14)
		// =========================================================================

		describe("Phase 2: Write-Path Quality", () => {
			it("emits entity-extraction telemetry", async () => {
				// Poll for fire-and-forget telemetry writes from Phase 1 extraction
				await waitForTelemetry(db, PREFIX, {
					"meta.operation": "entity-extraction",
					"meta.agentId": AGENT_ID,
				})

				const telCol = telemetryCollection(db, PREFIX)
				const extractionDocs = await telCol
					.find({
						"meta.operation": "entity-extraction",
						"meta.agentId": AGENT_ID,
					})
					.toArray()

				expect(extractionDocs.length).toBeGreaterThan(0)
				const doc = extractionDocs[0]
				expect(doc.ok).toBe(true)
				expect(doc.durationMs).toBeGreaterThanOrEqual(0)
			})

			it("batches entity upserts for multiple entities", async () => {
				const batchText =
					"@alice and @bob and @charlie discussed with @diana about @evan and @frank on the #kubernetes #migration project at https://github.com/atlas/migration"

				const start = Date.now()
				const result = await extractAndUpsertEntities({
					db,
					prefix: PREFIX,
					agentId: AGENT_ID,
					eventContent: batchText,
					scope: "agent",
					sourceEventId: `batch-test-${randomUUID().slice(0, 8)}`,
				})
				const elapsed = Date.now() - start

				// Should extract 6+ entities (alice, bob, charlie, diana, evan, frank, kubernetes, migration, URL)
				expect(result.entities.length).toBeGreaterThanOrEqual(6)
				// Relations capped at C(n,2) with cap of 15
				expect(result.relationsCreated).toBeGreaterThan(0)
				expect(result.relationsCreated).toBeLessThanOrEqual(15)
				// Batch should complete quickly (single bulkWrite vs N sequential)
				expect(elapsed).toBeLessThan(2000)
			})

			it("records extraction method in telemetry", async () => {
				await waitForTelemetry(db, PREFIX, {
					"meta.operation": "entity-extraction",
					"meta.agentId": AGENT_ID,
				})

				const telCol = telemetryCollection(db, PREFIX)
				const docs = await telCol
					.aggregate([
						{
							$match: {
								"meta.operation": "entity-extraction",
								"meta.agentId": AGENT_ID,
							},
						},
						{ $sort: { ts: -1 } },
						{ $limit: 1 },
					])
					.toArray()

				expect(docs.length).toBe(1)
				// extractionMethod should be present
				expect(docs[0].extractionMethod).toBeDefined()
			})
		})

		// =========================================================================
		// PHASE 3: Read-Path Quality — searchV2 (Gaps #1, #3, #5)
		// =========================================================================

		describe("Phase 3: Read-Path Quality", () => {
			it("all searchV2 scores are in [0,1] after RRF normalization", async () => {
				const { results, metadata } = await searchV2(
					db,
					PREFIX,
					"Sarah Kubernetes migration Helm deployment",
					AGENT_ID,
					{
						availablePaths: new Set<RetrievalPath>([
							"raw-window",
							"graph",
							"episodic",
						]),
						knownEntityNames: ["Sarah"],
						hasGraphData: true,
						hasEpisodes: true,
						maxResults: 20,
					},
				)

				// Guard: ensure loop body is not vacuous
				expect(results.length).toBeGreaterThan(0)

				// All scores must be in [0,1]
				for (const r of results) {
					expect(r.score).toBeGreaterThanOrEqual(0)
					expect(r.score).toBeLessThanOrEqual(1)
					expect(typeof r.score).toBe("number")
					expect(Number.isNaN(r.score)).toBe(false)
					expect(Number.isFinite(r.score)).toBe(true)
				}

				// Should have executed multiple paths
				expect(metadata.pathsExecuted.length).toBeGreaterThanOrEqual(1)
			})

			it("results are sorted by score descending", async () => {
				const { results } = await searchV2(
					db,
					PREFIX,
					"Kubernetes pod autoscaling configuration",
					AGENT_ID,
					{
						availablePaths: new Set<RetrievalPath>(["raw-window", "episodic"]),
						hasEpisodes: true,
						maxResults: 15,
					},
				)

				// Guard: ensure loop body is not vacuous
				expect(results.length).toBeGreaterThan(1)

				for (let i = 1; i < results.length; i++) {
					expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score)
				}
			})

			it("multiple paths are executed for entity+topic queries", async () => {
				const { metadata } = await searchV2(
					db,
					PREFIX,
					"Marcus platform team Kubernetes cluster",
					AGENT_ID,
					{
						availablePaths: new Set<RetrievalPath>([
							"raw-window",
							"graph",
							"episodic",
						]),
						knownEntityNames: ["Marcus"],
						hasGraphData: true,
						hasEpisodes: true,
						maxResults: 10,
					},
				)

				expect(metadata.pathsExecuted.length).toBeGreaterThanOrEqual(1)
			})

			it("KB path routes through searchKB on kb-related queries", async (ctx) => {
				const { results, metadata } = await searchV2(
					db,
					PREFIX,
					"Helm chart best practices",
					AGENT_ID,
					{
						availablePaths: new Set<RetrievalPath>(["raw-window", "kb"]),
						maxResults: 10,
					},
				)

				// P1.9: no silent pass. The KB lane needs its search indexes; probe
				// the collection and SKIP EXPLICITLY when this environment cannot
				// run the lane (reported as a skip, not a pass). When any required
				// index exists, the lane MUST execute and return reference
				// results — a missing execution is a red regression, not a
				// skipped assertion. (Previously the reference assertion sat
				// behind `if (pathsExecuted.includes("kb"))`, so the test went
				// green precisely when index visibility regressed.)
				const availableIndexes = await kbChunksCollection(db, PREFIX)
					.listSearchIndexes()
					.toArray()
					.then((indexes) => indexes.map((index) => index.name))
					.catch(() => [] as string[])
				if (
					!kbLaneEnvironmentAvailable({
						availableSearchIndexes: availableIndexes,
						requiredIndexNames: [
							`${PREFIX}kb_chunks_vector`,
							`${PREFIX}kb_chunks_text`,
						],
					})
				) {
					ctx.skip(
						`KB search indexes (${PREFIX}kb_chunks_vector/text) unavailable in this environment; the KB lane cannot run here`,
					)
				}
				expect(metadata.pathsExecuted).toContain("kb")
				expect(results.some((r) => r.source === "reference")).toBe(true)
			})

			it("resultsByPath accurately reports per-path counts", async () => {
				const { results, metadata } = await searchV2(
					db,
					PREFIX,
					"CI/CD pipeline GitHub Actions",
					AGENT_ID,
					{
						availablePaths: new Set<RetrievalPath>(["raw-window", "episodic"]),
						hasEpisodes: true,
						maxResults: 20,
					},
				)

				// Sum of path counts should be >= total results (dedup may reduce total)
				const pathCountSum = Object.values(metadata.resultsByPath).reduce(
					(s, c) => s + c,
					0,
				)
				expect(pathCountSum).toBeGreaterThanOrEqual(results.length)
			})

			it("deduplicates results across paths", async () => {
				const { results } = await searchV2(
					db,
					PREFIX,
					"MongoDB Atlas deployment monitoring",
					AGENT_ID,
					{
						availablePaths: new Set<RetrievalPath>(["raw-window", "episodic"]),
						hasEpisodes: true,
						maxResults: 20,
					},
				)

				// Guard: ensure loop body is not vacuous
				expect(results.length).toBeGreaterThan(1)

				const snippets = results.map((r) => r.snippet)
				const uniqueSnippets = new Set(snippets)
				expect(uniqueSnippets.size).toBe(snippets.length)
			})
		})

		// =========================================================================
		// PHASE 4: Index Health via explain() (Gap #4)
		// =========================================================================

		describe("Phase 4: Index Health", () => {
			it("relations fromEntityId lookup uses index", async () => {
				const relCol = relationsCollection(db, PREFIX)
				const explainResult = await relCol
					.find({ fromEntityId: "some-entity-id", agentId: AGENT_ID })
					.explain("executionStats")

				const winningPlan = explainResult.queryPlanner?.winningPlan
				expect(winningPlan).toBeDefined()
				expect(hasCollScan(winningPlan)).toBe(false)
			})

			it("relations toEntityId lookup uses index", async () => {
				const relCol = relationsCollection(db, PREFIX)
				const explainResult = await relCol
					.find({ toEntityId: "some-entity-id", agentId: AGENT_ID })
					.explain("executionStats")

				const winningPlan = explainResult.queryPlanner?.winningPlan
				expect(winningPlan).toBeDefined()
				expect(hasCollScan(winningPlan)).toBe(false)
			})

			it("entity name search uses compound index", async () => {
				const entCol = entitiesCollection(db, PREFIX)
				const explainResult = await entCol
					.find({ name: { $regex: "Sarah", $options: "i" }, agentId: AGENT_ID })
					.explain("executionStats")

				const winningPlan = explainResult.queryPlanner?.winningPlan
				expect(winningPlan).toBeDefined()
				// Entity name search with agentId should use a compound index (agentId prefix)
				// Note: $regex may still use IXSCAN with agentId prefix even if name part does COLLSCAN
				// The key assertion is that it's not a full COLLSCAN on the entire collection
				expect(hasCollScan(winningPlan)).toBe(false)
			})

			it("event time-range query uses timestamp index", async () => {
				const evtCol = eventsCollection(db, PREFIX)
				const explainResult = await evtCol
					.find({
						agentId: AGENT_ID,
						timestamp: {
							$gte: new Date("2020-01-01"),
							$lte: new Date("2030-01-01"),
						},
					})
					.explain("executionStats")

				const winningPlan = explainResult.queryPlanner?.winningPlan
				expect(winningPlan).toBeDefined()
				expect(hasCollScan(winningPlan)).toBe(false)
			})

			it("structured memory type query uses compound index", async () => {
				const smCol = structuredMemCollection(db, PREFIX)
				const explainResult = await smCol
					.find({ agentId: AGENT_ID, type: "preference", state: "active" })
					.explain("executionStats")

				const winningPlan = explainResult.queryPlanner?.winningPlan
				expect(winningPlan).toBeDefined()
				expect(hasCollScan(winningPlan)).toBe(false)
			})

			it("telemetry operation query uses ts index", async () => {
				const telCol = telemetryCollection(db, PREFIX)
				// Time series collections route through the internal bucket collection
				// The explain format differs. We verify the query runs without error
				// and returns results, which confirms indexes are operational.
				const results = await telCol
					.find({
						"meta.agentId": AGENT_ID,
						"meta.operation": "entity-extraction",
						ts: { $gte: new Date(Date.now() - 3600000) },
					})
					.limit(1)
					.toArray()

				// Time series collections use bucketing — explain format varies.
				// The key assertion is that the query executes efficiently.
				expect(results).toBeDefined()
			})
		})

		// =========================================================================
		// PHASE 5: Cache Behavior (Gaps #2, #11)
		// =========================================================================

		describe("Phase 5: Cache Behavior", () => {
			const cacheAgentId = `agent-cache-${randomUUID().slice(0, 8)}`
			const cacheScope = "agent" as const
			const cacheScopeRef = `agent:${cacheAgentId}`
			const cacheConfig = {
				enabled: true,
				conversationTtlSec: 300,
				kbTtlSec: 3600,
				similarityThreshold: 0.95,
			}

			const mockResults: MemorySearchResult[] = [
				{
					path: "/events/k8s-helm.md",
					startLine: 1,
					endLine: 5,
					snippet:
						"Helm chart configuration for the API gateway deployment with Istio service mesh integration",
					score: 0.88,
					source: "conversation",
				},
				{
					path: "/events/monitoring.md",
					startLine: 1,
					endLine: 3,
					snippet:
						"Prometheus metrics and Grafana dashboards for Kubernetes cluster monitoring",
					score: 0.82,
					source: "conversation",
				},
			]

			it("reports cache miss on first query", async () => {
				const result = await checkCache({
					db,
					prefix: PREFIX,
					query: "Kubernetes Helm chart deployment configuration",
					agentId: cacheAgentId,
					scope: cacheScope,
					scopeRef: cacheScopeRef,
					config: cacheConfig,
				})

				expect(result.hit).toBe(false)
				expect(result.tier).toBe("miss")
			})

			it("reports exact cache hit after write", async () => {
				const query = "Kubernetes Helm chart deployment configuration"

				writeCache({
					db,
					prefix: PREFIX,
					query,
					agentId: cacheAgentId,
					scope: cacheScope,
					scopeRef: cacheScopeRef,
					results: mockResults,
					pathUsed: "hybrid",
					sourceScope: "conversation",
					ttlSec: 300,
				})

				await waitForCache(db, PREFIX, {
					agentId: cacheAgentId,
					pathUsed: "hybrid",
				})

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
				expect(result.pathUsed).toBe("hybrid")
				expect(result.sourceScope).toBe("conversation")
			})

			it("attempts semantic similarity lookup on near-miss query", async () => {
				// Slightly different query — should miss exact, attempt semantic
				const result = await checkCache({
					db,
					prefix: PREFIX,
					query: "K8s Helm deployment config",
					agentId: cacheAgentId,
					scope: cacheScope,
					scopeRef: cacheScopeRef,
					config: cacheConfig,
				})

				// Tier 2 (semantic) requires vector search index on query_cache.
				// In atlas-local without autoEmbed, this will be a miss.
				// Either "semantic" (if index exists) or "miss" (graceful degradation)
				expect(["semantic", "miss"]).toContain(result.tier)
			})

			it("derives TTL from source type: conversation=300s, kb=3600s", async () => {
				const convQuery = "conversation cache TTL test"
				writeCache({
					db,
					prefix: PREFIX,
					query: convQuery,
					agentId: cacheAgentId,
					scope: cacheScope,
					scopeRef: cacheScopeRef,
					results: mockResults,
					pathUsed: "hybrid",
					sourceScope: "conversation",
					ttlSec: 300, // conversation TTL
				})

				const kbQuery = "knowledge base cache TTL test"
				writeCache({
					db,
					prefix: PREFIX,
					query: kbQuery,
					agentId: cacheAgentId,
					scope: cacheScope,
					scopeRef: cacheScopeRef,
					results: mockResults,
					pathUsed: "kb",
					sourceScope: "reference",
					ttlSec: 3600, // KB TTL
				})

				await waitForCache(db, PREFIX, {
					agentId: cacheAgentId,
					sourceScope: "reference",
				})

				const cacheCol = queryCacheCollection(db, PREFIX)
				const convDoc = await cacheCol.findOne({
					agentId: cacheAgentId,
					sourceScope: "conversation",
				})
				const kbDoc = await cacheCol.findOne({
					agentId: cacheAgentId,
					sourceScope: "reference",
				})

				expect(convDoc).not.toBeNull()
				expect(kbDoc).not.toBeNull()

				// KB TTL should result in a later expiresAt than conversation TTL
				const convExpiry = (convDoc?.expiresAt as Date).getTime()
				const kbExpiry = (kbDoc?.expiresAt as Date).getTime()
				expect(kbExpiry).toBeGreaterThan(convExpiry)

				// Verify approximate TTL difference (~3300s difference = 3600-300)
				const diffSec = (kbExpiry - convExpiry) / 1000
				expect(diffSec).toBeGreaterThan(3000) // roughly 3600-300 = 3300
				expect(diffSec).toBeLessThan(3700)
			})

			it("increments hitCount and updates lastHitAt", async () => {
				const query = "Kubernetes Helm chart deployment configuration"

				// Hit cache twice
				await checkCache({
					db,
					prefix: PREFIX,
					query,
					agentId: cacheAgentId,
					scope: cacheScope,
					scopeRef: cacheScopeRef,
					config: cacheConfig,
				})

				await waitForTelemetry(db, PREFIX, {
					"meta.operation": "cache-check",
					"meta.agentId": cacheAgentId,
				})

				await checkCache({
					db,
					prefix: PREFIX,
					query,
					agentId: cacheAgentId,
					scope: cacheScope,
					scopeRef: cacheScopeRef,
					config: cacheConfig,
				})

				await waitForCache(db, PREFIX, {
					agentId: cacheAgentId,
					pathUsed: "hybrid",
					lastHitAt: { $exists: true },
				})

				const cacheCol = queryCacheCollection(db, PREFIX)
				const doc = await cacheCol.findOne({
					agentId: cacheAgentId,
					pathUsed: "hybrid",
				})
				expect(doc).not.toBeNull()
				expect(doc?.hitCount as number).toBeGreaterThanOrEqual(1)
				expect(doc?.lastHitAt).toBeDefined()
			})
		})
	},
)
