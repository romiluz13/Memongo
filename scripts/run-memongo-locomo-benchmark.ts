import { createHash, randomUUID } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { MongoClient, type Collection, type Document } from "mongodb"
import type {
	MemoryBenchmarkConversation,
	MemoryBenchmarkDataset,
	MemoryBenchmarkEvaluationCase,
} from "../packages/memory-engine/src/types.js"
import { loadBenchmarkDataset } from "../packages/memory-engine/src/mongodb-benchmark-dataset.js"
import {
	keywordSearch,
	vectorSearch,
} from "../packages/memory-engine/src/mongodb-search.js"
import { sessionChunksCollection } from "../packages/memory-engine/src/mongodb-schema.js"
import { resolveScopeRef } from "../packages/memory-engine/src/mongodb-scope.js"
import { resolveBenchmarkCollectionPrefix } from "./benchmark-run-isolation.js"

type LoCoMoResult = {
	sample_id: string
	case_id: string
	question: string
	answer?: string
	category?: string
	evidence: string[]
	expected_ids: string[]
	retrieved_ids: string[]
	recall: number
	latencyMs: number
}

type LoCoMoMode = "raw" | "hybrid"

type LoCoMoCandidate = {
	sessionId: string
	text: string
	vectorScore?: number
	vectorRank?: number
	keywordScore?: number
	keywordRank?: number
	finalScore: number
	survivalReason: string
}

type LoCoMoArtifact = {
	artifactVersion: 1
	runId: string
	status: "completed"
	startedAt: string
	completedAt: string
	dataset: {
		path: string
		sha256: string
		kind: "locomo"
		scenarios: number
		qaCases: number
	}
	mongodb: {
		database: string
		collectionPrefix: string
		collection: string
		vectorIndex: string
		searchIndex: string
	}
	lane: {
		name: "locomo-raw-session-top10" | "locomo-hybrid-session-top10"
		retrievalUnit: "session"
		llm: "none"
		reranker: "none"
		embedding: "MongoDB autoEmbed voyage-4-large"
		topK: number
		mode: LoCoMoMode
	}
	metrics: {
		avgRecall: number
		perfect: number
		partial: number
		zero: number
		emptyRate: number
		perCategory: Record<string, { cases: number; recall: number }>
		latencyMs: {
			avg: number
			p95: number
		}
	}
	results: LoCoMoResult[]
}

const repoRoot = process.cwd()
const startedAt = new Date()
const runId =
	process.env.MEMONGO_BENCHMARK_RUN_ID?.trim() ||
	`memongo-locomo-${startedAt.toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`
const workspaceDir =
	process.env.MEMONGO_WORKSPACE_DIR?.trim() ||
	path.join(os.homedir(), ".memongo", "workspace")
const datasetPathInput =
	process.env.MEMONGO_BENCHMARK_DATASET_PATH?.trim() ||
	path.join(workspaceDir, "benchmarks", "locomo10.json")
const datasetPath = path.isAbsolute(datasetPathInput)
	? datasetPathInput
	: path.resolve(repoRoot, datasetPathInput)
const artifactRoot =
	process.env.MEMONGO_BENCHMARK_RUN_DIR?.trim() ||
	path.join(repoRoot, "artifacts", "benchmark-runs")
const runDir = path.join(artifactRoot, runId)
const responsePath = path.join(runDir, "benchmark-response.json")
const statusPath = path.join(runDir, "status.json")
const topK = Math.max(
	1,
	Math.floor(Number(process.env.MEMONGO_BENCHMARK_MAX_RESULTS ?? 10)),
)
const mode: LoCoMoMode =
	process.env.MEMONGO_LOCOMO_MODE?.trim().toLowerCase() === "hybrid"
		? "hybrid"
		: "raw"
const includeAdversarial =
	process.env.MEMONGO_LOCOMO_INCLUDE_ADVERSARIAL !== "0"
const limitScenarios = Math.max(
	0,
	Math.floor(Number(process.env.MEMONGO_BENCHMARK_LIMIT_SCENARIOS ?? 0)),
)
const limitQaPerScenario = Math.max(
	0,
	Math.floor(Number(process.env.MEMONGO_BENCHMARK_LIMIT_QA_PER_SCENARIO ?? 0)),
)
const prefixResolution = resolveBenchmarkCollectionPrefix({
	runId,
	explicitPrefix: process.env.MEMONGO_MONGODB_COLLECTION_PREFIX,
})

