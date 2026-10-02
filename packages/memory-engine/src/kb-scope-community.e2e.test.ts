import { randomUUID } from "node:crypto"
import { writeFileSync } from "node:fs"
import { MongoClient, type Document } from "mongodb"
import { afterAll, beforeAll, expect, it, vi } from "vitest"
import { MongoDBMemoryManager } from "./mongodb-manager.js"
import { ensureCollections } from "./mongodb-schema.js"
import { ensureCoreStandardIndexes } from "./mongodb-schema-standard-indexes-core.js"
import { shouldEnsureTextFallbackIndexes } from "./mongodb-schema-standard-indexes.js"
import { resolveScopeRef } from "./mongodb-scope.js"
const uri = process.env.MEMONGO_TEST_MONGODB_URI
if (
	!uri ||
	new URL(uri).hostname !== "127.0.0.1" ||
	new URL(uri).port !== "27218"
)
	throw new Error("E244 explicit owned server only")
const client = new MongoClient(uri, { monitorCommands: true })
const name = `memongo_e244_kb_${randomUUID().replaceAll("-", "")}`
const db = client.db(name),
	prefix = "test_",
	agentId = randomUUID(),
	workspaceDir = "/memongo-fixture-workspace"
const capabilities = {
	vectorSearch: false,
	textSearch: false,
	scoreFusion: false,
	rankFusion: false,
	storedSource: false,
	vectorIndexMethod: false,
}
const manager = Reflect.construct(MongoDBMemoryManager, [
	{
		client,
		db,
		prefix,
		agentId,
		workspaceDir,
		capabilities,
		nativeBitemporalVectorPrefilter: false,
		ownsClient: false,
		config: {
			mongodb: {
				embeddingMode: "automated",
				fusionMethod: "js-merge",
				numCandidates: 20,
			},
		},
	},
]) as MongoDBMemoryManager
const token = "graphite"
const refs = {
	global: resolveScopeRef({ scope: "global", agentId }),
	workspace: resolveScopeRef({ scope: "workspace", agentId, workspaceDir }),
	workspaceAgent: resolveScopeRef({ scope: "workspace", agentId }),
	agent: resolveScopeRef({ scope: "agent", agentId }),
	user: resolveScopeRef({ scope: "user", agentId, userId: "fixture-user" }),
	explicit: "explicit-fixture-reference",
}
const started = new Map<number, Document>(),
	succeeded: number[] = [],
	failures: string[] = []
let searchWindow = false
client.on("commandStarted", (event) => {
	if (searchWindow && event.databaseName === name)
		started.set(event.requestId, {
			name: event.commandName,
			command: event.command,
		})
})
client.on("commandSucceeded", (event) => {
	if (searchWindow && started.has(event.requestId))
		succeeded.push(event.requestId)
})
client.on("commandFailed", (event) => {
	if (searchWindow && started.has(event.requestId))
		failures.push(event.commandName)
})
function evidence(label: string, value: unknown) {
	const dir = process.env.E22_FETCH_EVIDENCE_DIR
	if (!dir) throw new Error("E244 evidence directory required")
	writeFileSync(`${dir}/kb-scope-${label}.json`, JSON.stringify(value))
}
beforeAll(async () => {
	evidence("fixture-worker", { fixturePid: process.pid })
	await client.connect()
	await ensureCollections(db, prefix)
	await ensureCoreStandardIndexes(db, prefix, {
		textFallbackIndexes: shouldEnsureTextFallbackIndexes(capabilities),
	})
	const indexes = await db
		.collection(`${prefix}kb_chunks`)
		.listIndexes()
		.toArray()
	expect(indexes.some((entry) => entry.name === "idx_kbchunks_text")).toBe(true)
	evidence("indexes", {
		name,
		indexes,
		capabilities,
		server: await db.command({ buildInfo: 1 }),
	})
	await db.collection(`${prefix}kb_chunks`).insertMany(
		Object.entries(refs).map(([path, scopeRef]) => ({
			agentId,
			scopeRef,
			docId: randomUUID(),
			path,
			text: token,
			startLine: 1,
			endLine: 1,
			updatedAt: new Date(),
		})),
	)
	searchWindow = true
})
afterAll(async () => {
	searchWindow = false
	try {
		evidence("commands", { started: [...started], succeeded, failures })
		expect(failures).toEqual([])
		const aggregates = [...started].filter(
			([, entry]) => entry.name === "aggregate",
		)
		expect(aggregates).toHaveLength(4)
		for (const [id, entry] of aggregates) {
			expect(succeeded).toContain(id)
			const pipeline = entry.command.pipeline as Document[]
			expect(pipeline[0].$match.$text.$search).toBe(token)
			for (const stage of pipeline)
				for (const kind of [
					"$search",
					"$vectorSearch",
					"$rankFusion",
					"$scoreFusion",
				])
					expect(stage).not.toHaveProperty(kind)
		}
	} finally {
		try {
			await db.dropDatabase()
			const listed = await client
				.db("admin")
				.admin()
				.listDatabases({ nameOnly: true, filter: { name } })
			evidence("cleanup", { name, databases: listed.databases })
			expect(listed.databases).toEqual([])
		} finally {
			await client.close()
		}
	}
})
async function search(
	expected: keyof typeof refs,
	options?: Parameters<MongoDBMemoryManager["searchKB"]>[1],
) {
	const before = started.size
	const results = await manager.searchKB(token, {
		maxResults: 5,
		minScore: 0,
		...options,
	})
	expect(results.map((hit) => hit.path)).toEqual([`kb:${expected}`])
	expect(results[0].filePath).toBe(expected)
	const calls = [...started]
		.slice(before)
		.filter(([, entry]) => entry.name === "aggregate")
	expect(calls).toHaveLength(1)
	expect(calls[0][1].command.pipeline[0].$match).toEqual({
		$text: { $search: token },
		scopeRef: refs[expected],
	})
	evidence(expected, { results, scopeRef: refs[expected] })
}
it("selects the global partition with implicit reference", async () => {
	await search("global", { scope: "global" })
})
it("selects the workspace hash partition, excluding the no-directory reference", async () => {
	await search("workspace", { scope: "workspace" })
})
it("preserves explicit reference precedence", async () => {
	await search("explicit", { scope: "global", scopeRef: refs.explicit })
})
it("keeps omitted scope in the legacy agent partition after global on the same manager under a user default", async () => {
	vi.stubEnv("MEMONGO_DEFAULT_SCOPE", "user")
	try {
		await search("agent")
	} finally {
		vi.unstubAllEnvs()
	}
})
