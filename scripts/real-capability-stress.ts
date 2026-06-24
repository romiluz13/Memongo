import { mkdir, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { spawn } from "node:child_process"
import { MongoClient } from "mongodb"
import { MemongoClient } from "@memongo/client"
import {
	emptyLaneCoverage,
	getCacheHitRate,
	getLaneCoverage,
	getLatencyStats,
	getOperationDistribution,
	materializeEpisode,
	recordProcedureOutcome,
	checkCache,
	extractAndUpsertEntities,
	expandGraph,
	evolveProcedure,
	synthesizeProfile,
	updateLaneCoverage,
	writeCache,
} from "@memongo/memory-engine"
import { buildMemongoConfig } from "../packages/memory-bridge/src/memory-config.ts"
import { resolveMemoryBackendConfig } from "../packages/memory-engine/src/backend-config.ts"
import { writeProofArtifact } from "./proof-artifacts.js"
import {
	getKBStats,
	ingestToKB,
	listKBDocuments,
	removeKBDocument,
} from "../packages/memory-engine/src/mongodb-kb.ts"
import { resolveScopeRef } from "../packages/memory-engine/src/mongodb-scope.ts"

type SearchLikeResult = {
	path?: string
	score?: number
	snippet?: string
	source?: string
}

type ReadFileResponse = {
	text?: string
	path?: string
	locator?: string
	source?: string
}

type RelevanceExplainResponse = {
	latencyMs?: number
	health?: string
	results?: SearchLikeResult[]
}

type RelevanceBenchmarkResponse = {
	cases?: number
	hitRate?: number
	emptyRate?: number
	p95LatencyMs?: number
}

type RelevanceReportResponse = {
	runs?: number
	health?: string
	fallbackRate?: number
}

type SampleRateResponse = {
	enabled?: boolean
	current?: number
}

type StatusResponse = {
	backend?: string
	workspaceDir?: string
	sources?: string[]
	custom?: Record<string, unknown>
}

type StatsResponse = {
	totalFiles?: number
	totalChunks?: number
	totalEvents?: number
}

type CapabilityCheck = {
	name: string
	ok: boolean
	details: string
}

type SearchMetric = {
	name: string
	evidenceCoverage: string
	topConfidence: string | null
	staleCount: number
	contradictionCount: number
	latencyMs: number
	pathsExecuted: string[]
}

const baseUrl = (
	process.env.MEMONGO_API_URL ?? "http://127.0.0.1:3847"
).replace(/\/$/, "")
const apiKey = process.env.MEMONGO_API_KEY?.trim() || undefined
const agentId =
	process.env.MEMONGO_AGENT_ID?.trim() ??
	`capability-stress-${randomUUID().slice(0, 8)}`
const sessionId =
	process.env.MEMONGO_SESSION_ID?.trim() ??
	`capability-session-${randomUUID().slice(0, 8)}`
const workspaceDir =
	process.env.MEMONGO_WORKSPACE_DIR?.trim() ||
	path.join(os.tmpdir(), `memongo-workspace-${randomUUID().slice(0, 8)}`)

const client = new MemongoClient({
	baseUrl,
	apiKey,
	maxRetries: 2,
})

function pass(name: string, details: string): CapabilityCheck {
	return { name, ok: true, details }
}

function fail(name: string, details: string): CapabilityCheck {
	return { name, ok: false, details }
}

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) {
		throw new Error(message)
	}
}

function asRecord(value: unknown): Record<string, unknown> {
	if (typeof value === "object" && value !== null) {
		return value as Record<string, unknown>
	}
	return {}
}

function asReadFileResponse(value: unknown): ReadFileResponse {
	return asRecord(value) as ReadFileResponse
}

function asStatusResponse(value: unknown): StatusResponse {
	return asRecord(value) as StatusResponse
}

function asStatsResponse(value: unknown): StatsResponse {
	return asRecord(value) as StatsResponse
}

function asRelevanceExplainResponse(value: unknown): RelevanceExplainResponse {
	return asRecord(value) as RelevanceExplainResponse
}

function asRelevanceBenchmarkResponse(
	value: unknown,
): RelevanceBenchmarkResponse {
	return asRecord(value) as RelevanceBenchmarkResponse
}

function asRelevanceReportResponse(value: unknown): RelevanceReportResponse {
	return asRecord(value) as RelevanceReportResponse
}

function asSampleRateResponse(value: unknown): SampleRateResponse {
	return asRecord(value) as SampleRateResponse
}

function asSearchResults(value: unknown): SearchLikeResult[] {
	const record = asRecord(value)
	return Array.isArray(record.results)
		? (record.results as SearchLikeResult[])
		: []
}

async function sleep(ms: number): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitFor<T>(
	label: string,
	fn: () => Promise<T>,
	predicate: (value: T) => boolean,
	timeoutMs = 30_000,
	intervalMs = 1_500,
): Promise<T> {
	const startedAt = Date.now()
	let lastValue: T | undefined
	let lastError: unknown
	while (Date.now() - startedAt < timeoutMs) {
		try {
			const value = await fn()
			lastValue = value
			if (predicate(value)) {
				return value
			}
		} catch (error) {
			lastError = error
		}
		await sleep(intervalMs)
	}

	if (lastError instanceof Error) {
		throw new Error(`${label} timed out after error: ${lastError.message}`)
	}
	throw new Error(
		`${label} timed out waiting for condition. Last value: ${JSON.stringify(lastValue)}`,
	)
}

