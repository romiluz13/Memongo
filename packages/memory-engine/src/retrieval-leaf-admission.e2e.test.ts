import { randomUUID } from "node:crypto"
import { writeFileSync } from "node:fs"
import { MongoClient } from "mongodb"
import { afterAll, beforeAll, expect, it, vi } from "vitest"
import { rewriteQuery } from "./mongodb-query-rewriter.js"
const emissions = vi.hoisted(() => ({
	returns: [] as Array<void | Promise<void>>,
}))
vi.mock("./mongodb-telemetry.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./mongodb-telemetry.js")>()
	return {
		...actual,
		emitTelemetry: vi.fn((...args: Parameters<typeof actual.emitTelemetry>) => {
			const result = Reflect.apply(
				actual.emitTelemetry,
				undefined,
				args,
			) as void | Promise<void>
			emissions.returns.push(result)
			if (result) void result.catch(() => {})
			return result
		}),
	}
})
import { deleteAllForAgent } from "./mongodb-erasure.js"
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
	throw new Error("E88 requires the explicit owned local server")
const client = new MongoClient(uri)
const name = `memongo_e88_leaf_${randomUUID().replaceAll("-", "")}`
const db = client.db(name),
	prefix = "test_"
function evidence(label: string, data: unknown) {
	if (process.env.E22_FETCH_EVIDENCE_DIR)
		writeFileSync(
			`${process.env.E22_FETCH_EVIDENCE_DIR}/leaf-${label}.json`,
			JSON.stringify(data, null, 2),
		)
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

it("rejects original leaf telemetry after completed erasure while preserving results", async () => {
	const agentId = `stale-${randomUUID()}`,
		admission = await captureAdmissionToken({ db, prefix, agentId })
	expect((await deleteAllForAgent({ db, prefix, agentId })).status).toBe(
		"complete",
	)
	const gate = await readErasureGate({ db, prefix, agentId })
	const rewrite = await rewriteQuery({
		db,
		prefix,
		agentId,
		admission,
		query: "auth",
		config: { enabled: true, method: "synonym-expansion", maxTokens: 128 },
	})
	expect(rewrite.rewrittenQuery).toContain("authentication")
	const pending = emissions.returns.filter(
			(p): p is Promise<void> => p !== undefined,
		),
		settled = await Promise.allSettled(pending)
	if (pending.length === 0)
		await vi.waitFor(async () =>
			expect(
				await db
					.collection(`${prefix}memory_telemetry`)
					.countDocuments({ "meta.agentId": agentId }),
			).toBe(1),
		)
	const rows = await db
			.collection(`${prefix}memory_telemetry`)
			.find({ "meta.agentId": agentId })
			.toArray(),
		afterGate = await readErasureGate({ db, prefix, agentId })
	evidence("stale", {
		admission,
		gate,
		afterGate,
		rows,
		settled: settled.map((x) =>
			x.status === "rejected"
				? { status: x.status, code: Reflect.get(x.reason, "code") }
				: x,
		),
		rewrite,
	})
	expect(rows).toEqual([])
	expect(afterGate).toEqual(gate)
	expect(settled).toHaveLength(1)
	for (const item of settled)
		expect(item).toMatchObject({
			status: "rejected",
			reason: { code: "ERASURE_GATE_CONFLICT" },
		})
})

it("persists fresh admitted leaf telemetry without provider calls", async () => {
	emissions.returns.length = 0
	const agentId = `fresh-${randomUUID()}`,
		admission = await captureAdmissionToken({ db, prefix, agentId })
	const rewrite = await rewriteQuery({
		db,
		prefix,
		agentId,
		admission,
		query: "auth",
		config: { enabled: true, method: "synonym-expansion", maxTokens: 128 },
	})
	await Promise.all(emissions.returns)
	const rows = await db
			.collection(`${prefix}memory_telemetry`)
			.find({ "meta.agentId": agentId })
			.toArray(),
		gate = await readErasureGate({ db, prefix, agentId })
	evidence("fresh", { rows, gate, rewrite })
	expect(rows).toHaveLength(1)
	expect(gate?.serial).toBe(1)
	expect(rows.map((r) => r.meta.operation)).toEqual(["query-rewrite"])
	expect(rewrite.rewritten).toBe(true)
})
