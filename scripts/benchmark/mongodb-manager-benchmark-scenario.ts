/**
 * Benchmark scenario-lifecycle collaborator extracted from `mongodb-manager.ts`
 * (P4.3): run configuration snapshots, scenario manager settling, fast ingest,
 * search-index convergence probing, and result identity resolution. Wired
 * through `MongoDBManagerBenchmarkOps` — the facade never talks to it
 * directly.
 */

import { createHash, randomUUID } from "node:crypto"
import { createReadStream } from "node:fs"
import path from "node:path"
import type {
	BenchmarkRetrievalLane,
	BenchmarkRunConfiguration,
} from "./benchmark-parity-envelope.js"
import { readSearchIndexStatus } from "./mongodb-benchmark-readiness.js"
import { renderEventChunkText } from "../../packages/memory-engine/src/mongodb-events.js"
import {
	isEvidenceMirrorEnabled,
	writeMemoryEvidenceDocuments,
} from "../../packages/memory-engine/src/mongodb-evidence-mirror.js"
import { updateLaneCoverage } from "../../packages/memory-engine/src/mongodb-lane-coverage.js"
import {
	BENCHMARK_SCENARIO_COLLECTION_SUFFIXES,
	benchmarkConvergenceFilter,
	benchmarkSearchEqualsFilters,
	benchmarkSearchProbeTerm,
	buildBenchmarkReplayMetadata,
	hasBenchmarkSearchableText,
	parseBenchmarkTurnTimestamp,
} from "./mongodb-manager-benchmark.js"
import type { BenchmarkEventEvidenceMaps } from "./mongodb-manager-benchmark.js"
import type { MongoDBManagerHost } from "../../packages/memory-engine/src/mongodb-manager-host.js"
import type { MongoDBMemoryManager } from "../../packages/memory-engine/src/mongodb-manager.js"
import { recordProjectionRun } from "../../packages/memory-engine/src/mongodb-ops.js"
import {
	checkCache,
	writeCache,
} from "../../packages/memory-engine/src/mongodb-query-cache.js"
import {
	chunksCollection,
	eventsCollection,
	memoryEvidenceCollection,
	queryCacheCollection,
	sessionChunksCollection,
} from "../../packages/memory-engine/src/mongodb-schema.js"
import { resolveScopeRef } from "../../packages/memory-engine/src/mongodb-scope.js"
import { isBenchmarkStrictMode } from "../../packages/memory-engine/src/mongodb-search-ranking.js"
import {
	buildVectorSearchStage,
	vectorSearch,
} from "../../packages/memory-engine/src/mongodb-search.js"
import type {
	MemoryBenchmarkDatasetKind,
	MemoryBenchmarkConversation,
	MemoryBenchmarkTurn,
	MemoryBenchmarkIngestResult,
	MemorySearchResult,
} from "../../packages/memory-engine/src/types.js"
import { createSubsystemLogger } from "@memongo/lib"
import type { MemoryScope } from "@memongo/lib"
import type { Collection, Document } from "mongodb"

const log = createSubsystemLogger("memory:mongodb")

export class MongoDBManagerBenchmarkScenarioOps {
	constructor(private readonly host: MongoDBManagerHost) {}

