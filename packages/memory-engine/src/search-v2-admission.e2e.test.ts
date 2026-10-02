import { randomUUID } from "node:crypto"
import { writeFileSync } from "node:fs"
import { MongoClient } from "mongodb"
import { afterAll, beforeAll, expect, it, vi } from "vitest"
import { searchV2 } from "./mongodb-search-v2.js"
import {
	resetSearchAdmissionForTests,
	tryConsumeSearchAdmission,
} from "./mongodb-search-admission.js"
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
	throw new Error("E86 requires the explicit owned local server")
const client = new MongoClient(uri)
const name = `memongo_e86_v2_${randomUUID().replaceAll("-", "")}`
const db = client.db(name),
	prefix = "test_"
function evidence(label: string, data: unknown) {
	if (process.env.E22_FETCH_EVIDENCE_DIR)
		writeFileSync(
			`${process.env.E22_FETCH_EVIDENCE_DIR}/v2-${label}.json`,
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

it("keeps nested clamp and throttle telemetry out after completed erasure", async () => {
	const agentId = `stale-${randomUUID()}`,
		admission = await captureAdmissionToken({ db, prefix, agentId })
	expect((await deleteAllForAgent({ db, prefix, agentId })).status).toBe(
		"complete",
	)
	const gate = await readErasureGate({ db, prefix, agentId })
	vi.stubEnv("MEMONGO_SEARCH_ADMISSION_RPM", "1")
	resetSearchAdmissionForTests(Date.now())
	try {
		while (tryConsumeSearchAdmission().ok) {}
		const context = { availablePaths: new Set<never>(), admission }
		const result = await searchV2(
			db,
			prefix,
			"x".repeat(2200),
			agentId,
			context,
		)
		expect(result.metadata.throttled).toBeDefined()
		expect(result.results).toEqual([])
		expect(emissions.returns).toHaveLength(2)
		const pending = emissions.returns.filter(
			(p): p is Promise<void> => p !== undefined,
		)
		const settled = await Promise.allSettled(pending)
		// Before repair legacyvoid has no completion handle: wait for the known faulty two writes, then assert the erasure requirement.
		if (pending.length === 0)
			await vi.waitFor(async () =>
				expect(
					await db
						.collection(`${prefix}memory_telemetry`)
						.countDocuments({ "meta.agentId": agentId }),
				).toBe(2),
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
			results: result.results,
			throttled: result.metadata.throttled,
		})
		expect(rows).toEqual([])
		expect(afterGate).toEqual(gate)
		expect(settled).toHaveLength(2)
		for (const item of settled)
			expect(item).toMatchObject({
				status: "rejected",
				reason: { code: "ERASURE_GATE_CONFLICT" },
			})
	} finally {
		vi.unstubAllEnvs()
		resetSearchAdmissionForTests(Date.now())
	}
})
