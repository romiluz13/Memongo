import { createHash, randomUUID } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { MongoClient, type Collection, type Document } from "mongodb"
import { vectorSearch } from "../packages/memory-engine/src/mongodb-search.js"
import { resolveBenchmarkCollectionPrefix } from "./benchmark-run-isolation.js"

type MemBenchTurn = {
	sid?: number
	mid?: number
	user?: string
	user_message?: string
	assistant?: string
	assistant_message?: string
	time?: string
}

type MemBenchRawItem = {
	tid?: number
	message_list?: unknown
	QA?: {
		question?: string
		choices?: Record<string, string>
		ground_truth?: string
		answer?: string
		target_step_id?: unknown[]
	}
}

type MemBenchItem = {
	category: string
	topic: string
	tid: number
	turns: unknown
	question: string
	groundTruth: string
	answerText: string
	targetStepIds: unknown[]
}

type IndexedTurn = {
	text: string
	sid: number
	globalIdx: number
	sessionIndex: number
	turnIndex: number
}

type MemBenchResult = {
	category: string
	topic: string
	tid: number
	question: string
	ground_truth: string
	answer_text: string
	target_sids: number[]
	retrieved_sids: number[]
	retrieved_global: number[]
	hit_at_k: boolean
	latencyMs: number
}

const CATEGORY_FILES: Record<string, string> = {
	simple: "simple.json",
	highlevel: "highlevel.json",
	knowledge_update: "knowledge_update.json",
	comparative: "comparative.json",
	conditional: "conditional.json",
	noisy: "noisy.json",
	aggregative: "aggregative.json",
	highlevel_rec: "highlevel_rec.json",
	lowlevel_rec: "lowlevel_rec.json",
	RecMultiSession: "RecMultiSession.json",
	post_processing: "post_processing.json",
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
	"would",
	"could",
	"should",
	"might",
	"can",
	"will",
	"shall",
	"kind",
	"type",
	"like",
	"prefer",
	"enjoy",
	"think",
	"feel",
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
	"I",
	"It",
	"Its",
	"This",
	"That",
	"These",
	"Those",
])

const repoRoot = process.cwd()
const startedAt = new Date()
const runId =
	process.env.MEMONGO_BENCHMARK_RUN_ID?.trim() ||
	`memongo-membench-${startedAt.toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`
const artifactRoot =
	process.env.MEMONGO_BENCHMARK_RUN_DIR?.trim() ||
	path.join(repoRoot, "artifacts", "benchmark-runs")
const runDir = path.join(artifactRoot, runId)
const responsePath = path.join(runDir, "benchmark-response.json")
const statusPath = path.join(runDir, "status.json")
const dataDir =
	process.env.MEMONGO_MEMBENCH_DATA_DIR?.trim() ||
	"/Users/rom.iluz/Dev/memongo-competitors/Membench/MemData/FirstAgent"
const topic = process.env.MEMONGO_MEMBENCH_TOPIC?.trim() || "movie"
const category = process.env.MEMONGO_MEMBENCH_CATEGORY?.trim() || ""
const mode =
	process.env.MEMONGO_MEMBENCH_MODE?.trim() === "raw" ? "raw" : "hybrid"