	snapshotBenchmarkRunConfiguration(params: {
		executionProfile: "shipped" | "diagnostic"
		retrievalLane: BenchmarkRetrievalLane
		maxResults: number
		minScore: number
		qualityContractId?: string
		qualityContractVersion?: string
	}): BenchmarkRunConfiguration {
		const mongoCfg = this.host.config.mongodb!
		const settings: BenchmarkRunConfiguration["settings"] = {
			qualityContractId: params.qualityContractId ?? null,
			qualityContractVersion: params.qualityContractVersion ?? null,
			deploymentProfile: mongoCfg.deploymentProfile,
			numCandidates: mongoCfg.numCandidates,
			fusionMethod: mongoCfg.fusionMethod,
			embeddingMode: mongoCfg.embeddingMode,
			embeddingDimensions: mongoCfg.numDimensions,
			embeddingQuantization: mongoCfg.quantization,
			cacheEnabled: mongoCfg.cache.enabled,
			cacheConversationTtlSec: mongoCfg.cache.conversationTtlSec,
			cacheKbTtlSec: mongoCfg.cache.kbTtlSec,
			cacheSimilarityThreshold: mongoCfg.cache.similarityThreshold,
			rerankerEnabled: mongoCfg.reranking?.enabled ?? false,
			rerankerModel: mongoCfg.reranking?.model ?? null,
			rerankerTopN: mongoCfg.reranking?.topN ?? null,
			rerankerMinScore: mongoCfg.reranking?.minScore ?? null,
			rerankerInstructionSha256: mongoCfg.reranking?.instruction
				? createHash("sha256")
						.update(mongoCfg.reranking.instruction)
						.digest("hex")
				: null,
			rerankerApiKeySha256: mongoCfg.reranking?.voyageApiKey
				? createHash("sha256")
						.update(mongoCfg.reranking.voyageApiKey)
						.digest("hex")
				: null,
			queryRewritingEnabled: mongoCfg.queryRewriting.enabled,
			queryRewritingMethod: mongoCfg.queryRewriting.method,
			queryRewritingMaxTokens: mongoCfg.queryRewriting.maxTokens,
			conversationSourceEnabled: mongoCfg.sources.conversation.enabled,
			referenceSourceEnabled: mongoCfg.sources.reference.enabled,
			structuredSourceEnabled: mongoCfg.sources.structured.enabled,
			kbEnabled: mongoCfg.kb.enabled,
			graphEnabled: mongoCfg.graph.enabled,
			graphMaxDepth: mongoCfg.graph.maxGraphDepth,
			graphEntityExtractionMethod: mongoCfg.graph.entityExtraction.method,
			graphEntityExtractionModel: mongoCfg.graph.entityExtraction.model ?? null,
			graphEntityExtractionTimeoutMs: mongoCfg.graph.entityExtraction.timeoutMs,
			episodesEnabled: mongoCfg.episodes.enabled,
			episodesMinEvents: mongoCfg.episodes.minEventsForEpisode,
			vectorSearchCapability: this.host.capabilities.vectorSearch,
			textSearchCapability: this.host.capabilities.textSearch,
			scoreFusionCapability: this.host.capabilities.scoreFusion,
			rankFusionCapability: this.host.capabilities.rankFusion,
		}
		const environmentKeys = [
			"MEMONGO_BENCHMARK_STRICT",
			"MEMONGO_BENCHMARK_DERIVED_WORK_MODE",
			"MEMONGO_BENCHMARK_EVENT_SEARCH_PROBE_MAX_TIME_MS",
			"MEMONGO_BENCHMARK_EVENT_SEARCH_SETTLE_TIMEOUT_MS",
			"MEMONGO_BENCHMARK_FAST_INGEST",
			"MEMONGO_BENCHMARK_FAST_INGEST_BATCH_SIZE",
			"MEMONGO_BENCHMARK_KEEP_SCENARIO_DATA",
			"MEMONGO_BENCHMARK_MEASUREMENT_PASSES",
			"MEMONGO_BENCHMARK_QUEUE_SETTLE_TIMEOUT_MS",
			"MEMONGO_BENCHMARK_TEMPORAL_COVERAGE_MODE",
			"MEMONGO_BENCHMARK_TURN_PRECISION_MODE",
			"MEMONGO_BENCHMARK_VECTOR_SEARCH_PROBE_MAX_TIME_MS",
			"MEMONGO_BENCHMARK_VECTOR_SEARCH_SETTLE_TIMEOUT_MS",
			"MEMONGO_ENRICHMENT_CONCURRENCY",
			"MEMONGO_ENRICHMENT_ALLOW_PRIVATE_NETWORK",
			"MEMONGO_ENRICHMENT_AUTH_STYLE",
			"MEMONGO_ENRICHMENT_MODEL",
			"MEMONGO_ENRICHMENT_PROVIDER",
			"MEMONGO_ENRICHMENT_TOKEN_PARAM",
			"MEMONGO_EVIDENCE_SETTLE_MS",
			"MEMONGO_EVIDENCE_MIRROR_MODE",
			"MEMONGO_LLM_ENRICHMENT_MAX_RETRIES",
			"MEMONGO_LLM_ENRICHMENT_MAX_TOKENS",
			"MEMONGO_LLM_ENRICHMENT_MODE",
			"MEMONGO_LLM_ENRICHMENT_STRICT",
			"MEMONGO_LLM_ENRICHMENT_TIMEOUT_MS",
			"MEMONGO_PREFERENCE_EVIDENCE_MODE",
			"MEMONGO_QUERY_DECOMPOSITION_MODE",
			// #66: reranking costs ~715ms of p95 and changes ranking, so a
			// rerank-off run must not hash identically to a rerank-on one.
			"MEMONGO_RERANKING_ENABLED",
			"MEMONGO_RERANK_MIN_SCORE",
			"MEMONGO_RERANK_STRICT",
			"MEMONGO_SCORING_ABLATION",
			"MEMONGO_SESSION_EVIDENCE_MODE",
			"MEMONGO_STRICT_SEARCH_INDEX_READY",
			"MEMONGO_TEMPORAL_COVERAGE_MODE",
			"MEMONGO_USERFACT_EVIDENCE_MODE",
			"MEMONGO_VECTOR_INDEXING_METHOD",
			"MEMONGO_VECTOR_STORED_SOURCE",
		] as const
		for (const key of environmentKeys) {
			settings[`env.${key}`] = process.env[key]?.trim() || null
		}
		const enrichmentApiKey =
			process.env.MEMONGO_ENRICHMENT_API_KEY?.trim() ?? ""
		settings["env.MEMONGO_ENRICHMENT_API_KEY.sha256"] = enrichmentApiKey
			? createHash("sha256").update(enrichmentApiKey).digest("hex")
			: null
		const enrichmentBaseUrl =
			process.env.MEMONGO_ENRICHMENT_BASE_URL?.trim() ?? ""
		settings["env.MEMONGO_ENRICHMENT_BASE_URL.sha256"] = enrichmentBaseUrl
			? createHash("sha256").update(enrichmentBaseUrl).digest("hex")
			: null
		return {
			executionProfile: params.executionProfile,
			retrievalLane: params.retrievalLane,
			maxResults: params.maxResults,
			minScore: params.minScore,
			settings,
		}
	}

