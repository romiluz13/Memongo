import type { Document } from "mongodb"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
	type BootContractOptions,
	enforceBootContract,
} from "./mongodb-boot-contract.js"
import { MemongoBootError } from "./mongodb-boot-errors.js"
import {
	type RequiredSearchIndex,
	buildRequiredIndexManifest,
} from "./mongodb-required-index-manifest.js"
import {
	type FakeSearchDbOptions,
	type FakeSearchIndex,
	createFakeSearchDb,
	embeddingQueries,
	readyIndex,
	writeCalls,
} from "./test-helpers/fake-search-db.js"

const PREFIX = "t_"
const ENV = {} as NodeJS.ProcessEnv

function manifest(): RequiredSearchIndex[] {
	return buildRequiredIndexManifest({
		prefix: PREFIX,
		serverVersionArray: [8, 3, 0, 0],
		env: ENV,
	})
}

function servingIndexes(
	override?: (entry: RequiredSearchIndex) => FakeSearchIndex | null | undefined,
): Record<string, FakeSearchIndex[]> {
	const byCollection: Record<string, FakeSearchIndex[]> = {}
	for (const entry of manifest()) {
		const overridden = override?.(entry)
		if (overridden === null) continue
		const index =
			overridden ?? readyIndex(entry.name, entry.type, entry.definition)
		byCollection[entry.collectionName] = [
			...(byCollection[entry.collectionName] ?? []),
			index,
		]
	}
	return byCollection
}

function withIndex(
	name: string,
	build: (entry: RequiredSearchIndex) => FakeSearchIndex | null,
): Record<string, FakeSearchIndex[]> {
	return servingIndexes((entry) =>
		entry.name === name ? build(entry) : undefined,
	)
}

function fakeClock() {
	let at = 0
	return {
		now: () => at,
		sleep: vi.fn(async (ms: number) => {
			at += ms
		}),
	}
}

function harness(
	fake: FakeSearchDbOptions,
	extra?: Partial<BootContractOptions>,
) {
	const { db, calls, indexes } = createFakeSearchDb(fake)
	const clock = fakeClock()
	const run = () =>
		enforceBootContract(db, {
			prefix: PREFIX,
			env: ENV,
			mode: "repair",
			deadlineMs: 5_000,
			pollMs: 1_000,
			now: clock.now,
			sleep: clock.sleep,
			...extra,
		})
	return { db, calls, indexes, clock, run }
}

async function bootError(promise: Promise<unknown>): Promise<MemongoBootError> {
	const err = await promise.then(
		() => undefined,
		(error: unknown) => error,
	)
	expect(err).toBeInstanceOf(MemongoBootError)
	return err as MemongoBootError
}

const fetchSpy = vi.fn()
beforeEach(() => {
	fetchSpy.mockReset()
	vi.stubGlobal("fetch", fetchSpy)
})
afterEach(() => {
	vi.unstubAllGlobals()
})

describe("enforceBootContract: serving manifest", () => {
	it("resolves with no write when every manifest index is READY, queryable and serving its definition", async () => {
		const { calls, run } = harness({ indexes: servingIndexes() })
		const result = await run()
		expect(result.serverVersion).toEqual([8, 3, 0, 0])
		expect(result.manifest.map((entry) => entry.name)).toContain(
			"t_chunks_vector",
		)
		expect(writeCalls(calls)).toEqual([])
	})

	it("tolerates server-added defaults in the serving definition", async () => {
		const { run } = harness({
			indexes: withIndex("t_chunks_text", (entry) =>
				readyIndex(entry.name, entry.type, {
					...entry.definition,
					analyzer: "lucene.standard",
					searchAnalyzer: "lucene.standard",
				}),
			),
		})
		await expect(run()).resolves.toBeDefined()
	})
})

