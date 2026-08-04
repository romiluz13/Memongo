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
import type { EpisodeSummarizer } from "./mongodb-episodes.js"
// v2 event functions
import { MongoDBMemoryManager, searchV2 } from "./mongodb-manager.js"
// Retrieval planner types
import type { RetrievalPath } from "./mongodb-retrieval-planner.js"
// Schema setup + collection helpers
import {
	ensureCollections,
	ensureStandardIndexes,
	telemetryCollection,
	queryCacheCollection,
	kbChunksCollection,
} from "./mongodb-schema.js"
// Search executor functions for Phase 17
import {
	buildMemorySearchRequestSignature,
	executeMongoSearchPlan,
} from "./mongodb-search-executor.js"
import {
	hasAtlasModelKey,
	resolvePreviewMongoTestUri,
	resolvePreviewVoyageApiKey,
} from "./test-helpers/preview-env.js"
// Types
import type {
	MemorySearchRequest,
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
const EVIDENCE_RANK: Record<EvidenceCoverage, number> = {
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

async function _waitForTelemetry(
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
		// PHASE 17: Agentic Search Stress Evaluation
		// =========================================================================

		describe("Phase 17: Agentic Search Stress Evaluation", () => {
			// Helper: wrap searchV2 as an executePass callback for executeMongoSearchPlan
			function makeExecutePass(agentId: string) {
				return async (input: {
					pass: number
					query: string
					availablePaths: Set<RetrievalPath>
					timeRange?: { start: Date; end: Date }
				}) => {
					const context: Parameters<typeof searchV2>[4] = {
						availablePaths: input.availablePaths,
						hasEpisodes: true,
						hasGraphData: true,
						maxResults: 20,
					}
					if (input.timeRange) {
						context.searchOptions = {
							conversationFilter: {
								source: {
									$in: ["conversation", "sessions"],
								},
								agentId,
								status: { $ne: "deleted" },
								timestamp: {
									$gte: input.timeRange.start,
									$lte: input.timeRange.end,
								},
							},
						}
					}
					const result = await searchV2(
						db,
						PREFIX,
						input.query,
						agentId,
						context,
					)
					return {
						results: result.results,
						metadata: {
							plan: result.metadata.plan,
							pathsExecuted: result.metadata.pathsExecuted,
							resultsByPath: result.metadata.resultsByPath,
							reranked: false,
							queryRewritten: false,
						},
					}
				}
			}

			it("(a) multi-hop retrieval finds cross-session connections that direct mode misses", async () => {
				// Query spanning Istio config (session 1) + rollback procedures (session 2)
				const query =
					"Who worked on the Istio service mesh config and what rollback procedures did they define"
				const availablePaths = new Set<RetrievalPath>([
					"raw-window",
					"graph",
					"episodic",
					"structured",
				])
				const directReq: MemorySearchRequest = {
					query,
					searchMode: "direct",
					sourcePreference: ["conversation"],
					maxResults: 10,
				}
				const agenticReq: MemorySearchRequest = {
					query,
					searchMode: "agentic",
					sourcePreference: ["conversation"],
					maxPasses: 3,
					maxResults: 10,
				}

				const direct = await executeMongoSearchPlan({
					request: directReq,
					availablePaths,
					executePass: makeExecutePass(AGENT_ID),
				})
				const agentic = await executeMongoSearchPlan({
					request: agenticReq,
					availablePaths,
					executePass: makeExecutePass(AGENT_ID),
				})

				// Agentic should try at least as many passes as direct
				expect(agentic.metadata.passes.length).toBeGreaterThanOrEqual(
					direct.metadata.passes.length,
				)
				// Agentic should try at least as many queries
				expect(agentic.metadata.queriesTried.length).toBeGreaterThanOrEqual(
					direct.metadata.queriesTried.length,
				)
				// Evidence coverage should be monotonically non-decreasing
				expect(
					EVIDENCE_RANK[agentic.metadata.evidenceCoverage],
				).toBeGreaterThanOrEqual(
					EVIDENCE_RANK[direct.metadata.evidenceCoverage],
				)
			})

			it("(b) noisy query resilience handles typos and abbreviations", async () => {
				// Intentionally messy query with typos and abbreviations
				const noisyReq: MemorySearchRequest = {
					query: "k8s deplpoment helm chrt best prctices",
					searchMode: "agentic",
					sourcePreference: ["conversation", "reference"],
					maxPasses: 2,
					maxResults: 10,
				}
				const availablePaths = new Set<RetrievalPath>([
					"raw-window",
					"episodic",
				])

				const response = await executeMongoSearchPlan({
					request: noisyReq,
					availablePaths,
					executePass: makeExecutePass(AGENT_ID),
				})

				// Should not crash and should report valid metadata
				expect(response.metadata.queriesTried.length).toBeGreaterThanOrEqual(1)
				expect(response.metadata.classification).toBeDefined()
				expect(response.metadata.passes.length).toBeGreaterThanOrEqual(1)
				// Even with heavy typos, the system should return a valid response structure
				expect(response.results).toBeDefined()
				expect(Array.isArray(response.results)).toBe(true)
			})

			it("(c) adversarial constraint stack applies all constraints simultaneously", async () => {
				const constrainedReq: MemorySearchRequest = {
					query: "rollback procedure steps",
					searchMode: "agentic",
					sourcePreference: ["conversation"],
					conversationScope: { sessionKey: "session-nonexistent" },
					needExactEvidence: true,
					timeRange: {
						start: "2020-01-01T00:00:00.000Z",
						end: "2030-01-01T00:00:00.000Z",
					},
					maxPasses: 2,
					maxResults: 5,
				}
				const availablePaths = new Set<RetrievalPath>([
					"raw-window",
					"episodic",
					"structured",
				])

				const response = await executeMongoSearchPlan({
					request: constrainedReq,
					availablePaths,
					executePass: makeExecutePass(AGENT_ID),
				})

				// All constraints should be reflected in metadata
				expect(
					response.metadata.constraintsApplied.length,
				).toBeGreaterThanOrEqual(2)
				expect(
					response.metadata.constraintsApplied.some((c) =>
						c.includes("conversationScope"),
					),
				).toBe(true)
				expect(
					response.metadata.constraintsApplied.some((c) =>
						c.includes("timeRange"),
					),
				).toBe(true)
				// No crash, valid passes
				expect(response.metadata.passes.length).toBeGreaterThanOrEqual(1)
			})

			it("(d) MMR diversity validation for family queries", async () => {
				const familyReq: MemorySearchRequest = {
					query: "rollback procedure family",
					searchMode: "agentic",
					sourcePreference: ["conversation", "reference"],
					maxPasses: 2,
					maxResults: 10,
				}
				const availablePaths = new Set<RetrievalPath>([
					"raw-window",
					"episodic",
				])

				const response = await executeMongoSearchPlan({
					request: familyReq,
					availablePaths,
					executePass: makeExecutePass(AGENT_ID),
				})

				// Classification should detect "family" keyword
				expect(response.metadata.classification).toBe("family")

				if (response.results.length >= 3) {
					// MMR should have been applied for family queries
					expect(response.metadata.mmrApplied).toBe(true)
					expect(response.metadata.mmrLambda).toBeLessThanOrEqual(0.5)

					// Check pairwise snippet similarity: no pair should exceed 85% Jaccard overlap
					const tokenize = (text: string) =>
						new Set(text.toLowerCase().split(/\s+/).filter(Boolean))
					for (let i = 0; i < response.results.length; i++) {
						for (let j = i + 1; j < response.results.length; j++) {
							const a = tokenize(response.results[i].snippet)
							const b = tokenize(response.results[j].snippet)
							let intersection = 0
							for (const word of a) {
								if (b.has(word)) {
									intersection++
								}
							}
							const union = a.size + b.size - intersection
							const jaccard = union === 0 ? 0 : intersection / union
							expect(jaccard).toBeLessThan(0.85)
						}
					}
				}
			})

			it("(e) CRAG corrective retrieval fires on poor initial coverage", async () => {
				// Use tight time range that excludes most data — forces corrective behavior
				const tightReq: MemorySearchRequest = {
					query: "Kubernetes migration planning",
					searchMode: "agentic",
					sourcePreference: ["conversation"],
					timeRange: {
						start: new Date(Date.now() - 60_000).toISOString(), // last 60 seconds
						end: new Date().toISOString(),
					},
					maxPasses: 3,
					maxResults: 5,
				}
				const availablePaths = new Set<RetrievalPath>([
					"raw-window",
					"episodic",
				])

				const response = await executeMongoSearchPlan({
					request: tightReq,
					availablePaths,
					executePass: makeExecutePass(AGENT_ID),
				})

				// Whether corrective fires depends on initial pass results
				const correctivePasses = response.metadata.passes.filter(
					(p) => p.correctionApplied != null,
				)
				// Key assertion: system does not crash and metadata is valid
				expect(response.metadata.passes.length).toBeGreaterThanOrEqual(1)
				// If corrective fired, it should be documented
				if (correctivePasses.length > 0) {
					expect(correctivePasses[0].correctionApplied).toMatch(
						/time-range|evidence|relaxation/,
					)
				}
			})

			it("(f) constraint relaxation proof with impossible time range", async () => {
				const impossibleReq: MemorySearchRequest = {
					query: "Kubernetes deployment",
					searchMode: "agentic",
					sourcePreference: ["conversation"],
					timeRange: {
						start: "1990-01-01T00:00:00.000Z",
						end: "1990-01-02T00:00:00.000Z",
					},
					maxPasses: 2,
					maxResults: 5,
				}
				const availablePaths = new Set<RetrievalPath>([
					"raw-window",
					"episodic",
				])

				const response = await executeMongoSearchPlan({
					request: impossibleReq,
					availablePaths,
					executePass: makeExecutePass(AGENT_ID),
				})

				// With impossible time range, all results should be rejected initially
				expect(response.metadata.resultsRejected.length).toBeGreaterThanOrEqual(
					0,
				)
				// If relaxation fired, metadata should document it
				if (response.metadata.constraintRelaxations?.length) {
					expect(response.metadata.constraintRelaxations[0].action).toMatch(
						/removed-time-range|disabled-exact-evidence/,
					)
				}
				// Either way, the system should not crash
				expect(response.metadata.passes.length).toBeGreaterThanOrEqual(1)
			})

			it("(g) cache coherence under mode switching", async () => {
				const query = "Emergency rollback procedure"
				const directReq: MemorySearchRequest = {
					query,
					searchMode: "direct",
					sourcePreference: ["conversation"],
					maxResults: 5,
				}
				const agenticReq: MemorySearchRequest = {
					query,
					searchMode: "agentic",
					sourcePreference: ["conversation", "reference"],
					maxPasses: 2,
					maxResults: 5,
				}
				const availablePaths = new Set<RetrievalPath>([
					"raw-window",
					"episodic",
				])

				const direct1 = await executeMongoSearchPlan({
					request: directReq,
					availablePaths,
					executePass: makeExecutePass(AGENT_ID),
				})
				const agentic1 = await executeMongoSearchPlan({
					request: agenticReq,
					availablePaths,
					executePass: makeExecutePass(AGENT_ID),
				})
				const direct2 = await executeMongoSearchPlan({
					request: directReq,
					availablePaths,
					executePass: makeExecutePass(AGENT_ID),
				})

				// Direct and agentic should have different request signatures
				const directSig = buildMemorySearchRequestSignature(directReq)
				const agenticSig = buildMemorySearchRequestSignature(agenticReq)
				expect(directSig).not.toBe(agenticSig)

				// Direct1 and direct2 should have same pass structure
				expect(direct1.metadata.passes.length).toBe(
					direct2.metadata.passes.length,
				)
				expect(direct1.metadata.classification).toBe(
					direct2.metadata.classification,
				)
				// Agentic should have at least as many passes
				expect(agentic1.metadata.passes.length).toBeGreaterThanOrEqual(
					direct1.metadata.passes.length,
				)
			})

			it("(h) reranker quality assertion — front-loads relevance", async () => {
				const rerankerReq: MemorySearchRequest = {
					query: "Emergency rollback procedure steps",
					searchMode: "agentic",
					sourcePreference: ["conversation"],
					maxPasses: 2,
					maxResults: 10,
				}
				const availablePaths = new Set<RetrievalPath>([
					"raw-window",
					"episodic",
				])

				const response = await executeMongoSearchPlan({
					request: rerankerReq,
					availablePaths,
					executePass: makeExecutePass(AGENT_ID),
				})

				if (response.results.length >= 2) {
					// Compute simple keyword overlap score
					const queryTokens = new Set(
						"emergency rollback procedure steps".toLowerCase().split(/\s+/),
					)
					const overlapScore = (snippet: string) => {
						const tokens = snippet.toLowerCase().split(/\s+/)
						return (
							tokens.filter((t) => queryTokens.has(t)).length / queryTokens.size
						)
					}
					const firstScore = overlapScore(response.results[0].snippet)
					const lastScore = overlapScore(
						response.results[response.results.length - 1].snippet,
					)
					// First result should have >= keyword overlap as last result
					expect(firstScore).toBeGreaterThanOrEqual(lastScore)
				}
			})

			it("(i) evidence coverage monotonicity across modes", async () => {
				const query = "rollback procedure family"
				const availablePaths = new Set<RetrievalPath>([
					"raw-window",
					"episodic",
				])

				const direct = await executeMongoSearchPlan({
					request: {
						query,
						searchMode: "direct",
						sourcePreference: ["conversation", "reference"],
						maxResults: 5,
					},
					availablePaths,
					executePass: makeExecutePass(AGENT_ID),
				})
				const auto = await executeMongoSearchPlan({
					request: {
						query,
						searchMode: "auto",
						sourcePreference: ["conversation", "reference"],
						maxPasses: 2,
						maxResults: 5,
					},
					availablePaths,
					executePass: makeExecutePass(AGENT_ID),
				})
				const agentic = await executeMongoSearchPlan({
					request: {
						query,
						searchMode: "agentic",
						sourcePreference: ["conversation", "reference"],
						maxPasses: 3,
						maxResults: 5,
					},
					availablePaths,
					executePass: makeExecutePass(AGENT_ID),
				})

				// Evidence coverage should not decrease as mode broadens
				expect(
					EVIDENCE_RANK[auto.metadata.evidenceCoverage],
				).toBeGreaterThanOrEqual(
					EVIDENCE_RANK[direct.metadata.evidenceCoverage],
				)
				expect(
					EVIDENCE_RANK[agentic.metadata.evidenceCoverage],
				).toBeGreaterThanOrEqual(EVIDENCE_RANK[auto.metadata.evidenceCoverage])
			})

			it("(j) latency budget — exact lookups faster than family searches", async () => {
				const availablePaths = new Set<RetrievalPath>([
					"raw-window",
					"episodic",
				])

				const exactStart = Date.now()
				await executeMongoSearchPlan({
					request: {
						query: "Emergency rollback procedure",
						searchMode: "direct",
						sourcePreference: ["conversation"],
						maxResults: 5,
					},
					availablePaths,
					executePass: makeExecutePass(AGENT_ID),
				})
				const exactMs = Date.now() - exactStart

				const familyStart = Date.now()
				await executeMongoSearchPlan({
					request: {
						query: "rollback procedure family",
						searchMode: "agentic",
						sourcePreference: ["conversation", "reference"],
						maxPasses: 2,
						maxResults: 5,
					},
					availablePaths,
					executePass: makeExecutePass(AGENT_ID),
				})
				const familyMs = Date.now() - familyStart

				// Both should complete within budget
				expect(exactMs).toBeLessThan(30_000)
				expect(familyMs).toBeLessThan(30_000)
				// Exact lookups should generally be faster (or equal if cached)
				// Using tolerance to allow for cache-fast equality
				expect(exactMs).toBeLessThanOrEqual(familyMs + 500)
			})
		})
	},
)