	async settleBenchmarkScenarioManager(
		manager: MongoDBManagerHost,
	): Promise<void> {
		const configuredTimeout = Number(
			process.env.MEMONGO_BENCHMARK_QUEUE_SETTLE_TIMEOUT_MS,
		)
		const timeoutMs =
			Number.isFinite(configuredTimeout) && configuredTimeout >= 0
				? configuredTimeout
				: isBenchmarkStrictMode()
					? 60_000
					: 0
		const awaitQueue = async (queue: Promise<void>, label: string) => {
			if (timeoutMs === 0) {
				await queue
				return
			}
			let timeout: ReturnType<typeof setTimeout> | undefined
			await Promise.race([
				queue,
				new Promise<never>((_, reject) => {
					timeout = setTimeout(() => {
						reject(
							new Error(
								`benchmark scenario manager ${label} settle timed out after ${timeoutMs}ms`,
							),
						)
					}, timeoutMs)
				}),
			]).finally(() => {
				if (timeout) clearTimeout(timeout)
			})
		}

		for (let attempt = 0; attempt < 8; attempt++) {
			const writeQueue = manager.writeQueue
			const derivationSchedulingQueue =
				manager.derivationSchedulingQueue ?? Promise.resolve()
			const derivationQueue = manager.derivationQueue
			const memoryJobWorkerPromise =
				manager.memoryJobWorkerPromise ?? Promise.resolve()
			await awaitQueue(writeQueue, "writeQueue")
			await awaitQueue(derivationSchedulingQueue, "derivationSchedulingQueue")
			await awaitQueue(derivationQueue, "derivationQueue")
			await awaitQueue(memoryJobWorkerPromise, "memoryJobWorkerPromise")
			if (
				writeQueue === manager.writeQueue &&
				derivationSchedulingQueue ===
					(manager.derivationSchedulingQueue ?? derivationSchedulingQueue) &&
				derivationQueue === manager.derivationQueue &&
				memoryJobWorkerPromise ===
					(manager.memoryJobWorkerPromise ?? memoryJobWorkerPromise)
			) {
				return
			}
		}
		log.warn("benchmark scenario manager did not fully settle after retries", {
			agentId: manager.agentId,
		})
	}

	shouldUseBenchmarkFastIngest(): boolean {
		const mode = process.env.MEMONGO_BENCHMARK_FAST_INGEST?.trim().toLowerCase()
		if (mode === "0" || mode === "false" || mode === "off" || mode === "none") {
			return false
		}
		if (
			mode === "1" ||
			mode === "true" ||
			mode === "on" ||
			mode === "enabled"
		) {
			return true
		}
		return !this.host.shouldRunPostWriteDerivedWork()
	}

	async insertBenchmarkDocumentsInBatches(
		collection: Collection<Document>,
		docs: Document[],
	): Promise<void> {
		if (docs.length === 0) return
		const configuredBatchSize = Number(
			process.env.MEMONGO_BENCHMARK_FAST_INGEST_BATCH_SIZE,
		)
		const batchSize =
			Number.isFinite(configuredBatchSize) && configuredBatchSize > 0
				? Math.min(1000, Math.floor(configuredBatchSize))
				: 200
		for (let offset = 0; offset < docs.length; offset += batchSize) {
			await collection.insertMany(docs.slice(offset, offset + batchSize), {
				ordered: false,
			})
		}
	}

	async fastIngestBenchmarkConversations(params: {
		datasetPath: string
		datasetName?: string
		datasetKind?: MemoryBenchmarkDatasetKind
		conversations: MemoryBenchmarkConversation[]
		failedLines?: number
		scope?: MemoryScope
		metadata?: Record<string, unknown>
	}): Promise<MemoryBenchmarkIngestResult> {
		const startedAt = new Date()
		const eventDocs: Document[] = []
		const chunkDocs: Document[] = []
		const eventIdsBySession = new Map<string, string[]>()
		let conversationsIngested = 0
		let turnsIngested = 0
		let skippedConversations = 0
		let failedTurns = 0

		for (const [index, conversation] of params.conversations.entries()) {
			const turns = conversation.turns
			if (turns.length === 0) {
				skippedConversations++
				continue
			}
			const sessionId =
				conversation.sessionId ??
				conversation.conversationId ??
				`conversation-${index + 1}`
			const scope =
				conversation.scope ?? params.scope ?? ("agent" as MemoryScope)
			const scopeRef = resolveScopeRef({
				scope,
				agentId: this.host.agentId,
				sessionId,
			})
			const conversationId = conversation.conversationId ?? sessionId

			for (const turn of turns) {
				try {
					const eventId = randomUUID()
					const timestamp =
						parseBenchmarkTurnTimestamp(turn.timestamp) ?? new Date()
					const metadata = buildBenchmarkReplayMetadata({
						baseMetadata: params.metadata,
						turnMetadata: turn.metadata,
						datasetName: params.datasetName,
						datasetKind: params.datasetKind,
						conversationId,
					})
					const eventDoc = {
						eventId,
						agentId: this.host.agentId,
						sessionId,
						role: turn.role,
						body: turn.body,
						scope,
						scopeRef,
						timestamp,
						projectedAt: startedAt,
						metadata,
					}
					const sessionEventIds = eventIdsBySession.get(sessionId) ?? []
					sessionEventIds.push(eventId)
					eventIdsBySession.set(sessionId, sessionEventIds)
					const text = renderEventChunkText({
						role: turn.role,
						body: turn.body,
					})
					const path = `events/${eventId}`
					chunkDocs.push({
						path,
						text,
						hash: createHash("sha256").update(text).digest("hex"),
						source: "conversation",
						agentId: this.host.agentId,
						scope,
						scopeRef,
						sessionId,
						updatedAt: startedAt,
					})
					eventDocs.push(eventDoc)
					turnsIngested++
				} catch (err) {
					failedTurns++
					log.warn("benchmark fast ingest turn failed", {
						datasetPath: params.datasetPath,
						datasetName: params.datasetName,
						sessionId,
						role: (turn as MemoryBenchmarkTurn).role,
						error: err instanceof Error ? err.message : String(err),
					})
				}
			}
			conversationsIngested++
		}

		await this.insertBenchmarkDocumentsInBatches(
			eventsCollection(this.host.db, this.host.prefix),
			eventDocs,
		)
		await this.insertBenchmarkDocumentsInBatches(
			chunksCollection(this.host.db, this.host.prefix),
			chunkDocs,
		)
		let memoryEvidenceCount = 0
		if (isEvidenceMirrorEnabled()) {
			const evidenceScope = params.scope ?? ("agent" as MemoryScope)
			const evidenceScopeRef = resolveScopeRef({
				scope: evidenceScope,
				agentId: this.host.agentId,
			})
			memoryEvidenceCount = await writeMemoryEvidenceDocuments({
				collection: memoryEvidenceCollection(this.host.db, this.host.prefix),
				conversations: params.conversations,
				agentId: this.host.agentId,
				scope: evidenceScope,
				scopeRef: evidenceScopeRef,
				eventIds: eventIdsBySession,
			})
		}
		if (turnsIngested > 0) {
			await updateLaneCoverage({
				db: this.host.db,
				prefix: this.host.prefix,
				agentId: this.host.agentId,
				increments: {
					"raw-window": turnsIngested,
					hybrid: chunkDocs.length,
					...(memoryEvidenceCount > 0
						? { "memory-evidence": memoryEvidenceCount }
						: {}),
				},
			})
		}
		await recordProjectionRun({
			db: this.host.db,
			prefix: this.host.prefix,
			run: {
				agentId: this.host.agentId,
				projectionType: "chunks",
				status: "ok",
				itemsProjected: chunkDocs.length,
				durationMs: Date.now() - startedAt.getTime(),
			},
		}).catch(() => {})
		this.host.chunkCount += chunkDocs.length
		this.host.dirty = false

		return {
			datasetPath: params.datasetPath,
			datasetName: params.datasetName,
			conversationsIngested,
			turnsIngested,
			skippedConversations,
			failedLines: params.failedLines ?? 0,
			failedTurns,
			startedAt,
			completedAt: new Date(),
		}
	}