function readUri(): string {
	const uri =
		process.env.MEMONGO_MONGODB_URI?.trim() ||
		process.env.MEMONGO_CLOUD_MONGODB_URI?.trim() ||
		process.env.MDB_MCP_CONNECTION_STRING?.trim()
	if (!uri) {
		throw new Error("set MEMONGO_MONGODB_URI before running LoCoMo benchmark")
	}
	return uri
}

function readDatabaseName(): string {
	return (
		process.env.MEMONGO_DB_NAME?.trim() ||
		process.env.MEMONGO_PARITY_DATABASE?.trim() ||
		"memongo"
	)
}

function sessionLabel(sessionId: string): string {
	return sessionId.includes("::")
		? (sessionId.split("::").pop() ?? sessionId)
		: sessionId
}

function evidenceToSessionIds(evidence: string[]): string[] {
	return Array.from(
		new Set(
			evidence
				.map((entry) => {
					const match = /^D(\d+):/.exec(entry)
					return match ? `session_${match[1]}` : ""
				})
				.filter(Boolean),
		),
	)
}

const STOP_WORDS = new Set([
	"what",
	"when",
	"where",
	"who",
	"how",
	"which",
	"did",
	"do",
	"was",
	"were",
	"have",
	"has",
	"had",
	"is",
	"are",
	"the",
	"a",
	"an",
	"my",
	"me",
	"i",
	"you",
	"your",
	"their",
	"it",
	"its",
	"in",
	"on",
	"at",
	"to",
	"for",
	"of",
	"with",
	"by",
	"from",
	"ago",
	"last",
	"that",
	"this",
	"there",
	"about",
	"get",
	"got",
	"give",
	"gave",
	"buy",
	"bought",
	"made",
	"make",
	"said",
])

const NOT_NAMES = new Set([
	"What",
	"When",
	"Where",
	"Who",
	"How",
	"Which",
	"Did",
	"Do",
	"Was",
	"Were",
	"Have",
	"Has",
	"Had",
	"Is",
	"Are",
	"The",
	"My",
	"Our",
	"Their",
	"Can",
	"Could",
	"Would",
	"Should",
	"Will",
	"Shall",
	"May",
	"Might",
	"Monday",
	"Tuesday",
	"Wednesday",
	"Thursday",
	"Friday",
	"Saturday",
	"Sunday",
	"January",
	"February",
	"March",
	"April",
	"June",
	"July",
	"August",
	"September",
	"October",
	"November",
	"December",
	"In",
	"On",
	"At",
	"For",
	"To",
	"Of",
	"With",
	"By",
	"From",
	"And",
	"But",
	"I",
	"It",
	"Its",
	"This",
	"That",
	"These",
	"Those",
	"Previously",
	"Recently",
	"Also",
	"Just",
	"Very",
	"More",
	"Said",
	"Speaker",
	"Person",
	"Time",
	"Date",
	"Year",
	"Day",
])

function extractKeywords(text: string): string[] {
	return Array.from(text.toLowerCase().matchAll(/\b[a-z]{3,}\b/g))
		.map((match) => match[0])
		.filter((word) => !STOP_WORDS.has(word))
}

function keywordOverlap(keywords: string[], text: string): number {
	if (keywords.length === 0) {
		return 0
	}
	const lower = text.toLowerCase()
	const hits = keywords.filter((keyword) => lower.includes(keyword)).length
	return hits / keywords.length
}

function extractQuotedPhrases(text: string): string[] {
	return [...text.matchAll(/'([^']{3,60})'|"([^"]{3,60})"/g)]
		.map((match) => (match[1] ?? match[2] ?? "").trim())
		.filter((phrase) => phrase.length >= 3)
}

function quotedBoost(phrases: string[], text: string): number {
	if (phrases.length === 0) {
		return 0
	}
	const lower = text.toLowerCase()
	const hits = phrases.filter((phrase) =>
		lower.includes(phrase.toLowerCase()),
	).length
	return Math.min(hits / phrases.length, 1)
}

function extractPersonNames(text: string): string[] {
	return Array.from(new Set([...text.matchAll(/\b[A-Z][a-z]{2,15}\b/g)]))
		.map((match) => match[0])
		.filter((word) => !NOT_NAMES.has(word))
}

