import { randomUUID } from "node:crypto"
import { writeFileSync } from "node:fs"
import {
	AbstractCursor,
	Collection,
	MongoClient,
	MongoServerError,
} from "mongodb"
import { beforeAll, afterAll, afterEach, expect, it, vi } from "vitest"
const emissions = vi.hoisted(() => ({
	values: [] as Array<{ agentId: string; result: void | Promise<void> }>,
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
			emissions.values.push({ agentId: args[2].meta.agentId, result })
			if (result) void result.catch(() => {})
			return result
		}),
	}
})
import { deleteAllForAgent } from "./mongodb-erasure.js"
import { MongoDBManagerLifecycleOps } from "./mongodb-manager-lifecycle.js"
import type { MongoDBManagerHost } from "./mongodb-manager-host.js"
import { synthesizeProfile } from "./mongodb-profile.js"
import { hydrateActiveSlate } from "./mongodb-active-slate.js"
import { buildDiscoveryProjection } from "./mongodb-discovery-projections.js"
import { buildContextBundle } from "./mongodb-context-bundle.js"
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
	throw new Error("E123 owned local MongoDB only")
const client = new MongoClient(uri),
	other = new MongoClient(uri),
	name = `memongo_e123_diagnostics_${randomUUID().replaceAll("-", "")}`,
	db = client.db(name),
	otherDb = other.db(name),
	prefix = "test_"
