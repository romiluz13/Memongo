import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { main } from "./mongodb-cluster-preflight.js"

// Drives the real preflight main with an injected fake client and fetch, so
// tests see the exact constructor URI, database and collection-prefix use
// without any socket. Env is test-scoped (vi.stubEnv) with synthetic values.
const dirs: string[] = []
afterEach(() => {
	vi.unstubAllEnvs()
	for (const dir of dirs.splice(0))
		fs.rmSync(dir, { recursive: true, force: true })
})

const SYNTHETIC_REQUIRED = {
	VOYAGE_API_KEY: "al-synthetic",
	MEMONGO_LLM_BASE_URL: "https://llm.invalid",
	MEMONGO_LLM_API_KEY: "synthetic-llm-key",
	MEMONGO_LLM_MODEL: "synthetic-model",
}

function useEnv(env: Record<string, string>, file: unknown = {}) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "memongo-preflight-"))
	dirs.push(dir)
	const configPath = path.join(dir, "memongo.json")
	fs.writeFileSync(configPath, JSON.stringify(file))
	for (const name of Object.keys(process.env))
		if (/^(MEMONGO_|VOYAGE_|MDB_)/.test(name)) vi.stubEnv(name, undefined)
	vi.stubEnv("HOME", dir)
	vi.stubEnv("MEMONGO_CONFIG_PATH", configPath)
	for (const [name, value] of Object.entries({ ...SYNTHETIC_REQUIRED, ...env }))
		vi.stubEnv(name, value)
}

function harness(argv: string[] = [], collections: string[] = []) {
	const calls = {
		uris: [] as string[],
		dbs: [] as string[],
		listCollections: 0,
		fetches: 0,
		closes: 0,
	}
	const out: string[] = []
	const err: string[] = []
	const createClient = (uri: string) => {
		calls.uris.push(uri)
		return {
			connect: async () => undefined,
			close: async () => {
				calls.closes += 1
			},
			db: (name: string) => {
				calls.dbs.push(name)
				return {
					listCollections: () => {
						calls.listCollections += 1
						return {
							toArray: async () => collections.map((name) => ({ name })),
						}
					},
					aggregate: () => ({ toArray: async () => [] }),
				}
			},
		}
	}
	const fetchFn = async () => {
		calls.fetches += 1
		return new Response("{}", { status: 200 })
	}
	const run = () =>
		main({
			argv,
			createClient: createClient as never,
			fetchFn: fetchFn as never,
			stdout: (text) => out.push(text),
			stderr: (text) => err.push(text),
		})
	return { calls, out, err, run }
}

const FORCE = "mongodb://force.invalid:27017"
const ENV_URI = "mongodb://env.invalid:27017"
const FILE_URI = "mongodb://file.invalid:27017"
const BENCH = "memongo_bench_lane_20261014_a_"

describe("mongodb:cluster-preflight target", () => {
	it("inspects the runner's target: FORCE URI, configured database and prefix", async () => {
		useEnv({
			MEMONGO_MONGODB_URI: ENV_URI,
			MEMONGO_FORCE_MONGODB_URI: FORCE,
			MEMONGO_MONGODB_DATABASE: "benchdb",
			MEMONGO_MONGODB_COLLECTION_PREFIX: BENCH,
		})
		const h = harness([], [`${BENCH}memories`, "other"])
		expect(await h.run()).toBe(1)
		expect(h.calls.uris).toEqual([FORCE])
		expect(h.calls.dbs).toEqual(["benchdb", "admin"])
		expect(h.out.join("\n")).toContain("db=benchdb")
		expect(h.out.join("\n")).toContain(`prefix=${BENCH}`)
		expect(h.out.join("\n")).toContain("matchingPrefix=1")
		expect(h.calls.closes).toBe(1)
	})

	it("uses the config-file URI, database and prefix when the env sets none", async () => {
		useEnv(
			{},
			{
				memory: {
					mongodb: {
						uri: FILE_URI,
						database: "filedb",
						collectionPrefix: BENCH,
					},
				},
			},
		)
		const h = harness()
		await h.run()
		expect(h.calls.uris).toEqual([FILE_URI])
		expect(h.calls.dbs[0]).toBe("filedb")
	})

	it("passes on an empty configured namespace with every required input", async () => {
		useEnv({
			MEMONGO_MONGODB_URI: ENV_URI,
			MEMONGO_MONGODB_COLLECTION_PREFIX: BENCH,
		})
		const h = harness(["--verify-atlas-model-key"])
		expect(await h.run()).toBe(0)
		expect(h.calls.uris).toEqual([ENV_URI])
		expect(h.calls.dbs[0]).toBe("memongo")
		expect(h.calls.fetches).toBe(1)
		expect(h.out.join("\n")).toContain("mongodb:cluster-preflight PASS")
	})

	it("accepts a --prefix equal to the configured prefix", async () => {
		useEnv({
			MEMONGO_MONGODB_URI: ENV_URI,
			MEMONGO_MONGODB_COLLECTION_PREFIX: BENCH,
		})
		const h = harness([`--prefix=${BENCH}`])
		expect(await h.run()).toBe(0)
		expect(h.calls.uris).toEqual([ENV_URI])
	})

	it("accepts MEMONGO_DB_NAME equal to the configured database", async () => {
		useEnv({
			MEMONGO_MONGODB_URI: ENV_URI,
			MEMONGO_MONGODB_DATABASE: "benchdb",
			MEMONGO_DB_NAME: "benchdb",
			MEMONGO_MONGODB_COLLECTION_PREFIX: BENCH,
		})
		const h = harness()
		expect(await h.run()).toBe(0)
		expect(h.calls.dbs[0]).toBe("benchdb")
	})
})