function nameBoost(names: string[], text: string): number {
	if (names.length === 0) {
		return 0
	}
	const lower = text.toLowerCase()
	const hits = names.filter((name) => lower.includes(name.toLowerCase())).length
	return Math.min(hits / names.length, 1)
}

function recallAtRetrieved(
	retrievedIds: string[],
	expectedIds: string[],
): number {
	if (expectedIds.length === 0) {
		return 1
	}
	const retrieved = new Set(retrievedIds)
	const found = expectedIds.filter((id) => retrieved.has(id)).length
	return found / expectedIds.length
}

function renderSessionText(conversation: MemoryBenchmarkConversation): string {
	return conversation.turns
		.map((turn) => {
			const speaker =
				typeof turn.metadata?.locomoSpeaker === "string" &&
				turn.metadata.locomoSpeaker.trim().length > 0
					? turn.metadata.locomoSpeaker.trim()
					: turn.role
			return `${speaker} said, "${turn.body}"`
		})
		.join("\n")
}

async function ensureSessionCollection(params: {
	collection: Collection
	vectorIndexName: string
	searchIndexName: string
}): Promise<void> {
	await params.collection.createIndex(
		{ agentId: 1, sessionId: 1 },
		{ name: "uq_session_chunks_agent_session", unique: true },
	)
	await params.collection.createIndex(
		{ agentId: 1, scope: 1, scopeRef: 1 },
		{ name: "idx_session_chunks_agent_scope" },
	)
	await params.collection.createIndex(
		{ agentId: 1, timestamp: -1 },
		{ name: "idx_session_chunks_agent_time" },
	)

	const searchCollection = params.collection as Collection & {
		createSearchIndex: (description: Document) => Promise<string>
		listSearchIndexes: (name?: string) => { toArray: () => Promise<Document[]> }
	}
	const existing = await searchCollection
		.listSearchIndexes(params.vectorIndexName)
		.toArray()
		.catch(() => [])
	if (existing.length === 0) {
		await searchCollection.createSearchIndex({
			name: params.vectorIndexName,
			type: "vectorSearch",
			definition: {
				fields: [
					{
						type: "autoEmbed",
						modality: "text",
						path: "text",
						model: "voyage-4-large",
					},
					{ type: "filter", path: "agentId" },
					{ type: "filter", path: "scope" },
					{ type: "filter", path: "scopeRef" },
					{ type: "filter", path: "sessionId" },
				],
			},
		})
	}

	const existingText = await searchCollection
		.listSearchIndexes(params.searchIndexName)
		.toArray()
		.catch(() => [])
	if (existingText.length === 0) {
		await searchCollection.createSearchIndex({
			name: params.searchIndexName,
			type: "search",
			definition: {
				mappings: {
					dynamic: false,
					fields: {
						text: { type: "string", analyzer: "lucene.standard" },
						agentId: { type: "token" },
						scope: { type: "token" },
						scopeRef: { type: "token" },
						sessionId: { type: "token" },
					},
				},
			},
		})
	}
}

async function waitForSearchable(params: {
	collection: Collection
	indexName: string
	agentId: string
	scopeRef: string
	query: string
	timeoutMs: number
}): Promise<void> {
	const started = Date.now()
	let lastError = ""
	while (Date.now() - started < params.timeoutMs) {
		try {
			const results = await vectorSearch(params.collection, null, {
				indexName: params.indexName,
				queryText: params.query,
				embeddingMode: "automated",
				maxResults: 1,
				minScore: 0,
				filter: {
					agentId: params.agentId,
					scope: "agent",
					scopeRef: params.scopeRef,
				},
			})
			if (results.length > 0) {
				return
			}
			lastError = "no vector results yet"
		} catch (err) {
			lastError = err instanceof Error ? err.message : String(err)
		}
		await new Promise((resolve) => setTimeout(resolve, 5_000))
	}
	throw new Error(`LoCoMo vector index did not become queryable: ${lastError}`)
}

async function waitForKeywordSearchable(params: {
	collection: Collection
	indexName: string
	agentId: string
	scopeRef: string
	query: string
	timeoutMs: number
}): Promise<void> {
	const started = Date.now()
	let lastError = ""
	while (Date.now() - started < params.timeoutMs) {
		try {
			const results = await keywordSearch(params.collection, params.query, {
				indexName: params.indexName,
				maxResults: 1,
				minScore: 0,
				filter: {
					agentId: params.agentId,
					scope: "agent",
					scopeRef: params.scopeRef,
				},
			})
			if (results.length > 0) {
				return
			}
			lastError = "no keyword results yet"
		} catch (err) {
			lastError = err instanceof Error ? err.message : String(err)
		}
		await new Promise((resolve) => setTimeout(resolve, 5_000))
	}
	throw new Error(`LoCoMo search index did not become queryable: ${lastError}`)
}

