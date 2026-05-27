import { createHash, randomUUID } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { MongoClient, type Collection, type Document } from "mongodb"
import { vectorSearch } from "../packages/memory-engine/src/mongodb-search.js"
import { resolveBenchmarkCollectionPrefix } from "./benchmark-run-isolation.js"

type ConvoMemMessage = {
	speaker?: string
	text?: string
}

type ConvoMemItem = {
	question: string
	answer?: string
	category?: string
	_category_key?: string
	message_evidences?: ConvoMemMessage[]
	conversations?: Array<{ messages?: ConvoMemMessage[] }>
}

type ConvoMemResult = {
	question: string
	answer?: string
	category: string
	recall: number
	details: {
		retrieved_count: number
		evidence_count: number
		found: number
	}
	latencyMs: number
}

const CATEGORIES = [
	"user_evidence",
	"assistant_facts_evidence",
	"changing_evidence",
	"abstention_evidence",
	"preference_evidence",
	"implicit_connection_evidence",
]

const repoRoot = process.cwd()
const startedAt = new Date()
const runId =
	process.env.MEMONGO_BENCHMARK_RUN_ID?.trim() ||
	`memongo-convomem-${startedAt.toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`
const artifactRoot =
	process.env.MEMONGO_BENCHMARK_RUN_DIR?.trim() ||
	path.join(repoRoot, "artifacts", "benchmark-runs")
const runDir = path.join(artifactRoot, runId)
const responsePath = path.join(runDir, "benchmark-response.json")
const statusPath = path.join(runDir, "status.json")
const cacheDir =
	process.env.MEMONGO_CONVOMEM_CACHE_DIR?.trim() ||
	path.join(repoRoot, "artifacts", "competitors", "mempalace", "convomem-cache")
const topK = Math.max(
	1,
	Math.floor(Number(process.env.MEMONGO_BENCHMARK_MAX_RESULTS ?? 10)),
)
const limitPerCategory = Math.max(
	1,
	Math.floor(Number(process.env.MEMONGO_CONVOMEM_LIMIT_PER_CATEGORY ?? 50)),
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
		throw new Error("set MEMONGO_MONGODB_URI before running ConvoMem benchmark")
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

function normalizeText(value: string): string {
	return value.trim().toLowerCase()
}

function categoryFilePath(category: string, relativePath: string): string {
	return path.join(cacheDir, category, relativePath.replace(/\//g, "_"))
}

async function readJsonFile(filePath: string): Promise<unknown> {
	return JSON.parse(await readFile(filePath, "utf8")) as unknown
}

async function loadCategoryItems(category: string): Promise<ConvoMemItem[]> {
	const fileListPath = path.join(cacheDir, `${category}_filelist.json`)
	let files: string[] = []
	try {
		const parsed = await readJsonFile(fileListPath)
		files = Array.isArray(parsed)
			? parsed.filter((entry): entry is string => typeof entry === "string")
			: []
	} catch {
		return []
	}
	const items: ConvoMemItem[] = []
	for (const relativePath of files) {
		if (items.length >= limitPerCategory) {
			break
		}
		const filePath = categoryFilePath(category, relativePath)
		let parsed: unknown
		try {
			parsed = await readJsonFile(filePath)
		} catch {
			continue
		}
		const evidenceItems =
			parsed && typeof parsed === "object"
				? (parsed as { evidence_items?: unknown }).evidence_items
				: undefined
		if (!Array.isArray(evidenceItems)) {
			continue
		}
		for (const item of evidenceItems) {
			if (items.length >= limitPerCategory) {
				break
			}
			if (!item || typeof item !== "object") {
				continue
			}
			const record = item as ConvoMemItem
			if (typeof record.question !== "string") {
				continue
			}
			items.push({ ...record, _category_key: category })
		}
	}
	return items
}

async function loadItems(): Promise<{
	items: ConvoMemItem[]
	skipped: string[]
}> {
	const requested = (process.env.MEMONGO_CONVOMEM_CATEGORIES?.trim() || "all")
		.split(",")
		.map((entry) => entry.trim())
		.filter(Boolean)
	const categories =
		requested.length === 1 && requested[0] === "all" ? CATEGORIES : requested
	const items: ConvoMemItem[] = []
	const skipped: string[] = []
	for (const category of categories) {
		const loaded = await loadCategoryItems(category)
		if (loaded.length === 0) {
			skipped.push(category)
		}
		items.push(...loaded)
	}
	return { items, skipped }
}

async function ensureMessageCollection(params: {
	collection: Collection
	indexName: string
}): Promise<void> {
	await params.collection.createIndex(
		{ agentId: 1, messageIndex: 1 },
		{ name: "idx_convomem_agent_message" },
	)
	await params.collection.createIndex(
		{ agentId: 1, category: 1 },
		{ name: "idx_convomem_agent_category" },
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
			],
		},
	})
}