const topK = Math.max(
	1,
	Math.floor(Number(process.env.MEMONGO_BENCHMARK_MAX_RESULTS ?? 5)),
)
const limitItems = Math.max(
	0,
	Math.floor(Number(process.env.MEMONGO_BENCHMARK_LIMIT_ITEMS ?? 0)),
)
const reuseExistingIndex = /^(1|true|enabled|yes)$/i.test(
	process.env.MEMONGO_MEMBENCH_REUSE_EXISTING_INDEX?.trim() ?? "",
)
const vectorRetries = Math.max(
	1,
	Math.floor(Number(process.env.MEMONGO_MEMBENCH_VECTOR_RETRIES ?? 8)),
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
		throw new Error("set MEMONGO_MONGODB_URI before running MemBench benchmark")
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

async function readJsonFile(filePath: string): Promise<unknown> {
	return JSON.parse(await readFile(filePath, "utf8")) as unknown
}

async function loadMemBenchItems(): Promise<{
	items: MemBenchItem[]
	datasetHash: string
}> {
	const categories = category ? [category] : Object.keys(CATEGORY_FILES)
	const hash = createHash("sha256")
	const items: MemBenchItem[] = []
	for (const cat of categories) {
		const fileName = CATEGORY_FILES[cat]
		if (!fileName) continue
		const filePath = path.join(dataDir, fileName)
		let parsed: unknown
		try {
			const text = await readFile(filePath, "utf8")
			hash.update(fileName)
			hash.update(text)
			parsed = JSON.parse(text) as unknown
		} catch {
			continue
		}
		if (!parsed || typeof parsed !== "object") continue
		for (const [recordTopic, topicItems] of Object.entries(parsed)) {
			if (topic && ![topic, "roles", "events"].includes(recordTopic)) {
				continue
			}
			if (!Array.isArray(topicItems)) continue
			for (const rawItem of topicItems) {
				if (limitItems > 0 && items.length >= limitItems) {
					break
				}
				if (!rawItem || typeof rawItem !== "object") continue
				const item = rawItem as MemBenchRawItem
				const qa = item.QA
				if (
					!qa ||
					typeof qa.question !== "string" ||
					!Array.isArray(item.message_list)
				) {
					continue
				}
				items.push({
					category: cat,
					topic: recordTopic,
					tid: typeof item.tid === "number" ? item.tid : 0,
					turns: item.message_list,
					question: qa.question,
					groundTruth:
						typeof qa.ground_truth === "string" ? qa.ground_truth : "",
					answerText: typeof qa.answer === "string" ? qa.answer : "",
					targetStepIds: Array.isArray(qa.target_step_id)
						? qa.target_step_id
						: [],
				})
			}
		}
	}
	hash.update(JSON.stringify({ category, topic, limitItems }))
	return { items, datasetHash: hash.digest("hex") }
}

function renderTurn(turn: MemBenchTurn): string {
	const user = turn.user ?? turn.user_message ?? ""
	const assistant = turn.assistant ?? turn.assistant_message ?? ""
	const time = turn.time ?? ""
	const text = `[User] ${user} [Assistant] ${assistant}`
	return time ? `[${time}] ${text}` : text
}

function normalizeTurns(messageList: unknown): IndexedTurn[] {
	if (!Array.isArray(messageList)) return []
	const sessions =
		messageList.length > 0 &&
		messageList[0] &&
		typeof messageList[0] === "object" &&
		!Array.isArray(messageList[0])
			? [messageList]
			: messageList
	const turns: IndexedTurn[] = []
	let globalIdx = 0
	for (const [sessionIndex, session] of sessions.entries()) {
		if (!Array.isArray(session)) continue
		for (const [turnIndex, rawTurn] of session.entries()) {
			if (!rawTurn || typeof rawTurn !== "object") continue
			const turn = rawTurn as MemBenchTurn
			const sid =
				typeof turn.sid === "number"
					? turn.sid
					: typeof turn.mid === "number"
						? turn.mid
						: globalIdx
			turns.push({
				text: renderTurn(turn),
				sid,
				globalIdx,
				sessionIndex,
				turnIndex,
			})
			globalIdx++
		}
	}
	return turns
}

function keywords(text: string): string[] {
	return (text.toLowerCase().match(/\b[a-z]{3,}\b/g) ?? []).filter(
		(word) => !STOP_WORDS.has(word),
	)
}

function personNames(text: string): string[] {
	return Array.from(
		new Set(
			(text.match(/\b[A-Z][a-z]{2,15}\b/g) ?? []).filter(
				(word) => !NOT_NAMES.has(word),
			),
		),
	)
}

function keywordOverlap(queryKeywords: string[], docText: string): number {
	if (queryKeywords.length === 0) return 0
	const lower = docText.toLowerCase()
	const hits = queryKeywords.filter((keyword) => lower.includes(keyword)).length
	return hits / queryKeywords.length
}

function parseCanonicalId(value: string | undefined): {
	sid: number
	globalIdx: number
} | null {
	if (!value) return null
	const parts = value.split(":")
	if (parts.length < 4) return null
	const sid = Number(parts[2])
	const globalIdx = Number(parts[3])
	return Number.isFinite(sid) && Number.isFinite(globalIdx)
		? { sid, globalIdx }
		: null
}

function targetSids(targetStepIds: unknown[]): number[] {
	const ids = new Set<number>()
	for (const step of targetStepIds) {
		if (!Array.isArray(step) || step.length < 1) continue
		const id = Number(step[0])
		if (Number.isFinite(id)) ids.add(id)
	}
	return Array.from(ids)
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

function isTransientVectorSearchError(err: unknown): boolean {
	const message = err instanceof Error ? err.message : String(err)
	return /\b(HostUnreachable|Connection refused|Connection closed by peer|closed by peer|ECONNRESET|ETIMEDOUT|timeout|temporar(?:y|ily)|connection pool|network)\b/i.test(
		message,
	)
}

async function sleep(ms: number): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, ms))
}