async function retrieveLocomoCandidates(params: {
	collection: Collection
	vectorIndexName: string
	searchIndexName: string
	mode: LoCoMoMode
	query: string
	agentId: string
	scopeRef: string
	topK: number
	sessionTexts: Map<string, string>
}): Promise<LoCoMoCandidate[]> {
	const candidateLimit =
		params.mode === "hybrid"
			? Math.max(params.topK * 3, params.topK)
			: params.topK
	const filter = {
		agentId: params.agentId,
		scope: "agent",
		scopeRef: params.scopeRef,
	}
	const vectorHits = await vectorSearch(params.collection, null, {
		indexName: params.vectorIndexName,
		queryText: params.query,
		embeddingMode: "automated",
		maxResults: candidateLimit,
		minScore: 0,
		filter,
	})
	if (params.mode === "raw") {
		return vectorHits.slice(0, params.topK).map((hit, index) => {
			const sessionId = hit.sessionId ? sessionLabel(hit.sessionId) : ""
			return {
				sessionId,
				text: params.sessionTexts.get(sessionId) ?? hit.snippet,
				vectorScore: hit.score,
				vectorRank: index + 1,
				finalScore: hit.score,
				survivalReason: "vector-rank",
			}
		})
	}

	const keywordHits = await keywordSearch(params.collection, params.query, {
		indexName: params.searchIndexName,
		maxResults: candidateLimit,
		minScore: 0,
		filter,
	})
	const candidates = new Map<string, LoCoMoCandidate>()
	for (const [index, hit] of vectorHits.entries()) {
		const sessionId = hit.sessionId ? sessionLabel(hit.sessionId) : ""
		if (!sessionId) {
			continue
		}
		candidates.set(sessionId, {
			sessionId,
			text: params.sessionTexts.get(sessionId) ?? hit.snippet,
			vectorScore: hit.score,
			vectorRank: index + 1,
			finalScore: 0,
			survivalReason: "vector",
		})
	}
	for (const [index, hit] of keywordHits.entries()) {
		const sessionId = hit.sessionId ? sessionLabel(hit.sessionId) : ""
		if (!sessionId) {
			continue
		}
		const existing = candidates.get(sessionId)
		if (existing) {
			existing.keywordScore = hit.score
			existing.keywordRank = index + 1
			existing.survivalReason = "vector+keyword"
			continue
		}
		candidates.set(sessionId, {
			sessionId,
			text: params.sessionTexts.get(sessionId) ?? hit.snippet,
			keywordScore: hit.score,
			keywordRank: index + 1,
			finalScore: 0,
			survivalReason: "keyword",
		})
	}

	const names = extractPersonNames(params.query)
	const nameWords = new Set(names.map((name) => name.toLowerCase()))
	const predicateKeywords = extractKeywords(params.query).filter(
		(keyword) => !nameWords.has(keyword),
	)
	const quoted = extractQuotedPhrases(params.query)
	for (const candidate of candidates.values()) {
		const vectorRrf = candidate.vectorRank ? 1 / (60 + candidate.vectorRank) : 0
		const keywordRrf = candidate.keywordRank
			? 1 / (60 + candidate.keywordRank)
			: 0
		const predicateOverlap = keywordOverlap(predicateKeywords, candidate.text)
		const quotedMatch = quotedBoost(quoted, candidate.text)
		const nameMatch = nameBoost(names, candidate.text)
		candidate.finalScore =
			0.5 * vectorRrf +
			0.5 * keywordRrf +
			0.012 * predicateOverlap +
			0.018 * quotedMatch +
			0.006 * nameMatch
		if (predicateOverlap > 0 || quotedMatch > 0 || nameMatch > 0) {
			candidate.survivalReason = `${candidate.survivalReason}+generic-lexical`
		}
	}

	return Array.from(candidates.values())
		.sort((a, b) => b.finalScore - a.finalScore)
		.slice(0, params.topK)
}

function percentile(values: number[], p: number): number {
	if (values.length === 0) return 0
	const sorted = values.toSorted((a, b) => a - b)
	const index = Math.min(
		sorted.length - 1,
		Math.ceil((p / 100) * sorted.length) - 1,
	)
	return sorted[index] ?? 0
}