	async waitForBenchmarkSearchConvergence(params: {
		agentId: string
		retrievalLane?: BenchmarkRetrievalLane
		scope?: MemoryScope
		scopeRef?: string
		sessionId?: string
	}): Promise<void> {
		if (params.retrievalLane === "raw-session") {
			await this.waitForBenchmarkVectorSearchCollectionConvergence({
				agentId: params.agentId,
				scope: params.scope,
				scopeRef: params.scopeRef,
				sessionId: params.sessionId,
				label: "session_chunks",
				collection: sessionChunksCollection(this.host.db, this.host.prefix),
				collectionName: `${this.host.prefix}session_chunks`,
				indexName: `${this.host.prefix}session_chunks_vector`,
				textPath: "text",
				requireSearchableDocuments: true,
			})
			return
		}
		await this.waitForBenchmarkSearchCollectionConvergence({
			agentId: params.agentId,
			scope: params.scope,
			scopeRef: params.scopeRef,
			sessionId: params.sessionId,
			label: "events",
			collection: eventsCollection(this.host.db, this.host.prefix),
			collectionName: `${this.host.prefix}events`,
			indexName: `${this.host.prefix}events_text`,
			textPath: "body",
		})
		await this.waitForBenchmarkVectorSearchCollectionConvergence({
			agentId: params.agentId,
			scope: params.scope,
			scopeRef: params.scopeRef,
			sessionId: params.sessionId,
			label: "events",
			collection: eventsCollection(this.host.db, this.host.prefix),
			collectionName: `${this.host.prefix}events`,
			indexName: `${this.host.prefix}events_vector`,
			textPath: "body",
		})
		await this.waitForBenchmarkSearchCollectionConvergence({
			agentId: params.agentId,
			scope: params.scope,
			scopeRef: params.scopeRef,
			sessionId: params.sessionId,
			label: "chunks",
			collection: chunksCollection(this.host.db, this.host.prefix),
			collectionName: `${this.host.prefix}chunks`,
			indexName: `${this.host.prefix}chunks_text`,
			textPath: "text",
		})
		await this.waitForBenchmarkVectorSearchCollectionConvergence({
			agentId: params.agentId,
			scope: params.scope,
			scopeRef: params.scopeRef,
			sessionId: params.sessionId,
			label: "chunks",
			collection: chunksCollection(this.host.db, this.host.prefix),
			collectionName: `${this.host.prefix}chunks`,
			indexName: `${this.host.prefix}chunks_vector`,
			textPath: "text",
		})
		await this.waitForBenchmarkSearchCollectionConvergence({
			agentId: params.agentId,
			scope: params.scope,
			scopeRef: params.scopeRef,
			sessionId: params.sessionId,
			label: "session_chunks",
			collection: sessionChunksCollection(this.host.db, this.host.prefix),
			collectionName: `${this.host.prefix}session_chunks`,
			indexName: `${this.host.prefix}session_chunks_text`,
			textPath: "text",
		})
		await this.waitForBenchmarkVectorSearchCollectionConvergence({
			agentId: params.agentId,
			scope: params.scope,
			scopeRef: params.scopeRef,
			sessionId: params.sessionId,
			label: "session_chunks",
			collection: sessionChunksCollection(this.host.db, this.host.prefix),
			collectionName: `${this.host.prefix}session_chunks`,
			indexName: `${this.host.prefix}session_chunks_vector`,
			textPath: "text",
		})
		if (isEvidenceMirrorEnabled()) {
			await this.waitForBenchmarkSearchCollectionConvergence({
				agentId: params.agentId,
				scope: params.scope,
				scopeRef: params.scopeRef,
				sessionId: params.sessionId,
				label: "memory_evidence",
				collection: memoryEvidenceCollection(this.host.db, this.host.prefix),
				collectionName: `${this.host.prefix}memory_evidence`,
				indexName: `${this.host.prefix}memory_evidence_text`,
				textPath: "text",
			})
		}
	}

