import { randomUUID } from "node:crypto"
import { writeFileSync } from "node:fs"
import { MongoClient, type Document } from "mongodb"
import { afterAll, beforeAll, expect, it } from "vitest"
import { searchV2, type SearchV2Context } from "./mongodb-search-v2.js"
import { ensureCollections } from "./mongodb-schema.js"
import { ensureCoreStandardIndexes } from "./mongodb-schema-standard-indexes-core.js"
import { shouldEnsureTextFallbackIndexes } from "./mongodb-schema-standard-indexes.js"

const uri = process.env.MEMONGO_TEST_MONGODB_URI
if (
	!uri ||
	new URL(uri).hostname !== "127.0.0.1" ||
	new URL(uri).port !== "27218"
)
	throw new Error("E221 explicit owned server only")
const client = new MongoClient(uri, { monitorCommands: true })
const name = `memongo_e221_search_${randomUUID().replaceAll("-", "")}`
const db = client.db(name),
	prefix = "test_"
const now = new Date(),
	past = new Date(now.getTime() - 3600000),
	future = new Date(now.getTime() + 3600000)
const capabilities = {
	vectorSearch: false,
	textSearch: false,
	scoreFusion: false,
	rankFusion: false,
	storedSource: false,
	vectorIndexMethod: false,
}
const commands: Document[] = []
client.on("commandStarted", (event) => {
	if (event.databaseName === name && event.commandName === "aggregate")
		commands.push(event.command)
})
function evidence(label: string, value: unknown) {
	const dir = process.env.E22_FETCH_EVIDENCE_DIR
	if (!dir) throw new Error("E221 evidence directory required")
	writeFileSync(`${dir}/community-search-${label}.json`, JSON.stringify(value))
}
beforeAll(async () => {
	evidence("fixture-worker", { fixturePid: process.pid })
	await client.connect()
	await ensureCollections(db, prefix)
	await ensureCoreStandardIndexes(db, prefix, {
		textFallbackIndexes: shouldEnsureTextFallbackIndexes(capabilities),
	})
	const indexes: Record<string, Document[]> = {}
	for (const collection of await db
		.listCollections({}, { nameOnly: true })
		.toArray())
		indexes[collection.name] = await db
			.collection(collection.name)
			.listIndexes()
			.toArray()
	for (const [collection, index] of [
		["chunks", "idx_chunks_text"],
		["kb_chunks", "idx_kbchunks_text"],
		["structured_mem", "idx_structured_text"],
	])
		expect(
			indexes[`${prefix}${collection}`].some((entry) => entry.name === index),
		).toBe(true)
	evidence("indexes", {
		name,
		indexes,
		capabilities,
		server: await db.command({ buildInfo: 1 }),
	})
})
afterAll(async () => {
	try {
		evidence("commands", commands)
		await db.dropDatabase()
		const listed = await client
			.db("admin")
			.admin()
			.listDatabases({ nameOnly: true, filter: { name } })
		evidence("cleanup", { name, databases: listed.databases })
		expect(listed.databases).toEqual([])
		expect(commands).toHaveLength(8)
		let searches = 0
		for (const command of commands) {
			const pipeline = command.pipeline as Document[]
			for (const stage of [
				"$search",
				"$vectorSearch",
				"$rankFusion",
				"$scoreFusion",
			])
				for (const element of pipeline)
					expect(element).not.toHaveProperty(stage)
			if (JSON.stringify(pipeline[0].$match).includes('"$text"')) searches++
			else expect(pipeline[1]).toEqual({ $group: { _id: 1, n: { $sum: 1 } } })
		}
		expect(searches).toBe(5)
	} finally {
		await client.close()
	}
})
function identity(agentId: string) {
	return { agentId, scope: "agent", scopeRef: `agent:${agentId}` }
}
function search(
	agentId: string,
	query: string,
	path: "structured" | "hybrid" | "kb",
	options: SearchV2Context["searchOptions"] = {},
) {
	return searchV2(db, prefix, query, agentId, {
		availablePaths: new Set([path]),
		maxResults: 20,
		searchOptions: {
			capabilities,
			conversationEvidenceMode: "disabled",
			allowHybridBackstop: false,
			questionDate: now,
			...options,
		},
	})
}
async function structured(agentId: string, rows: Document[]) {
	await db.collection(`${prefix}structured_mem`).insertMany(
		rows.map((row) => ({
			...identity(agentId),
			type: "fact",
			state: "active",
			updatedAt: now,
			...row,
		})),
	)
}
it("explicit fact returns the fact despite preference inference", async () => {
	const agentId = randomUUID(),
		value = "preference graphite"
	await structured(agentId, [
		{ key: "chosen", value },
		{ type: "preference", key: "inferred", value },
	])
	const result = await search(agentId, value, "structured", {
		structuredScope: { type: "fact" },
	})
	expect(result.metadata.plan.constraints?.structured?.type).toBe("preference")
	expect(result.results.map((hit) => hit.canonicalId)).toEqual([
		"structured:fact:chosen",
	])
	evidence("explicit-type", result)
})
it("conflicted current state excludes equally matching stale and foreign rows", async () => {
	const agentId = randomUUID(),
		value = "preference cobalt"
	await structured(agentId, [
		{ key: "chosen", state: "conflicted", value },
		{ key: "active", value },
		{ key: "closed", state: "conflicted", value, validTo: past },
		{ key: "future", state: "conflicted", value, validFrom: future },
		{ key: "expired", state: "conflicted", value, expiresAt: past },
		{ ...identity(randomUUID()), key: "foreign", state: "conflicted", value },
	])
	const result = await search(agentId, value, "structured", {
		structuredScope: { type: "fact", state: "conflicted" },
	})
	expect(result.results.map((hit) => hit.canonicalId)).toEqual([
		"structured:fact:chosen",
	])
	expect(result.results[0].state).toBe("conflicted")
	const stored = await db
		.collection(`${prefix}structured_mem`)
		.countDocuments({ agentId, key: { $in: ["closed", "future"] } })
	expect(stored).toBe(2)
	expect(
		await db
			.collection(`${prefix}structured_mem`)
			.countDocuments({ agentId, key: "expired" }),
	).toBe(1)
	evidence("current-conflicted", result)
})
it("absent state retains the active control", async () => {
	const agentId = randomUUID(),
		value = "preference quartz"
	await structured(agentId, [
		{ key: "chosen", value },
		{ key: "conflicted", state: "conflicted", value },
	])
	const result = await search(agentId, value, "structured", {
		structuredScope: { type: "fact" },
	})
	expect(result.results.map((hit) => hit.canonicalId)).toEqual([
		"structured:fact:chosen",
	])
	expect(result.results[0].state).toBe("active")
	evidence("active-control", result)
})
it("hybrid ordinary text applies identity, lifecycle and validity predicates", async () => {
	const agentId = randomUUID(),
		text = "graphite amber"
	const rows = [
		{ id: "chosen" },
		{ id: "foreign", ...identity(randomUUID()) },
		{ id: "expired", expiresAt: past },
		{ id: "closed", invalidAt: past },
		{ id: "future", validAt: future },
		{ id: "deleted", status: "deleted" },
	]
	await db.collection(`${prefix}chunks`).insertMany(
		rows.map(({ id, ...row }) => ({
			...identity(agentId),
			path: `events/${id}`,
			hash: randomUUID(),
			text,
			startLine: 1,
			endLine: 1,
			source: "conversation",
			status: "active",
			updatedAt: now,
			...row,
		})),
	)
	const result = await search(agentId, text, "hybrid")
	expect(result.results.map((hit) => hit.canonicalId)).toEqual(["event:chosen"])
	expect(result.results[0].snippet).toBe(text)
	expect(
		await db
			.collection(`${prefix}chunks`)
			.countDocuments({ agentId, path: "events/expired" }),
	).toBe(1)
	evidence("hybrid", result)
})
it("explicit KB source and category override conflicting inferred filters", async () => {
	const agentId = randomUUID(),
		text = "file API endpoint graphite"
	const rows = [
		{ id: "chosen", type: "url", category: "research" },
		{ id: "file", type: "file", category: "research" },
		{ id: "api", type: "url", category: "api" },
		{
			id: "foreign",
			type: "url",
			category: "research",
			...identity(randomUUID()),
		},
	]
	for (const { id, type, category, ...row } of rows) {
		const scope = { ...identity(agentId), ...row },
			docId = randomUUID()
		await db
			.collection<Document & { _id: string }>(`${prefix}knowledge_base`)
			.insertOne({
				_id: docId,
				...scope,
				hash: randomUUID(),
				title: id,
				source: { type },
				category,
				updatedAt: now,
			})
		await db.collection(`${prefix}kb_chunks`).insertOne({
			...scope,
			docId,
			path: id,
			text,
			startLine: 1,
			endLine: 1,
			updatedAt: now,
		})
	}
	const result = await search(agentId, text, "kb", {
		referenceScope: { source: "url", category: "research" },
	})
	expect(result.metadata.plan.constraints?.kb).toMatchObject({
		category: "api",
	})
	expect(result.results.map((hit) => hit.path)).toEqual(["kb:chosen"])
	evidence("kb-precedence", result)
})