function itemMessages(item: ConvoMemItem): ConvoMemMessage[] {
	return (item.conversations ?? []).flatMap((conversation) =>
		Array.isArray(conversation.messages) ? conversation.messages : [],
	)
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
			const results = await vectorSearch(params.collection, null, {
				indexName: params.indexName,
				queryText: params.query,
				embeddingMode: "automated",
				maxResults: 1,
				minScore: 0,
				filter: { agentId: params.agentId },
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
	throw new Error(
		`ConvoMem vector index did not become queryable: ${lastError}`,
	)
}

function scoreRecall(params: {
	retrievedTexts: string[]
	evidenceTexts: string[]
}): { recall: number; found: number } {
	if (params.evidenceTexts.length === 0) {
		return { recall: 1, found: 0 }
	}
	let found = 0
	for (const evidenceText of params.evidenceTexts) {
		if (
			params.retrievedTexts.some(
				(retrievedText) =>
					evidenceText.includes(retrievedText) ||
					retrievedText.includes(evidenceText),
			)
		) {
			found++
		}
	}
	return { recall: found / params.evidenceTexts.length, found }
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

async function writeStatus(payload: Record<string, unknown>): Promise<void> {
	await mkdir(runDir, { recursive: true })
	await writeFile(statusPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8")
}

async function main(): Promise<void> {
	await mkdir(runDir, { recursive: true })
	const { items, skipped } = await loadItems()
	const datasetHash = createHash("sha256")
		.update(JSON.stringify({ cacheDir, limitPerCategory, items }))
		.digest("hex")
	const database = readDatabaseName()
	const prefix = prefixResolution.collectionPrefix
	const collectionName = `${prefix}convomem_messages`
	const indexName = `${prefix}convomem_messages_vector`
	const client = new MongoClient(readUri(), {
		appName: "memongo-convomem-benchmark",
		serverSelectionTimeoutMS: 15_000,
	})
	const results: ConvoMemResult[] = []

	await writeStatus({
		runId,
		status: "running",
		startedAt: startedAt.toISOString(),
		cacheDir,
		items: items.length,
		skipped,
	})

	await client.connect()
	try {
		const db = client.db(database)
		const collection = db.collection(collectionName)
		await ensureMessageCollection({ collection, indexName })
		const docs: Document[] = []
		for (const [itemIndex, item] of items.entries()) {
			const agentId = `${runId}::item_${itemIndex}`
			const category = item._category_key ?? item.category ?? "unknown"
			for (const [messageIndex, message] of itemMessages(item).entries()) {
				const text = typeof message.text === "string" ? message.text.trim() : ""
				if (!text) continue
				docs.push({
					agentId,
					itemIndex,
					messageIndex,
					category,
					text,
					speaker: message.speaker ?? "",
					path: `convomem/${itemIndex}/message_${messageIndex}`,
					canonicalId: `convomem/${itemIndex}/message_${messageIndex}`,
					createdAt: new Date(),
				})
			}
		}
		if (docs.length > 0) {
			for (let index = 0; index < docs.length; index += 1000) {
				await collection.insertMany(docs.slice(index, index + 1000))
			}
		}
		const firstItemWithMessages = items.find(
			(item) => itemMessages(item).length > 0,
		)
		if (firstItemWithMessages) {
			const firstIndex = items.indexOf(firstItemWithMessages)
			await waitForSearchable({
				collection,
				indexName,
				agentId: `${runId}::item_${firstIndex}`,
				query: firstItemWithMessages.question,
				timeoutMs: Number(
					process.env.MEMONGO_VECTOR_READY_TIMEOUT_MS ?? 300_000,
				),
			})
		}

		for (const [itemIndex, item] of items.entries()) {
			const agentId = `${runId}::item_${itemIndex}`
			const category = item._category_key ?? item.category ?? "unknown"
			const started = Date.now()
			const hits = await vectorSearch(collection, null, {
				indexName,
				queryText: item.question,
				embeddingMode: "automated",
				maxResults: topK,
				minScore: 0,
				filter: { agentId },
			})
			const retrievedTexts = hits.map((hit) => normalizeText(hit.text ?? ""))
			const evidenceTexts = (item.message_evidences ?? [])
				.map((message) =>
					typeof message.text === "string" ? normalizeText(message.text) : "",
				)
				.filter(Boolean)
			const scored = scoreRecall({ retrievedTexts, evidenceTexts })
			results.push({
				question: item.question,
				...(item.answer ? { answer: item.answer } : {}),
				category,
				recall: scored.recall,
				details: {
					retrieved_count: hits.length,
					evidence_count: evidenceTexts.length,
					found: scored.found,
				},
				latencyMs: Date.now() - started,
			})
			if ((itemIndex + 1) % 25 === 0 || itemIndex === items.length - 1) {
				await writeStatus({
					runId,
					status: "running",
					items: items.length,
					completed: itemIndex + 1,
					avgRecall:
						results.reduce((sum, result) => sum + result.recall, 0) /
						results.length,
					updatedAt: new Date().toISOString(),
				})
			}
		}
		const perCategory: Record<string, { cases: number; recall: number }> = {}
		for (const category of new Set(results.map((result) => result.category))) {
			const values = results.filter((result) => result.category === category)
			perCategory[category] = {
				cases: values.length,
				recall:
					values.reduce((sum, result) => sum + result.recall, 0) /
					values.length,
			}
		}
		const latencies = results.map((result) => result.latencyMs)
		const artifact = {
			artifactVersion: 1,
			runId,
			status: "completed",
			startedAt: startedAt.toISOString(),
			completedAt: new Date().toISOString(),
			dataset: {
				cacheDir,
				sha256: datasetHash,
				items: items.length,
				limitPerCategory,
				skipped,
			},
			mongodb: {
				database,
				collectionPrefix: prefix,
				collection: collectionName,
				vectorIndex: indexName,
			},
			lane: {
				name: "convomem-raw-message-top10",
				retrievalUnit: "message",
				llm: "none",
				reranker: "none",
				embedding: "MongoDB autoEmbed voyage-4-large",
				topK,
			},
			metrics: {
				avgRecall:
					results.length > 0
						? results.reduce((sum, result) => sum + result.recall, 0) /
							results.length
						: 0,
				perfect: results.filter((result) => result.recall >= 1).length,
				zero: results.filter((result) => result.recall === 0).length,
				emptyRate:
					results.length > 0
						? results.filter((result) => result.details.retrieved_count === 0)
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