	async waitForBenchmarkSearchReadiness(params?: {
		retrievalLane?: BenchmarkRetrievalLane
		scope?: MemoryScope
		scopeRef?: string
		sessionId?: string
	}): Promise<void> {
		await this.waitForBenchmarkSearchConvergence({
			agentId: this.host.agentId,
			retrievalLane: params?.retrievalLane,
			scope: params?.scope,
			scopeRef: params?.scopeRef,
			sessionId: params?.sessionId,
		})
	}

	async waitForBenchmarkVectorSearchCollectionConvergence(params: {
		agentId: string
		scope?: MemoryScope
		scopeRef?: string
		sessionId?: string
		label: string
		collection: Collection<Document>
		collectionName: string
		indexName: string
		textPath: string
		requireSearchableDocuments?: boolean
	}): Promise<void> {
		const {
			agentId,
			label,
			collection,
			collectionName,
			indexName,
			textPath,
			requireSearchableDocuments = false,
		} = params
		const namespace = {
			agentId,
			scope: params.scope,
			scopeRef: params.scopeRef,
			sessionId: params.sessionId,
		}
		const scopeFilter = benchmarkConvergenceFilter(namespace)
		const mongoCfg = this.host.config.mongodb!
		if (
			mongoCfg.embeddingMode !== "automated" ||
			!this.host.capabilities.vectorSearch
		) {
			if (isBenchmarkStrictMode()) {
				throw new Error(
					"benchmark vector convergence requires MongoDB Vector Search auto-embed capability in strict mode",
				)
			}
			return
		}

		const expectedDocs = await collection
			.find(
				{
					...scopeFilter,
					[textPath]: { $type: "string", $ne: "" },
				},
				{ projection: { [textPath]: 1 } },
			)
			.toArray()
		const expectedCount = expectedDocs.filter((doc) =>
			hasBenchmarkSearchableText(doc[textPath]),
		).length
		if (expectedCount === 0) {
			const message = `benchmark ${label} vector convergence has no searchable documents: collection=${collectionName} agentId=${agentId} textPath=${textPath}`
			if (requireSearchableDocuments && isBenchmarkStrictMode()) {
				throw new Error(message)
			}
			if (requireSearchableDocuments) {
				log.warn(message)
			}
			return
		}

		const configuredTimeout = Number(
			process.env.MEMONGO_BENCHMARK_VECTOR_SEARCH_SETTLE_TIMEOUT_MS ??
				process.env.MEMONGO_BENCHMARK_EVENT_SEARCH_SETTLE_TIMEOUT_MS,
		)
		const timeoutMs =
			Number.isFinite(configuredTimeout) && configuredTimeout >= 0
				? configuredTimeout
				: isBenchmarkStrictMode()
					? 300_000
					: 0
		if (timeoutMs === 0) return

		const readinessProbe = await readSearchIndexStatus(
			this.host.db,
			collectionName,
			indexName,
		)
		if (readinessProbe.kind === "ok") {
			if (
				(readinessProbe.status === "FAILED" ||
					readinessProbe.status === "DELETING" ||
					readinessProbe.status === "STALE") &&
				isBenchmarkStrictMode()
			) {
				throw new Error(
					`index-not-ready: vector index ${indexName} status ${readinessProbe.status} (queryable=${readinessProbe.queryable}) agentId=${agentId}`,
				)
			}
		}

		const limit = Math.min(expectedCount, 1000)
		const vectorStage = buildVectorSearchStage({
			queryVector: null,
			queryText: "benchmark vector readiness probe",
			embeddingMode: mongoCfg.embeddingMode,
			indexName,
			numCandidates: Math.max(limit, Math.min(expectedCount * 4, 10_000)),
			limit,
			filter: scopeFilter,
			textFieldPath: textPath,
			exact: true,
		})
		if (!vectorStage) {
			if (isBenchmarkStrictMode()) {
				throw new Error(
					`benchmark ${label} vector convergence cannot build $vectorSearch stage agentId=${agentId}`,
				)
			}
			return
		}

		const intervalMs = 2_000
		const configuredProbeMaxTime = Number(
			process.env.MEMONGO_BENCHMARK_VECTOR_SEARCH_PROBE_MAX_TIME_MS ??
				process.env.MEMONGO_BENCHMARK_EVENT_SEARCH_PROBE_MAX_TIME_MS,
		)
		const probeMaxTimeMs =
			Number.isFinite(configuredProbeMaxTime) && configuredProbeMaxTime > 0
				? Math.floor(configuredProbeMaxTime)
				: 30_000
		const deadline = Date.now() + timeoutMs
		let indexedCount = 0
		let lastError: unknown
		let lastProgressLogAt = 0

		while (Date.now() <= deadline) {
			try {
				const controller = new AbortController()
				let timeout: ReturnType<typeof setTimeout> | undefined
				const probe = collection
					.aggregate<{ count: number }>(
						[{ $vectorSearch: vectorStage }, { $count: "count" }],
						{ maxTimeMS: probeMaxTimeMs, signal: controller.signal },
					)
					.toArray()
				const rows = await Promise.race([
					probe,
					new Promise<Array<{ count: number }>>((_, reject) => {
						timeout = setTimeout(() => {
							controller.abort()
							reject(
								new Error(
									`benchmark vector convergence probe exceeded ${probeMaxTimeMs}ms`,
								),
							)
						}, probeMaxTimeMs)
					}),
				]).finally(() => {
					if (timeout) clearTimeout(timeout)
				})
				indexedCount =
					typeof rows[0]?.count === "number" ? Number(rows[0].count) : 0
				if (indexedCount >= Math.min(expectedCount, limit)) {
					return
				}
			} catch (err) {
				lastError = err
				if (!isBenchmarkStrictMode()) {
					log.warn("benchmark vector convergence probe failed", {
						agentId,
						error: err instanceof Error ? err.message : String(err),
					})
					return
				}
			}
			const now = Date.now()
			if (now - lastProgressLogAt >= 30_000) {
				lastProgressLogAt = now
				log.info("benchmark vector convergence waiting", {
					agentId,
					collection: collectionName,
					index: indexName,
					indexedCount,
					expectedCount,
					remainingMs: Math.max(0, deadline - now),
					lastError: lastError ? String(lastError) : undefined,
				})
			}
			await new Promise((resolve) => setTimeout(resolve, intervalMs))
		}

		const message = `benchmark ${label} vector convergence timed out: indexed=${indexedCount}/${expectedCount} agentId=${agentId}`
		if (isBenchmarkStrictMode()) {
			throw new Error(
				lastError ? `${message}; lastError=${String(lastError)}` : message,
			)
		}
		log.warn(message)
	}

