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

function fakeClock(onSleep?: () => void) {
	let at = 0
	return {
		now: () => at,
		advance: (ms: number) => {
			at += ms
		},
		sleep: vi.fn(async (ms: number) => {
			at += ms
			onSleep?.()
		}),
	}
}

// Time passing between polls is what lets a staged update finish building, so
// the harness advances rollouts on every poll sleep unless a test opts out.
function harness(
	fake: FakeSearchDbOptions,
	extra?: Partial<BootContractOptions>,
	rollouts: "on-poll" | "manual" = "on-poll",
) {
	const { db, calls, indexes, advanceRollouts } = createFakeSearchDb(fake)
	const clock = fakeClock(rollouts === "on-poll" ? advanceRollouts : undefined)
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
	return { db, calls, indexes, clock, advanceRollouts, run }
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
		const { run } = harness(
			{
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
			},
			undefined,
			"manual",
		)
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

	// $listSearchIndexes documents no `type` field, and keyless atlas-local
	// omits it: CI run 39214244063 listed a fresh vectorSearch index named
	// chunks_text this way, and boot then tried updateSearchIndex on it.
	it("reads the type from the definition when the listing omits it", async () => {
		const { calls, run } = harness({
			indexes: withIndex("t_chunks_text", (entry) => ({
				name: entry.name,
				status: "PENDING",
				queryable: false,
				latestDefinition: {
					fields: [
						{
							type: "vector",
							path: "embedding",
							numDimensions: 4,
							similarity: "cosine",
						},
					],
				},
			})),
			updateError: () =>
				Object.assign(new Error('"fields" is required'), {
					code: 125,
					codeName: "CommandFailed",
				}),
		})
		const err = await bootError(run())
		expect(err.code).toBe("index-type-mismatch")
		expect(err.index).toBe("t_chunks_text")
		expect(writeCalls(calls)).toEqual([])
	})

	it("serves an untyped listing whose definition matches the manifest", async () => {
		const { calls, run } = harness({
			indexes: servingIndexes((entry) => {
				const { type: _omitted, ...untyped } = readyIndex(
					entry.name,
					entry.type,
					entry.definition,
				)
				return untyped as FakeSearchIndex
			}),
		})
		await expect(run()).resolves.toBeDefined()
		expect(writeCalls(calls)).toEqual([])
	})

	it("fails as unknown metadata when neither type nor definition is readable", async () => {
		const { calls, run } = harness({
			indexes: withIndex("t_chunks_text", (entry) => ({
				name: entry.name,
				status: "PENDING",
				queryable: false,
			})),
		})
		expect((await bootError(run())).code).toBe("index-metadata-unknown")
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
		expect(err.code).toBe("index-definition-rejected")
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

	it("types a definition the server rejects as rejected, not as management unavailable", async () => {
		const { run } = harness({
			indexes: withIndex("t_events_text", (entry) =>
				readyIndex(entry.name, entry.type, { mappings: { dynamic: true } }),
			),
			updateError: () =>
				Object.assign(new Error('"fields" is required'), {
					code: 125,
					codeName: "CommandFailed",
				}),
		})
		const err = await bootError(run())
		expect(err.code).toBe("index-definition-rejected")
		expect(err.index).toBe("t_events_text")
	})

	it("keeps search-management-unavailable for the management service error", async () => {
		const { run } = harness({
			indexes: {},
			createError: () =>
				new Error("Error connecting to Search Index Management service."),
		})
		expect((await bootError(run())).code).toBe("search-management-unavailable")
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

describe("enforceBootContract: host serving proof", () => {
	const READY_HOST = { status: "READY", queryable: true } as const

	it("refuses a READY host with neither a serving definition nor a definition version, beside latestDefinitionVersion", async () => {
		const { calls, clock, run } = harness({
			indexes: withIndex("t_chunks_text", (entry) => ({
				...readyIndex(entry.name, entry.type, entry.definition),
				latestDefinitionVersion: { version: 2 },
				statusDetail: [
					{ hostname: "shard-00", ...READY_HOST, mainIndex: { ...READY_HOST } },
				],
			})),
		})
		const err = await bootError(run())
		expect(err.code).toBe("index-metadata-unknown")
		expect(err.index).toBe("t_chunks_text")
		expect(err.message).toContain("neither a serving definition")
		expect(clock.sleep).not.toHaveBeenCalled()
		expect(writeCalls(calls)).toEqual([])
	})

	it("refuses a host that reports a generation when the listing has no latestDefinitionVersion to compare", async () => {
		const { run } = harness({
			indexes: withIndex("t_chunks_text", (entry) => ({
				...readyIndex(entry.name, entry.type, entry.definition),
				statusDetail: [
					{
						hostname: "shard-00",
						...READY_HOST,
						mainIndex: { ...READY_HOST, definitionVersion: { version: 1 } },
					},
				],
			})),
		})
		expect((await bootError(run())).code).toBe("index-metadata-unknown")
	})

	it("refuses when only one of several hosts lacks proof", async () => {
		const { run } = harness({
			indexes: withIndex("t_chunks_text", (entry) => ({
				...readyIndex(entry.name, entry.type, entry.definition),
				latestDefinitionVersion: { version: 2 },
				statusDetail: [
					{
						hostname: "shard-00",
						...READY_HOST,
						mainIndex: { ...READY_HOST, definitionVersion: { version: 2 } },
					},
					{ hostname: "shard-01", ...READY_HOST, mainIndex: { ...READY_HOST } },
				],
			})),
		})
		const err = await bootError(run())
		expect(err.code).toBe("index-metadata-unknown")
		expect(err.message).toContain("host 2")
		expect(err.message).not.toContain("shard-01")
	})

	it("refuses a statusDetail that is not a host list", async () => {
		const { run } = harness({
			indexes: withIndex("t_chunks_text", (entry) => ({
				...readyIndex(entry.name, entry.type, entry.definition),
				statusDetail: "READY",
			})),
		})
		expect((await bootError(run())).code).toBe("index-metadata-unknown")
	})

	it("serves when each host proves its generation or its definition", async () => {
		const { calls, run } = harness({
			indexes: withIndex("t_chunks_text", (entry) => ({
				...readyIndex(entry.name, entry.type, entry.definition),
				latestDefinitionVersion: { version: 2 },
				statusDetail: [
					{
						hostname: "shard-00",
						...READY_HOST,
						mainIndex: { ...READY_HOST, definitionVersion: { version: 2 } },
					},
					{
						hostname: "shard-01",
						...READY_HOST,
						mainIndex: { ...READY_HOST, definition: entry.definition },
					},
				],
			})),
		})
		await expect(run()).resolves.toBeDefined()
		expect(writeCalls(calls)).toEqual([])
	})

	it("still serves an index whose listing carries no statusDetail at all (atlas-local)", async () => {
		const { run } = harness({ indexes: servingIndexes() })
		await expect(run()).resolves.toBeDefined()
	})
})

describe("fake search db: an update is asynchronous", () => {
	function eventsText(): RequiredSearchIndex {
		const target = manifest().find((entry) => entry.name === "t_events_text")
		if (!target) throw new Error("manifest has no t_events_text")
		return target
	}

	it("keeps the old main generation and a staged build until the rollout advances", async () => {
		const target = eventsText()
		const { db, advanceRollouts } = createFakeSearchDb({
			indexes: {
				[target.collectionName]: [
					readyIndex(target.name, target.type, { mappings: { dynamic: true } }),
				],
			},
		})
		const events = db.collection(target.collectionName) as unknown as {
			updateSearchIndex: (name: string, definition: Document) => Promise<void>
			listSearchIndexes: (name: string) => {
				toArray: () => Promise<Document[]>
			}
		}
		await events.updateSearchIndex(target.name, target.definition)
		const [staged] = await events.listSearchIndexes(target.name).toArray()
		expect(staged.latestDefinition).toEqual(target.definition)
		expect(staged.statusDetail[0].mainIndex.definition).toEqual({
			mappings: { dynamic: true },
		})
		expect(staged.statusDetail[0].stagedIndex.status).toBe("BUILDING")

		expect(advanceRollouts()).toBe(1)
		const [advanced] = await events.listSearchIndexes(target.name).toArray()
		expect(advanced.statusDetail[0].mainIndex.definition).toEqual(
			target.definition,
		)
		expect(advanced.statusDetail[0].stagedIndex).toBeUndefined()
		expect(advanceRollouts()).toBe(0)
	})

	it("is not ready before the rollout advances: boot does not pass on the requested definition", async () => {
		const stuck = harness(
			{
				indexes: withIndex("t_events_text", (entry) =>
					readyIndex(entry.name, entry.type, { mappings: { dynamic: true } }),
				),
			},
			undefined,
			"manual",
		)
		const err = await bootError(stuck.run())
		expect(err.code).toBe("index-not-ready")
		expect(err.index).toBe("t_events_text")
		expect(err.message).toContain("still building the updated definition")
		expect(writeCalls(stuck.calls)).toEqual([
			{
				op: "updateSearchIndex",
				collection: "t_events",
				name: "t_events_text",
			},
		])
	})
})

describe("enforceBootContract: safe diagnostics", () => {
	const SENTINEL_PASSWORD = "s3cr3t-pass"
	const CREDENTIALED_URI = [
		"mongodb+srv://boot-user:",
		SENTINEL_PASSWORD,
		"@private-host.example.net/tenant-db?retryWrites=true",
	].join("")
	const BARE_URI = "mongodb://private-host.example.net:27017/tenant-db"
	const FORBIDDEN = [
		SENTINEL_PASSWORD,
		"private-host",
		"tenant-db",
		"mongodb://",
		"mongodb+srv://",
		"10.1.2.3",
		"memongo_test",
		"mongot-svc",
	]

	function driverFailure(text: string) {
		return Object.assign(new Error(text), {
			code: 6,
			codeName: "HostUnreachable",
		})
	}

	const hostileTexts = [
		`connection to ${CREDENTIALED_URI} failed`,
		`connection to ${BARE_URI} failed`,
		`connect ECONNREFUSED 10.1.2.3:27017 (${BARE_URI})`,
		"getaddrinfo ENOTFOUND private-host.example.net",
		`not authorized on tenant-db to execute command { aggregate: "x", uri: "${BARE_URI}" }`,
		"index memongo_test.t_chunks rejected by mongot-0.mongot-svc.example.internal",
		'{ createSearchIndexes: "t_chunks", $db: "memongo_test" } failed',
	]

	function serialized(err: MemongoBootError): string {
		return JSON.stringify({
			message: err.message,
			failures: err.failures,
			code: err.code,
			requirement: err.requirement,
			index: err.index,
			collection: err.collection,
			status: err.status,
			setting: err.setting,
		})
	}

	function expectNoLeak(text: string) {
		for (const forbidden of FORBIDDEN) expect(text).not.toContain(forbidden)
	}

	const surfaces: Array<[string, (text: string) => FakeSearchDbOptions]> = [
		["buildInfo", (text) => ({ buildInfoError: driverFailure(text) })],
		[
			"connectionStatus",
			(text) => ({ connectionStatusError: driverFailure(text) }),
		],
		[
			"$listSearchIndexes",
			(text) => ({ listError: () => driverFailure(text) }),
		],
		[
			"createSearchIndex",
			(text) => ({ indexes: {}, createError: () => driverFailure(text) }),
		],
		[
			"updateSearchIndex",
			(text) => ({
				indexes: withIndex("t_events_text", (entry) =>
					readyIndex(entry.name, entry.type, { mappings: { dynamic: true } }),
				),
				updateError: () => driverFailure(text),
			}),
		],
	]

	it.each(
		surfaces,
	)("never carries a URI, host, database or secret from a %s driver error", async (_surface, build) => {
		for (const text of hostileTexts) {
			const { run } = harness(build(text))
			const err = await bootError(run())
			expectNoLeak(serialized(err))
			expect(err.message).toContain("HostUnreachable")
		}
	})

	it("keeps the typed code, index and requirement on a rejected definition", async () => {
		const { run } = harness({
			indexes: {},
			createError: () => driverFailure(`rejected ${CREDENTIALED_URI}`),
		})
		const err = await bootError(run())
		expect(err.code).toBe("index-definition-rejected")
		expect(err.index).toBeDefined()
		expect(err.collection).toBeDefined()
		expect(err.requirement).toBe("a definition the deployment accepts")
	})

	it("shows the server's wording about a refused definition, scrubbed, and only there", async () => {
		const wording = "Omit quantization to use the default (float)"
		const { run } = harness({
			indexes: {},
			createError: () =>
				driverFailure(
					`${wording} for memongo_test.t_chunks via ${BARE_URI} on 10.1.2.3:27017`,
				),
		})
		const err = await bootError(run())
		expect(err.code).toBe("index-definition-rejected")
		expect(err.message).toContain(wording)
		expectNoLeak(serialized(err))

		const privilege = await bootError(
			harness({
				indexes: {},
				createError: () =>
					Object.assign(new Error(`not authorized: ${wording}`), {
						code: 13,
						codeName: "Unauthorized",
					}),
			}).run(),
		)
		expect(privilege.code).toBe("search-privileges-denied")
		expect(privilege.message).not.toContain(wording)
	})

	it("scrubs a URI out of any typed boot error message and field, wherever it came from", () => {
		const err = new MemongoBootError(
			{
				code: "config-invalid",
				requirement: `valid ${BARE_URI}`,
				setting: CREDENTIALED_URI,
				index: BARE_URI,
				collection: BARE_URI,
				status: BARE_URI,
			},
			`boot refused: ${CREDENTIALED_URI} and ${BARE_URI}`,
		)
		expectNoLeak(serialized(err))
	})

	it("never echoes a provider-reported status, type or host name", async () => {
		const hostile = `STATUS-${BARE_URI}`
		const { run } = harness({
			indexes: withIndex("t_events_text", (entry) => ({
				...readyIndex(entry.name, entry.type, entry.definition),
				status: hostile,
				type: hostile,
			})),
		})
		expectNoLeak(serialized(await bootError(run())))
		const { run: hostRun } = harness({
			indexes: withIndex("t_events_text", (entry) => ({
				...readyIndex(entry.name, entry.type, entry.definition),
				statusDetail: [
					{
						hostname: "private-host.example.net:27017",
						status: "READY",
						queryable: true,
					},
				],
			})),
		})
		expectNoLeak(serialized(await bootError(hostRun())))
	})

	it("writes no URI, host, database or secret to the logs, on a repaired boot or a failed one", async () => {
		const previous = process.env.MEMONGO_LOG_LEVEL
		process.env.MEMONGO_LOG_LEVEL = "debug"
		const sinks = (["log", "info", "warn", "error", "debug"] as const).map(
			(method) => vi.spyOn(console, method).mockImplementation(() => {}),
		)
		try {
			await harness({ indexes: {} }).run()
			await harness({
				indexes: {},
				createError: () => driverFailure(`rejected ${CREDENTIALED_URI}`),
			})
				.run()
				.catch(() => undefined)
			const logged = sinks
				.flatMap((sink) => sink.mock.calls)
				.map((args) => args.join(" "))
				.join("\n")
			expect(logged).toContain("created")
			expectNoLeak(logged)
		} finally {
			for (const sink of sinks) sink.mockRestore()
			if (previous === undefined) delete process.env.MEMONGO_LOG_LEVEL
			else process.env.MEMONGO_LOG_LEVEL = previous
		}
	})
})