describe("enforceBootContract: server version", () => {
	it("refuses MongoDB below 8.3", async () => {
		const { calls, run } = harness({ versionArray: [8, 2, 6, 0] })
		const err = await bootError(run())
		expect(err.code).toBe("server-version-unsupported")
		expect(err.message).toContain("MongoDB 8.2.6 is unsupported")
		expect(writeCalls(calls)).toEqual([])
	})

	it("refuses when buildInfo fails instead of assuming a version", async () => {
		const { run } = harness({
			buildInfoError: Object.assign(new Error("not authorized on admin"), {
				code: 13,
				codeName: "Unauthorized",
			}),
		})
		expect((await bootError(run())).code).toBe("server-version-unreadable")
	})

	it("refuses when buildInfo has no readable versionArray", async () => {
		const { run } = harness({ versionArray: "8.3" })
		expect((await bootError(run())).code).toBe("server-version-unreadable")
	})
})

describe("enforceBootContract: Search management and privileges", () => {
	it("fails typed when the deployment has no Search", async () => {
		const { calls, run } = harness({
			listError: () =>
				Object.assign(
					new Error("Error connecting to Search Index Management service."),
					{ code: 125, codeName: "CommandFailed" },
				),
		})
		const err = await bootError(run())
		expect(err.code).toBe("search-management-unavailable")
		expect(writeCalls(calls)).toEqual([])
	})

	it("fails fast when connectionStatus shows the search management privileges are missing", async () => {
		const { calls, clock, run } = harness({
			indexes: servingIndexes(),
			connectionStatus: {
				authInfo: {
					authenticatedUsers: [{ user: "reader", db: "admin" }],
					authenticatedUserPrivileges: [
						{
							resource: { db: "memongo_test", collection: "" },
							actions: ["find", "listSearchIndexes"],
						},
					],
				},
			},
		})
		const err = await bootError(run())
		expect(err.code).toBe("search-privileges-denied")
		expect(err.failures.map((failure) => failure.requirement)).toContain(
			"createSearchIndexes privilege",
		)
		expect(err.failures.map((failure) => failure.requirement)).toContain(
			"updateSearchIndex privilege",
		)
		expect(clock.sleep).not.toHaveBeenCalled()
		expect(writeCalls(calls)).toEqual([])
	})

	it("passes the privilege check when readWrite covers the database", async () => {
		const { run } = harness({
			indexes: servingIndexes(),
			connectionStatus: {
				authInfo: {
					authenticatedUsers: [{ user: "app", db: "admin" }],
					authenticatedUserPrivileges: [
						{
							resource: { db: "memongo_test", collection: "" },
							actions: [
								"listSearchIndexes",
								"createSearchIndexes",
								"updateSearchIndex",
							],
						},
					],
				},
			},
		})
		await expect(run()).resolves.toBeDefined()
	})

	it("fails typed when $listSearchIndexes is denied", async () => {
		const { run } = harness({
			listError: () =>
				Object.assign(new Error("not authorized on memongo_test"), {
					code: 13,
					codeName: "Unauthorized",
				}),
		})
		expect((await bootError(run())).code).toBe("search-privileges-denied")
	})

	it("fails typed when connectionStatus returns no authInfo", async () => {
		const { run } = harness({ connectionStatus: { ok: 1 } })
		expect((await bootError(run())).code).toBe("index-metadata-unknown")
	})
})