type Kind = "profile" | "slate" | "discovery" | "bundle"
const kinds: Kind[] = ["profile", "slate", "discovery", "bundle"]
function evidence(label: string, data: unknown) {
	if (process.env.E22_FETCH_EVIDENCE_DIR)
		writeFileSync(
			`${process.env.E22_FETCH_EVIDENCE_DIR}/diagnostics-${label}.json`,
			JSON.stringify(data),
		)
}
async function seed() {
	const agentId = `agent-${randomUUID()}`,
		scopeRef = `agent:${agentId}`
	await db.collection(`${prefix}structured_mem`).insertOne({
		agentId,
		scope: "agent",
		scopeRef,
		type: "fact",
		key: "city",
		value: "Paris",
		state: "active",
		salience: "high",
		updatedAt: new Date(),
	})
	return { agentId, scopeRef }
}
function manager(agentId: string) {
	const host = {
		db,
		prefix,
		client,
		agentId,
		workspaceDir: "/tmp/memongo-e123-no-files",
		config: {
			mongodb: {
				kb: { enabled: false },
				relevance: { telemetry: { queryPrivacyMode: "omit" } },
			},
		},
		buildV2AvailablePaths: () => new Set<string>(),
	}
	return new MongoDBManagerLifecycleOps(host as unknown as MongoDBManagerHost)
}
function invoke(kind: Kind, agentId: string, admission?: unknown) {
	const params = {
		db,
		prefix,
		agentId,
		scope: "agent" as const,
		scopeRef: `agent:${agentId}`,
		admission,
	}
	switch (kind) {
		case "profile":
			return Reflect.apply(synthesizeProfile, undefined, [
				params,
			]) as Promise<unknown>
		case "slate":
			return Reflect.apply(hydrateActiveSlate, undefined, [
				params,
			]) as Promise<unknown>
		case "discovery":
			return Reflect.apply(buildDiscoveryProjection, undefined, [
				{ ...params, kind: "topic-brief", query: "city" },
			]) as Promise<unknown>
		case "bundle":
			return Reflect.apply(buildContextBundle, undefined, [
				{
					...params,
					request: {
						query: "city",
						includeProfile: true,
						includeDiscoveryProjection: true,
						discoveryKind: "topic-brief",
					},
				},
			]) as Promise<unknown>
	}
}
function managed(kind: Kind, agentId: string) {
	const ops = manager(agentId)
	switch (kind) {
		case "profile":
			return ops.synthesizeProfile()
		case "slate":
			return ops.hydrateActiveSlate()
		case "discovery":
			return ops.buildDiscoveryProjection({
				kind: "topic-brief",
				query: "city",
			})
		case "bundle":
			return ops.buildContextBundle({
				query: "city",
				includeProfile: true,
				includeDiscoveryProjection: true,
				discoveryKind: "topic-brief",
			})
	}
}
async function erase(agentId: string) {
	expect(
		(await deleteAllForAgent({ db: otherDb, prefix, agentId })).status,
	).toBe("complete")
}
async function rows(agentId: string) {
	return {
		telemetry: await db
			.collection(`${prefix}memory_telemetry`)
			.find({ "meta.agentId": agentId })
			.sort({ _id: 1 })
			.toArray(),
		projection: await db
			.collection(`${prefix}projection_runs`)
			.find({ agentId })
			.sort({ _id: 1 })
			.toArray(),
	}
}
async function flush(agentId: string) {
	const own = emissions.values.filter((x) => x.agentId === agentId)
	if (own.some((x) => x.result === undefined))
		await vi.waitFor(async () =>
			expect((await rows(agentId)).telemetry.length).toBe(own.length),
		)
	await Promise.allSettled(own.map((x) => x.result))
}
function pauseRead(agentId: string, fail = false) {
	const original = AbstractCursor.prototype.toArray
	let done = false
	const error = new Error("E123 outside-settled synthesis failure")
	const spy = vi
		.spyOn(AbstractCursor.prototype, "toArray")
		.mockImplementation(async function (this: AbstractCursor) {
			const docs = await original.call(this)
			if (!done && this.namespace.collection === `${prefix}structured_mem`) {
				done = true
				await erase(agentId)
				if (fail) {
					const bad = {
						type: "fact",
						value: "Paris",
						state: "active",
						salience: "high",
						updatedAt: new Date(),
					}
					Object.defineProperty(bad, "key", {
						get() {
							throw error
						},
					})
					return [bad]
				}
			}
			return docs
		})
	return { spy, error, wasPaused: () => done }
}
beforeAll(async () => {
	evidence("fixture-worker", { fixturePid: process.pid })
	await client.connect()
	await other.connect()
	await ensureCollections(db, prefix)
})
afterEach(() => {
	vi.restoreAllMocks()
	vi.unstubAllEnvs()
	emissions.values.length = 0
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
		await other.close()
		await client.close()
	}
})
it.each(kinds)("fresh managed %s writes admitted diagnostics", async (kind) => {
	const { agentId } = await seed()
	const result = await managed(kind, agentId)
	expect(result).toBeDefined()
	await flush(agentId)
	const actual = await rows(agentId),
		gate = await readErasureGate({ db, prefix, agentId })
	expect(actual.telemetry).toHaveLength(kind === "bundle" ? 4 : 1)
	expect(actual.projection).toHaveLength(
		kind === "bundle" || kind === "discovery" ? 1 : 0,
	)
	expect(gate?.serial).toBe(kind === "bundle" ? 5 : 1)
})
it.each(
	kinds,
)("managed %s keeps pre-read token when read straddles erasure", async (kind) => {
	const { agentId } = await seed(),
		barrier = pauseRead(agentId)
	const result = await managed(kind, agentId)
	expect(result).toBeDefined()
	expect(barrier.wasPaused()).toBe(true)
	const gate = await readErasureGate({ db, prefix, agentId })
	await flush(agentId)
	expect(await rows(agentId)).toEqual({ telemetry: [], projection: [] })
	expect(await readErasureGate({ db, prefix, agentId })).toEqual(gate)
})
it.each(
	kinds.flatMap((kind) =>
		["owner", "kind"].map((which) => [kind, which] as const),
	),
)("wrong %s admission %s rejects before reads even sampling disabled", async (kind, which) => {
	vi.stubEnv("MEMONGO_TELEMETRY_ENABLED", "false")
	const { agentId } = await seed(),
		token = await captureAdmissionToken({ db, prefix, agentId }),
		read = vi.spyOn(db, "collection")
	const bad =
		which === "owner"
			? { ...token, agentId: "foreign" }
			: { ...token, kind: "erasure", runId: "fixture" }
	await expect(invoke(kind, agentId, bad)).rejects.toMatchObject({
		code: "ERASURE_GATE_CONFLICT",
	})
	expect(read).not.toHaveBeenCalled()
})
it.each([
	"slate",
	"discovery",
] as const)("old %s failure telemetry retains original read epoch", async (kind) => {
	const { agentId } = await seed(),
		admission = await captureAdmissionToken({ db, prefix, agentId }),
		barrier = pauseRead(agentId, true)
	await expect(invoke(kind, agentId, admission)).rejects.toBe(barrier.error)
	expect(barrier.wasPaused()).toBe(true)
	const gate = await readErasureGate({ db, prefix, agentId })
	await flush(agentId)
	expect(await rows(agentId)).toEqual({ telemetry: [], projection: [] })
	expect(await readErasureGate({ db, prefix, agentId })).toEqual(gate)
})
it("profile source failure after erase keeps original error and emits no stale row", async () => {
	const { agentId } = await seed(),
		admission = await captureAdmissionToken({ db, prefix, agentId }),
		original = AbstractCursor.prototype.toArray,
		error = new Error("E123 profile source failed")
	let done = false
	vi.spyOn(AbstractCursor.prototype, "toArray").mockImplementation(
		async function (this: AbstractCursor) {
			if (!done && this.namespace.collection === `${prefix}structured_mem`) {
				done = true
				await erase(agentId)
				throw error
			}
			return original.call(this)
		},
	)
	await expect(invoke("profile", agentId, admission)).rejects.toBe(error)
	const gate = await readErasureGate({ db, prefix, agentId })
	await flush(agentId)
	expect(await rows(agentId)).toEqual({ telemetry: [], projection: [] })
	expect(await readErasureGate({ db, prefix, agentId })).toEqual(gate)
})
it("projection telemetry failure rolls back run and serial while preserving result", async () => {
	const { agentId } = await seed(),
		admission = await captureAdmissionToken({ db, prefix, agentId }),
		gate = await readErasureGate({ db, prefix, agentId }),
		original = Collection.prototype.insertOne
	vi.spyOn(Collection.prototype, "insertOne").mockImplementation(function (
		this: Collection,
		doc,
		...args
	) {
		if (this.collectionName === `${prefix}memory_telemetry`)
			return Promise.reject(new Error("E123 telemetry failure"))
		return original.call(this, doc, ...args)
	})
	expect(await invoke("discovery", agentId, admission)).toBeDefined()
	await flush(agentId)
	expect(await rows(agentId)).toEqual({ telemetry: [], projection: [] })
	expect(await readErasureGate({ db, prefix, agentId })).toEqual(gate)
})
it.each([
	false,
	true,
])("projection transaction replay keeps original admission erased=%s", async (erased) => {
	const { agentId } = await seed(),
		admission = await captureAdmissionToken({ db, prefix, agentId }),
		start = client.startSession.bind(client)
	let attempts = 0
	vi.spyOn(client, "startSession").mockImplementation((...args) => {
		const session = start(...args)
		if (session.explicit) {
			const commit = session.commitTransaction.bind(session)
			vi.spyOn(session, "commitTransaction").mockImplementation(
				async (...commitArgs) => {
					if (++attempts === 1) {
						await session.abortTransaction()
						if (erased) await erase(agentId)
						throw new MongoServerError({
							message: "E123 replay",
							code: 112,
							errorLabels: ["TransientTransactionError"],
						})
					}
					return commit(...commitArgs)
				},
			)
		}
		return session
	})
	expect(await invoke("discovery", agentId, admission)).toBeDefined()
	await flush(agentId)
	const actual = await rows(agentId),
		gate = await readErasureGate({ db, prefix, agentId })
	if (erased) {
		expect(actual).toEqual({ telemetry: [], projection: [] })
		expect(gate?.epoch).toBe(admission.epoch + 1)
	} else {
		expect(actual.projection).toHaveLength(1)
		expect(actual.telemetry).toHaveLength(1)
		expect(gate?.serial).toBe(1)
		expect(attempts).toBe(2)
	}
})
