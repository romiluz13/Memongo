import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type { Db } from "mongodb"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
	ignoredLegacyTargetEnvVars,
	type PrepareOptions,
	resolvePrepareOptions,
	resolveSchemaOnlyFlag,
	runSchemaOnly,
	schemaOnlyReceiptLines,
} from "./prepare-mongodb-runtime.js"

// Hermetic resolver contract: `mongodb:prepare` must resolve its target and
// schema options through the application configuration path (bridge
// buildMemongoConfig -> engine resolveMemoryBackendConfig). These tests never
// open a socket; the real entrypoint is exercised by the native command probe.
// The static import above also proves the module is side-effect-free when not
// run as `bun scripts/prepare-mongodb-runtime.ts` (import.meta.main guard).

describe("prepare-mongodb-runtime configuration resolution", () => {
	const prev = { ...process.env }

	afterEach(() => {
		process.env = { ...prev }
	})

	function writeConfig(body: unknown): {
		env: NodeJS.ProcessEnv
		cleanup: () => void
	} {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "memongo-prepare-"))
		const cfgPath = path.join(dir, "memongo.json")
		fs.writeFileSync(cfgPath, JSON.stringify(body), "utf-8")
		return {
			env: { MEMONGO_CONFIG_PATH: cfgPath },
			cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
		}
	}

	const configuredFile = {
		memory: {
			mongodb: {
				uri: "mongodb://file-host:27017/filedb",
				database: "filedb",
				collectionPrefix: "file_",
				memoryTtlDays: 31,
				episodesRetentionDays: 9,
				relevance: { retention: { days: 17 } },
			},
		},
	}

	it("resolves target and file-only retention from the config file", () => {
		const { env, cleanup } = writeConfig(configuredFile)
		try {
			process.env = { ...env }
			const options = resolvePrepareOptions()
			expect(options.uri).toBe("mongodb://file-host:27017/filedb")
			expect(options.database).toBe("filedb")
			expect(options.prefix).toBe("file_")
			expect(options.memoryTtlDays).toBe(31)
			expect(options.episodesRetentionDays).toBe(9)
			expect(options.relevanceRetentionDays).toBe(17)
			expect(options.profile).toBe("atlas-local-preview")
			expect(options.embeddingMode).toBe("automated")
		} finally {
			cleanup()
		}
	})

	it("MEMONGO_FORCE_MONGODB_URI wins over the file URI", () => {
		const { env, cleanup } = writeConfig(configuredFile)
		try {
			process.env = {
				...env,
				MEMONGO_FORCE_MONGODB_URI: "mongodb://forced:27017/forced",
			}
			expect(resolvePrepareOptions().uri).toBe("mongodb://forced:27017/forced")
		} finally {
			cleanup()
		}
	})

	it("env database/prefix override the file while file retention survives", () => {
		const { env, cleanup } = writeConfig(configuredFile)
		try {
			process.env = {
				...env,
				MEMONGO_MONGODB_DATABASE: "envdb",
				MEMONGO_MONGODB_COLLECTION_PREFIX: "env_",
			}
			const options = resolvePrepareOptions()
			expect(options.database).toBe("envdb")
			expect(options.prefix).toBe("env_")
			expect(options.memoryTtlDays).toBe(31)
			expect(options.episodesRetentionDays).toBe(9)
			expect(options.relevanceRetentionDays).toBe(17)
		} finally {
			cleanup()
		}
	})

	it("ignores legacy script-only aliases when selecting the target", () => {
		const { env, cleanup } = writeConfig(configuredFile)
		try {
			process.env = {
				...env,
				MDB_MCP_CONNECTION_STRING: "mongodb://127.0.0.1:1/decoy",
				MEMONGO_CLOUD_MONGODB_URI: "mongodb://127.0.0.1:1/decoy",
				MEMONGO_DB_NAME: "decoydb",
			}
			const options = resolvePrepareOptions()
			expect(options.uri).toBe("mongodb://file-host:27017/filedb")
			expect(options.database).toBe("filedb")
		} finally {
			cleanup()
		}
	})

	it("falls back to shared defaults with only an env URI", () => {
		const home = fs.mkdtempSync(path.join(os.tmpdir(), "memongo-prepare-home-"))
		// The default config path derives from os.homedir(), which does not
		// reliably observe a replaced process.env.HOME; stub it instead.
		const homedir = vi.spyOn(os, "homedir").mockReturnValue(home)
		try {
			process.env = {
				MEMONGO_MONGODB_URI: "mongodb://env-host:27017/envdb",
			}
			const options = resolvePrepareOptions()
			expect(options.uri).toBe("mongodb://env-host:27017/envdb")
			expect(options.database).toBe("memongo")
			expect(options.prefix).toBe("memongo_")
			expect(options.memoryTtlDays).toBe(0)
			expect(options.episodesRetentionDays).toBe(0)
			// Application default: relevance retention is ON at 14 days even
			// without user config (backend-config.ts relevance.retention.days
			// resolution), unlike memory/episodes which default to disabled.
			expect(options.relevanceRetentionDays).toBe(14)
		} finally {
			homedir.mockRestore()
			fs.rmSync(home, { recursive: true, force: true })
		}
	})

	it("honors MEMONGO_PREPARE_WAIT_MS and rejects invalid values", () => {
		const { env, cleanup } = writeConfig(configuredFile)
		try {
			process.env = { ...env, MEMONGO_PREPARE_WAIT_MS: "0" }
			expect(resolvePrepareOptions().waitMs).toBe(0)
			process.env = { ...env, MEMONGO_PREPARE_WAIT_MS: "abc" }
			expect(() => resolvePrepareOptions()).toThrow(/non-negative integer/)
		} finally {
			cleanup()
		}
	})

	it("throws before connecting when the explicit config file is missing", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "memongo-prepare-"))
		try {
			process.env = { MEMONGO_CONFIG_PATH: path.join(dir, "absent.json") }
			expect(() => resolvePrepareOptions()).toThrow(
				/Memongo config file not found/,
			)
		} finally {
			fs.rmSync(dir, { recursive: true, force: true })
		}
	})

	it("throws on malformed config without echoing file content", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "memongo-prepare-"))
		try {
			const cfgPath = path.join(dir, "memongo.json")
			fs.writeFileSync(
				cfgPath,
				'{"memory":{"mongodb":{"uri":"mongodb://user:SECRET-CREDENTIAL@host/db"},},}',
				"utf-8",
			)
			process.env = { MEMONGO_CONFIG_PATH: cfgPath }
			let message = ""
			try {
				resolvePrepareOptions()
			} catch (error) {
				message = (error as Error).message
			}
			expect(message).toMatch(/is not valid JSON/)
			expect(message).not.toContain("SECRET-CREDENTIAL")
		} finally {
			fs.rmSync(dir, { recursive: true, force: true })
		}
	})

	it("reports only the legacy aliases that are actually set", () => {
		expect(
			ignoredLegacyTargetEnvVars({
				MDB_MCP_CONNECTION_STRING: "mongodb://h/db",
				MEMONGO_DB_NAME: "  ",
			}),
		).toEqual(["MDB_MCP_CONNECTION_STRING"])
		expect(ignoredLegacyTargetEnvVars({})).toEqual([])
	})
})