describe("enforceBootContract: index states", () => {
	it("fails fast on a FAILED index without waiting for the deadline", async () => {
		const { clock, run } = harness({
			indexes: withIndex("t_events_vector", (entry) => ({
				...readyIndex(entry.name, entry.type, entry.definition),
				status: "FAILED",
				queryable: false,
			})),
		})
		const err = await bootError(run())
		expect(err.code).toBe("index-failed")
		expect(err.index).toBe("t_events_vector")
		expect(err.collection).toBe("t_events")
		expect(clock.sleep).not.toHaveBeenCalled()
	})

	it("fails fast on a STALE index", async () => {
		const { clock, run } = harness({
			indexes: withIndex("t_chunks_text", (entry) => ({
				...readyIndex(entry.name, entry.type, entry.definition),
				status: "STALE",
				queryable: true,
			})),
		})
		const err = await bootError(run())
		expect(err.code).toBe("index-stale")
		expect(clock.sleep).not.toHaveBeenCalled()
	})

	it("fails fast when one host reports STALE behind a READY summary", async () => {
		const { run } = harness({
			indexes: withIndex("t_chunks_text", (entry) => ({
				...readyIndex(entry.name, entry.type, entry.definition),
				statusDetail: [
					{
						hostname: "shard-00",
						status: "STALE",
						queryable: true,
						mainIndex: {
							status: "STALE",
							queryable: true,
							definition: entry.definition,
						},
					},
				],
			})),
		})
		expect((await bootError(run())).code).toBe("index-stale")
	})

	it("fails at the deadline when an index is still BUILDING, naming the index", async () => {
		const { clock, run } = harness({
			indexes: withIndex("t_procedures_vector", (entry) => ({
				...readyIndex(entry.name, entry.type, entry.definition),
				status: "BUILDING",
				queryable: false,
			})),
		})
		const err = await bootError(run())
		expect(err.code).toBe("index-not-ready")
		expect(err.index).toBe("t_procedures_vector")
		expect(err.status).toBe("BUILDING")
		expect(err.message).toContain("5 s readiness deadline")
		expect(clock.sleep.mock.calls.length).toBeGreaterThanOrEqual(4)
		expect(clock.now()).toBeLessThanOrEqual(5_000)
	})

	it("does not accept a pending latestDefinition: a host still serving an older generation is not ready", async () => {
		const { run } = harness({
			indexes: withIndex("t_chunks_text", (entry) => ({
				...readyIndex(entry.name, entry.type, entry.definition),
				latestDefinitionVersion: { version: 2 },
				statusDetail: [
					{
						hostname: "shard-00",
						status: "READY",
						queryable: true,
						mainIndex: {
							status: "READY",
							queryable: true,
							definitionVersion: { version: 1 },
							definition: entry.definition,
						},
					},
				],
			})),
		})
		const err = await bootError(run())
		expect(err.code).toBe("index-not-ready")
		expect(err.message).toContain("serves definition version 1, not 2")
	})

	it("does not accept a staged index still building the updated definition", async () => {
		const { run } = harness({
			indexes: withIndex("t_chunks_text", (entry) => ({
				...readyIndex(entry.name, entry.type, entry.definition),
				statusDetail: [
					{
						hostname: "shard-00",
						status: "READY",
						queryable: true,
						mainIndex: {
							status: "READY",
							queryable: true,
							definition: entry.definition,
						},
						stagedIndex: {
							status: "BUILDING",
							queryable: false,
							definition: entry.definition,
						},
					},
				],
			})),
		})
		const err = await bootError(run())
		expect(err.code).toBe("index-not-ready")
		expect(err.message).toContain("still building the updated definition")
	})

	it("does not trust a matching latestDefinition when the host serves a definition without autoEmbed", async () => {
		const hostServesPlainVector = (entry: RequiredSearchIndex) => ({
			...readyIndex(entry.name, entry.type, entry.definition),
			statusDetail: [
				{
					hostname: "shard-00",
					status: "READY",
					queryable: true,
					mainIndex: {
						status: "READY",
						queryable: true,
						definition: {
							fields: [{ type: "vector", path: "embedding" }],
						},
					},
				},
			],
		})
		const verify = harness(
			{ indexes: withIndex("t_chunks_vector", hostServesPlainVector) },
			{ mode: "verify" },
		)
		const err = await bootError(verify.run())
		expect(err.code).toBe("autoembed-unavailable")
		expect(err.index).toBe("t_chunks_vector")

		const repair = harness({
			indexes: withIndex("t_chunks_vector", hostServesPlainVector),
		})
		await expect(repair.run()).resolves.toBeDefined()
		expect(writeCalls(repair.calls)).toEqual([
			{
				op: "updateSearchIndex",
				collection: "t_chunks",
				name: "t_chunks_vector",
			},
		])
	})

	it.each([
		["an undocumented status", { status: "ACTIVE", queryable: true }],
		["READY without queryable", { status: "READY", queryable: undefined }],
		["READY reported not queryable", { status: "READY", queryable: false }],
	] as const)("treats %s as unknown metadata", async (_name, patch) => {
		const { clock, run } = harness({
			indexes: withIndex("t_events_text", (entry) => ({
				...readyIndex(entry.name, entry.type, entry.definition),
				...patch,
			})),
		})
		const err = await bootError(run())
		expect(err.code).toBe("index-metadata-unknown")
		expect(err.index).toBe("t_events_text")
		expect(clock.sleep).not.toHaveBeenCalled()
	})

	it("treats a host without mainIndex metadata as unknown", async () => {
		const { run } = harness({
			indexes: withIndex("t_events_text", (entry) => ({
				...readyIndex(entry.name, entry.type, entry.definition),
				statusDetail: [
					{ hostname: "shard-00", status: "READY", queryable: true },
				],
			})),
		})
		expect((await bootError(run())).code).toBe("index-metadata-unknown")
	})

	it("treats a host generation newer than latestDefinitionVersion as unknown", async () => {
		const { run } = harness({
			indexes: withIndex("t_events_text", (entry) => ({
				...readyIndex(entry.name, entry.type, entry.definition),
				latestDefinitionVersion: { version: 1 },
				statusDetail: [
					{
						hostname: "shard-00",
						mainIndex: {
							status: "READY",
							queryable: true,
							definitionVersion: { version: 3 },
							definition: entry.definition,
						},
					},
				],
			})),
		})
		expect((await bootError(run())).code).toBe("index-metadata-unknown")
	})

	it("refuses an index of the wrong type and never drops it", async () => {
		const { calls, run } = harness({
			indexes: withIndex("t_chunks_vector", (entry) => ({
				...readyIndex(entry.name, "search", { mappings: { dynamic: true } }),
			})),
		})
		const err = await bootError(run())
		expect(err.code).toBe("index-type-mismatch")
		expect(writeCalls(calls)).toEqual([])
	})
})