async function vectorSearchWithRetry(
	collection: Collection,
	indexName: string,
	queryText: string,
	maxResults: number,
	filter: Record<string, string>,
) {
	let lastError: unknown
	for (let attempt = 1; attempt <= vectorRetries; attempt++) {
		try {
			return await vectorSearch(collection, null, {
				indexName,
				queryText,
				embeddingMode: "automated",
				maxResults,
				minScore: 0,
				filter,
			})
		} catch (err) {
			lastError = err
			if (!isTransientVectorSearchError(err) || attempt === vectorRetries) {
				throw err
			}
			await sleep(Math.min(30_000, attempt * 2_500))
		}
	}
	throw lastError
}

async function ensureTurnCollection(params: {
	collection: Collection
	indexName: string
}): Promise<void> {
	await params.collection.createIndex(
		{ agentId: 1, sid: 1 },
		{ name: "idx_membench_agent_sid" },
	)
	await params.collection.createIndex(
		{ agentId: 1, globalIdx: 1 },
		{ name: "idx_membench_agent_global" },
	)
	await params.collection.createIndex(
		{ category: 1, topic: 1 },
		{ name: "idx_membench_category_topic" },
	)
	const searchCollection = params.collection as Collection & {
		createSearchIndex: (description: Document) => Promise<string>
		listSearchIndexes: (name?: string) => { toArray: () => Promise<Document[]> }
	}
	const existing = await searchCollection
		.listSearchIndexes(params.indexName)
		.toArray()
		.catch(() => [])
	if (existing.length > 0) {
		return
	}
	await searchCollection.createSearchIndex({
		name: params.indexName,
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
				{ type: "filter", path: "category" },
				{ type: "filter", path: "topic" },
			],
		},
	})
}

async function waitForSearchable(params: {
	collection: Collection
	indexName: string
	agentId: string
	query: string
	timeoutMs: number
}): Promise<void> {
	const started = Date.now()
	let lastError = ""
	while (Date.now() - started < params.timeoutMs) {
		try {
			const results = await vectorSearchWithRetry(
				params.collection,
				params.indexName,
				params.query,
				1,
				{ agentId: params.agentId },
			)
			if (results.length > 0) return
			lastError = "no vector results yet"
		} catch (err) {
			lastError = err instanceof Error ? err.message : String(err)
		}
		await new Promise((resolve) => setTimeout(resolve, 5_000))
	}
	throw new Error(
		`MemBench vector index did not become queryable: ${lastError}`,
	)
}