	async waitForBenchmarkEventSearchConvergence(agentId: string): Promise<void> {
		await this.waitForBenchmarkSearchCollectionConvergence({
			agentId,
			label: "events",
			collection: eventsCollection(this.host.db, this.host.prefix),
			collectionName: `${this.host.prefix}events`,
			indexName: `${this.host.prefix}events_text`,
			textPath: "body",
		})
	}

	async waitForBenchmarkSearchCollectionConvergence(params: {
		agentId: string
		scope?: MemoryScope
		scopeRef?: string
		sessionId?: string
		label: string
		collection: Collection<Document>
		collectionName: string
		indexName: string
		textPath: string
	}): Promise<void> {
		const { agentId, label, collection, collectionName, indexName, textPath } =
			params
		const namespace = {
			agentId,
			scope: params.scope,
			scopeRef: params.scopeRef,
			sessionId: params.sessionId,
		}
		const scopeFilter = benchmarkConvergenceFilter(namespace)
		const searchFilters = benchmarkSearchEqualsFilters(namespace)
		if (!this.host.capabilities.textSearch) {
			if (isBenchmarkStrictMode()) {
				throw new Error(
					"benchmark event search convergence requires MongoDB Search text capability in strict mode",
				)
			}
			return
		}

		const expectedDocs = await collection
			.find(
				{
					...scopeFilter,
					[textPath]: { $type: "string", $ne: "" },
				},
				{ projection: { [textPath]: 1 } },
			)
			.toArray()
		const expectedCount = expectedDocs.filter((doc) =>
			hasBenchmarkSearchableText(doc[textPath]),
		).length
		const textProbeQuery = [...expectedDocs]
			.reverse()
			.map((doc) => benchmarkSearchProbeTerm(doc[textPath]))
			.find((term): term is string => Boolean(term))
		if (expectedCount === 0) return

		const configuredTimeout = Number(
			process.env.MEMONGO_BENCHMARK_EVENT_SEARCH_SETTLE_TIMEOUT_MS,
		)
		const timeoutMs =
			Number.isFinite(configuredTimeout) && configuredTimeout >= 0
				? configuredTimeout
				: isBenchmarkStrictMode()
					? 60_000
					: 0
		if (timeoutMs === 0) return

		const readinessProbe = await readSearchIndexStatus(
			this.host.db,
			collectionName,
			indexName,
		)
		if (readinessProbe.kind === "ok") {
			if (readinessProbe.queryable) {
				if (readinessProbe.status === "STALE" && isBenchmarkStrictMode()) {
					throw new Error(
						`index-not-ready: search index ${indexName} status STALE (queryable=${readinessProbe.queryable}) agentId=${agentId}`,
					)
				}
				// queryable=true means the index is usable, not that fresh writes have
				// propagated into mongot. MongoDB Search is eventually consistent, so
				// benchmark setup must still probe document visibility below.
			}
			if (!readinessProbe.queryable && isBenchmarkStrictMode()) {
				throw new Error(
					`index-not-ready: search index ${indexName} queryable=false status=${readinessProbe.status} agentId=${agentId}`,
				)
			}
			// non-strict: fall through to aggregate probe and keep polling
		}

		const intervalMs = 2_000
		const configuredProbeMaxTime = Number(
			process.env.MEMONGO_BENCHMARK_EVENT_SEARCH_PROBE_MAX_TIME_MS,
		)
		const probeMaxTimeMs =
			Number.isFinite(configuredProbeMaxTime) && configuredProbeMaxTime > 0
				? Math.floor(configuredProbeMaxTime)
				: 5_000
		const deadline = Date.now() + timeoutMs
		let indexedCount = 0
		let textProbeCount = 0
		let lastError: unknown

		while (Date.now() <= deadline) {
			try {
				const controller = new AbortController()
				let timeout: ReturnType<typeof setTimeout> | undefined
				const probe = collection
					.aggregate<{
						count?: { total?: number; lowerBound?: number } | number
					}>(
						[
							{
								$searchMeta: {
									index: indexName,
									compound: {
										filter: searchFilters,
										must: [
											{
												// Atlas Search `exists` can report zero for analyzed string
												// fields even after `text` queries are live; wildcard probes
												// the same analyzed field used by retrieval.
												wildcard: {
													path: textPath,
													query: "*",
													allowAnalyzedField: true,
												},
											},
										],
									},
									count: { type: "total" },
								},
							},
						],
						{
							maxTimeMS: probeMaxTimeMs,
							signal: controller.signal,
						},
					)
					.toArray()
				const rows = await Promise.race([
					probe,
					new Promise<never>((_, reject) => {
						timeout = setTimeout(() => {
							controller.abort()
							reject(
								new Error(
									`benchmark event search convergence probe exceeded ${probeMaxTimeMs}ms`,
								),
							)
						}, probeMaxTimeMs)
					}),
				]).finally(() => {
					if (timeout) clearTimeout(timeout)
				})
				const countMeta = rows[0]?.count
				indexedCount =
					typeof countMeta === "number"
						? countMeta
						: (countMeta?.total ?? countMeta?.lowerBound ?? 0)
				if (indexedCount >= expectedCount && !textProbeQuery) {
					return
				}
				if (indexedCount >= expectedCount && textProbeQuery) {
					const textProbeRows = await collection
						.aggregate<{
							count?: { total?: number; lowerBound?: number } | number
						}>(
							[
								{
									$searchMeta: {
										index: indexName,
										compound: {
											filter: searchFilters,
											must: [
												{
													text: {
														path: textPath,
														query: textProbeQuery,
													},
												},
											],
										},
										count: { type: "total" },
									},
								},
							],
							{
								maxTimeMS: probeMaxTimeMs,
								signal: controller.signal,
							},
						)
						.toArray()
					const textCountMeta = textProbeRows[0]?.count
					textProbeCount =
						typeof textCountMeta === "number"
							? textCountMeta
							: (textCountMeta?.total ?? textCountMeta?.lowerBound ?? 0)
					if (textProbeCount > 0) {
						return
					}
				}
			} catch (err) {
				lastError = err
				if (!isBenchmarkStrictMode()) {
					log.warn("benchmark event search convergence probe failed", {
						agentId,
						error: err instanceof Error ? err.message : String(err),
					})
					return
				}
			}
			await new Promise((resolve) => setTimeout(resolve, intervalMs))
		}

		const message = `benchmark ${label} search convergence timed out: indexed=${indexedCount}/${expectedCount} textProbe=${textProbeCount}${textProbeQuery ? ` query=${textProbeQuery}` : ""} agentId=${agentId}`
		if (isBenchmarkStrictMode()) {
			throw new Error(
				lastError ? `${message}; lastError=${String(lastError)}` : message,
			)
		}
		log.warn(message)
	}