describe("mongodb:cluster-preflight refusals", () => {
	function expectRefused(h: ReturnType<typeof harness>, message: string) {
		expect(h.calls.uris).toEqual([])
		expect(h.calls.fetches).toBe(0)
		expect(h.calls.dbs).toEqual([])
		expect(h.out).toEqual([])
		const text = h.err.join("\n")
		expect(text).toContain(message)
		for (const value of [
			FORCE,
			ENV_URI,
			"force.invalid",
			"env.invalid",
			"otherdb",
		])
			expect(text).not.toContain(value)
	}

	it("refuses a --prefix that differs from the configured prefix, then passes after the fix", async () => {
		useEnv({
			MEMONGO_FORCE_MONGODB_URI: FORCE,
			MEMONGO_MONGODB_URI: ENV_URI,
		})
		const refused = harness([`--prefix=${BENCH}`, "--verify-atlas-model-key"])
		expect(await refused.run()).toBe(1)
		expectRefused(
			refused,
			"--prefix differs from the configured collection prefix (MEMONGO_MONGODB_COLLECTION_PREFIX or memory.mongodb.collectionPrefix). Remove --prefix or set MEMONGO_MONGODB_COLLECTION_PREFIX to that value, then rerun.",
		)
		expect(refused.err.join("\n")).not.toContain(BENCH)

		vi.stubEnv("MEMONGO_MONGODB_COLLECTION_PREFIX", BENCH)
		const rerun = harness([`--prefix=${BENCH}`, "--verify-atlas-model-key"])
		expect(await rerun.run()).toBe(0)
		expect(rerun.calls.uris).toEqual([FORCE])
		expect(rerun.out.join("\n")).toContain(`prefix=${BENCH}`)
	})

	it("refuses a legacy MEMONGO_DB_NAME that differs from the configured database", async () => {
		useEnv({
			MEMONGO_MONGODB_URI: ENV_URI,
			MEMONGO_DB_NAME: "otherdb",
			MEMONGO_MONGODB_COLLECTION_PREFIX: BENCH,
		})
		const refused = harness(["--verify-atlas-model-key"])
		expect(await refused.run()).toBe(1)
		expectRefused(
			refused,
			"MEMONGO_DB_NAME is a legacy setting the benchmark runner ignores and differs from the configured database (MEMONGO_MONGODB_DATABASE or memory.mongodb.database). Unset MEMONGO_DB_NAME or set MEMONGO_MONGODB_DATABASE to the intended database, then rerun.",
		)

		vi.stubEnv("MEMONGO_MONGODB_DATABASE", "otherdb")
		const rerun = harness()
		expect(await rerun.run()).toBe(0)
		expect(rerun.calls.dbs[0]).toBe("otherdb")
	})

	it("refuses the application default prefix and names the setting to change", async () => {
		useEnv({ MEMONGO_MONGODB_URI: ENV_URI })
		const refused = harness(["--verify-atlas-model-key"])
		expect(await refused.run()).toBe(1)
		expectRefused(refused, "collection prefix must start with memongo_bench_")
		expect(refused.err.join("\n")).toContain(
			"set MEMONGO_MONGODB_COLLECTION_PREFIX",
		)
	})

	it("fails closed on a missing configured URI before any client or fetch", async () => {
		useEnv({})
		const h = harness(["--verify-atlas-model-key"])
		await expect(h.run()).rejects.toThrow(/MongoDB URI required/)
		expect(h.calls.uris).toEqual([])
		expect(h.calls.fetches).toBe(0)
	})
})