describe("enforceBootContract: repair", () => {
	it("fails on a terminal index before writing any repair", async () => {
		const failedOnly = servingIndexes((entry) =>
			entry.name === "t_events_text"
				? {
						...readyIndex(entry.name, entry.type, entry.definition),
						status: "FAILED",
					}
				: null,
		)
		const { calls, run } = harness({ indexes: failedOnly })
		expect((await bootError(run())).code).toBe("index-failed")
		expect(writeCalls(calls)).toEqual([])
	})

	it("classifies keyless atlas-local's model refusal as autoembed-unavailable", async () => {
		const { run } = harness({
			indexes: withIndex("t_chunks_vector", () => null),
			createError: () =>
				Object.assign(
					new Error(
						"CanonicalModel: voyage-4-large not registered yet, supported models are: []",
					),
					{ code: 8, codeName: "UnknownError" },
				),
		})
		const err = await bootError(run())
		expect(err.code).toBe("autoembed-unavailable")
		expect(err.index).toBe("t_chunks_vector")
	})

	it("creates every absent manifest index and boots once they are serving", async () => {
		const { calls, run } = harness({ indexes: {} })
		await expect(run()).resolves.toBeDefined()
		const created = writeCalls(calls).map((call) =>
			call.op === "createSearchIndex" ? call.name : call.op,
		)
		expect(created.sort()).toEqual(
			manifest()
				.map((entry) => entry.name)
				.sort(),
		)
	})

	it("updates a drifted definition in place and never drops", async () => {
		const { calls, run } = harness({
			indexes: withIndex("t_events_vector", (entry) =>
				readyIndex(entry.name, entry.type, {
					fields: [
						(entry.definition.fields as Document[])[0],
						{ type: "filter", path: "agentId" },
					],
				}),
			),
		})
		await expect(run()).resolves.toBeDefined()
		expect(writeCalls(calls)).toEqual([
			{
				op: "updateSearchIndex",
				collection: "t_events",
				name: "t_events_vector",
			},
		])
	})

	it("boots after a repaired index finishes building within the deadline", async () => {
		let listings = 0
		const { run } = harness({
			indexes: {},
			onCreate: (_collection, description) => ({
				...readyIndex(
					description.name,
					description.type,
					description.definition,
				),
				get status() {
					listings += 1
					return listings > 40 ? "READY" : "BUILDING"
				},
				queryable: true,
			}),
		})
		await expect(run()).resolves.toBeDefined()
	})

	it("fails typed with index-absent when an index is still absent after repair", async () => {
		const { calls, run } = harness({
			indexes: withIndex("t_kb_chunks_text", () => null),
			onCreate: (_collection, description) =>
				description.name === "t_kb_chunks_text"
					? undefined
					: readyIndex(
							description.name,
							description.type,
							description.definition,
						),
		})
		const err = await bootError(run())
		expect(err.code).toBe("index-absent")
		expect(err.index).toBe("t_kb_chunks_text")
		expect(writeCalls(calls)).toContainEqual({
			op: "createSearchIndex",
			collection: "t_kb_chunks",
			name: "t_kb_chunks_text",
		})
	})

	it("fails typed when the create command is rejected", async () => {
		const { run } = harness({
			indexes: withIndex("t_kb_chunks_text", () => null),
			createError: () =>
				Object.assign(new Error("Search index creation failed: internal"), {
					code: 1,
					codeName: "InternalError",
				}),
		})
		const err = await bootError(run())
		expect(err.code).toBe("search-management-unavailable")
		expect(err.index).toBe("t_kb_chunks_text")
	})

	it("fails typed as autoembed-unavailable when the deployment rejects the autoEmbed definition", async () => {
		const { run } = harness({
			indexes: withIndex("t_chunks_vector", () => null),
			createError: () =>
				Object.assign(
					new Error(
						'"fields[0].type" must be one of [vector, filter], got autoEmbed',
					),
					{
						code: 9,
						codeName: "FailedToParse",
					},
				),
		})
		const err = await bootError(run())
		expect(err.code).toBe("autoembed-unavailable")
		expect(err.index).toBe("t_chunks_vector")
	})

	it("fails typed when the update command is denied", async () => {
		const { run } = harness({
			indexes: withIndex("t_events_text", (entry) =>
				readyIndex(entry.name, entry.type, { mappings: { dynamic: true } }),
			),
			updateError: () =>
				Object.assign(new Error("not authorized to updateSearchIndex"), {
					code: 13,
					codeName: "Unauthorized",
				}),
		})
		expect((await bootError(run())).code).toBe("search-privileges-denied")
	})

	it("runs beforeRepair before any write and stops on its failure", async () => {
		const { calls, run } = harness(
			{ indexes: {} },
			{
				beforeRepair: async () => {
					throw new Error("model changed: refusing to strand documents")
				},
			},
		)
		await expect(run()).rejects.toThrow("refusing to strand documents")
		expect(writeCalls(calls)).toEqual([])
	})

	it("never issues a drop, whatever it finds", async () => {
		for (const fake of [
			{ indexes: {} },
			{
				indexes: withIndex("t_chunks_vector", (entry) =>
					readyIndex(entry.name, "search", {}),
				),
			},
			{
				indexes: withIndex("t_chunks_text", (entry) =>
					readyIndex(entry.name, entry.type, { mappings: { dynamic: true } }),
				),
			},
		]) {
			const { calls, run } = harness(fake)
			await run().catch(() => undefined)
			expect(calls.some((call) => call.op === "dropSearchIndex")).toBe(false)
		}
	})
})