	async cleanupBenchmarkScenarioData(agentId: string): Promise<void> {
		const settled = await Promise.allSettled(
			BENCHMARK_SCENARIO_COLLECTION_SUFFIXES.map(async (suffix) => {
				await this.host.db
					.collection(`${this.host.prefix}${suffix}`)
					.deleteMany({ agentId })
			}),
		)
		for (const [index, result] of settled.entries()) {
			if (result.status === "rejected") {
				log.warn("benchmark scenario cleanup failed", {
					agentId,
					collection: BENCHMARK_SCENARIO_COLLECTION_SUFFIXES[index],
					error: result.reason,
				})
			}
		}
	}

	/**
	 * #66: drop the benchmark tenant's query cache between measurement passes.
	 * Without this, pass 2+ replays pass 1 from `query_cache` — latencyMs ~0 and
	 * bit-identical rankings — so every extra pass would be fake-fast noise-free
	 * garbage. Deleting the scenario agent's entries keeps every pass as cold as
	 * pass 1 without touching the shipped `checkCache`/`writeCache` path.
	 *
	 * `writeCache` is fire-and-forget, so an upsert issued by the previous
	 * pass's last query can still land after this delete; at most one stale
	 * entry per pass survives, which cannot move a p95 over a full dataset.
	 */
	async flushBenchmarkQueryCache(agentId: string): Promise<void> {
		try {
			const deleted = await queryCacheCollection(
				this.host.db,
				this.host.prefix,
			).deleteMany({ agentId })
			log.info("benchmark query cache flushed between measurement passes", {
				agentId,
				deletedCount: deleted.deletedCount,
			})
		} catch (err) {
			throw new Error(
				`benchmark query cache flush failed for agentId=${agentId}: ${err instanceof Error ? err.message : String(err)}`,
			)
		}
	}

	async listBenchmarkEventSessions(
		agentId: string,
	): Promise<Map<string, string>> {
		return (await this.listBenchmarkEventEvidence(agentId)).sessionIds
	}

