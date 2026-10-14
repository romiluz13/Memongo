import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { main, readRuntimeInputs } from "./check-mongodb-runtime-parity.js"

// Drives the real parity main with an injected fake client, capturing the
// constructor URI, database and the collections whose Search indexes it lists
// (which proves the prefix in use). Env is test-scoped with synthetic values;
// fetch is stubbed to count any call.
const dirs: string[] = []
afterEach(() => {
	vi.unstubAllEnvs()
	vi.unstubAllGlobals()
	for (const dir of dirs.splice(0))
		fs.rmSync(dir, { recursive: true, force: true })
})

function useEnv(env: Record<string, string>, file: unknown = {}) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "memongo-parity-"))
	dirs.push(dir)
	const configPath = path.join(dir, "memongo.json")
	fs.writeFileSync(configPath, JSON.stringify(file))
	for (const name of Object.keys(process.env))
		if (/^(MEMONGO_|MDB_)/.test(name)) vi.stubEnv(name, undefined)
	vi.stubEnv("HOME", dir)
	vi.stubEnv("MEMONGO_CONFIG_PATH", configPath)
	for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value)
}

function harness(argv: string[] = []) {
	const clients: { uri: string; dbs: string[]; collections: string[] }[] = []
	const fetchFn = vi.fn(async () => new Response("{}"))
	vi.stubGlobal("fetch", fetchFn)
	const out: string[] = []
	const err: string[] = []
	const createClient = (uri: string) => {
		const seen = { uri, dbs: [] as string[], collections: [] as string[] }
		clients.push(seen)
		return {
			connect: async () => undefined,
			close: async () => undefined,
			db: (name: string) => {
				seen.dbs.push(name)
				return {
					admin: () => ({
						command: async () => ({
							version: "8.2.0",
							versionArray: [8, 2, 0],
						}),
					}),
					collection: (collectionName: string) => {
						seen.collections.push(collectionName)
						return {
							listSearchIndexes: () => ({ toArray: async () => [] }),
							aggregate: () => ({ toArray: async () => [] }),
						}
					},
				}
			},
		}
	}
	const run = () =>
		main({
			argv,
			createClient: createClient as never,
			stdout: (text) => out.push(text),
			stderr: (text) => err.push(text),
		})
	return { clients, fetchFn, out, err, run }
}

const FORCE = "mongodb://force.invalid:27017"
const ENV_URI = "mongodb://env.invalid:27017"
const FILE_URI = "mongodb://file.invalid:27017"
const CLOUD = "mongodb+srv://cloud.mongodb.net"
const LOCAL = "mongodb://local.invalid:27017"

