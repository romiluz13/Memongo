import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
	MongoTargetRefusal,
	resolveConfiguredMongoDB,
} from "./mongodb-target.js"

// The resolver reads process.env only. Each test stubs every inherited
// MEMONGO_* variable away and points HOME and the config path at a temporary
// directory, so no real config file or credential is ever read.
const dirs: string[] = []
afterEach(() => {
	vi.unstubAllEnvs()
	for (const dir of dirs.splice(0))
		fs.rmSync(dir, { recursive: true, force: true })
})

function useEnv(env: Record<string, string>, file: unknown = {}) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "memongo-target-"))
	dirs.push(dir)
	const configPath = path.join(dir, "memongo.json")
	fs.writeFileSync(
		configPath,
		typeof file === "string" ? file : JSON.stringify(file),
	)
	for (const name of Object.keys(process.env))
		if (name.startsWith("MEMONGO_")) vi.stubEnv(name, undefined)
	vi.stubEnv("HOME", dir)
	vi.stubEnv("MEMONGO_CONFIG_PATH", configPath)
	for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value)
}

describe("resolveConfiguredMongoDB", () => {
	it("lets MEMONGO_FORCE_MONGODB_URI win over the env and file URIs", () => {
		useEnv(
			{
				MEMONGO_MONGODB_URI: "mongodb://env.invalid:27017",
				MEMONGO_FORCE_MONGODB_URI: "mongodb://force.invalid:27017",
			},
			{ memory: { mongodb: { uri: "mongodb://file.invalid:27017" } } },
		)
		expect(resolveConfiguredMongoDB().uri).toBe("mongodb://force.invalid:27017")
	})

	it("prefers the env URI, database and prefix over the config file", () => {
		useEnv(
			{
				MEMONGO_MONGODB_URI: "mongodb://env.invalid:27017",
				MEMONGO_MONGODB_DATABASE: "envdb",
				MEMONGO_MONGODB_COLLECTION_PREFIX: "memongo_bench_env_",
			},
			{
				memory: {
					mongodb: {
						uri: "mongodb://file.invalid:27017",
						database: "filedb",
						collectionPrefix: "memongo_bench_file_",
					},
				},
			},
		)
		expect(resolveConfiguredMongoDB()).toMatchObject({
			uri: "mongodb://env.invalid:27017",
			database: "envdb",
			collectionPrefix: "memongo_bench_env_",
		})
	})

	it("reads the target and other settings from the config file in one resolution", () => {
		useEnv(
			{},
			{
				memory: {
					mongodb: {
						uri: "mongodb://file.invalid:27017",
						database: "filedb",
						collectionPrefix: "memongo_bench_file_",
						memoryTtlDays: 31,
					},
				},
			},
		)
		expect(resolveConfiguredMongoDB()).toMatchObject({
			uri: "mongodb://file.invalid:27017",
			database: "filedb",
			collectionPrefix: "memongo_bench_file_",
			memoryTtlDays: 31,
		})
	})

	it("defaults the database to memongo and the prefix to memongo_", () => {
		useEnv({ MEMONGO_MONGODB_URI: "mongodb://env.invalid:27017" })
		expect(resolveConfiguredMongoDB()).toMatchObject({
			database: "memongo",
			collectionPrefix: "memongo_",
		})
	})

	it("throws when no URI is configured anywhere", () => {
		useEnv({})
		expect(() => resolveConfiguredMongoDB()).toThrow(/MongoDB URI required/)
	})

	it("throws when the selected config file is malformed", () => {
		useEnv({ MEMONGO_MONGODB_URI: "mongodb://env.invalid:27017" }, "{not json")
		expect(() => resolveConfiguredMongoDB()).toThrow(/not valid JSON/)
	})

	it("names refusals so entrypoints can report them without a stack", () => {
		expect(new MongoTargetRefusal("x")).toBeInstanceOf(Error)
		expect(new MongoTargetRefusal("x").name).toBe("MongoTargetRefusal")
	})
})