	async listBenchmarkEventEvidence(
		agentId: string,
	): Promise<BenchmarkEventEvidenceMaps> {
		const rows = await eventsCollection(this.host.db, this.host.prefix)
			.find(
				{ agentId },
				{
					projection: {
						eventId: 1,
						sessionId: 1,
						metadata: 1,
					},
				},
			)
			.toArray()
		const evidence: BenchmarkEventEvidenceMaps = {
			sessionIds: new Map<string, string>(),
			turnIds: new Map<string, string>(),
			dialogIds: new Map<string, string>(),
		}
		for (const row of rows) {
			if (typeof row.eventId !== "string" || row.eventId.trim().length === 0) {
				continue
			}
			const eventId = row.eventId.trim()
			if (
				typeof row.sessionId === "string" &&
				row.sessionId.trim().length > 0
			) {
				evidence.sessionIds.set(eventId, row.sessionId.trim())
			}
			const metadata =
				row.metadata && typeof row.metadata === "object"
					? (row.metadata as Record<string, unknown>)
					: undefined
			if (
				typeof metadata?.benchmarkTurnId === "string" &&
				metadata.benchmarkTurnId.trim().length > 0
			) {
				evidence.turnIds.set(eventId, metadata.benchmarkTurnId.trim())
			}
			if (
				typeof metadata?.locomoDialogId === "string" &&
				metadata.locomoDialogId.trim().length > 0
			) {
				evidence.dialogIds.set(eventId, metadata.locomoDialogId.trim())
			}
		}
		return evidence
	}

	collectBenchmarkResultSourceEventIds(result: MemorySearchResult): string[] {
		const sourceEventIds = new Set<string>()
		if (Array.isArray(result.sourceEventIds)) {
			for (const eventId of result.sourceEventIds) {
				if (typeof eventId === "string" && eventId.trim().length > 0) {
					sourceEventIds.add(eventId.trim())
				}
			}
		}
		const provenance = result.provenance
		if (
			provenance &&
			typeof provenance === "object" &&
			Array.isArray(
				(provenance as { sourceEventIds?: unknown[] }).sourceEventIds,
			)
		) {
			for (const eventId of (provenance as { sourceEventIds: unknown[] })
				.sourceEventIds) {
				if (typeof eventId === "string" && eventId.trim().length > 0) {
					sourceEventIds.add(eventId.trim())
				}
			}
		}
		return Array.from(sourceEventIds)
	}

	resolveBenchmarkResultSessionIds(
		result: MemorySearchResult,
		evidence: BenchmarkEventEvidenceMaps | Map<string, string>,
	): string[] {
		const sessionIds: string[] = []
		if (
			typeof result.sessionId === "string" &&
			result.sessionId.trim().length > 0
		) {
			sessionIds.push(result.sessionId.trim())
		}
		// Recognize session-chunk canonical IDs (from session evidence documents)
		if (
			typeof result.canonicalId === "string" &&
			result.canonicalId.startsWith("session-chunk/")
		) {
			const sessionId = result.canonicalId.slice("session-chunk/".length).trim()
			if (sessionId.length > 0) {
				sessionIds.push(sessionId)
			}
		}
		const eventSessions =
			evidence instanceof Map ? evidence : evidence.sessionIds
		for (const eventId of this.collectBenchmarkResultSourceEventIds(result)) {
			const sessionId = eventSessions.get(eventId)
			if (sessionId) {
				sessionIds.push(sessionId)
			}
		}
		return Array.from(new Set(sessionIds))
	}

	resolveBenchmarkResultTurnIds(
		result: MemorySearchResult,
		evidence: BenchmarkEventEvidenceMaps,
	): string[] {
		const turnIds: string[] = []
		for (const eventId of this.collectBenchmarkResultSourceEventIds(result)) {
			const turnId = evidence.turnIds.get(eventId)
			if (turnId) {
				turnIds.push(turnId)
			}
		}
		return Array.from(new Set(turnIds))
	}

	resolveBenchmarkResultDialogIds(
		result: MemorySearchResult,
		evidence: BenchmarkEventEvidenceMaps,
	): string[] {
		const dialogIds: string[] = []
		for (const eventId of this.collectBenchmarkResultSourceEventIds(result)) {
			const dialogId = evidence.dialogIds.get(eventId)
			if (dialogId) {
				dialogIds.push(dialogId)
			}
		}
		return Array.from(new Set(dialogIds))
	}

	async buildBenchmarkDatasetVersion(datasetPath: string): Promise<string> {
		const hash = createHash("sha256")
		const stream = createReadStream(datasetPath)
		await new Promise<void>((resolve, reject) => {
			stream.on("data", (chunk) => {
				hash.update(chunk)
			})
			stream.on("end", () => resolve())
			stream.on("error", (err) => reject(err))
		})
		return hash.digest("hex")
	}

	async searchBenchmarkRawSession(
		query: string,
		opts: {
			maxResults: number
			minScore: number
		},
	): Promise<MemorySearchResult[]> {
		const mongoCfg = this.host.config.mongodb!
		if (
			mongoCfg.embeddingMode !== "automated" ||
			!this.host.capabilities.vectorSearch
		) {
			throw new Error(
				"raw-session benchmark lane requires MongoDB Vector Search auto-embed",
			)
		}
		const scopeRef = resolveScopeRef({
			scope: "agent",
			agentId: this.host.agentId,
		})
		const collection = sessionChunksCollection(this.host.db, this.host.prefix)
		return vectorSearch(collection, null, {
			maxResults: opts.maxResults,
			minScore: opts.minScore,
			numCandidates: mongoCfg.numCandidates,
			filter: {
				agentId: this.host.agentId,
				scope: "agent",
				scopeRef,
			},
			indexName: `${this.host.prefix}session_chunks_vector`,
			queryText: query,
			embeddingMode: mongoCfg.embeddingMode,
		})
	}
}