function summarizeResults(results: LoCoMoResult[]): LoCoMoArtifact["metrics"] {
	const avgRecall =
		results.length > 0
			? results.reduce((sum, result) => sum + result.recall, 0) / results.length
			: 0
	const perCategoryValues = new Map<string, number[]>()
	for (const result of results) {
		const category = result.category ?? "unknown"
		const values = perCategoryValues.get(category) ?? []
		values.push(result.recall)
		perCategoryValues.set(category, values)
	}
	const perCategory: Record<string, { cases: number; recall: number }> = {}
	for (const [category, values] of perCategoryValues) {
		perCategory[category] = {
			cases: values.length,
			recall: values.reduce((sum, value) => sum + value, 0) / values.length,
		}
	}
	const latencies = results.map((result) => result.latencyMs)
	return {
		avgRecall,
		perfect: results.filter((result) => result.recall >= 1).length,
		partial: results.filter((result) => result.recall > 0 && result.recall < 1)
			.length,
		zero: results.filter((result) => result.recall === 0).length,
		emptyRate:
			results.length > 0
				? results.filter((result) => result.retrieved_ids.length === 0).length /
					results.length
				: 0,
		perCategory,
		latencyMs: {
			avg:
				latencies.length > 0
					? latencies.reduce((sum, value) => sum + value, 0) / latencies.length
					: 0,
			p95: percentile(latencies, 95),
		},
	}
}

