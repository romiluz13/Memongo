import { randomUUID } from "node:crypto"
import { writeFileSync } from "node:fs"
import { Collection, MongoClient } from "mongodb"
import { afterAll, beforeAll, expect, it, vi } from "vitest"
import { resolveMemoryBackendConfig } from "./backend-config.js"
import { deleteAllForAgent } from "./mongodb-erasure.js"
import {
	MongoDBRelevanceRuntime,
	type RelevanceRunPersistInput,
} from "./mongodb-relevance.js"
import { ensureCollections } from "./mongodb-schema.js"
import {
	captureAdmissionToken,
	readErasureGate,
} from "./mongodb-write-fence.js"

const uri = process.env.MEMONGO_TEST_MONGODB_URI
if (
	!uri ||
	new URL(uri).hostname !== "127.0.0.1" ||
	new URL(uri).port !== "27218"
)
	throw new Error("E92 requires the explicit owned local server")
const client = new MongoClient(uri)
const name = `memongo_e92_relevance_${randomUUID().replaceAll("-", "")}`
const db = client.db(name),
	prefix = "test_"
const resolvedConfig = resolveMemoryBackendConfig({
	agentId: "fixture",
	cfg: {
		memory: {
			backend: "mongodb",
			mongodb: { uri, embeddingMode: "automated" },
		},
	},
}).mongodb
if (!resolvedConfig) throw new Error("fixture requires resolved MongoDB config")
const config = resolvedConfig
function runtime(agentId: string) {
	return new MongoDBRelevanceRuntime(db, prefix, agentId, config, {
		textSearch: false,
		vectorSearch: false,
		rankFusion: false,
		storedSource: false,
		vectorIndexMethod: false,
		scoreFusion: false,
	})
}
function input(): RelevanceRunPersistInput {
	return {
		query: "erased private query",
		sourceScope: "all",
		latencyMs: 1,
		topK: 1,
		hitSources: ["memory"],
		status: "ok",
		sampled: true,
		sampleRate: 1,
		artifacts: [{ artifactType: "trace", summary: { hitId: "old-event" } }],
	}
}
function evidence(label: string, data: unknown) {
	if (process.env.E22_FETCH_EVIDENCE_DIR)
		writeFileSync(
			`${process.env.E22_FETCH_EVIDENCE_DIR}/relevance-${label}.json`,
			JSON.stringify(data, null, 2),
		)
}
async function rows(agentId: string) {
	return {
		runs: await db
			.collection(`${prefix}relevance_runs`)
			.find({ agentId })
			.toArray(),
		artifacts: await db
			.collection(`${prefix}relevance_artifacts`)
			.find({ agentId })
			.toArray(),
	}
}
beforeAll(async () => {
	evidence("fixture-worker", { fixturePid: process.pid })
	await client.connect()
	await ensureCollections(db, prefix)
})
afterAll(async () => {
	try {
		await db.dropDatabase()
		const listed = await client
			.db("admin")
			.admin()
			.listDatabases({ nameOnly: true, filter: { name } })
		expect(listed.databases).toEqual([])
		evidence("cleanup", { name, databases: listed.databases })
	} finally {
		await client.close()
	}
})
it("rejects an original relevance run after completed erasure", async () => {
	const agentId = `stale-${randomUUID()}`,
		admission = await captureAdmissionToken({ db, prefix, agentId })
	expect((await deleteAllForAgent({ db, prefix, agentId })).status).toBe(
		"complete",
	)
	const gate = await readErasureGate({ db, prefix, agentId })
	let error: unknown
	try {
		await runtime(agentId).persistRun({ ...input(), admission })
	} catch (caught) {
		error = caught
	}
	const stored = await rows(agentId),
		afterGate = await readErasureGate({ db, prefix, agentId })
	evidence("stale", {
		admission,
		gate,
		afterGate,
		...stored,
		error:
			error instanceof Error ? { code: Reflect.get(error, "code") } : error,
	})
	expect(stored).toEqual({ runs: [], artifacts: [] })
	expect(error).toMatchObject({ code: "ERASURE_GATE_CONFLICT" })
	expect(afterGate).toEqual(gate)
})
it("commits a fresh run and artifact in one gate serial", async () => {
	const agentId = `fresh-${randomUUID()}`,
		admission = await captureAdmissionToken({ db, prefix, agentId })
	const runId = await runtime(agentId).persistRun({ ...input(), admission })
	const stored = await rows(agentId),
		gate = await readErasureGate({ db, prefix, agentId })
	evidence("fresh", { runId, gate, ...stored })
	expect(stored.runs).toHaveLength(1)
	expect(stored.artifacts).toHaveLength(1)
	expect(stored.runs[0]?.runId).toBe(runId)
	expect(stored.artifacts[0]?.runId).toBe(runId)
	expect(gate?.serial).toBe(1)
})
it("rolls back the first insert and gate on a second-insert failure", async () => {
	const agentId = `rollback-${randomUUID()}`,
		admission = await captureAdmissionToken({ db, prefix, agentId })
	const gate = await readErasureGate({ db, prefix, agentId }),
		fault = new Error("second insert fixture fault")
	const original = Collection.prototype.insertMany
	const spy = vi
		.spyOn(Collection.prototype, "insertMany")
		.mockImplementation(function (this: Collection, docs, options) {
			if (this.collectionName === `${prefix}relevance_artifacts`)
				return Promise.reject(fault)
			return Reflect.apply(original, this, [docs, options])
		})
	try {
		await expect(
			runtime(agentId).persistRun({ ...input(), admission }),
		).rejects.toBe(fault)
	} finally {
		spy.mockRestore()
	}
	const stored = await rows(agentId),
		afterGate = await readErasureGate({ db, prefix, agentId })
	evidence("rollback", { gate, afterGate, ...stored })
	expect(stored).toEqual({ runs: [], artifacts: [] })
	expect(afterGate).toEqual(gate)
})
it("starts a new intent for compatible no-token callers and supports no artifacts", async () => {
	const agentId = `legacy-${randomUUID()}`
	const runId = await runtime(agentId).persistRun({ ...input(), artifacts: [] })
	const stored = await rows(agentId),
		gate = await readErasureGate({ db, prefix, agentId })
	evidence("legacy", { runId, gate, ...stored })
	expect(stored.runs).toHaveLength(1)
	expect(stored.artifacts).toEqual([])
	expect(gate?.serial).toBe(1)
})
it("rejects a different owner before writing either gate", async () => {
	const agentId = `owner-${randomUUID()}`,
		otherId = `other-${randomUUID()}`
	const admission = await captureAdmissionToken({
		db,
		prefix,
		agentId: otherId,
	})
	const gate = await readErasureGate({ db, prefix, agentId: otherId })
	await expect(
		runtime(agentId).persistRun({ ...input(), admission }),
	).rejects.toMatchObject({ code: "ERASURE_GATE_CONFLICT" })
	expect(await rows(agentId)).toEqual({ runs: [], artifacts: [] })
	expect(await readErasureGate({ db, prefix, agentId })).toBeNull()
	expect(await readErasureGate({ db, prefix, agentId: otherId })).toEqual(gate)
})
