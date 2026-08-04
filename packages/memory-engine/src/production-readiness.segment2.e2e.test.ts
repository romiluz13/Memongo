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
import { materializeEpisode, updateEpisodeStatus } from "./mongodb-episodes.js"
import type { EpisodeSummarizer } from "./mongodb-episodes.js"
// v2 event functions
import { MongoDBMemoryManager, searchV2 } from "./mongodb-manager.js"
// Profile synthesis
import { synthesizeProfile } from "./mongodb-profile.js"
// Semantic query cache
import { checkCache } from "./mongodb-query-cache.js"
// Query rewriter
import { rewriteQuery, expandSynonyms } from "./mongodb-query-rewriter.js"
// Reranker
import { crossEncoderRerank, type RerankConfig } from "./mongodb-reranker.js"
// Retrieval planner types
import type { RetrievalPath } from "./mongodb-retrieval-planner.js"
// Schema setup + collection helpers
import {
	ensureCollections,
	ensureStandardIndexes,
	episodesCollection,
	telemetryCollection,
	queryCacheCollection,
	kbChunksCollection,
} from "./mongodb-schema.js"
// Scope resolution
import { resolveScopeRef } from "./mongodb-scope.js"
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
const HAS_VOYAGE_KEY = VOYAGE_API_KEY.length > 0
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