/**
 * Schema-only mode oracle. The recording Db drives the REAL schema seam
 * (ensureCollections + ensureStandardIndexes, exactly what the script's
 * schema-only path calls) against in-memory state, so these tests observe
 * what the implementation actually issues rather than a restated
 * expectation. Mock fidelity is server-shaped: createIndex with an
 * identical name+key+options is a no-op (the server treats identical
 * re-creation as success), a same-name different-spec creation throws
 * IndexOptionsConflict, and dropIndex of a missing index throws code 27
 * (the engine's guarded drops swallow it). The mock deliberately exposes
 * NO Search or capability surface — no listSearchIndexes, no aggregate —
 * so any such call from the schema-only path fails loudly here.
 *
 * Parity contract note: the standard-index layer re-issues identical
 * createIndex commands on every run by design (server-idempotent), so a
 * same-config rerun is asserted as a STATE-level no-op — zero
 * createCollection, zero index entries added or removed, zero TTL
 * convergence collMods, identical report — not as zero createIndex calls.
 */
describe("prepare-mongodb-runtime --schema-only mode", () => {
	// The evidence-mirror gate changes the initializer's collection set; pin
	// it off for these tests (the accepted migration oracle does the same).
	const prevEnv = { ...process.env }

	beforeEach(() => {
		delete process.env.MEMONGO_EVIDENCE_MIRROR_MODE
	})

	afterEach(() => {
		process.env = { ...prevEnv }
	})

	const schemaOnlyOptions = (
		overrides?: Partial<PrepareOptions>,
	): PrepareOptions => ({
		// Credential-bearing on purpose: the receipt test proves the URI
		// never reaches output.
		uri: "mongodb://schema-user:SECRET-CREDENTIAL@schema-host:27017/schemadb",
		database: "schemadb",
		prefix: "prep_",
		profile: "atlas-managed",
		embeddingMode: "automated",
		quantization: "none",
		numDimensions: 768,
		memoryTtlDays: 31,
		episodesRetentionDays: 9,
		relevanceRetentionDays: 17,
		waitMs: 120_000,
		pollMs: 5_000,
		...overrides,
	})

	type RecordedIndex = {
		name: string
		key: Record<string, unknown>
		options?: Record<string, unknown>
	}

	const autoIndexName = (key: Record<string, unknown>): string =>
		Object.entries(key)
			.map(([field, direction]) => `${field}_${String(direction)}`)
			.join("_")

	const makeRecordingDb = () => {
		const existing: string[] = []
		const created: Array<{ name: string; options?: unknown }> = []
		const indexes = new Map<string, RecordedIndex[]>()
		const commands: string[] = []
		const specJson = (key: unknown, options: unknown) =>
			JSON.stringify({ key, options: options ?? {} })
		const listFor = (name: string): RecordedIndex[] => {
			let list = indexes.get(name)
			if (!list) {
				list = []
				indexes.set(name, list)
			}
			return list
		}
		const visible = (filter?: { name?: string }) =>
			filter?.name === undefined
				? existing
				: existing.filter((n) => n === filter.name)
		const db = {
			listCollections: (filter?: { name?: string }) => ({
				map: (f: (c: { name: string }) => string) => ({
					toArray: async () => visible(filter).map((n) => f({ name: n })),
				}),
				toArray: async () =>
					visible(filter).map((name) => ({ name, type: "collection" })),
			}),
			admin: () => ({
				command: async () => ({ versionArray: [8, 1, 0, 0] }),
			}),
			createCollection: async (name: string, options?: unknown) => {
				created.push({ name, options })
				existing.push(name)
				return {}
			},
			collection: (name: string) => ({
				listIndexes: () => ({
					toArray: async () =>
						listFor(name).map((i) => ({
							name: i.name,
							key: i.key,
							...(i.options ?? {}),
						})),
				}),
				createIndex: async (
					key: Record<string, unknown>,
					options?: Record<string, unknown>,
				) => {
					const nameOption = options?.name
					const indexName =
						typeof nameOption === "string" ? nameOption : autoIndexName(key)
					const prior = listFor(name).find((i) => i.name === indexName)
					if (prior) {
						if (specJson(prior.key, prior.options) === specJson(key, options)) {
							return indexName
						}
						throw new Error(
							`IndexOptionsConflict: index ${indexName} on ${name} already exists with different options`,
						)
					}
					listFor(name).push({ name: indexName, key, options })
					return indexName
				},
				dropIndex: async (indexName: string) => {
					const list = listFor(name)
					const at = list.findIndex((i) => i.name === indexName)
					if (at < 0) {
						const err = new Error(`index not found: ${indexName}`) as Error & {
							code: number
						}
						err.code = 27
						throw err
					}
					list.splice(at, 1)
				},
			}),
			command: async (command: Record<string, unknown>) => {
				commands.push(JSON.stringify(command))
				return { ok: 1 }
			},
		}
		return {
			db: db as unknown as Db,
			created,
			commands,
			indexesFor: (collection: string): RecordedIndex[] =>
				indexes.get(collection) ?? [],
			catalogSnapshot: (): Record<string, RecordedIndex[]> =>
				Object.fromEntries(
					[...indexes.entries()].map(([coll, list]) => [
						coll,
						list.map((i) => ({ ...i })),
					]),
				),
		}
	}

	it("resolveSchemaOnlyFlag matches only the exact --schema-only token", () => {
		expect(resolveSchemaOnlyFlag(["--schema-only"])).toBe(true)
		expect(resolveSchemaOnlyFlag(["--dry-run", "--schema-only"])).toBe(true)
		expect(resolveSchemaOnlyFlag([])).toBe(false)
		expect(resolveSchemaOnlyFlag(["--schema-only=true"])).toBe(false)
		expect(resolveSchemaOnlyFlag(["--schema-onlyx"])).toBe(false)
		expect(resolveSchemaOnlyFlag(["schema-only"])).toBe(false)
	})

	it("runSchemaOnly drives the real schema initializer on the configured prefix", async () => {
		const { db, created } = makeRecordingDb()
		const report = await runSchemaOnly(db, schemaOnlyOptions())
		// Drift tripwire mirroring the accepted migration oracle: today's
		// initializer creates 28 plain + 2 ordinary diagnostic collections.
		expect(created).toHaveLength(30)
		for (const c of created) {
			expect(c.name.startsWith("prep_")).toBe(true)
		}
		expect(report.database).toBe("schemadb")
		expect(report.prefix).toBe("prep_")
		expect(report.retention).toEqual({
			memoryTtlDays: 31,
			episodesRetentionDays: 9,
			relevanceRetentionDays: 17,
		})
		expect(report.standardIndexes).toBeGreaterThan(0)
	})

	it("applies the configured retention TTL surface (the 4 convergence indexes)", async () => {
		const withRetention = makeRecordingDb()
		await runSchemaOnly(withRetention.db, schemaOnlyOptions())
		const seconds = (days: number) => days * 24 * 60 * 60
		expect(
			withRetention
				.indexesFor("prep_files")
				.find((i) => i.name === "idx_files_ttl")?.options?.expireAfterSeconds,
		).toBe(seconds(31))
		expect(
			withRetention
				.indexesFor("prep_episodes")
				.find((i) => i.name === "idx_episodes_ttl_updated")?.options
				?.expireAfterSeconds,
		).toBe(seconds(9))
		expect(
			withRetention
				.indexesFor("prep_relevance_runs")
				.find((i) => i.name === "idx_relruns_ttl")?.options?.expireAfterSeconds,
		).toBe(seconds(17))
		expect(
			withRetention
				.indexesFor("prep_relevance_artifacts")
				.find((i) => i.name === "idx_relart_ttl")?.options?.expireAfterSeconds,
		).toBe(seconds(17))

		const withoutRetention = makeRecordingDb()
		await runSchemaOnly(
			withoutRetention.db,
			schemaOnlyOptions({
				memoryTtlDays: 0,
				episodesRetentionDays: 0,
				relevanceRetentionDays: 0,
			}),
		)
		expect(
			withoutRetention
				.indexesFor("prep_files")
				.some((i) => i.name === "idx_files_ttl"),
		).toBe(false)
		expect(
			withoutRetention
				.indexesFor("prep_episodes")
				.some((i) => i.name === "idx_episodes_ttl_updated"),
		).toBe(false)
		expect(
			withoutRetention
				.indexesFor("prep_relevance_runs")
				.some((i) => i.name === "idx_relruns_ttl"),
		).toBe(false)
		expect(
			withoutRetention
				.indexesFor("prep_relevance_artifacts")
				.some((i) => i.name === "idx_relart_ttl"),
		).toBe(false)
	})

	it("issues no Search or capability commands — only validator collMods", async () => {
		const { db, commands, created } = makeRecordingDb()
		await runSchemaOnly(db, schemaOnlyOptions())
		expect(created.length).toBeGreaterThan(0)
		expect(commands.length).toBeGreaterThan(0)
		for (const json of commands) {
			const command = JSON.parse(json) as Record<string, unknown>
			expect(Object.hasOwn(command, "collMod")).toBe(true)
			expect(Object.hasOwn(command, "index")).toBe(false)
		}
		expect(commands.join("\n")).not.toMatch(
			/createSearchIndexes|listSearchIndexes|searchIndexes|\$search|\$vectorSearch/i,
		)
	})

	it("schemaOnlyReceiptLines renders the PASS receipt without the URI", async () => {
		const { db } = makeRecordingDb()
		const report = await runSchemaOnly(db, schemaOnlyOptions())
		const lines = schemaOnlyReceiptLines(report)
		expect(lines).toEqual([
			"mongodb:prepare-schema PASS",
			"db=schemadb",
			"prefix=prep_",
			"retention: memory=31d episodes=9d relevance=17d",
			`standardIndexes=${report.standardIndexes}`,
		])
		const text = lines.join("\n")
		expect(text).not.toContain("SECRET-CREDENTIAL")
		expect(text).not.toContain("mongodb://")
	})

	it("a same-config second run is a state-level no-op", async () => {
		const mock = makeRecordingDb()
		const first = await runSchemaOnly(mock.db, schemaOnlyOptions())
		const createdAfterFirst = mock.created.length
		const catalogAfterFirst = mock.catalogSnapshot()
		const second = await runSchemaOnly(mock.db, schemaOnlyOptions())
		// Zero createCollection: the initializer skips existing collections.
		expect(mock.created).toHaveLength(createdAfterFirst)
		// Zero index entries added or removed: every re-issued createIndex
		// carries an identical spec (server-idempotent no-op — see the
		// describe header). A same-config rerun must never mutate state.
		expect(mock.catalogSnapshot()).toEqual(catalogAfterFirst)
		// Zero TTL convergence: no collMod carries index/expireAfterSeconds.
		for (const json of mock.commands) {
			expect(
				Object.hasOwn(JSON.parse(json) as Record<string, unknown>, "index"),
			).toBe(false)
		}
		expect(second).toEqual(first)
	})

	it("propagates initializer failures instead of swallowing them", async () => {
		const failing = {
			listCollections: () => {
				throw new Error("connection lost during listing")
			},
		}
		await expect(
			runSchemaOnly(failing as unknown as Db, schemaOnlyOptions()),
		).rejects.toThrow("connection lost during listing")
	})
})