async function writeStatus(payload: Record<string, unknown>): Promise<void> {
	await mkdir(runDir, { recursive: true })
	await writeFile(statusPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8")
}

async function main(): Promise<void> {
	await mkdir(runDir, { recursive: true })
	const { items, datasetHash } = await loadMemBenchItems()
	const database = readDatabaseName()
	const prefix = prefixResolution.collectionPrefix
	const collectionName = `${prefix}membench_turns`
	const indexName = `${prefix}membench_turns_vector`
	const client = new MongoClient(readUri(), {
		appName: "memongo-membench-benchmark",
		serverSelectionTimeoutMS: 15_000,
	})
	const results: MemBenchResult[] = []

	await writeStatus({
		runId,
		status: "running",
		phase: "loaded",
		startedAt: startedAt.toISOString(),
		dataDir,
		items: items.length,
		mode,
		topK,
	})

	await client.connect()
	try {
		const db = client.db(database)
		const collection = db.collection(collectionName)
		await ensureTurnCollection({ collection, indexName })
		let docsInserted = 0
		if (reuseExistingIndex) {
			docsInserted = await collection.countDocuments({})
			await writeStatus({
				runId,
				status: "running",
				phase: "reusing-indexed-data",
				items: items.length,
				docsInserted,
				updatedAt: new Date().toISOString(),
			})
		} else {
			for (const [itemIndex, item] of items.entries()) {
				const agentId = `${runId}::item_${itemIndex}`
				const turns = normalizeTurns(item.turns)
				const docs = turns
					.filter((turn) => turn.text.trim().length > 0)
					.map((turn) => ({
						agentId,
						itemIndex,
						category: item.category,
						topic: item.topic,
						tid: item.tid,
						sid: turn.sid,
						globalIdx: turn.globalIdx,
						sessionIndex: turn.sessionIndex,
						turnIndex: turn.turnIndex,
						text: turn.text,
						path: `membench/${itemIndex}/turn_${turn.globalIdx}`,
						canonicalId: `membench:${itemIndex}:${turn.sid}:${turn.globalIdx}`,
						createdAt: new Date(),
					}))
				if (docs.length > 0) {
					await collection.insertMany(docs)
					docsInserted += docs.length
				}
				if ((itemIndex + 1) % 100 === 0 || itemIndex === items.length - 1) {
					await writeStatus({
						runId,
						status: "running",
						phase: "indexed",
						items: items.length,
						indexedItems: itemIndex + 1,
						docsInserted,
						updatedAt: new Date().toISOString(),
					})
				}
			}
		}

		const firstItemIndex = items.findIndex(
			(item) => normalizeTurns(item.turns).length > 0,
		)
		if (firstItemIndex >= 0) {
			await waitForSearchable({
				collection,
				indexName,
				agentId: `${runId}::item_${firstItemIndex}`,
				query: items[firstItemIndex]?.question ?? "memory",
				timeoutMs: Number(
					process.env.MEMONGO_VECTOR_READY_TIMEOUT_MS ?? 300_000,
				),
			})
		}

		for (const [itemIndex, item] of items.entries()) {
			const agentId = `${runId}::item_${itemIndex}`
			const started = Date.now()
			const retrieveCount = mode === "hybrid" ? topK * 3 : topK
			const hits = await vectorSearchWithRetry(
				collection,
				indexName,
				item.question,
				retrieveCount,
				{ agentId },
			)
			const selected =
				mode === "hybrid"
					? (() => {
							const names = new Set(
								personNames(item.question).map((name) => name.toLowerCase()),
							)
							const predicateKeywords = keywords(item.question).filter(
								(keyword) => !names.has(keyword),
							)
							return hits
								.map((hit, index) => ({
									hit,
									rank: index + 1,
									overlap: keywordOverlap(predicateKeywords, hit.text ?? ""),
								}))
								.sort(
									(left, right) =>
										left.rank * (1 - 0.5 * left.overlap) -
										right.rank * (1 - 0.5 * right.overlap),
								)
								.slice(0, topK)
								.map((entry) => entry.hit)
						})()
					: hits.slice(0, topK)
			const parsed = selected
				.map((hit) => parseCanonicalId(hit.canonicalId))
				.filter(
					(hit): hit is { sid: number; globalIdx: number } => hit !== null,
				)
			const retrievedSids = parsed.map((hit) => hit.sid)
			const retrievedGlobal = parsed.map((hit) => hit.globalIdx)
			const targets = targetSids(item.targetStepIds)
			const targetSet = new Set(targets)
			const hitAtK =
				retrievedSids.some((sid) => targetSet.has(sid)) ||
				retrievedGlobal.some((globalIdx) => targetSet.has(globalIdx))
			results.push({
				category: item.category,
				topic: item.topic,
				tid: item.tid,
				question: item.question,
				ground_truth: item.groundTruth,
				answer_text: item.answerText,
				target_sids: targets,
				retrieved_sids: retrievedSids,
				retrieved_global: retrievedGlobal,
				hit_at_k: hitAtK,
				latencyMs: Date.now() - started,
			})
			if ((itemIndex + 1) % 25 === 0 || itemIndex === items.length - 1) {
				await writeStatus({
					runId,
					status: "running",
					phase: "querying",
					items: items.length,
					completed: itemIndex + 1,
					hitRate:
						results.filter((result) => result.hit_at_k).length / results.length,
					updatedAt: new Date().toISOString(),
				})
			}
		}

		const perCategory: Record<string, { cases: number; recall: number }> = {}
		for (const cat of new Set(results.map((result) => result.category))) {
			const values = results.filter((result) => result.category === cat)
			perCategory[cat] = {
				cases: values.length,
				recall:
					values.filter((result) => result.hit_at_k).length / values.length,
			}
		}
		const hitCount = results.filter((result) => result.hit_at_k).length
		const latencies = results.map((result) => result.latencyMs)
		const artifact = {
			artifactVersion: 1,
			runId,
			status: "completed",
			startedAt: startedAt.toISOString(),
			completedAt: new Date().toISOString(),
			dataset: {
				dataDir,
				sha256: datasetHash,
				items: items.length,
				category: category || "all",
				topic,
			},
			mongodb: {
				database,
				collectionPrefix: prefix,
				collection: collectionName,
				vectorIndex: indexName,
			},
			lane: {
				name: `membench-${mode}-turn-top${topK}`,
				retrievalUnit: "turn",
				llm: "none",
				reranker: mode === "hybrid" ? "keyword-overlap-rescore" : "none",
				embedding: "MongoDB autoEmbed voyage-4-large",
				topK,
			},
			metrics: {
				hitRate: results.length > 0 ? hitCount / results.length : 0,
				hits: hitCount,
				misses: results.length - hitCount,
				emptyRate:
					results.length > 0
						? results.filter((result) => result.retrieved_sids.length === 0)
								.length / results.length
						: 0,
				perCategory,
				latencyMs: {
					avg:
						latencies.length > 0
							? latencies.reduce((sum, value) => sum + value, 0) /
								latencies.length
							: 0,
					p95: percentile(latencies, 95),
				},
			},
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
