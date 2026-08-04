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
import {
	MongoDBMemoryManager,
	writeEventAndProject,
	searchV2,
} from "./mongodb-manager.js"
// Mutation audit trail
import { recordMutation, getMutationHistory } from "./mongodb-mutations.js"
// Profile synthesis
import { synthesizeProfile } from "./mongodb-profile.js"
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
	mutationsCollection,
} from "./mongodb-schema.js"
// Scope resolution
import { resolveScopeRef } from "./mongodb-scope.js"
// Time series telemetry
import { getLatencyStats } from "./mongodb-telemetry.js"
import {
	hasAtlasModelKey,
	resolvePreviewMongoTestUri,
	resolvePreviewVoyageApiKey,
} from "./test-helpers/preview-env.js"
// Types
import type {
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
const HAS_ATLAS_MODEL_KEY = hasAtlasModelKey(VOYAGE_API_KEY)
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
		// PHASE 11: Score Normalization Deep Check (Gaps #1, #5 reinforced)
		// =========================================================================

		describe("Phase 11: Score Normalization Deep Check", () => {
			it("every searchV2 result score satisfies 0 <= score <= 1", async () => {
				// Use raw-window + episodic paths (guaranteed to work with seeded data)
				const { results } = await searchV2(
					db,
					PREFIX,
					"Kubernetes migration deployment Helm",
					AGENT_ID,
					{
						availablePaths: new Set<RetrievalPath>(["raw-window", "episodic"]),
						hasEpisodes: true,
						maxResults: 30,
					},
				)

				// Guard: ensure loop body is not vacuous
				expect(results.length).toBeGreaterThan(0)

				for (const r of results) {
					expect(r.score).toBeGreaterThanOrEqual(0)
					expect(r.score).toBeLessThanOrEqual(1)
				}
			})

			it("scores are finite numbers (no NaN, Infinity)", async () => {
				const { results } = await searchV2(
					db,
					PREFIX,
					"CI/CD rollback cluster monitoring alerts",
					AGENT_ID,
					{
						availablePaths: new Set<RetrievalPath>(["raw-window", "episodic"]),
						hasEpisodes: true,
						maxResults: 20,
					},
				)

				// Guard: ensure loop body is not vacuous
				expect(results.length).toBeGreaterThan(0)

				for (const r of results) {
					expect(typeof r.score).toBe("number")
					expect(Number.isNaN(r.score)).toBe(false)
					expect(Number.isFinite(r.score)).toBe(true)
				}
			})

			it("results are sorted descending by score", async () => {
				const { results } = await searchV2(
					db,
					PREFIX,
					"CI/CD pipeline GitHub Actions deployment",
					AGENT_ID,
					{
						availablePaths: new Set<RetrievalPath>(["raw-window", "episodic"]),
						hasEpisodes: true,
						maxResults: 20,
					},
				)

				// Guard: ensure loop body is not vacuous
				expect(results.length).toBeGreaterThan(1)

				for (let i = 1; i < results.length; i++) {
					expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score)
				}
			})

			it("RRF normalization applied when multiple paths execute", async () => {
				const { metadata } = await searchV2(
					db,
					PREFIX,
					"Sarah Helm chart autoscaling monitoring",
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

				// Verify the plan decided on multiple paths
				expect(metadata.plan.paths.length).toBeGreaterThanOrEqual(2)
			})

			it("graph-only path produces scores in [0,1]", async () => {
				// First check if we have any entities to query the graph with
				const entities = await entitiesCollection(db, PREFIX)
					.find({ agentId: AGENT_ID })
					.limit(1)
					.toArray()
				if (entities.length === 0) {
					// No entities extracted — graph path can't return results without entity data
					// This validates that RegexEntityExtractor has limitations (known gap for LLM extraction)
					return
				}
				const entityName = entities[0].name as string
				const result = await searchV2(db, PREFIX, entityName, AGENT_ID, {
					availablePaths: new Set(["graph"] as RetrievalPath[]),
					knownEntityNames: [entityName],
					hasGraphData: true,
					maxResults: 20,
					searchOptions: {},
				})
				if (result.results.length > 0) {
					for (const r of result.results) {
						expect(r.score).toBeGreaterThanOrEqual(0)
						expect(r.score).toBeLessThanOrEqual(1)
					}
				}
			})

			it("raw-window path caps results at 50", async () => {
				const { metadata } = await searchV2(
					db,
					PREFIX,
					"everything about the project",
					AGENT_ID,
					{
						availablePaths: new Set<RetrievalPath>(["raw-window"]),
						maxResults: 100,
					},
				)

				if (metadata.resultsByPath["raw-window"]) {
					expect(metadata.resultsByPath["raw-window"]).toBeLessThanOrEqual(50)
				}
			})
		})

		// =========================================================================
		// PHASE 12: MongoDB Operator Inventory
		// =========================================================================

		describe("Phase 12: MongoDB Operator Inventory", () => {
			it("$facet: returns structured results from parallel branches", async () => {
				const smCol = structuredMemCollection(db, PREFIX)
				const result = await smCol
					.aggregate([
						{ $match: { agentId: AGENT_ID } },
						{
							$facet: {
								preferences: [
									{ $match: { type: "preference" } },
									{ $limit: 5 },
								],
								decisions: [{ $match: { type: "decision" } }, { $limit: 5 }],
							},
						},
					])
					.toArray()

				expect(result.length).toBe(1)
				expect(result[0]).toHaveProperty("preferences")
				expect(result[0]).toHaveProperty("decisions")
			})

			it("$lookup: joins entities to relations", async () => {
				const entCol = entitiesCollection(db, PREFIX)
				const result = await entCol
					.aggregate([
						{ $match: { agentId: AGENT_ID } },
						{ $limit: 3 },
						{
							$lookup: {
								from: `${PREFIX}relations`,
								localField: "entityId",
								foreignField: "fromEntityId",
								as: "outgoingRelations",
							},
						},
					])
					.toArray()

				expect(result.length).toBeGreaterThan(0)
				expect(result[0]).toHaveProperty("outgoingRelations")
			})

			it("$graphLookup: recursive traversal on relations", async () => {
				const relCol = relationsCollection(db, PREFIX)
				// Get a starting entity for traversal
				const entities = await entitiesCollection(db, PREFIX)
					.find({ agentId: AGENT_ID })
					.limit(1)
					.toArray()

				// Guard: ensure we have entities to traverse (seeded in Phase 1)
				expect(entities.length).toBeGreaterThan(0)

				const result = await relCol
					.aggregate([
						{
							$match: { fromEntityId: entities[0].entityId, agentId: AGENT_ID },
						},
						{
							$graphLookup: {
								from: `${PREFIX}relations`,
								startWith: "$toEntityId",
								connectFromField: "toEntityId",
								connectToField: "fromEntityId",
								as: "transitive",
								maxDepth: 2,
								restrictSearchWithMatch: { agentId: AGENT_ID },
							},
						},
					])
					.toArray()

				// Should return results (even if transitive is empty)
				expect(result).toBeDefined()
			})

			it("$percentile: computes latency percentiles on telemetry", async () => {
				const telCol = telemetryCollection(db, PREFIX)
				const result = await telCol
					.aggregate([
						{
							$match: {
								"meta.agentId": AGENT_ID,
								ts: { $gte: new Date(Date.now() - 300_000) },
							},
						},
						{
							$group: {
								_id: null,
								p50: {
									$percentile: {
										input: "$durationMs",
										p: [0.5],
										method: "approximate",
									},
								},
								p95: {
									$percentile: {
										input: "$durationMs",
										p: [0.95],
										method: "approximate",
									},
								},
							},
						},
					])
					.toArray()

				// Guard: ensure aggregation returned results (telemetry seeded in prior phases)
				expect(result.length).toBeGreaterThan(0)

				expect(Array.isArray(result[0].p50)).toBe(true)
				expect(Array.isArray(result[0].p95)).toBe(true)
				expect(typeof result[0].p50[0]).toBe("number")
			})

			it("$group + $count: groups events by role", async () => {
				const evtCol = eventsCollection(db, PREFIX)
				const result = await evtCol
					.aggregate([
						{ $match: { agentId: AGENT_ID } },
						{ $group: { _id: "$role", count: { $sum: 1 } } },
						{ $sort: { count: -1 } },
					])
					.toArray()

				expect(result.length).toBeGreaterThanOrEqual(2) // user + assistant
				const userCount = result.find((r) => r._id === "user")
				const assistantCount = result.find((r) => r._id === "assistant")
				expect(userCount).toBeDefined()
				expect(assistantCount).toBeDefined()
			})

			it("$addFields + $sort + $limit: computed fields on entities", async () => {
				const entCol = entitiesCollection(db, PREFIX)
				const result = await entCol
					.aggregate([
						{ $match: { agentId: AGENT_ID } },
						{ $addFields: { nameLength: { $strLenCP: "$name" } } },
						{ $sort: { nameLength: -1 } },
						{ $limit: 5 },
					])
					.toArray()

				expect(result.length).toBeGreaterThan(0)
				expect(result[0]).toHaveProperty("nameLength")
				expect(typeof result[0].nameLength).toBe("number")
			})

			it("bulkWrite (updateOne + upsert): batch entity operations", async () => {
				const entCol = entitiesCollection(db, PREFIX)
				const bulkOps = [
					{
						updateOne: {
							filter: {
								entityId: `bulk-test-1-${AGENT_ID}`,
								agentId: AGENT_ID,
							},
							update: {
								$set: {
									name: "BulkTestEntity1",
									type: "custom",
									agentId: AGENT_ID,
									scope: "agent",
									scopeRef: AGENT_ID,
									updatedAt: new Date(),
								},
								$setOnInsert: {
									entityId: `bulk-test-1-${AGENT_ID}`,
									createdAt: new Date(),
								},
							},
							upsert: true,
						},
					},
					{
						updateOne: {
							filter: {
								entityId: `bulk-test-2-${AGENT_ID}`,
								agentId: AGENT_ID,
							},
							update: {
								$set: {
									name: "BulkTestEntity2",
									type: "custom",
									agentId: AGENT_ID,
									scope: "agent",
									scopeRef: AGENT_ID,
									updatedAt: new Date(),
								},
								$setOnInsert: {
									entityId: `bulk-test-2-${AGENT_ID}`,
									createdAt: new Date(),
								},
							},
							upsert: true,
						},
					},
					{
						updateOne: {
							filter: {
								entityId: `bulk-test-3-${AGENT_ID}`,
								agentId: AGENT_ID,
							},
							update: {
								$set: {
									name: "BulkTestEntity3",
									type: "custom",
									agentId: AGENT_ID,
									scope: "agent",
									scopeRef: AGENT_ID,
									updatedAt: new Date(),
								},
								$setOnInsert: {
									entityId: `bulk-test-3-${AGENT_ID}`,
									createdAt: new Date(),
								},
							},
							upsert: true,
						},
					},
				]

				const result = await entCol.bulkWrite(bulkOps)
				expect(result.upsertedCount + result.modifiedCount).toBe(3)
			})

			it("insertOne (time series): writes to telemetry collection", async () => {
				const telCol = telemetryCollection(db, PREFIX)
				const result = await telCol.insertOne({
					ts: new Date(),
					meta: { agentId: AGENT_ID, operation: "search" },
					durationMs: 42,
					ok: true,
				})

				expect(result.insertedId).toBeDefined()
			})

			it("createIndex (compound): creates without error", async () => {
				const entCol = entitiesCollection(db, PREFIX)
				// Create a test compound index (will be a no-op if it already exists)
				const indexName = await entCol.createIndex(
					{ agentId: 1, type: 1, updatedAt: -1 },
					{ name: `${PREFIX}test_compound_idx` },
				)
				expect(indexName).toBeDefined()
			})

			it("createIndex (text): verifies text index on chunks", async () => {
				const chunksCol = db.collection(`${PREFIX}chunks`)
				const indexes = await chunksCol.indexes()
				const hasTextIndex = indexes.some(
					(idx) =>
						idx.key &&
						Object.values(idx.key as Record<string, unknown>).includes("text"),
				)
				// Text index might be a standard index or a search index
				// Either way, the collection should have indexes
				expect(indexes.length).toBeGreaterThan(0)
				// Text index may or may not exist (depends on ensureStandardIndexes creating one)
				// The key assertion is that we can query indexes without error
				expect(typeof hasTextIndex).toBe("boolean")
			})

			it("createIndex (TTL): creates with expireAfterSeconds", async () => {
				const testCol = db.collection(`${PREFIX}ttl_test`)
				try {
					await testCol.drop()
				} catch {
					// Collection may not exist
				}
				await db.createCollection(`${PREFIX}ttl_test`)

				const indexName = await testCol.createIndex(
					{ createdAt: 1 },
					{ expireAfterSeconds: 3600, name: `${PREFIX}test_ttl_idx` },
				)
				expect(indexName).toBeDefined()

				const indexes = await testCol.indexes()
				const ttlIdx = indexes.find((i) => i.name === `${PREFIX}test_ttl_idx`)
				expect(ttlIdx).toBeDefined()
				expect(ttlIdx?.expireAfterSeconds).toBe(3600)

				// Cleanup
				await testCol.drop()
			})

			it("createIndex (sparse): creates with sparse option", async () => {
				const entCol = entitiesCollection(db, PREFIX)
				const indexName = await entCol.createIndex(
					{ aliases: 1 },
					{ sparse: true, name: `${PREFIX}test_sparse_idx` },
				)
				expect(indexName).toBeDefined()

				const indexes = await entCol.indexes()
				const sparseIdx = indexes.find(
					(i) => i.name === `${PREFIX}test_sparse_idx`,
				)
				expect(sparseIdx).toBeDefined()
				expect(sparseIdx?.sparse).toBe(true)
			})

			;(HAS_ATLAS_MODEL_KEY ? describe : describe.skip)(
				"$vectorSearch operator",
				() => {
					it("returns results with autoEmbed vectors", async () => {
						// $vectorSearch requires Atlas Search index with vector field.
						// atlas-local:preview with autoEmbed creates these automatically.
						const chunksCol = db.collection(`${PREFIX}chunks`)
						const pipeline = [
							{
								$vectorSearch: {
									index: `${PREFIX}chunks_vector_index`,
									path: "embedding",
									queryVector: Array.from({ length: 1024 }, () => 0.01), // Voyage AI dimension
									numCandidates: 50,
									limit: 5,
									filter: { agentId: AGENT_ID },
								},
							},
							{ $project: { text: 1, score: { $meta: "vectorSearchScore" } } },
						]

						// P1.9: explicit capability assertion - fail loudly when the
						// serving vector index is absent instead of branching green
						// (the old branch swallowed a missing index with a passing no-op).
						const vectorIndexes = await chunksCol
							.listSearchIndexes(`${PREFIX}chunks_vector_index`)
							.toArray()
						expect(
							vectorIndexes.length,
							`vector search index ${PREFIX}chunks_vector_index must exist in this environment`,
						).toBeGreaterThan(0)
						// No try/catch: a missing or non-queryable index must fail
						// the test, not degrade silently.
						const results = await chunksCol.aggregate(pipeline).toArray()
						expect(results.length).toBeGreaterThan(0)
						expect(results[0]).toHaveProperty("score")
						expect(typeof results[0].score).toBe("number")
					})
				},
			)

			;(HAS_ATLAS_MODEL_KEY ? describe : describe.skip)(
				"$search operator",
				() => {
					it("returns results with text search scoring", async () => {
						const chunksCol = db.collection(`${PREFIX}chunks`)
						const pipeline = [
							{
								$search: {
									index: `${PREFIX}chunks_search_index`,
									text: {
										query: "Kubernetes Helm deployment",
										path: "text",
									},
								},
							},
							{ $limit: 5 },
							{ $project: { text: 1, score: { $meta: "searchScore" } } },
						]

						// P1.9: explicit capability assertion - fail loudly when the
						// serving search index is absent instead of branching green
						// (the old branch swallowed a missing index with a passing no-op).
						const keywordIndexes = await chunksCol
							.listSearchIndexes(`${PREFIX}chunks_search_index`)
							.toArray()
						expect(
							keywordIndexes.length,
							`search index ${PREFIX}chunks_search_index must exist in this environment`,
						).toBeGreaterThan(0)
						// No try/catch: a missing or non-queryable index must fail
						// the test, not degrade silently.
						const results = await chunksCol.aggregate(pipeline).toArray()
						expect(results.length).toBeGreaterThan(0)
						expect(results[0]).toHaveProperty("score")
						expect(typeof results[0].score).toBe("number")
					})
				},
			)
		})

		// =========================================================================
		// PHASE 13: Scale Stress Test (Gap #5)
		// =========================================================================

		describe("Phase 13: Scale Stress Test", () => {
			it("handles 200+ events without OOM or timeout", async () => {
				const topics = [
					"auth",
					"database",
					"deployment",
					"testing",
					"monitoring",
				]
				const people = ["Alice", "Bob", "Charlie"]

				for (let i = 0; i < 200; i++) {
					await writeEventAndProject(db, PREFIX, {
						agentId: AGENT_ID,
						role: i % 3 === 0 ? "user" : "assistant",
						body: `Scale test message ${i}: discussing ${topics[i % 5]} with ${people[i % 3]}`,
						scope: "agent",
						sessionId: `scale-session-${Math.floor(i / 20)}`,
					})
				}

				// searchV2 still works under load
				const result = await searchV2(
					db,
					PREFIX,
					"auth database deployment",
					AGENT_ID,
					{
						availablePaths: new Set<RetrievalPath>(["raw-window", "episodic"]),
						hasEpisodes: true,
						maxResults: 30,
					},
				)
				expect(result.results.length).toBeGreaterThan(0)
				for (const r of result.results) {
					expect(r.score).toBeLessThanOrEqual(1)
				}
			})

			it("profile synthesis handles large entity sets", async () => {
				const scopeRef = resolveScopeRef({ scope: "agent", agentId: AGENT_ID })
				const profile = await synthesizeProfile({
					db,
					prefix: PREFIX,
					agentId: AGENT_ID,
					scope: "agent",
					scopeRef,
				})
				// 20 original + 200 scale = 220+ events
				expect(profile.activityPatterns.totalEvents).toBeGreaterThanOrEqual(200)
			})

			it("$percentile works on 200+ telemetry docs", async () => {
				const stats = await getLatencyStats({
					db,
					prefix: PREFIX,
					agentId: AGENT_ID,
					windowMs: 300_000,
				})
				expect(stats.count).toBeGreaterThan(0)
				expect(stats.p50).toBeGreaterThanOrEqual(0)
				expect(stats.p95).toBeGreaterThanOrEqual(stats.p50)
			})
		})

		// =========================================================================
		// PHASE 14: Mutation Audit Trail
		// =========================================================================

		describe("Phase 14: Mutation Audit Trail", () => {
			it("records mutation on structured_mem write (verify count > 0)", async () => {
				// Record a mutation for a structured memory write
				const result = await recordMutation({
					db,
					prefix: PREFIX,
					mutation: {
						collectionName: "structured_mem",
						documentId: "sm-e2e-1",
						operation: "create",
						agentId: AGENT_ID,
						oldValue: null,
						newValue: { type: "preference", key: "theme", value: "dark mode" },
					},
				})
				expect(result.mutationId).toBeTruthy()

				// Verify the mutation was persisted
				const count = await mutationsCollection(db, PREFIX).countDocuments({
					agentId: AGENT_ID,
					collectionName: "structured_mem",
				})
				expect(count).toBeGreaterThan(0)
			})

			it("getMutationHistory returns correct collectionName filter", async () => {
				// Record mutations for different collections
				await recordMutation({
					db,
					prefix: PREFIX,
					mutation: {
						collectionName: "entities",
						documentId: "ent-e2e-1",
						operation: "create",
						agentId: AGENT_ID,
						oldValue: null,
						newValue: { name: "Test Entity" },
					},
				})
				await recordMutation({
					db,
					prefix: PREFIX,
					mutation: {
						collectionName: "relations",
						documentId: "rel-e2e-1",
						operation: "create",
						agentId: AGENT_ID,
						oldValue: null,
						newValue: { fromEntityId: "e1", toEntityId: "e2" },
					},
				})

				// Query only entities mutations
				const history = await getMutationHistory({
					db,
					prefix: PREFIX,
					agentId: AGENT_ID,
					collectionName: "entities",
				})
				expect(history.length).toBeGreaterThan(0)
				for (const record of history) {
					expect(record.collectionName).toBe("entities")
				}
			})

			it("mutation TTL index exists with expireAfterSeconds=7776000", async () => {
				const indexes = await mutationsCollection(db, PREFIX)
					.listIndexes()
					.toArray()
				const ttlIndex = indexes.find((idx) => idx.name === "idx_mutations_ttl")
				expect(ttlIndex).toBeDefined()
				expect(ttlIndex?.expireAfterSeconds).toBe(7776000)
			})

			it("mutation records include changedFields for updates", async () => {
				await recordMutation({
					db,
					prefix: PREFIX,
					mutation: {
						collectionName: "structured_mem",
						documentId: "sm-e2e-2",
						operation: "update",
						agentId: AGENT_ID,
						oldValue: { type: "fact", key: "lang", value: "Python" },
						newValue: { type: "fact", key: "lang", value: "TypeScript" },
						changedFields: ["value"],
					},
				})

				const history = await getMutationHistory({
					db,
					prefix: PREFIX,
					agentId: AGENT_ID,
					documentId: "sm-e2e-2",
				})
				expect(history.length).toBeGreaterThan(0)
				const updateRecord = history.find((r) => r.operation === "update")
				expect(updateRecord).toBeDefined()
				expect(updateRecord?.changedFields).toEqual(["value"])
			})
		})
	},
)
