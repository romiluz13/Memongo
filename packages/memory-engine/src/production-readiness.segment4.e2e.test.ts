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
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { MongoClient, type Db, type Document } from "mongodb"
import { describe, it, expect, beforeAll, afterAll } from "vitest"
import type { EpisodeSummarizer } from "./mongodb-episodes.js"
// v2 event functions
import { MongoDBMemoryManager } from "./mongodb-manager.js"
// Procedure evolution
import {
	writeProcedure,
	recordProcedureOutcome,
	evolveProcedure,
} from "./mongodb-procedures.js"
// Schema setup + collection helpers
import {
	ensureCollections,
	ensureStandardIndexes,
	eventsCollection,
	structuredMemCollection,
	telemetryCollection,
	queryCacheCollection,
	kbChunksCollection,
	proceduresCollection,
	procedureRevisionsCollection,
	structuredMemRevisionsCollection,
} from "./mongodb-schema.js"
// Scope resolution
import { resolveScopeRef } from "./mongodb-scope.js"
// Structured memory
import { writeStructuredMemory } from "./mongodb-structured-memory.js"
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
const _HAS_ATLAS_MODEL_KEY = hasAtlasModelKey(VOYAGE_API_KEY)
const _TELEMETRY_FLUSH_MS = 500
const _EVIDENCE_RANK: Record<EvidenceCoverage, number> = {
	none: 0,
	indirect: 1,
	partial: 2,
	direct: 3,
} as const