describe("mongodb:parity active arm", () => {
	it("inspects the runner's target: FORCE URI, configured database and prefix", async () => {
		useEnv({
			MEMONGO_MONGODB_URI: ENV_URI,
			MEMONGO_FORCE_MONGODB_URI: FORCE,
			MEMONGO_MONGODB_DATABASE: "benchdb",
			MEMONGO_MONGODB_COLLECTION_PREFIX: "memongo_bench_x_",
		})
		const h = harness()
		expect(await h.run()).toBe(1)
		expect(h.clients.map((c) => c.uri)).toEqual([FORCE])
		expect(h.clients[0]?.dbs).toEqual(["benchdb"])
		expect(h.clients[0]?.collections.length).toBeGreaterThan(0)
		for (const name of h.clients[0]?.collections ?? [])
			expect(name.startsWith("memongo_bench_x_")).toBe(true)
		expect(h.out.join("\n")).toContain(
			"- active profile=atlas-local-preview db=benchdb",
		)
		expect(h.fetchFn).not.toHaveBeenCalled()
	})

	it("defaults to the application prefix memongo_ and database memongo", () => {
		useEnv({ MEMONGO_MONGODB_URI: ENV_URI })
		expect(readRuntimeInputs()).toEqual([
			{
				name: "active",
				uri: ENV_URI,
				profile: "atlas-local-preview",
				database: "memongo",
				prefix: "memongo_",
			},
		])
	})

	it("uses the config-file target when the env sets no URI", () => {
		useEnv(
			{},
			{
				memory: {
					mongodb: {
						uri: FILE_URI,
						database: "filedb",
						collectionPrefix: "file_",
					},
				},
			},
		)
		expect(readRuntimeInputs()).toMatchObject([
			{ name: "active", uri: FILE_URI, database: "filedb", prefix: "file_" },
		])
	})

	it("accepts MEMONGO_PARITY_* values equal to the configured target", () => {
		useEnv({
			MEMONGO_MONGODB_URI: ENV_URI,
			MEMONGO_PARITY_DATABASE: "memongo",
			MEMONGO_PARITY_COLLECTION_PREFIX: "memongo_",
		})
		expect(readRuntimeInputs()).toMatchObject([
			{ database: "memongo", prefix: "memongo_" },
		])
	})

	it.each([
		["MEMONGO_PARITY_DATABASE", "otherdb"],
		["MEMONGO_PARITY_COLLECTION_PREFIX", "memongo_default_"],
	])("refuses a differing %s, then inspects the target after the fix", async (name, value) => {
		useEnv({ MEMONGO_FORCE_MONGODB_URI: FORCE, [name]: value })
		const refused = harness()
		expect(await refused.run()).toBe(1)
		expect(refused.clients).toEqual([])
		expect(refused.fetchFn).not.toHaveBeenCalled()
		expect(refused.out).toEqual([])
		const text = refused.err.join("\n")
		expect(text).toContain(
			`${name} applies only to explicit cloud/local arms and differs from the configured target. Unset it, or set MEMONGO_CLOUD_MONGODB_URI/MEMONGO_LOCAL_MONGODB_URI for an explicit comparison.`,
		)
		for (const secret of [FORCE, "force.invalid", value])
			expect(text).not.toContain(secret)

		vi.stubEnv(name, undefined)
		const rerun = harness()
		await rerun.run()
		expect(rerun.clients.map((c) => c.uri)).toEqual([FORCE])
		expect(rerun.clients[0]?.dbs).toEqual(["memongo"])
	})

	it("fails closed on a missing configured URI before any client", async () => {
		useEnv({})
		const h = harness()
		await expect(h.run()).rejects.toThrow(/MongoDB URI required/)
		expect(h.clients).toEqual([])
	})
})

describe("mongodb:parity explicit arms", () => {
	it("keep their own defaults and never take the FORCE URI or configured target", async () => {
		useEnv({
			MEMONGO_CLOUD_MONGODB_URI: CLOUD,
			MEMONGO_LOCAL_MONGODB_URI: LOCAL,
			MEMONGO_FORCE_MONGODB_URI: FORCE,
			MEMONGO_MONGODB_DATABASE: "benchdb",
			MEMONGO_MONGODB_COLLECTION_PREFIX: "memongo_bench_x_",
		})
		const h = harness()
		await h.run()
		expect(h.clients.map((c) => c.uri).sort()).toEqual([CLOUD, LOCAL].sort())
		for (const client of h.clients) {
			expect(client.dbs).toEqual(["memongo"])
			for (const name of client.collections)
				expect(name.startsWith("memongo_default_")).toBe(true)
		}
	})

	it("use MEMONGO_PARITY_DATABASE and MEMONGO_PARITY_COLLECTION_PREFIX", () => {
		useEnv({
			MEMONGO_LOCAL_MONGODB_URI: LOCAL,
			MEMONGO_PARITY_DATABASE: "paritydb",
			MEMONGO_PARITY_COLLECTION_PREFIX: "parity_",
		})
		expect(readRuntimeInputs()).toEqual([
			{
				name: "local",
				uri: LOCAL,
				profile: "atlas-local-preview",
				database: "paritydb",
				prefix: "parity_",
			},
		])
	})

	it("do not read the application config file", () => {
		useEnv({ MEMONGO_CLOUD_MONGODB_URI: CLOUD })
		vi.stubEnv(
			"MEMONGO_CONFIG_PATH",
			path.join(os.tmpdir(), "memongo-parity-missing", "memongo.json"),
		)
		expect(readRuntimeInputs()).toMatchObject([
			{ name: "cloud", uri: CLOUD, profile: "atlas-managed" },
		])
	})
})