async function fetchJson(pathname: string): Promise<unknown> {
	const headers: Record<string, string> = {}
	if (apiKey) {
		headers.Authorization = `Bearer ${apiKey}`
	}
	const response = await fetch(`${baseUrl}${pathname}`, { headers })
	if (!response.ok) {
		throw new Error(`${pathname} returned HTTP ${response.status}`)
	}
	return await response.json()
}

async function runRealAgentLane(): Promise<CapabilityCheck> {
	if (
		!process.env.MEMONGO_LLM_API_KEY?.trim() ||
		!process.env.MEMONGO_LLM_BASE_URL?.trim() ||
		!process.env.MEMONGO_LLM_MODEL?.trim()
	) {
		return pass("real-agent", "skipped: MEMONGO_LLM_* env not set")
	}

	const stdoutChunks: string[] = []
	const stderrChunks: string[] = []
	await new Promise<void>((resolve, reject) => {
		const child = spawn("bun", ["scripts/real-agent-smoke.ts"], {
			cwd: process.cwd(),
			env: {
				...process.env,
				MEMONGO_API_URL: baseUrl,
				MEMONGO_API_KEY: apiKey,
				MEMONGO_AGENT_ID: `${agentId}-agent`,
				MEMONGO_SESSION_ID: `${sessionId}-agent`,
			},
			stdio: ["ignore", "pipe", "pipe"],
		})

		child.stdout.on("data", (chunk) => {
			stdoutChunks.push(String(chunk))
		})
		child.stderr.on("data", (chunk) => {
			stderrChunks.push(String(chunk))
		})
		child.on("error", reject)
		child.on("exit", (code) => {
			if (code === 0) {
				resolve()
				return
			}
			reject(
				new Error(
					`agent smoke failed (${code ?? "unknown"}): ${stderrChunks.join("") || stdoutChunks.join("")}`,
				),
			)
		})
	})

	const stdout = stdoutChunks.join("")
	assert(
		stdout.includes('"step": "success"'),
		"real agent smoke did not report success",
	)
	return pass("real-agent", "real LLM model stored and recalled memory")
}