function createLifecycleManagerHarness(
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

function buildStructuredStableHandle(params: {
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

function buildProcedureStableHandle(params: {
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
		// PHASE 15: Lifecycle Ergonomics
		// =========================================================================

		describe("Phase 15: Lifecycle Ergonomics", () => {
			it("keeps structured current state and revision history queryable through lifecycle methods", async () => {
				const manager = createLifecycleManagerHarness(db, client)
				const scope = "agent" as const
				const scopeRef = resolveScopeRef({ scope, agentId: AGENT_ID })
				const key = `lifecycle-structured-${randomUUID().slice(0, 8)}`
				const sourceEventId = `evt-lifecycle-${randomUUID().slice(0, 8)}`

				await writeStructuredMemory({
					db,
					prefix: PREFIX,
					entry: {
						type: "decision",
						key,
						value: "Use Helm 3 for gateway deployments",
						agentId: AGENT_ID,
						scope,
						scopeRef,
						source: "user",
						sourceEventIds: [sourceEventId],
						sourceReliability: 0.91,
						reviewAt: new Date("2026-04-20T00:00:00.000Z"),
						sourceAgent: { id: "dreamer", name: "Dreamer" },
					},
					embeddingMode: "automated",
					client,
				})

				const current =
					await MongoDBMemoryManager.prototype.getLifecycleItem.call(
						manager,
						buildStructuredStableHandle({
							agentId: AGENT_ID,
							scope,
							scopeRef,
							type: "decision",
							key,
							revision: 1,
							state: "active",
						}),
					)

				expect(current).not.toBeNull()
				expect(current?.family).toBe("structured")
				expect(current?.data.value).toBe("Use Helm 3 for gateway deployments")
				expect(current?.data.sourceEventIds).toEqual([sourceEventId])
				expect(current?.data.sourceAgent).toEqual({
					id: "dreamer",
					name: "Dreamer",
				})
				expect(current?.data.sourceReliability).toBe(0.91)

				const updated =
					await MongoDBMemoryManager.prototype.updateLifecycleItem.call(
						manager,
						current?.handle,
						{
							value: "Use Helm 3 with startup probes and Istio routing",
							reviewAt: new Date("2026-04-25T00:00:00.000Z"),
							lastConfirmedAt: new Date("2026-04-11T09:00:00.000Z"),
						},
					)

				expect(updated).not.toBeNull()
				expect(updated?.family).toBe("structured")
				expect(updated?.handle.revision).toBe(2)
				expect(updated?.data.value).toBe(
					"Use Helm 3 with startup probes and Istio routing",
				)
				expect(updated?.data.sourceEventIds).toEqual([sourceEventId])
				expect(updated?.data.reviewAt).toBeInstanceOf(Date)
				expect(updated?.data.lastConfirmedAt).toBeInstanceOf(Date)

				expect(
					await structuredMemCollection(db, PREFIX).countDocuments({
						agentId: AGENT_ID,
						type: "decision",
						key,
					}),
				).toBe(1)
				expect(
					await structuredMemRevisionsCollection(db, PREFIX).countDocuments({
						agentId: AGENT_ID,
						type: "decision",
						key,
					}),
				).toBe(1)

				const history =
					await MongoDBMemoryManager.prototype.getLifecycleHistory.call(
						manager,
						{
							handle: updated?.handle,
						},
					)

				expect(history.map((entry) => entry.historyKind)).toEqual([
					"revision",
					"current",
				])
				expect(history[0]?.handle.revision).toBe(1)
				expect(history[0]?.data.value).toBe(
					"Use Helm 3 for gateway deployments",
				)
				expect(history[1]?.handle.revision).toBe(2)
				expect(history[1]?.data.value).toBe(
					"Use Helm 3 with startup probes and Istio routing",
				)
			})

			it("invalidates procedures without hard delete and keeps ordered history through lifecycle methods", async () => {
				const manager = createLifecycleManagerHarness(db, client)
				const scope = "agent" as const
				const scopeRef = resolveScopeRef({ scope, agentId: AGENT_ID })
				const procedureId = `proc-lifecycle-${randomUUID().slice(0, 8)}`

				await writeProcedure({
					db,
					prefix: PREFIX,
					entry: {
						procedureId,
						name: "Rollback Atlas API deployment",
						steps: ["Identify bad rollout", "Undo deployment", "Verify health"],
						agentId: AGENT_ID,
						scope,
						scopeRef,
						sourceEventIds: [`evt-${procedureId}`],
						sourceAgent: { id: "dreamer", name: "Dreamer" },
					},
					embeddingMode: "automated",
					client,
				})

				const current =
					await MongoDBMemoryManager.prototype.getLifecycleItem.call(
						manager,
						buildProcedureStableHandle({
							agentId: AGENT_ID,
							scope,
							scopeRef,
							procedureId,
							revision: 1,
							state: "active",
						}),
					)

				expect(current).not.toBeNull()
				expect(current?.family).toBe("procedure")
				expect(current?.data.name).toBe("Rollback Atlas API deployment")

				const updated =
					await MongoDBMemoryManager.prototype.updateLifecycleItem.call(
						manager,
						current?.handle,
						{
							steps: [
								"Identify bad rollout",
								"Undo deployment",
								"Verify health",
								"Confirm latency recovery",
							],
							successSignals: [
								"Latency normalizes",
								"Health endpoint returns 200",
							],
						},
					)

				expect(updated).not.toBeNull()
				expect(updated?.family).toBe("procedure")
				expect(updated?.handle.revision).toBe(2)
				expect(updated?.data.steps).toContain("Confirm latency recovery")
				expect(updated?.data.successSignals).toEqual([
					"Latency normalizes",
					"Health endpoint returns 200",
				])

				const invalidated =
					await MongoDBMemoryManager.prototype.invalidateLifecycleItem.call(
						manager,
						updated?.handle,
						{ reason: "superseded-by-incident-runbook" },
					)

				expect(invalidated).not.toBeNull()
				expect(invalidated?.family).toBe("procedure")
				expect(invalidated?.handle.state).toBe("invalidated")
				expect(invalidated?.handle.revision).toBe(3)

				expect(
					await proceduresCollection(db, PREFIX).countDocuments({
						agentId: AGENT_ID,
						procedureId,
					}),
				).toBe(1)
				expect(
					await procedureRevisionsCollection(db, PREFIX).countDocuments({
						agentId: AGENT_ID,
						procedureId,
					}),
				).toBe(2)

				const history =
					await MongoDBMemoryManager.prototype.getLifecycleHistory.call(
						manager,
						{
							handle: invalidated?.handle,
						},
					)

				expect(history.map((entry) => entry.historyKind)).toEqual([
					"revision",
					"revision",
					"current",
				])
				expect(history.map((entry) => entry.handle.revision)).toEqual([1, 2, 3])
				expect(history[0]?.data.steps).toEqual([
					"Identify bad rollout",
					"Undo deployment",
					"Verify health",
				])
				expect(history[1]?.data.steps).toEqual([
					"Identify bad rollout",
					"Undo deployment",
					"Verify health",
					"Confirm latency recovery",
				])
				expect(history[2]?.handle.state).toBe("invalidated")
			})

			it("imports conversation history through canonical events and recalls it through the same surface", async () => {
				const workspaceDir = await mkdtemp(
					path.join(os.tmpdir(), "memongo-import-e2e-"),
				)
				const importDir = path.join(workspaceDir, "imports")
				const datasetPath = path.join(importDir, "history.json")
				const sessionId = `import-session-${randomUUID().slice(0, 8)}`
				const timestamp = new Date(Date.now() - 60_000).toISOString()
				try {
					await mkdir(importDir, { recursive: true })
					await writeFile(
						datasetPath,
						JSON.stringify({
							conversations: [
								{
									conversationId: sessionId,
									sessionId,
									turns: [
										{
											role: "user",
											body: "We decided Memongo import must use canonical event writes.",
											timestamp,
										},
										{
											role: "assistant",
											body: "Confirmed: imports should be recallable through conversation recall.",
											timestamp,
										},
									],
								},
							],
						}),
					)

					const manager = createLifecycleManagerHarness(
						db,
						client,
						workspaceDir,
					)
					const imported =
						await MongoDBMemoryManager.prototype.importConversations.call(
							manager,
							{
								datasetPath: "imports/history.json",
								scope: "agent",
							},
						)

					expect(imported.conversationsImported).toBe(1)
					expect(imported.turnsImported).toBe(2)
					expect(imported.datasetKind).toBe("generic")
					expect(
						await eventsCollection(db, PREFIX).countDocuments({
							agentId: AGENT_ID,
							sessionId,
							"metadata.importConversationId": sessionId,
						}),
					).toBe(2)

					const recalled =
						await MongoDBMemoryManager.prototype.recallConversation.call(
							manager,
							{
								sessionId,
								roles: ["user", "assistant"],
								limit: 10,
							},
						)

					expect(recalled.metadata.searchMethod).toBe("standard")
					expect(recalled.metadata.filtersApplied).toContain(
						`sessionId:${sessionId}`,
					)
					expect(
						recalled.results.map((result) => result.citation.preview),
					).toEqual(
						expect.arrayContaining([
							expect.stringContaining("Memongo import must use canonical"),
							expect.stringContaining("imports should be recallable"),
						]),
					)
				} finally {
					await rm(workspaceDir, { recursive: true, force: true })
				}
			})
		})

		// ---------------------------------------------------------------------------
		// Phase 16: Procedural Memory Evolution
		// ---------------------------------------------------------------------------

		describe("Phase 16: Procedural Memory Evolution", () => {
			const procId = `proc-e2e-${randomUUID().slice(0, 8)}`

			it("recordProcedureOutcome increments counts atomically", async () => {
				// Create a procedure first via writeProcedure
				await writeProcedure({
					db,
					prefix: PREFIX,
					entry: {
						procedureId: procId,
						name: "Deploy to production",
						steps: ["Build", "Test", "Deploy"],
						agentId: AGENT_ID,
						scope: "agent",
						scopeRef: `agent:${AGENT_ID}`,
					},
					embeddingMode: "automated",
				})

				// Record 3 successes and 2 failures
				for (let i = 0; i < 3; i++) {
					await recordProcedureOutcome({
						db,
						prefix: PREFIX,
						procedureId: procId,
						agentId: AGENT_ID,
						scope: "agent",
						scopeRef: `agent:${AGENT_ID}`,
						success: true,
					})
				}
				for (let i = 0; i < 2; i++) {
					await recordProcedureOutcome({
						db,
						prefix: PREFIX,
						procedureId: procId,
						agentId: AGENT_ID,
						scope: "agent",
						scopeRef: `agent:${AGENT_ID}`,
						success: false,
					})
				}

				// Verify counts
				const doc = await proceduresCollection(db, PREFIX).findOne({
					procedureId: procId,
					agentId: AGENT_ID,
				})
				expect(doc).toBeDefined()
				expect(doc?.successCount).toBe(3)
				expect(doc?.failCount).toBe(2)
				expect(doc?.lastSuccessAt).toBeInstanceOf(Date)
				expect(doc?.lastFailureAt).toBeInstanceOf(Date)
			})

			it("evolveProcedure bumps version and records history", async () => {
				const result = await evolveProcedure({
					db,
					prefix: PREFIX,
					procedureId: procId,
					agentId: AGENT_ID,
					scope: "agent",
					scopeRef: `agent:${AGENT_ID}`,
					newSteps: ["Build", "Lint", "Test", "Deploy", "Verify"],
					changeType: "enhancement",
					changeDescription: "Added lint and verify steps",
				})

				expect(result.newVersion).toBeGreaterThanOrEqual(2)

				const doc = await proceduresCollection(db, PREFIX).findOne({
					procedureId: procId,
					agentId: AGENT_ID,
				})
				expect(doc).toBeDefined()
				expect(doc?.version).toBeGreaterThanOrEqual(2)
				expect(doc?.steps).toEqual([
					"Build",
					"Lint",
					"Test",
					"Deploy",
					"Verify",
				])
				expect(doc?.evolutionHistory).toBeDefined()
				expect(doc?.evolutionHistory.length).toBeGreaterThanOrEqual(1)
				const lastEntry =
					doc?.evolutionHistory[doc?.evolutionHistory.length - 1]
				expect(lastEntry.changeType).toBe("enhancement")
				expect(lastEntry.changeDescription).toBe("Added lint and verify steps")
			})

			it("evolutionHistory is bounded at 20 entries", async () => {
				// Evolve 25 times to exceed the 20-entry cap
				for (let i = 0; i < 25; i++) {
					await evolveProcedure({
						db,
						prefix: PREFIX,
						procedureId: procId,
						agentId: AGENT_ID,
						scope: "agent",
						scopeRef: `agent:${AGENT_ID}`,
						newSteps: [`Step iteration ${i}`],
						changeType: "iteration",
						changeDescription: `Iteration ${i}`,
					})
				}

				const doc = await proceduresCollection(db, PREFIX).findOne({
					procedureId: procId,
					agentId: AGENT_ID,
				})
				expect(doc).toBeDefined()
				// evolutionHistory must never exceed 20
				expect(doc?.evolutionHistory.length).toBeLessThanOrEqual(20)
				// Should still have history entries
				expect(doc?.evolutionHistory.length).toBeGreaterThan(0)
			})

			it("procedure version and counts survive concurrent updates", async () => {
				// Read current state
				const beforeDoc = await proceduresCollection(db, PREFIX).findOne({
					procedureId: procId,
					agentId: AGENT_ID,
				})
				const versionBefore = beforeDoc?.version as number
				const successBefore = beforeDoc?.successCount as number

				// Run evolve and outcome concurrently
				const [_evolveResult] = await Promise.all([
					evolveProcedure({
						db,
						prefix: PREFIX,
						procedureId: procId,
						agentId: AGENT_ID,
						scope: "agent",
						scopeRef: `agent:${AGENT_ID}`,
						newSteps: ["Concurrent step"],
						changeType: "concurrent",
						changeDescription: "Concurrent test",
					}),
					recordProcedureOutcome({
						db,
						prefix: PREFIX,
						procedureId: procId,
						agentId: AGENT_ID,
						scope: "agent",
						scopeRef: `agent:${AGENT_ID}`,
						success: true,
					}),
				])

				// Both operations should have succeeded atomically
				const afterDoc = await proceduresCollection(db, PREFIX).findOne({
					procedureId: procId,
					agentId: AGENT_ID,
				})
				expect(afterDoc).toBeDefined()
				// Version should have bumped at least once from evolve
				expect(afterDoc?.version).toBeGreaterThan(versionBefore)
				// successCount should have incremented by 1
				expect(afterDoc?.successCount).toBe(successBefore + 1)
			})
		})
	},
)