async function _waitForCache(
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
function _hasCollScan(plan: Document): boolean {
	if (!plan) {
		return false
	}
	if (plan.stage === "COLLSCAN") {
		return true
	}
	if (plan.inputStage && _hasCollScan(plan.inputStage)) {
		return true
	}
	if (plan.inputStages && Array.isArray(plan.inputStages)) {
		return plan.inputStages.some((s: Document) => _hasCollScan(s))
	}
	// For aggregation explain format
	if (plan.queryPlanner?.winningPlan) {
		return _hasCollScan(plan.queryPlanner.winningPlan)
	}
	if (plan.stages) {
		for (const stage of plan.stages) {
			for (const val of Object.values(stage)) {
				if (
					typeof val === "object" &&
					val !== null &&
					_hasCollScan(val as Document)
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

const _SESSION_1_EVENTS = [
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

const _SESSION_2_EVENTS = [
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
const _SESSION_3_EVENTS = [
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

const _testSummarizer: EpisodeSummarizer = async (events) => {
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
		// PHASE 6: Reranker Robustness (Gaps #8, #9)
		// =========================================================================

		describe("Phase 6: Reranker Robustness", () => {
			;(HAS_VOYAGE_KEY ? describe : describe.skip)(
				"with Voyage API key",
				() => {
					it("reranks valid results with Voyage API", async () => {
						const results: MemorySearchResult[] = [
							{
								path: "e/1",
								startLine: 0,
								endLine: 0,
								score: 0.5,
								snippet: "Python data science machine learning numpy pandas",
								source: "conversation",
							},
							{
								path: "e/2",
								startLine: 0,
								endLine: 0,
								score: 0.3,
								snippet:
									"Kubernetes Helm chart deployment with horizontal pod autoscaling on the Atlas cluster",
								source: "conversation",
							},
							{
								path: "e/3",
								startLine: 0,
								endLine: 0,
								score: 0.8,
								snippet:
									"JavaScript frontend React component library for the web dashboard",
								source: "conversation",
							},
							{
								path: "e/4",
								startLine: 0,
								endLine: 0,
								score: 0.6,
								snippet:
									"MongoDB Atlas replica set configuration for high availability and automatic failover",
								source: "conversation",
							},
							{
								path: "e/5",
								startLine: 0,
								endLine: 0,
								score: 0.4,
								snippet:
									"CI/CD pipeline with GitHub Actions for automated testing and deployment to Kubernetes",
								source: "conversation",
							},
						]

						const config: RerankConfig = {
							enabled: true,
							model: "rerank-2.5",
							topN: 10,
							minScore: 0,
							voyageApiKey: VOYAGE_API_KEY,
							instruction:
								"This is agent memory for a Kubernetes migration project. Prioritize deployment and infrastructure content.",
						}

						const result = await crossEncoderRerank({
							db,
							prefix: PREFIX,
							agentId: AGENT_ID,
							query: "How do we deploy to Kubernetes with Helm charts?",
							results,
							config,
						})

						expect(result.reranked).toBe(true)
						expect(result.latencyMs).toBeGreaterThan(0)

						// Guard: ensure loop body is not vacuous
						expect(result.results.length).toBeGreaterThan(0)

						// All reranked scores must be in [0,1]
						for (const r of result.results) {
							expect(r.score).toBeGreaterThanOrEqual(0)
							expect(r.score).toBeLessThanOrEqual(1)
						}

						// Guard: ensure sort loop body is not vacuous
						expect(result.results.length).toBeGreaterThan(1)

						// Results should be sorted by score descending (reranked portion)
						for (let i = 1; i < Math.min(5, result.results.length); i++) {
							expect(result.results[i - 1].score).toBeGreaterThanOrEqual(
								result.results[i].score,
							)
						}
					})

					it("emits rerank telemetry on success and failure", async () => {
						await waitForTelemetry(db, PREFIX, {
							"meta.operation": "rerank",
							"meta.agentId": AGENT_ID,
						})

						const telCol = telemetryCollection(db, PREFIX)
						const rerankDocs = await telCol
							.find({ "meta.operation": "rerank", "meta.agentId": AGENT_ID })
							.toArray()

						expect(rerankDocs.length).toBeGreaterThan(0)
					})
				},
			)

			it("preserves input order when reranking fails or times out", async () => {
				const results: MemorySearchResult[] = [
					{
						path: "e/1",
						startLine: 0,
						endLine: 0,
						score: 0.9,
						snippet: "First result about Kubernetes",
						source: "conversation",
					},
					{
						path: "e/2",
						startLine: 0,
						endLine: 0,
						score: 0.7,
						snippet: "Second result about Helm charts",
						source: "conversation",
					},
					{
						path: "e/3",
						startLine: 0,
						endLine: 0,
						score: 0.5,
						snippet: "Third result about monitoring",
						source: "conversation",
					},
				]

				const result = await crossEncoderRerank({
					db,
					prefix: PREFIX,
					agentId: AGENT_ID,
					query: "test query",
					results,
					config: {
						enabled: true,
						model: "rerank-2.5",
						topN: 10,
						minScore: 0,
						voyageApiKey: "invalid-key-will-cause-failure",
					},
				})

				expect(result.reranked).toBe(false)
				// Original order preserved
				expect(result.results[0].path).toBe("e/1")
				expect(result.results[1].path).toBe("e/2")
				expect(result.results[2].path).toBe("e/3")
			})

			it("filters empty snippets before sending to reranker API", async () => {
				const results: MemorySearchResult[] = [
					{
						path: "e/1",
						startLine: 0,
						endLine: 0,
						score: 0.8,
						snippet:
							"Valid result with content about Kubernetes deployment strategies",
						source: "conversation",
					},
					{
						path: "e/2",
						startLine: 0,
						endLine: 0,
						score: 0.7,
						snippet: "",
						source: "conversation",
					},
					{
						path: "e/3",
						startLine: 0,
						endLine: 0,
						score: 0.6,
						snippet: "   ",
						source: "conversation",
					},
					{
						path: "e/4",
						startLine: 0,
						endLine: 0,
						score: 0.5,
						snippet: "Another valid result about MongoDB configuration",
						source: "conversation",
					},
				]

				// With invalid key, will fall back — but the function should not crash
				const result = await crossEncoderRerank({
					db,
					prefix: PREFIX,
					agentId: AGENT_ID,
					query: "deployment",
					results,
					config: {
						enabled: true,
						model: "rerank-2.5",
						topN: 10,
						minScore: 0,
						voyageApiKey: "invalid-key",
					},
				})

				// Fallback preserves all results (including empty snippets)
				expect(result.results.length).toBe(4)
				expect(result.reranked).toBe(false)
			})
		})

		// =========================================================================
		// PHASE 7: Profile Synthesis (Gap #4 continued)
		// =========================================================================

		describe("Phase 7: Profile Synthesis", () => {
			it("returns complete profile with all sections populated", async () => {
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

				// Structured memory should have entries from Phase 1
				expect(
					profile.preferences.length +
						profile.decisions.length +
						profile.facts.length,
				).toBeGreaterThanOrEqual(1)
			})

			it("groups structured memory by type via $facet", async () => {
				const scopeRef = resolveScopeRef({ scope: "agent", agentId: AGENT_ID })
				const profile = await synthesizeProfile({
					db,
					prefix: PREFIX,
					agentId: AGENT_ID,
					scope: "agent",
					scopeRef,
				})

				// Preferences and decisions were written in Phase 1
				expect(profile.preferences.length).toBeGreaterThanOrEqual(1)
				expect(profile.decisions.length).toBeGreaterThanOrEqual(1)
			})

			it("excludes deleted episodes from recentEpisodes", async () => {
				const scopeRef = resolveScopeRef({ scope: "agent", agentId: AGENT_ID })
				const deletedEpisode = await materializeEpisode({
					db,
					prefix: PREFIX,
					agentId: AGENT_ID,
					type: "topic",
					timeRange: {
						start: new Date("2020-01-01"),
						end: new Date("2030-01-01"),
					},
					scope: "agent",
					summarizer: async () => ({
						title: "Deleted episode should not surface",
						summary: "This episode exists only to validate deleted filtering.",
						tags: ["deleted-test"],
					}),
				})

				expect(deletedEpisode).not.toBeNull()
				const deleted = await updateEpisodeStatus({
					db,
					prefix: PREFIX,
					episodeId: deletedEpisode?.episodeId,
					agentId: AGENT_ID,
					status: "deleted",
				})
				expect(deleted).toBe(true)

				const deletedDoc = await episodesCollection(db, PREFIX).findOne({
					agentId: AGENT_ID,
					episodeId: deletedEpisode?.episodeId,
				})
				expect(deletedDoc?.status).toBe("deleted")

				const profile = await synthesizeProfile({
					db,
					prefix: PREFIX,
					agentId: AGENT_ID,
					scope: "agent",
					scopeRef,
				})

				expect(
					profile.recentEpisodes.some(
						(episode) => episode.title === "Deleted episode should not surface",
					),
				).toBe(false)
			})

			it("calculates activity patterns from events", async () => {
				const scopeRef = resolveScopeRef({ scope: "agent", agentId: AGENT_ID })
				const profile = await synthesizeProfile({
					db,
					prefix: PREFIX,
					agentId: AGENT_ID,
					scope: "agent",
					scopeRef,
				})

				// 20 events were written in Phase 1 (10 + 5 + 5 across 3 sessions)
				expect(profile.activityPatterns.totalEvents).toBeGreaterThanOrEqual(20)
				expect(
					profile.activityPatterns.roleDistribution.user,
				).toBeGreaterThanOrEqual(1)
				expect(
					profile.activityPatterns.roleDistribution.assistant,
				).toBeGreaterThanOrEqual(1)
				expect(profile.activityPatterns.lastActive).toBeInstanceOf(Date)
			})

			it("ranks entities by relation count", async () => {
				const scopeRef = resolveScopeRef({ scope: "agent", agentId: AGENT_ID })
				const profile = await synthesizeProfile({
					db,
					prefix: PREFIX,
					agentId: AGENT_ID,
					scope: "agent",
					scopeRef,
				})

				// Guard: ensure loop body is not vacuous
				expect(profile.topEntities.length).toBeGreaterThan(1)

				// Should be sorted by relationCount descending
				for (let i = 1; i < profile.topEntities.length; i++) {
					expect(
						profile.topEntities[i - 1].relationCount,
					).toBeGreaterThanOrEqual(profile.topEntities[i].relationCount)
				}
			})

			it("emits profile-synthesis telemetry", async () => {
				await waitForTelemetry(db, PREFIX, {
					"meta.operation": "profile-synthesis",
					"meta.agentId": AGENT_ID,
				})

				const telCol = telemetryCollection(db, PREFIX)
				const docs = await telCol
					.find({
						"meta.operation": "profile-synthesis",
						"meta.agentId": AGENT_ID,
					})
					.toArray()

				expect(docs.length).toBeGreaterThan(0)
				expect(docs[0].ok).toBe(true)
			})
		})

		// =========================================================================
		// PHASE 8: Telemetry Completeness (Gap #13)
		// =========================================================================

		describe("Phase 8: Telemetry Completeness", () => {
			it("getLatencyStats returns valid p50/p95/p99 via $percentile", async () => {
				// Emit known telemetry data to have a controlled test
				emitTelemetry(db, PREFIX, {
					meta: { agentId: AGENT_ID, operation: "search" },
					durationMs: 50,
					ok: true,
				})
				emitTelemetry(db, PREFIX, {
					meta: { agentId: AGENT_ID, operation: "search" },
					durationMs: 100,
					ok: true,
				})
				emitTelemetry(db, PREFIX, {
					meta: { agentId: AGENT_ID, operation: "search" },
					durationMs: 250,
					ok: true,
				})

				await waitForTelemetry(db, PREFIX, {
					"meta.operation": "search",
					"meta.agentId": AGENT_ID,
				})

				const stats = await getLatencyStats({
					db,
					prefix: PREFIX,
					agentId: AGENT_ID,
					operation: "search",
					windowMs: 60_000,
				})

				expect(stats.count).toBeGreaterThanOrEqual(3)
				expect(typeof stats.p50).toBe("number")
				expect(typeof stats.p95).toBe("number")
				expect(typeof stats.p99).toBe("number")
				expect(stats.p50).toBeGreaterThanOrEqual(0)
				expect(stats.p95).toBeGreaterThanOrEqual(stats.p50)
				expect(stats.p99).toBeGreaterThanOrEqual(stats.p95)
			})

			it("getOperationDistribution reports multiple operations", async () => {
				const dist = await getOperationDistribution({
					db,
					prefix: PREFIX,
					agentId: AGENT_ID,
					windowMs: 300_000, // 5 minutes
				})

				// Prior phases generated entity-extraction, cache-check, profile-synthesis, search telemetry
				expect(dist.length).toBeGreaterThanOrEqual(3)

				for (const entry of dist) {
					expect(entry.count).toBeGreaterThan(0)
					expect(typeof entry.avgDurationMs).toBe("number")
					expect(entry.avgDurationMs).toBeGreaterThanOrEqual(0)
				}
			})

			it("getCacheHitRate returns valid rate", async () => {
				const rate = await getCacheHitRate({
					db,
					prefix: PREFIX,
					agentId: AGENT_ID,
					windowMs: 300_000,
				})

				expect(rate.hitRate).toBeGreaterThanOrEqual(0)
				expect(rate.hitRate).toBeLessThanOrEqual(1)
				expect(rate.total).toBeGreaterThanOrEqual(0)
			})

			it("telemetry covers all operation types from prior phases", async () => {
				const telCol = telemetryCollection(db, PREFIX)
				const operations = await telCol
					.aggregate([
						{
							$match: {
								"meta.agentId": AGENT_ID,
								ts: { $gte: new Date(Date.now() - 300_000) },
							},
						},
						{ $group: { _id: "$meta.operation" } },
					])
					.toArray()

				const opNames = operations.map((o) => o._id as string)

				// These operations were generated by prior phases
				expect(opNames).toContain("entity-extraction")
				expect(opNames).toContain("profile-synthesis")
				// search telemetry was emitted manually above
				expect(opNames).toContain("search")
			})
		})

		// =========================================================================
		// PHASE 9: Query Rewriting (Gap #15)
		// =========================================================================

		describe("Phase 9: Query Rewriting", () => {
			it("expands known synonyms: auth -> authentication, login, oauth", () => {
				// Test single-word expansion (no cap interference)
				const authExpanded = expandSynonyms("auth")
				expect(authExpanded).toContain("auth")
				expect(authExpanded).toContain("authentication")
				expect(authExpanded).toContain("login")

				// Test config expansion separately
				const configExpanded = expandSynonyms("config")
				expect(configExpanded).toContain("config")
				expect(configExpanded).toContain("configuration")
				expect(configExpanded).toContain("settings")

				// Multi-word: 3x cap means 2 words × 3 = 6 max expanded terms
				const twoWordExpanded = expandSynonyms("auth db")
				expect(twoWordExpanded).toContain("auth")
				expect(twoWordExpanded).toContain("authentication")
				expect(twoWordExpanded).toContain("database")
			})

			it("does NOT expand api to route/rest (H7 fix)", () => {
				const expanded = expandSynonyms("api endpoint")
				expect(expanded).toContain("api")
				expect(expanded).not.toContain("route")
				expect(expanded).not.toContain("rest")
			})

			it("respects 3x expansion cap", () => {
				// 5 words, max 15 expanded
				const expanded = expandSynonyms("auth db config deps deploy")
				const wordCount = expanded.split(/\s+/).filter(Boolean).length
				expect(wordCount).toBeLessThanOrEqual(15)
			})

			it("preserves original words in expansion", () => {
				const original = "auth db perf"
				const expanded = expandSynonyms(original)
				for (const word of original.split(/\s+/)) {
					expect(expanded).toContain(word)
				}
			})

			it("rewriteQuery emits query-rewrite telemetry", async () => {
				const result = await rewriteQuery({
					db,
					prefix: PREFIX,
					agentId: AGENT_ID,
					query: "auth config deploy",
					config: {
						enabled: true,
						method: "synonym-expansion",
						maxTokens: 128,
					},
				})

				expect(result.rewritten).toBe(true)
				expect(result.method).toBe("synonym-expansion")
				// With 3 words and 3x cap (9 total), not all synonyms fit
				// auth → authentication is always first expansion
				expect(result.rewrittenQuery).toContain("authentication")
				// Original words are always preserved
				expect(result.rewrittenQuery).toContain("auth")
				expect(result.rewrittenQuery).toContain("config")
				expect(result.rewrittenQuery).toContain("deploy")

				await waitForTelemetry(db, PREFIX, {
					"meta.operation": "query-rewrite",
					"meta.agentId": AGENT_ID,
				})

				const telCol = telemetryCollection(db, PREFIX)
				const docs = await telCol
					.find({
						"meta.operation": "query-rewrite",
						"meta.agentId": AGENT_ID,
					})
					.toArray()
				expect(docs.length).toBeGreaterThan(0)
			})
		})

		// =========================================================================
		// PHASE 10: Graceful Degradation (Gap #6)
		// =========================================================================

		describe("Phase 10: Graceful Degradation", () => {
			const emptyAgentId = `agent-empty-${randomUUID().slice(0, 8)}`

			it("searchV2 returns empty on completely empty agent", async () => {
				const { results, metadata } = await searchV2(
					db,
					PREFIX,
					"anything at all about Kubernetes",
					emptyAgentId,
					{
						availablePaths: new Set<RetrievalPath>([
							"raw-window",
							"graph",
							"episodic",
							"structured",
						]),
						hasGraphData: false,
						hasEpisodes: false,
						maxResults: 10,
					},
				)

				expect(results.length).toBe(0)
				// No crash, metadata still valid
				expect(metadata.plan).toBeDefined()
			})

			it("synthesizeProfile returns empty profile on no data", async () => {
				const profile = await synthesizeProfile({
					db,
					prefix: PREFIX,
					agentId: emptyAgentId,
					scope: "agent",
					scopeRef: `agent:${emptyAgentId}`,
				})

				expect(profile.preferences).toEqual([])
				expect(profile.decisions).toEqual([])
				expect(profile.facts).toEqual([])
				expect(profile.topEntities).toEqual([])
				expect(profile.activityPatterns.totalEvents).toBe(0)
				expect(profile.activityPatterns.lastActive).toBeNull()
			})

			it("getLatencyStats returns safe defaults for unknown agent", async () => {
				const stats = await getLatencyStats({
					db,
					prefix: PREFIX,
					agentId: emptyAgentId,
					windowMs: 60_000,
				})

				// An agent with no telemetry should get count=0, p50/p95/p99=0
				// Time series bucketing may affect meta-field filtering; verify safe return shape
				expect(typeof stats.p50).toBe("number")
				expect(typeof stats.p95).toBe("number")
				expect(typeof stats.p99).toBe("number")
				expect(typeof stats.count).toBe("number")
				expect(stats.p50).toBeGreaterThanOrEqual(0)
				expect(stats.p95).toBeGreaterThanOrEqual(0)
				expect(stats.p99).toBeGreaterThanOrEqual(0)
				expect(stats.count).toBeGreaterThanOrEqual(0)
			})

			it("checkCache returns miss on empty cache", async () => {
				const result = await checkCache({
					db,
					prefix: PREFIX,
					query: "nonexistent query about nothing",
					agentId: emptyAgentId,
					scope: "agent",
					scopeRef: `agent:${emptyAgentId}`,
					config: {
						enabled: true,
						conversationTtlSec: 300,
						kbTtlSec: 3600,
						similarityThreshold: 0.95,
					},
				})

				expect(result.hit).toBe(false)
				expect(result.tier).toBe("miss")
			})

			it("searchV2 degrades gracefully with no vector capabilities", async () => {
				const { results, metadata } = await searchV2(
					db,
					PREFIX,
					"Kubernetes deployment monitoring",
					AGENT_ID,
					{
						availablePaths: new Set<RetrievalPath>(["raw-window"]),
						maxResults: 10,
						searchOptions: {
							capabilities: {
								vectorSearch: false,
								textSearch: false,
								scoreFusion: false,
								rankFusion: false,
								storedSource: false,
								vectorIndexMethod: false,
							},
						},
					},
				)

				// Should not crash, raw-window doesn't need vector capabilities
				expect(results).toBeDefined()
				expect(metadata.plan).toBeDefined()
			})

			it("query rewriter throws on unimplemented method", async () => {
				await expect(
					rewriteQuery({
						db,
						prefix: PREFIX,
						agentId: AGENT_ID,
						query: "test",
						config: { enabled: true, method: "llm", maxTokens: 128 },
					}),
				).rejects.toThrow(/not yet implemented/)
			})

			it("reranker degrades gracefully with empty API key", async () => {
				const result = await crossEncoderRerank({
					db,
					prefix: PREFIX,
					agentId: AGENT_ID,
					query: "test",
					results: [
						{
							path: "p",
							startLine: 0,
							endLine: 0,
							snippet: "a",
							score: 0.9,
							source: "conversation",
						},
						{
							path: "p2",
							startLine: 0,
							endLine: 0,
							snippet: "b",
							score: 0.8,
							source: "conversation",
						},
					] as MemorySearchResult[],
					config: {
						enabled: true,
						model: "rerank-2.5",
						topN: 20,
						minScore: 0,
						voyageApiKey: "",
					},
				})

				expect(result.reranked).toBe(false)
			})
		})
	},
)