describe("enforceBootContract: no paid call", () => {
	it("issues no $vectorSearch and no provider request in any boot outcome", async () => {
		for (const fake of [
			{ indexes: {} },
			{ indexes: servingIndexes() },
			{ versionArray: [8, 0, 0] },
			{
				indexes: withIndex("t_chunks_vector", (entry) => ({
					...readyIndex(entry.name, entry.type, entry.definition),
					status: "BUILDING",
				})),
			},
		]) {
			const { calls, run } = harness(fake)
			await run().catch(() => undefined)
			expect(embeddingQueries(calls)).toEqual([])
		}
		expect(fetchSpy).not.toHaveBeenCalled()
	})
})

describe("enforceBootContract: safe diagnostics", () => {
	it("never carries a connection string or credential from a driver error", async () => {
		const uri = [
			"mongodb+srv://boot-user:",
			"s3cr3t-pass",
			"@cluster0.example.net",
		].join("")
		const { run } = harness({
			listError: () =>
				Object.assign(new Error(`connection to ${uri} failed`), {
					code: 6,
					codeName: "HostUnreachable",
				}),
		})
		const err = await bootError(run())
		expect(err.message).not.toContain("s3cr3t-pass")
		expect(JSON.stringify(err.failures)).not.toContain("s3cr3t-pass")
	})
})