async function writeStatus(payload: Record<string, unknown>): Promise<void> {
	await mkdir(runDir, { recursive: true })
	await writeFile(statusPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8")
}

async function main(): Promise<void> {
	await mkdir(runDir, { recursive: true })
	const datasetText = await readFile(datasetPath, "utf8")
	const datasetSha256 = createHash("sha256").update(datasetText).digest("hex")
	const dataset: MemoryBenchmarkDataset =
		await loadBenchmarkDataset(datasetPath)
	if (dataset.datasetKind !== "locomo" || !dataset.scenarios) {
		throw new Error("dataset must normalize as LoCoMo")
	}
	const scenarios =
		limitScenarios > 0
			? dataset.scenarios.slice(0, limitScenarios)
			: dataset.scenarios
	const database = readDatabaseName()
	const client = new MongoClient(readUri(), {
		appName: "memongo-locomo-benchmark",
		serverSelectionTimeoutMS: 15_000,
	})
	const prefix = prefixResolution.collectionPrefix
	const vectorIndexName = `${prefix}session_chunks_vector`
	const searchIndexName = `${prefix}session_chunks_text`
	const results: LoCoMoResult[] = []

	await writeStatus({
		runId,
		status: "running",
		startedAt: startedAt.toISOString(),
		datasetPath,
		datasetSha256,
		scenarios: scenarios.length,
		mode,
		includeAdversarial,
	})

	await client.connect()
	try {
		const db = client.db(database)
		const collection = sessionChunksCollection(db, prefix)
		await ensureSessionCollection({
			collection,
			vectorIndexName,
			searchIndexName,
		})

		for (const [scenarioIndex, scenario] of scenarios.entries()) {
			const agentId = `${runId}::${scenario.scenarioId}`
			const scopeRef = resolveScopeRef({ scope: "agent", agentId })
			const sessionTexts = new Map<string, string>()
			const docs = scenario.conversations
				.filter((conversation) => conversation.sessionId)
				.map((conversation) => {
					const timestampValue = conversation.turns[0]?.timestamp
					const timestamp = timestampValue
						? new Date(timestampValue)
						: new Date()
					const validTimestamp = Number.isNaN(timestamp.getTime())
						? new Date()
						: timestamp
					const renderedText = renderSessionText(conversation)
					const labeledSessionId = sessionLabel(conversation.sessionId ?? "")
					if (labeledSessionId) {
						sessionTexts.set(labeledSessionId, renderedText)
					}
					return {
						source: "session-evidence",
						path: `session_chunks/${conversation.sessionId}`,
						text: renderedText,
						agentId,
						scope: "agent",
						scopeRef,
						sessionId: conversation.sessionId,
						canonicalId: `session-chunk/${conversation.sessionId}`,
						status: "active",
						timestamp: validTimestamp,
						updatedAt: new Date(),
						metadata: {
							sourceEventIds: [],
							turnCount: conversation.turns.length,
							docType: "session",
							benchmarkDatasetKind: "locomo",
							benchmarkConversationId: scenario.scenarioId,
						},
						provenance: {
							lane: "session_chunks",
							unit: "session",
							source: "session-evidence",
						},
					}
				})
			if (docs.length > 0) {
				await collection.insertMany(docs)
			}
			const firstQuery =
				scenario.evaluations.find((evaluation) => !evaluation.abstention)
					?.query ??
				docs[0]?.text ??
				"session"
			await waitForSearchable({
				collection,
				indexName: vectorIndexName,
				agentId,
				scopeRef,
				query: firstQuery,
				timeoutMs: Number(
					process.env.MEMONGO_VECTOR_READY_TIMEOUT_MS ?? 300_000,
				),
			})
			if (mode === "hybrid") {
				await waitForKeywordSearchable({
					collection,
					indexName: searchIndexName,
					agentId,
					scopeRef,
					query: firstQuery,
					timeoutMs: Number(
						process.env.MEMONGO_SEARCH_READY_TIMEOUT_MS ??
							process.env.MEMONGO_VECTOR_READY_TIMEOUT_MS ??
							300_000,
					),
				})
			}

			const evaluations = scenario.evaluations.filter(
				(evaluation): evaluation is MemoryBenchmarkEvaluationCase =>
					includeAdversarial || !evaluation.abstention,
			)
			const limitedEvaluations =
				limitQaPerScenario > 0
					? evaluations.slice(0, limitQaPerScenario)
					: evaluations
			for (const evaluation of limitedEvaluations) {
				const queryStarted = Date.now()
				const hits = await retrieveLocomoCandidates({
					collection,
					vectorIndexName,
					searchIndexName,
					mode,
					query: evaluation.query,
					agentId,
					scopeRef,
					topK,
					sessionTexts,
				})
				const retrievedIds = hits.map((hit) => hit.sessionId).filter(Boolean)
				const evidence = Array.isArray(evaluation.metadata?.evidence)
					? evaluation.metadata.evidence
							.map((entry) => (typeof entry === "string" ? entry : ""))
							.filter(Boolean)
					: (evaluation.expectedDialogIds ?? [])
				const expectedIds = evidenceToSessionIds(evidence)
				results.push({
					sample_id: scenario.scenarioId,
					case_id: evaluation.caseId,
					question: evaluation.query,
					...(evaluation.answer ? { answer: evaluation.answer } : {}),
					...(evaluation.questionType
						? { category: evaluation.questionType }
						: {}),
					evidence,
					expected_ids: expectedIds,
					retrieved_ids: retrievedIds,
					recall: recallAtRetrieved(retrievedIds, expectedIds),
					latencyMs: Date.now() - queryStarted,
				})
			}
			await writeStatus({
				runId,
				status: "running",
				scenario: scenario.scenarioId,
				scenarioIndex: scenarioIndex + 1,
				totalScenarios: scenarios.length,
				results: results.length,
				mode,
				updatedAt: new Date().toISOString(),
			})
		}
		const artifact: LoCoMoArtifact = {
			artifactVersion: 1,
			runId,
			status: "completed",
			startedAt: startedAt.toISOString(),
			completedAt: new Date().toISOString(),
			dataset: {
				path: datasetPath,
				sha256: datasetSha256,
				kind: "locomo",
				scenarios: scenarios.length,
				qaCases: results.length,
			},
			mongodb: {
				database,
				collectionPrefix: prefix,
				collection: `${prefix}session_chunks`,
				vectorIndex: vectorIndexName,
				searchIndex: searchIndexName,
			},
			lane: {
				name:
					mode === "hybrid"
						? "locomo-hybrid-session-top10"
						: "locomo-raw-session-top10",
				retrievalUnit: "session",
				llm: "none",
				reranker: "none",
				embedding: "MongoDB autoEmbed voyage-4-large",
				topK,
				mode,
			},
			metrics: summarizeResults(results),
			results,
		}
		await writeFile(
			responsePath,
			`${JSON.stringify(artifact, null, 2)}\n`,
			"utf8",
		)
		await writeStatus({
			runId,
			status: "completed",
			responsePath,
			metrics: artifact.metrics,
			completedAt: artifact.completedAt,
		})
		console.log(JSON.stringify({ ok: true, runId, responsePath }, null, 2))
	} finally {
		await client.close()
	}
}

await main()
