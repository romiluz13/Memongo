// M2 T1 config rows: each invalid setting fails boot with a typed
// MemongoBootError whose message and `setting` name the setting.
import type { MemongoConfig } from "@memongo/lib"
import { afterEach, describe, expect, it, vi } from "vitest"
import { resolveMemoryBackendConfig } from "./backend-config.js"
import { MemongoBootError } from "./mongodb-boot-errors.js"
import { resolveSearchIndexReadinessTiming } from "./mongodb-schema-search-definitions.js"

function resolveWith(
	mongodb: Record<string, unknown>,
	env: Record<string, string> = {},
): unknown {
	for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value)
	try {
		resolveMemoryBackendConfig({
			cfg: {
				memory: {
					backend: "mongodb",
					mongodb: { uri: "mongodb://localhost:27017", ...mongodb },
				},
			} as unknown as MemongoConfig,
			agentId: "main",
		})
		return undefined
	} catch (err) {
		return err
	}
}

afterEach(() => {
	vi.unstubAllEnvs()
})

const rows: Array<{
	row: string
	mongodb?: Record<string, unknown>
	env?: Record<string, string>
	setting: string
	code?: string
}> = [
	{
		row: "the community-mongot profile alias",
		mongodb: { deploymentProfile: "community-mongot" },
		setting: "memory.mongodb.deploymentProfile",
	},
	{
		row: "an unknown profile",
		mongodb: { deploymentProfile: "self-hosted-search" },
		setting: "memory.mongodb.deploymentProfile",
	},
	{
		row: "fusionMethod js-merge from config (or a config file)",
		mongodb: { fusionMethod: "js-merge" },
		setting: "memory.mongodb.fusionMethod",
	},
	{
		row: "an unknown fusionMethod from config",
		mongodb: { fusionMethod: "reciprocal" },
		setting: "memory.mongodb.fusionMethod",
	},
	{
		row: "fusionMethod js-merge from env",
		env: { MEMONGO_MONGODB_FUSION_METHOD: "js-merge" },
		setting: "MEMONGO_MONGODB_FUSION_METHOD",
	},
	{
		row: "an unknown fusionMethod from env, even over a valid config value",
		mongodb: { fusionMethod: "rankFusion" },
		env: { MEMONGO_MONGODB_FUSION_METHOD: "rrf" },
		setting: "MEMONGO_MONGODB_FUSION_METHOD",
	},
	{
		row: "an invalid ttl.sessionDays",
		mongodb: { ttl: { enabled: true, sessionDays: -1 } },
		setting: "memory.mongodb.ttl.sessionDays",
	},
	{
		row: "an invalid memoryTtlDays",
		mongodb: { memoryTtlDays: "thirty" },
		setting: "memory.mongodb.memoryTtlDays",
	},
	{
		row: "an invalid boolean env value",
		env: { MEMONGO_RERANKING_ENABLED: "maybe" },
		setting: "MEMONGO_RERANKING_ENABLED",
	},
	{
		row: "a numDimensions mismatch",
		mongodb: { numDimensions: 1536 },
		setting: "memory.mongodb.numDimensions",
	},
	{
		row: "LLM entity extraction with no provider",
		mongodb: { graph: { entityExtraction: { method: "llm" } } },
		setting: "memory.mongodb.graph.entityExtraction.method",
	},
	{
		row: "the removed MEMONGO_STRICT_SEARCH_INDEX_READY",
		env: { MEMONGO_STRICT_SEARCH_INDEX_READY: "1" },
		setting: "MEMONGO_STRICT_SEARCH_INDEX_READY",
		code: "config-removed",
	},
	{
		row: "the removed MEMONGO_REQUIRE_VECTOR",
		env: { MEMONGO_REQUIRE_VECTOR: "true" },
		setting: "MEMONGO_REQUIRE_VECTOR",
		code: "config-removed",
	},
]

describe("boot config rejections (M2 T1)", () => {
	it.each(rows)("fails boot on $row, naming $setting", (row) => {
		const err = resolveWith(row.mongodb ?? {}, row.env)
		expect(err).toBeInstanceOf(MemongoBootError)
		expect(err).toMatchObject({
			code: row.code ?? "config-invalid",
			setting: row.setting,
		})
		expect((err as Error).message).toContain(row.setting)
	})

	it.each([
		["MEMONGO_SEARCH_INDEX_READINESS_TIMEOUT_MS", "0"],
		["MEMONGO_SEARCH_INDEX_READINESS_POLL_MS", "soon"],
	])("fails boot on an invalid %s, naming it", (setting, value) => {
		let err: unknown
		try {
			resolveSearchIndexReadinessTiming({ [setting]: value })
		} catch (error) {
			err = error
		}
		expect(err).toMatchObject({ code: "config-invalid", setting })
		expect((err as Error).message).toContain(setting)
	})

	it("accepts the supported values", () => {
		expect(
			resolveWith({
				deploymentProfile: "atlas-local-preview",
				fusionMethod: "rankFusion",
				numDimensions: 1024,
				ttl: { enabled: true, sessionDays: 7 },
				memoryTtlDays: 0,
				graph: { entityExtraction: { method: "regex" } },
			}),
		).toBeUndefined()
	})
})

describe("boot config rejections never echo the rejected value", () => {
	const HOSTILE = [
		"mongodb+srv://cfg-user:",
		"s3cr3t-cfg",
		"@private-host.example.net/tenant-db",
	].join("")
	const echoRows: Array<{
		row: string
		mongodb?: Record<string, unknown>
		env?: Record<string, string>
	}> = [
		{ row: "deploymentProfile", mongodb: { deploymentProfile: HOSTILE } },
		{ row: "fusionMethod from config", mongodb: { fusionMethod: HOSTILE } },
		{
			row: "fusionMethod from env",
			env: { MEMONGO_MONGODB_FUSION_METHOD: HOSTILE },
		},
		{
			row: "ttl.sessionDays",
			mongodb: { ttl: { enabled: true, sessionDays: HOSTILE } },
		},
		{ row: "memoryTtlDays", mongodb: { memoryTtlDays: HOSTILE } },
		{ row: "numDimensions", mongodb: { numDimensions: HOSTILE } },
		{ row: "a boolean env value", env: { MEMONGO_RERANKING_ENABLED: HOSTILE } },
	]

	it.each(echoRows)("keeps $row out of the message and fields", (row) => {
		const err = resolveWith(row.mongodb ?? {}, row.env)
		expect(err).toBeInstanceOf(MemongoBootError)
		const text = JSON.stringify({
			message: (err as Error).message,
			failures: (err as MemongoBootError).failures,
		})
		for (const forbidden of [
			"s3cr3t-cfg",
			"private-host",
			"tenant-db",
			"mongodb+srv://",
		]) {
			expect(text).not.toContain(forbidden)
		}
	})

	it("keeps a hostile readiness timeout out of the message", () => {
		let err: unknown
		try {
			resolveSearchIndexReadinessTiming({
				MEMONGO_SEARCH_INDEX_READINESS_TIMEOUT_MS: HOSTILE,
			})
		} catch (error) {
			err = error
		}
		expect(err).toBeInstanceOf(MemongoBootError)
		expect((err as Error).message).not.toContain("s3cr3t-cfg")
		expect((err as Error).message).not.toContain("private-host")
	})
})