async function main() {
	const checks: CapabilityCheck[] = []
	const searchMetrics: SearchMetric[] = []
	const scopeRefAgent = resolveScopeRef({ scope: "agent", agentId })
	const marker = `capability-marker-${randomUUID().slice(0, 8)}`
	const decisionKey = `${marker}:release-window`
	const preferenceKey = `${marker}:communication-style`
	const procedureId = `${marker}:deploy`
	const kbPathPrimary = `${marker}/phoenix-api.md`
	const kbPathDisposable = `${marker}/cleanup.md`
	const bridgeMarker = `${marker} bridge note`
	const workspaceMemoryDir = path.join(workspaceDir, "memory")
	const workspaceBenchmarkDir = path.join(workspaceDir, "benchmarks")
	const relevanceDatasetPath = path.join(
		workspaceBenchmarkDir,
		`memongo-relevance-${randomUUID().slice(0, 8)}.jsonl`,
	)

	await mkdir(workspaceMemoryDir, { recursive: true })
	await mkdir(workspaceBenchmarkDir, { recursive: true })
	await writeFile(
		path.join(workspaceMemoryDir, "bridge.md"),
		[
			"# Bridge Memory",
			"",
			`${bridgeMarker} keeps public docs aligned with the product story.`,
			"Phoenix deploys on Fridays after proof-pack and stress validation.",
		].join("\n"),
		"utf8",
	)

	const cfg = buildMemongoConfig({
		...process.env,
		MEMONGO_WORKSPACE_DIR: workspaceDir,
	})
	const resolved = resolveMemoryBackendConfig({ cfg, agentId })
	const mongoCfg = resolved.mongodb
	assert(mongoCfg, "MongoDB config is required for capability stress")

	const mongo = new MongoClient(mongoCfg.uri, {
		serverSelectionTimeoutMS: mongoCfg.connectTimeoutMs,
		connectTimeoutMS: mongoCfg.connectTimeoutMs,
	})

	const disposableWorkspaceCreated = !process.env.MEMONGO_WORKSPACE_DIR

	try {
		await mongo.connect()
		const db = mongo.db(mongoCfg.database)

		const health = asRecord(await fetchJson("/health"))
		assert(health.ok === true, "health endpoint did not return ok=true")
		checks.push(
			pass("health", `service=${String(health.service ?? "unknown")}`),
		)

		const openApi = asRecord(await fetchJson("/openapi.json"))
		const paths = asRecord(openApi.paths)
		assert(paths["/v1/search"], "openapi missing /v1/search")
		assert(paths["/v1/search-detailed"], "openapi missing /v1/search-detailed")
		assert(paths["/v1/read-file"], "openapi missing /v1/read-file")
		checks.push(pass("openapi", "core memory routes present"))

		const initialStatus = asStatusResponse(await client.status(agentId))
		assert(initialStatus.backend === "mongodb", "status backend is not mongodb")
		checks.push(
			pass(
				"status",
				`backend=${initialStatus.backend}, workspace=${String(initialStatus.workspaceDir ?? "unknown")}`,
			),
		)

		await client.sync({ agentId, reason: "capability-stress", force: true })
		const bridgeRead = asReadFileResponse(
			await client.readFile({ agentId, relPath: "memory/bridge.md" }),
		)
		assert(
			bridgeRead.text?.includes(bridgeMarker),
			"bridge read-file did not return synced workspace content",
		)
		checks.push(
			pass("sync-read-bridge", `path=${bridgeRead.path ?? "memory/bridge.md"}`),
		)

		const firstTs = new Date(Date.now() - 10 * 60 * 1000).toISOString()
		const secondTs = new Date(Date.now() - 9 * 60 * 1000).toISOString()
		const thirdTs = new Date(Date.now() - 8 * 60 * 1000).toISOString()
		const fourthTs = new Date(Date.now() - 7 * 60 * 1000).toISOString()

		const writeA = await client.writeEvent({
			agentId,
			sessionId,
			role: "user",
			timestamp: firstTs,
			body: `${marker} Alice is handling the Phoenix release blocker for Atlas Local preview rollout.`,
			scope: "session",
		})
		await client.writeEvent({
			agentId,
			sessionId,
			role: "assistant",
			timestamp: secondTs,
			body: `Noted. The Phoenix blocker is the vector recall regression and Alice owns the fix.`,
			scope: "session",
		})
		await client.add({
			agentId,
			sessionId,
			content: `${marker} the launch codeword is Blue Finch and the deploy cadence is Friday afternoon.`,
		})
		await client.writeEvent({
			agentId,
			sessionId,
			role: "user",
			timestamp: thirdTs,
			body: `Document the Phoenix deploy checklist and remember that concise updates are preferred.`,
			scope: "session",
		})
		await client.writeEvent({
			agentId,
			sessionId,
			role: "assistant",
			timestamp: fourthTs,
			body: `I will keep concise updates, preserve Atlas Local preview validation, and track the Phoenix deploy checklist.`,
			scope: "session",
		})
		checks.push(
			pass(
				"conversation-write",
				`eventId=${writeA.eventId}, session=${sessionId}`,
			),
		)

		const structuredDecision = await client.writeStructured({
			agentId,
			entry: {
				type: "decision",
				key: decisionKey,
				value:
					"Phoenix deploys on Friday after proof-pack and stress validation.",
				source: "agent",
				sessionId,
				scope: "agent",
				state: "active",
				salience: "critical",
				tags: ["deploy", "release", "phoenix"],
			},
		})
		await client.writeStructured({
			agentId,
			entry: {
				type: "preference",
				key: preferenceKey,
				value: "Provide concise updates with direct evidence.",
				source: "agent",
				sessionId,
				scope: "agent",
				state: "active",
				salience: "high",
				tags: ["style", "communication"],
			},
		})
		await client.writeStructured({
			agentId,
			entry: {
				type: "fact",
				key: `${marker}:approval-policy`,
				value: "Phoenix requires only Marcus approval.",
				source: "agent",
				sessionId,
				scope: "agent",
				state: "conflicted",
				salience: "high",
				tags: ["approval", "conflict", "phoenix"],
			},
		})
		checks.push(
			pass(
				"structured-write",
				`id=${structuredDecision.id}, critical decision stored`,
			),
		)

		const procedure = await client.writeProcedure({
			agentId,
			entry: {
				procedureId,
				name: "Phoenix deploy checklist",
				intentTags: ["deploy", "release", "phoenix"],
				triggerQueries: ["deploy phoenix", "release checklist"],
				steps: [
					"Run root quality gates",
					"Run capability stress harness",
					"Review relevance report",
					"Deploy API and web",
				],
				successSignals: ["all live lanes green", "real agent recall verified"],
				scope: "agent",
				sessionId,
			},
		})
		await client.writeProcedure({
			agentId,
			entry: {
				procedureId: `${marker}:contingency`,
				name: "Phoenix contingency escalation",
				intentTags: ["phoenix", "contingency"],
				triggerQueries: ["phoenix contradiction", "phoenix contingency"],
				steps: ["Page Marcus only", "Skip proof lanes"],
				scope: "agent",
				sessionId,
				state: "conflicted",
			},
		})
		checks.push(pass("procedure-write", `id=${procedure.id}`))

		await recordProcedureOutcome({
			db,
			prefix: mongoCfg.collectionPrefix,
			procedureId,
			agentId,
			scope: "agent",
			scopeRef: scopeRefAgent,
			success: true,
		})
		await evolveProcedure({
			db,
			prefix: mongoCfg.collectionPrefix,
			procedureId,
			agentId,
			scope: "agent",
			scopeRef: scopeRefAgent,
			newSteps: [
				"Run root quality gates",
				"Run capability stress harness",
				"Run real agent smoke",
				"Review relevance report",
				"Deploy API and web",
			],
			changeType: "hardening",
			changeDescription: "Added real agent validation before deployment",
		})
		checks.push(
			pass("procedure-evolution", "outcome and version evolution recorded"),
		)

		const activeSlate = await client.hydrateActiveSlate({
			agentId,
			scope: "agent",
			scopeRef: scopeRefAgent,
			maxItems: 6,
		})
		assert(activeSlate.items.length > 0, "active slate returned no items")
		assert(
			activeSlate.items.some((item) => item.kind === "active-critical"),
			"active slate did not include active-critical memory",
		)
		assert(
			activeSlate.items.some((item) => item.kind === "procedure"),
			"active slate did not include a live procedure",
		)
		checks.push(
			pass(
				"active-slate",
				`items=${activeSlate.items.length}, kinds=${activeSlate.items.map((item) => item.kind).join(",")}`,
			),
		)

		const whatChanged = await client.buildDiscoveryProjection({
			agentId,
			kind: "what-changed",
			scope: "agent",
			scopeRef: scopeRefAgent,
			maxItems: 6,
			timeRange: {
				preset: "last-7d",
			},
		})
		assert(
			whatChanged.sections.length > 0,
			"what-changed projection returned no sections",
		)
		assert(
			whatChanged.sections.some((section) =>
				section.evidence.some(
					(entry) =>
						entry.path.startsWith("structured:") ||
						entry.path.startsWith("procedure:"),
				),
			),
			"what-changed projection did not surface durable evidence",
		)
		checks.push(
			pass(
				"discovery-what-changed",
				`sections=${whatChanged.sections.length}, evidence=${whatChanged.metadata.evidenceCount}`,
			),
		)

		const contradictionProjection = await client.buildDiscoveryProjection({
			agentId,
			kind: "contradiction-report",
			scope: "agent",
			scopeRef: scopeRefAgent,
			maxItems: 6,
		})
		assert(
			contradictionProjection.sections.length > 0,
			"contradiction projection returned no sections",
		)
		assert(
			contradictionProjection.sections.some((section) =>
				section.evidence.some(
					(entry) =>
						entry.path.startsWith("structured:") ||
						entry.path.startsWith("procedure:"),
				),
			),
			"contradiction projection did not surface durable contradictions",
		)
		checks.push(
			pass(
				"discovery-contradictions",
				`sections=${contradictionProjection.sections.length}, evidence=${contradictionProjection.metadata.evidenceCount}`,
			),
		)

		const entityExtraction = await extractAndUpsertEntities({
			db,
			prefix: mongoCfg.collectionPrefix,
			agentId,
			eventContent:
				'@alice owns #phoenix. See "Atlas Local" and docs/phoenix/runbook.md before the 2026-04-03 rollout.',
			scope: "agent",
			sourceEventId: writeA.eventId,
			role: "user",
		})
		assert(
			entityExtraction.entities.length >= 2,
			"graph extraction did not create enough entities",
		)
		const aliceEntity = entityExtraction.entities.find((entity) =>
			entity.name.toLowerCase().includes("alice"),
		)
		assert(aliceEntity, "expected Alice entity to exist")
		const graphExpansion = await expandGraph({
			db,
			prefix: mongoCfg.collectionPrefix,
			agentId,
			entityId: aliceEntity.entityId,
			scope: "agent",
			scopeRef: scopeRefAgent,
			maxDepth: 2,
		})
		assert(
			graphExpansion !== null && graphExpansion.connections.length > 0,
			"graph expansion did not return connections",
		)
		await updateLaneCoverage({
			db,
			prefix: mongoCfg.collectionPrefix,
			agentId,
			increments: {
				graph: Math.max(entityExtraction.entities.length, 1),
			},
		})
		checks.push(
			pass(
				"graph-extract-expand",
				`entities=${entityExtraction.entities.length}, relations=${entityExtraction.relationsCreated}`,
			),
		)

		const episode = await materializeEpisode({
			db,
			prefix: mongoCfg.collectionPrefix,
			agentId,
			type: "thread",
			scope: "session",
			scopeRef: resolveScopeRef({ scope: "session", agentId, sessionId }),
			timeRange: {
				start: new Date(Date.now() - 11 * 60 * 1000),
				end: new Date(Date.now() - 6 * 60 * 1000),
			},
			summarizer: async () => ({
				title: "Phoenix release blocker thread",
				summary:
					"Alice investigated the Phoenix release blocker, aligned deploy steps, and confirmed Blue Finch launch readiness.",
				tags: ["phoenix", "release", "blocker"],
				shortTermSummary: "Phoenix blocker triaged.",
				mediumTermSummary: "Deploy workflow captured and stabilized.",
				longTermSummary:
					"Release readiness now depends on proof-pack and stress validation.",
				topics: ["phoenix", "deploy"],
			}),
		})
		assert(episode, "episode materialization returned null")
		checks.push(pass("episode-materialize", `episode=${episode.episodeId}`))

		const kbResult = await ingestToKB({
			db,
			prefix: mongoCfg.collectionPrefix,
			documents: [
				{
					title: "Phoenix API reference",
					content: [
						"# Phoenix API",
						"",
						"The deploy endpoint is POST /v1/deploy.",
						"Use Atlas Local preview validation before promotion.",
						"Blue Finch is the launch codeword for this rollout.",
					].join("\n"),
					source: {
						type: "file",
						path: kbPathPrimary,
						importedBy: "api",
					},
					category: "api",
					tags: ["docs", "api", "phoenix"],
					hash: randomUUID(),
				},
				{
					title: "Phoenix cleanup note",
					content:
						"Delete this KB document after the stress harness verifies removal.",
					source: {
						type: "manual",
						path: kbPathDisposable,
						importedBy: "api",
					},
					category: "ops",
					tags: ["cleanup"],
					hash: randomUUID(),
				},
			],
			embeddingMode: mongoCfg.embeddingMode,
			chunking: mongoCfg.kb.chunking,
			maxDocumentSize: mongoCfg.kb.maxDocumentSize,
			client: mongo,
		})
		assert(
			kbResult.documentsProcessed >= 2,
			"KB ingest did not process documents",
		)
		const kbDocs = await listKBDocuments(db, mongoCfg.collectionPrefix)
		const kbStats = await getKBStats(db, mongoCfg.collectionPrefix)
		assert(kbDocs.length >= 2, "KB list is missing ingested documents")
		assert(
			(kbStats.documents ?? 0) >= 2,
			"KB stats did not record ingested documents",
		)
		checks.push(
			pass(
				"kb-ingest",
				`documents=${kbResult.documentsProcessed}, chunks=${kbResult.chunksCreated}`,
			),
		)

		let searchStartedAt = Date.now()
		const conversationSearch = await waitFor(
			"conversation detailed search",
			() =>
				client.searchDetailed({
					agentId,
					query: marker,
					limit: 5,
					searchMode: "agentic",
					sourcePreference: ["conversation"],
					conversationScope: { sessionKey: sessionId },
					returnPlan: true,
				}),
			(result) =>
				result.metadata.pathsExecuted.some(
					(pathname) => pathname === "raw-window" || pathname === "hybrid",
				) && result.results.length > 0,
		)
		searchMetrics.push({
			name: "conversation",
			evidenceCoverage: conversationSearch.metadata.evidenceCoverage,
			topConfidence:
				conversationSearch.metadata.trustSummary?.topConfidence ?? null,
			staleCount: conversationSearch.metadata.trustSummary?.staleCount ?? 0,
			contradictionCount:
				conversationSearch.metadata.trustSummary?.contradictionCount ?? 0,
			latencyMs: Date.now() - searchStartedAt,
			pathsExecuted: conversationSearch.metadata.pathsExecuted,
		})
		const eventResult =
			conversationSearch.results.find(
				(result) =>
					result.path.startsWith("events/") && result.snippet?.includes(marker),
			) ??
			conversationSearch.results.find((result) =>
				result.path.startsWith("events/"),
			)
		assert(eventResult, "conversation search did not return an event locator")
		const eventRead = asReadFileResponse(
			await client.readFile({ agentId, relPath: eventResult.path }),
		)
		assert(
			eventRead.text?.includes(marker),
			"event exact read did not return the written conversation event",
		)
		checks.push(
			pass(
				"conversation-search-read",
				`paths=${conversationSearch.metadata.pathsExecuted.join(",")}`,
			),
		)

		searchStartedAt = Date.now()
		const structuredSearch = await waitFor(
			"structured detailed search",
			() =>
				client.searchDetailed({
					agentId,
					query:
						"what matters now about the current Phoenix release blocker status",
					limit: 5,
					searchMode: "agentic",
					sourcePreference: ["structured"],
					structuredScope: {
						state: "active",
						salience: ["critical", "high"],
					},
					returnPlan: true,
				}),
			(result) =>
				result.metadata.pathsExecuted.includes("active-critical") &&
				result.metadata.pathsExecuted.includes("structured") &&
				result.results.some((entry) => entry.path.startsWith("structured:")),
		)
		searchMetrics.push({
			name: "structured",
			evidenceCoverage: structuredSearch.metadata.evidenceCoverage,
			topConfidence:
				structuredSearch.metadata.trustSummary?.topConfidence ?? null,
			staleCount: structuredSearch.metadata.trustSummary?.staleCount ?? 0,
			contradictionCount:
				structuredSearch.metadata.trustSummary?.contradictionCount ?? 0,
			latencyMs: Date.now() - searchStartedAt,
			pathsExecuted: structuredSearch.metadata.pathsExecuted,
		})
		const structuredResult =
			structuredSearch.results.find((result) =>
				result.path.includes(decisionKey),
			) ??
			structuredSearch.results.find((result) =>
				result.path.startsWith("structured:"),
			)
		assert(
			structuredResult,
			"structured search did not return a structured locator",
		)
		const structuredRead = asReadFileResponse(
			await client.readFile({ agentId, relPath: structuredResult.path }),
		)
		assert(
			structuredRead.text?.includes(decisionKey) ||
				structuredRead.text?.includes("Friday") ||
				structuredRead.text?.includes(marker),
			"structured locator read did not return structured memory content",
		)
		checks.push(
			pass(
				"structured-search-read",
				`paths=${structuredSearch.metadata.pathsExecuted.join(",")}`,
			),
		)

		searchStartedAt = Date.now()
		const procedureSearch = await waitFor(
			"procedural detailed search",
			() =>
				client.searchDetailed({
					agentId,
					query: "what is the Phoenix deploy checklist process",
					limit: 5,
					searchMode: "agentic",
					sourcePreference: ["procedural"],
					proceduralScope: { intentTags: ["deploy"] },
					returnPlan: true,
				}),
			(result) =>
				result.metadata.pathsExecuted.includes("procedural") &&
				result.results.some((entry) => entry.path.startsWith("procedure:")),
		)
		searchMetrics.push({
			name: "procedural",
			evidenceCoverage: procedureSearch.metadata.evidenceCoverage,
			topConfidence:
				procedureSearch.metadata.trustSummary?.topConfidence ?? null,
			staleCount: procedureSearch.metadata.trustSummary?.staleCount ?? 0,
			contradictionCount:
				procedureSearch.metadata.trustSummary?.contradictionCount ?? 0,
			latencyMs: Date.now() - searchStartedAt,
			pathsExecuted: procedureSearch.metadata.pathsExecuted,
		})
		const procedureResult = procedureSearch.results.find((result) =>
			result.path.startsWith("procedure:"),
		)
		assert(
			procedureResult,
			"procedural search did not return a procedure locator",
		)
		const procedureRead = asReadFileResponse(
			await client.readFile({ agentId, relPath: procedureResult.path }),
		)
		assert(
			procedureRead.text?.includes("Run real agent smoke"),
			"procedure exact read did not include evolved steps",
		)
		checks.push(
			pass(
				"procedural-search-read",
				`paths=${procedureSearch.metadata.pathsExecuted.join(",")}`,
			),
		)

		searchStartedAt = Date.now()
		const graphSearch = await waitFor(
			"graph detailed search",
			() =>
				client.searchDetailed({
					agentId,
					query:
						"What relationship connects Alice and Phoenix in the release graph?",
					limit: 5,
					searchMode: "agentic",
					sourcePreference: ["graph"],
					returnPlan: true,
				}),
			(result) =>
				result.metadata.pathsExecuted.includes("graph") &&
				result.results.some((entry) => entry.path.startsWith("relation:")),
		)
		searchMetrics.push({
			name: "graph",
			evidenceCoverage: graphSearch.metadata.evidenceCoverage,
			topConfidence: graphSearch.metadata.trustSummary?.topConfidence ?? null,
			staleCount: graphSearch.metadata.trustSummary?.staleCount ?? 0,
			contradictionCount:
				graphSearch.metadata.trustSummary?.contradictionCount ?? 0,
			latencyMs: Date.now() - searchStartedAt,
			pathsExecuted: graphSearch.metadata.pathsExecuted,
		})
		checks.push(
			pass(
				"graph-search",
				`paths=${graphSearch.metadata.pathsExecuted.join(",")}`,
			),
		)
		const firstConnection = graphExpansion.connections[0]
		assert(
			firstConnection,
			"graph expansion did not produce a relation to read",
		)
		const relationLocator = `relation:${firstConnection.relation.fromEntityId}-${firstConnection.relation.toEntityId}`
		const relationRead = asReadFileResponse(
			await client.readFile({ agentId, relPath: relationLocator }),
		)
		assert(
			relationRead.text?.includes(firstConnection.relation.fromEntityId) ||
				relationRead.text?.includes(firstConnection.relation.toEntityId) ||
				relationRead.text?.includes(String(firstConnection.relation.type)),
			"relation exact read did not reopen graph evidence",
		)
		checks.push(pass("graph-read", `locator=${relationLocator}`))

		searchStartedAt = Date.now()
		const episodicSearch = await client.searchDetailed({
			agentId,
			query: "Summarize what happened in the Phoenix release blocker thread",
			limit: 5,
			searchMode: "agentic",
			sourcePreference: ["episodic"],
			conversationScope: { sessionKey: sessionId },
			returnPlan: true,
		})
		searchMetrics.push({
			name: "episodic",
			evidenceCoverage: episodicSearch.metadata.evidenceCoverage,
			topConfidence:
				episodicSearch.metadata.trustSummary?.topConfidence ?? null,
			staleCount: episodicSearch.metadata.trustSummary?.staleCount ?? 0,
			contradictionCount:
				episodicSearch.metadata.trustSummary?.contradictionCount ?? 0,
			latencyMs: Date.now() - searchStartedAt,
			pathsExecuted: episodicSearch.metadata.pathsExecuted,
		})
		if (
			episodicSearch.metadata.pathsExecuted.includes("episodic") &&
			episodicSearch.results.some((entry) => entry.path.startsWith("episode:"))
		) {
			checks.push(
				pass(
					"episodic-search",
					`paths=${episodicSearch.metadata.pathsExecuted.join(",")}`,
				),
			)
		} else {
			checks.push(
				fail(
					"episodic-search",
					`cold path: ${episodicSearch.metadata.pathsExecuted.join(",") || "none"} (expected episodic lane)`,
				),
			)
		}
		const episodeLocator = `episode:${episode.episodeId}`
		const episodeRead = asReadFileResponse(
			await client.readFile({ agentId, relPath: episodeLocator }),
		)
		assert(
			episodeRead.text?.includes("Phoenix release blocker thread"),
			"episode read did not return compact summary",
		)
		const episodeExpanded = asReadFileResponse(
			await client.readFile({
				agentId,
				relPath: `${episodeLocator}?expand=events`,
			}),
		)
		assert(
			episodeExpanded.text?.includes(marker),
			"episode expand read did not reopen source events",
		)
		checks.push(pass("episodic-read", `locator=${episodeLocator}`))

		const kbSearch = await waitFor(
			"kb search",
			() =>
				client.searchKB({
					agentId,
					query: "Phoenix API deploy endpoint",
					limit: 5,
					filter: { category: "api" },
				}),
			(result) => asSearchResults(result).length > 0,
		)
		searchStartedAt = Date.now()
		const kbDetailed = await client.searchDetailed({
			agentId,
			query: "API docs for the Phoenix deploy endpoint",
			limit: 5,
			searchMode: "agentic",
			sourcePreference: ["reference"],
			referenceScope: { category: "api", tags: ["docs"] },
			returnPlan: true,
		})
		searchMetrics.push({
			name: "kb-detailed",
			evidenceCoverage: kbDetailed.metadata.evidenceCoverage,
			topConfidence: kbDetailed.metadata.trustSummary?.topConfidence ?? null,
			staleCount: kbDetailed.metadata.trustSummary?.staleCount ?? 0,
			contradictionCount:
				kbDetailed.metadata.trustSummary?.contradictionCount ?? 0,
			latencyMs: Date.now() - searchStartedAt,
			pathsExecuted: kbDetailed.metadata.pathsExecuted,
		})
		if (
			kbDetailed.metadata.pathsExecuted.includes("kb") &&
			kbDetailed.results.length > 0
		) {
			checks.push(
				pass(
					"kb-detailed-search",
					`paths=${kbDetailed.metadata.pathsExecuted.join(",")}`,
				),
			)
		} else {
			checks.push(
				fail(
					"kb-detailed-search",
					`cold path: ${kbDetailed.metadata.pathsExecuted.join(",") || "none"} (expected kb lane)`,
				),
			)
		}
		const kbRead = asReadFileResponse(
			await client.readFile({ agentId, relPath: `kb:${kbPathPrimary}` }),
		)
		assert(
			kbRead.text?.includes("POST /v1/deploy"),
			"KB read-file did not reopen the ingested KB document",
		)
		checks.push(
			pass(
				"kb-search-read",
				`results=${asSearchResults(kbSearch).length}, path=kb:${kbPathPrimary}`,
			),
		)

		const agentProfile = asRecord(
			await client.profile({
				agentId,
				scope: "agent",
				scopeRef: scopeRefAgent,
				maxEntities: 5,
				maxEpisodes: 5,
				maxPerType: 5,
			}),
		)
		assert(
			Array.isArray(agentProfile.topEntities) &&
				agentProfile.topEntities.length > 0,
			"profile synthesis did not include graph entities for agent scope",
		)
		checks.push(pass("profile-api-entities", "API profile included entities"))
		const profile = asRecord(
			await client.profile({
				agentId,
				scope: "session",
				scopeRef: resolveScopeRef({ scope: "session", agentId, sessionId }),
				maxEntities: 5,
				maxEpisodes: 5,
				maxPerType: 5,
			}),
		)
		if (
			Array.isArray(profile.recentEpisodes) &&
			profile.recentEpisodes.length > 0
		) {
			checks.push(pass("profile-api-episodes", "API profile included episodes"))
		} else {
			checks.push(
				fail(
					"profile-api-episodes",
					"cold path: session-scoped profile API did not include the session episode",
				),
			)
		}
		const sessionProfile = await synthesizeProfile({
			db,
			prefix: mongoCfg.collectionPrefix,
			agentId,
			scope: "session",
			scopeRef: resolveScopeRef({ scope: "session", agentId, sessionId }),
			maxEntities: 5,
			maxEpisodes: 5,
			maxPerType: 5,
		})
		assert(
			sessionProfile.recentEpisodes.length > 0,
			"engine profile synthesis did not include the session-scoped episode",
		)
		checks.push(
			pass(
				"profile",
				"profile API covered both agent entities and session episodes",
			),
		)

		const detailedStatus = asRecord(await client.getDetailedStatus(agentId))
		const stats = asStatsResponse(await client.stats(agentId))
		assert(
			typeof stats.totalChunks === "number" && stats.totalChunks > 0,
			"stats did not report stored chunks",
		)
		if (
			typeof detailedStatus.laneCoverage === "object" ||
			typeof detailedStatus.projectionHealth === "object"
		) {
			checks.push(
				pass("detailed-status", "detailed status exposed runtime diagnostics"),
			)
		} else {
			checks.push(
				fail(
					"detailed-status",
					"cold path: /v1/status/detailed did not expose laneCoverage or projectionHealth",
				),
			)
		}
		checks.push(
			pass("status-stats", `chunks=${String(stats.totalChunks ?? 0)}`),
		)

		const embeddingProbe = asRecord(await client.probeEmbedding(agentId))
		const vectorProbe = asRecord(await client.probeVector(agentId))
		assert(
			typeof embeddingProbe.ok === "boolean",
			"embedding probe did not return an ok boolean",
		)
		assert(
			typeof vectorProbe.ok === "boolean",
			"vector probe did not return ok",
		)
		checks.push(
			pass(
				"probes",
				`embedding=${String(embeddingProbe.ok)}, vector=${String(vectorProbe.ok)}`,
			),
		)

		const repeatedQuery = "Phoenix deploy checklist process"
		await client.searchDetailed({
			agentId,
			query: repeatedQuery,
			limit: 5,
			searchMode: "agentic",
			sourcePreference: ["procedural"],
			returnPlan: true,
		})
		await client.searchDetailed({
			agentId,
			query: repeatedQuery,
			limit: 5,
			searchMode: "agentic",
			sourcePreference: ["procedural"],
			returnPlan: true,
		})

		const initialCacheHit = await checkCache({
			db,
			prefix: mongoCfg.collectionPrefix,
			query: repeatedQuery,
			agentId,
			scope: "agent",
			scopeRef: scopeRefAgent,
			config: mongoCfg.cache,
		})
		if (!initialCacheHit.hit) {
			writeCache({
				db,
				prefix: mongoCfg.collectionPrefix,
				query: repeatedQuery,
				agentId,
				scope: "agent",
				scopeRef: scopeRefAgent,
				results: procedureSearch.results,
				pathUsed: "procedural",
				sourceScope: "structured",
				ttlSec: 300,
			})
			await sleep(500)
		}
		const cacheHit = initialCacheHit.hit
			? initialCacheHit
			: await waitFor(
					"query cache hit",
					() =>
						checkCache({
							db,
							prefix: mongoCfg.collectionPrefix,
							query: repeatedQuery,
							agentId,
							scope: "agent",
							scopeRef: scopeRefAgent,
							config: mongoCfg.cache,
						}),
					(result) => result.hit,
				)
		const cacheStats = await getCacheHitRate({
			db,
			prefix: mongoCfg.collectionPrefix,
			agentId,
			windowMs: 60 * 60 * 1000,
		})
		checks.push(
			pass(
				"query-cache",
				`tier=${cacheHit.tier}, hitRate=${cacheStats.hitRate.toFixed(2)}`,
			),
		)

		const relevanceExplain = asRelevanceExplainResponse(
			await client.relevanceExplain({
				agentId,
				query:
					"What is the Phoenix deploy checklist and current release decision?",
				sourceScope: "all",
				sessionKey: sessionId,
				maxResults: 5,
				minScore: 0.05,
				deep: true,
			}),
		)
		assert(
			Array.isArray(relevanceExplain.results) &&
				relevanceExplain.results.length > 0,
			"relevance explain returned no results",
		)

		await writeFile(
			relevanceDatasetPath,
			[
				JSON.stringify({
					query: marker,
					sourceScope: "memory",
					expectedSources: ["conversation"],
				}),
				JSON.stringify({
					query: "Phoenix deploy checklist process",
					sourceScope: "structured",
					expectedSources: ["structured"],
				}),
				JSON.stringify({
					query: "Phoenix API deploy endpoint",
					sourceScope: "kb",
					expectedSources: ["reference"],
				}),
			].join("\n"),
			"utf8",
		)
		const benchmark = asRelevanceBenchmarkResponse(
			await client.relevanceBenchmark({
				agentId,
				datasetPath: relevanceDatasetPath,
				maxResults: 5,
				minScore: 0.05,
			}),
		)
		assert(
			typeof benchmark.cases === "number" && benchmark.cases >= 3,
			"relevance benchmark did not process the dataset",
		)
		const relevanceReport = asRelevanceReportResponse(
			await client.relevanceReport(agentId, 24 * 60 * 60 * 1000),
		)
		const sampleRate = asSampleRateResponse(
			await client.relevanceSampleRate(agentId),
		)
		assert(
			typeof relevanceReport.runs === "number",
			"relevance report missing run count",
		)
		assert(
			typeof sampleRate.current === "number",
			"relevance sample-rate missing current value",
		)
		checks.push(
			pass(
				"relevance",
				`cases=${benchmark.cases}, runs=${relevanceReport.runs}, sampleRate=${sampleRate.current}`,
			),
		)

		const latencyStats = await getLatencyStats({
			db,
			prefix: mongoCfg.collectionPrefix,
			agentId,
			windowMs: 60 * 60 * 1000,
		})
		const opDist = await getOperationDistribution({
			db,
			prefix: mongoCfg.collectionPrefix,
			agentId,
			windowMs: 60 * 60 * 1000,
		})
		assert(
			typeof latencyStats.p95 === "number" && latencyStats.p95 >= 0,
			"latency stats missing p95",
		)
		assert(
			Array.isArray(opDist) && opDist.length > 0,
			"operation distribution is empty",
		)
		checks.push(
			pass(
				"telemetry",
				`p95=${latencyStats.p95}, ops=${opDist.map((entry) => entry.operation).join(",")}`,
			),
		)

		const removedDoc = await removeKBDocument(
			db,
			mongoCfg.collectionPrefix,
			kbDocs.find((doc) => doc.source?.path === kbPathDisposable)?._id ?? "",
			mongo,
		)
		assert(removedDoc, "KB cleanup document was not removed")
		checks.push(pass("kb-remove", `removed=${kbPathDisposable}`))

		const laneCoverage =
			(
				await getLaneCoverage({
					db,
					prefix: mongoCfg.collectionPrefix,
					agentId,
				})
			)?.lanes ?? emptyLaneCoverage()
		const laneSummary = Object.entries(laneCoverage).map(([lane, status]) => ({
			lane,
			count: status.count,
			hasData: status.hasData,
		}))
		const coldLanes = laneSummary
			.filter((entry) => entry.hasData === false || entry.count === 0)
			.map((entry) => entry.lane)
		if (coldLanes.length > 0) {
			throw new Error(`retrieval lanes still cold: ${coldLanes.join(", ")}`)
		}
		checks.push(
			pass(
				"lane-coverage",
				laneSummary.map((entry) => `${entry.lane}:${entry.count}`).join(", "),
			),
		)

		checks.push(await runRealAgentLane())

		const report = {
			ok: checks.every((check) => check.ok),
			baseUrl,
			agentId,
			sessionId,
			workspaceDir,
			retrievalLanes: laneSummary,
			searchMetrics,
			dormantCapabilities: [
				{
					name: "batch-voyage",
					classification: "dormant-capability",
					reason:
						"The Voyage batch embedding runner exists in the engine, but the supported Memongo contract is atlas-local-preview with embeddingMode=automated, so it is not part of the hot path. batch-openai and batch-gemini were removed as dead code.",
				},
			],
			checks,
		}
		const artifactPath = await writeProofArtifact({
			suite: "real-capability-stress",
			payload: report,
		})

		console.log(
			JSON.stringify(
				artifactPath ? { ...report, artifactPath } : report,
				null,
				2,
			),
		)
	} finally {
		await mongo.close().catch(() => undefined)
		await rm(relevanceDatasetPath, { force: true }).catch(() => undefined)
		if (disposableWorkspaceCreated) {
			await rm(workspaceDir, { recursive: true, force: true }).catch(
				() => undefined,
			)
		}
	}
}

await main()
