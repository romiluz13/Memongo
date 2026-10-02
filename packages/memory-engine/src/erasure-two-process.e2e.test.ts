import { fork, type ChildProcess } from "node:child_process"
import { randomUUID } from "node:crypto"
import { writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { MongoClient } from "mongodb"
import { afterAll, beforeAll, expect, it } from "vitest"
import { writeEvent } from "./mongodb-events.js"
import { deleteAllForAgent } from "./mongodb-erasure.js"
import { ensureCollections } from "./mongodb-schema.js"
import { readErasureGate } from "./mongodb-write-fence.js"

const uri = process.env.MEMONGO_TEST_MONGODB_URI
if (
	!uri ||
	new URL(uri).hostname !== "127.0.0.1" ||
	new URL(uri).port !== "27218"
)
	throw new Error("E134 owned local MongoDB only")
const fetchDirectory = process.env.E22_FETCH_EVIDENCE_DIR
if (!fetchDirectory) throw new Error("E134 preload evidence required")
const name = `memongo_e134_${randomUUID().replaceAll("-", "")}`,
	client = new MongoClient(uri),
	db = client.db(name),
	prefix = "test_",
	children: Array<{
		child: ChildProcess
		closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }>
	}> = []
function evidence(label: string, data: unknown) {
	writeFileSync(
		`${fetchDirectory}/two-process-${label}.json`,
		JSON.stringify(data),
	)
}
type Message = {
	kind: string
	pid?: number
	hit?: boolean
	sourceCount?: number
	stale?: { status: string; conflict?: boolean; error?: { code?: string } }
	fresh?: {
		eventsProcessed?: number
		chunksCreated?: number
		eventId?: string
		chunkCreated?: boolean
	}
	imports?: string[]
}
function worker(agentId: string, mode: string) {
	const child = fork(
		new URL("./test-helpers/erasure-two-process-child.mjs", import.meta.url),
		[uri as string, name, agentId, mode],
		{
			execArgv: [
				"--import",
				fileURLToPath(
					new URL("./test-helpers/erasure-provider-guard.mjs", import.meta.url),
				),
			],
			serialization: "json",
			timeout: 20000,
			killSignal: "SIGTERM",
			stdio: ["ignore", "pipe", "pipe", "ipc"],
			env: {
				HOME: process.env.HOME,
				PATH: process.env.PATH,
				E22_FETCH_EVIDENCE_DIR: fetchDirectory,
				MEMONGO_TELEMETRY_ENABLED: "false",
			},
		},
	)
	const messages = new Map<string, Message>(),
		waiting = new Map<string, (message: Message) => void>()
	let output = ""
	child.stdout?.on("data", (data) => {
		output = (output + String(data)).slice(-65536)
	})
	child.stderr?.on("data", (data) => {
		output = (output + String(data)).slice(-65536)
	})
	child.on("message", (message) => {
		const value = message as Message
		messages.set(value.kind, value)
		waiting.get(value.kind)?.(value)
	})
	const closed = new Promise<{
		code: number | null
		signal: NodeJS.Signals | null
	}>((resolve) => {
		child.on("error", (error) => {
			output += String(error)
		})
		child.once("close", (code, signal) => resolve({ code, signal }))
	})
	children.push({ child, closed })
	async function receive(kind: string) {
		if (messages.has(kind)) return messages.get(kind) as Message
		return new Promise<Message>((resolve, reject) => {
			const timer = setTimeout(
				() => reject(new Error(`E134 missing ${kind}: ${output}`)),
				8000,
			)
			waiting.set(kind, (value) => {
				clearTimeout(timer)
				waiting.delete(kind)
				resolve(value)
			})
		})
	}
	return { child, closed, receive, messages }
}
async function rows(agentId: string, suffix: string) {
	return db.collection(`${prefix}${suffix}`).find({ agentId }).toArray()
}
beforeAll(async () => {
	evidence("fixture-worker", { fixturePid: process.pid })
	await client.connect()
	await ensureCollections(db, prefix)
})
afterAll(async () => {
	try {
		const processCleanup = []
		for (const { child, closed } of children) {
			let timer: ReturnType<typeof setTimeout> | undefined
			if (child.exitCode === null && child.signalCode === null) {
				timer = setTimeout(() => child.kill("SIGKILL"), 3000)
				child.kill("SIGTERM")
			}
			const result = await closed
			clearTimeout(timer)
			expect(() => process.kill(child.pid as number, 0)).toThrow()
			processCleanup.push({ pid: child.pid, ...result })
		}
		await db.dropDatabase()
		const listed = await client
			.db("admin")
			.admin()
			.listDatabases({ nameOnly: true, filter: { name } })
		expect(listed.databases).toEqual([])
		evidence("cleanup", { name, databases: listed.databases, processCleanup })
	} finally {
		await client.close()
	}
})
it.each([
	"repair",
	"public",
])("old %s work in another process rejects after complete, fresh work succeeds", async (mode) => {
	const agentId = `agent-${randomUUID()}`,
		eventId = randomUUID()
	if (mode === "repair")
		await writeEvent({
			db,
			prefix,
			event: {
				eventId,
				agentId,
				role: "user",
				body: "Old repair content",
				scope: "agent",
				scopeRef: `agent:${agentId}`,
				timestamp: new Date(),
			},
		})
	const w = worker(agentId, mode)
	const paused = await w.receive("paused")
	expect(paused.pid).toBe(w.child.pid)
	expect(paused.pid).not.toBe(process.pid)
	expect(paused.sourceCount).toBe(mode === "repair" ? 1 : 0)
	const receipt = await deleteAllForAgent({ db, prefix, agentId })
	expect(receipt.status).toBe("complete")
	expect(receipt.gateState).toBe("open")
	const gate = await readErasureGate({ db, prefix, agentId })
	const audit = await db
		.collection(`${prefix}memory_mutations`)
		.findOne({ mutationId: receipt.mutationId })
	expect(audit?.meta).toMatchObject({
		kind: "tenant-erasure",
		status: "complete",
		runId: receipt.runId,
		epoch: receipt.epoch,
	})
	for (const suffix of [
		"events",
		"chunks",
		"projection_runs",
		"ingest_runs",
		"lane_coverage",
		"memory_jobs",
	])
		expect(await rows(agentId, suffix)).toEqual([])
	if (mode === "repair")
		await writeEvent({
			db,
			prefix,
			event: {
				eventId,
				agentId,
				role: "user",
				body: "Fresh repair content",
				scope: "agent",
				scopeRef: `agent:${agentId}`,
				timestamp: new Date(),
			},
		})
	await new Promise<void>((resolve, reject) =>
		w.child.send({ kind: "release" }, (error) =>
			error ? reject(error) : resolve(),
		),
	)
	await w.receive("ack-release")
	const stale = await w.receive("stale")
	evidence(`${mode}-stale`, {
		parentPid: process.pid,
		childPid: w.child.pid,
		paused,
		stale,
		gate,
	})
	expect(stale.hit).toBe(true)
	expect(stale.stale).toMatchObject({
		status: "rejected",
		conflict: true,
		error: { code: "ERASURE_GATE_CONFLICT" },
	})
	expect(await readErasureGate({ db, prefix, agentId })).toEqual(gate)
	for (const suffix of [
		"chunks",
		"projection_runs",
		"ingest_runs",
		"lane_coverage",
		"memory_jobs",
	])
		expect(await rows(agentId, suffix)).toEqual([])
	const retained = await rows(agentId, "events")
	if (mode === "repair") {
		expect(retained).toEqual([
			expect.objectContaining({ eventId, body: "Fresh repair content" }),
		])
		expect(retained[0].projectedAt).toBeUndefined()
	} else expect(retained).toEqual([])
	await new Promise<void>((resolve, reject) =>
		w.child.send({ kind: "fresh" }, (error) =>
			error ? reject(error) : resolve(),
		),
	)
	const result = await w.receive("result")
	const closed = await w.closed
	evidence(`${mode}-processes`, {
		parentPid: process.pid,
		childPid: w.child.pid,
		paused,
		stale,
		result,
		closed,
	})
	expect(closed).toEqual({ code: 0, signal: null })
	expect(() => process.kill(w.child.pid as number, 0)).toThrow()
	expect(stale.hit).toBe(true)
	expect(stale.stale).toMatchObject({
		status: "rejected",
		conflict: true,
		error: { code: "ERASURE_GATE_CONFLICT" },
	})
	expect(result.hit).toBe(true)
	expect(
		result.imports?.filter((url) => /mongodb-events\.ts/.test(url)),
	).toHaveLength(1)
	const events = await rows(agentId, "events"),
		chunks = await rows(agentId, "chunks")
	expect(events).toHaveLength(1)
	expect(events[0]).toMatchObject({
		body: mode === "repair" ? "Fresh repair content" : "Fresh public content",
		projectedAt: expect.any(Date),
	})
	expect(chunks).toHaveLength(1)
	expect(JSON.stringify(chunks)).not.toContain("Old ")
	expect(await rows(agentId, "projection_runs")).toEqual([
		expect.objectContaining({ status: "ok", itemsProjected: 1 }),
	])
	// Same disabled tails as event-projection-admission.e2e.test.ts:153-171.
	expect((await readErasureGate({ db, prefix, agentId }))?.serial).toBe(
		(gate?.serial as number) + (mode === "repair" ? 2 : 5),
	)
	if (mode === "repair")
		expect(result.fresh).toEqual({ eventsProcessed: 1, chunksCreated: 1 })
	else {
		expect(result.fresh).toMatchObject({
			eventId: events[0].eventId,
			chunkCreated: true,
		})
		expect(await rows(agentId, "ingest_runs")).toHaveLength(1)
		expect(await rows(agentId, "lane_coverage")).toHaveLength(1)
		expect(await rows(agentId, "memory_jobs")).toEqual([])
	}
})
