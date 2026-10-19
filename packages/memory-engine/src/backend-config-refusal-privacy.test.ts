// M2 review fix R6: a configuration refusal never echoes the rejected value.
// The value an operator mistyped can be a connection string, so neither the
// Error, the returned `error`, nor any log line may carry its scheme, host,
// database or credentials. Sentinels make a leak greppable.
import type { MemongoConfig } from "@memongo/lib"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
	resolveDefaultScope,
	resolveMemoryBackendConfig,
	resolveSearchDefaultScope,
} from "./backend-config.js"
import { getMemorySearchManager } from "./search-manager.js"

vi.mock("./mongodb-manager.js", () => ({
	MongoDBMemoryManager: { create: vi.fn() },
	buildMongoClientOptions: vi.fn(() => ({})),
}))

const SENTINEL_URI =
	"mongodb://sentinel-user:sentinel-secret@private-host.example:27017/tenant-db"
const LEAK_SENTINELS = [
	"mongodb://",
	"private-host.example",
	"tenant-db",
	"sentinel-secret",
	"sentinel-user",
]

function expectNoSentinel(text: string): void {
	for (const sentinel of LEAK_SENTINELS) {
		expect(text, `leaked ${sentinel}`).not.toContain(sentinel)
	}
}

function cfgWith(mongodb: Record<string, unknown>, backend = "mongodb") {
	return {
		agents: { defaults: { workspace: "/tmp/memory-test" } },
		memory: {
			backend,
			mongodb: { uri: "mongodb://localhost:27017", ...mongodb },
		},
	} as unknown as MemongoConfig
}

describe("configuration refusals never echo the rejected value", () => {
	let consoleLines: string[]

	beforeEach(() => {
		consoleLines = []
		for (const method of ["warn", "error", "log", "debug"] as const) {
			vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
				consoleLines.push(args.map(String).join(" "))
			})
		}
	})

	afterEach(() => {
		vi.restoreAllMocks()
		vi.unstubAllEnvs()
	})

	const refusals: Array<
		[string, { env?: Record<string, string>; cfg?: MemongoConfig }]
	> = [
		[
			"MEMONGO_QUERY_EMBEDDING_MODEL",
			{ env: { MEMONGO_QUERY_EMBEDDING_MODEL: SENTINEL_URI } },
		],
		[
			"memory.mongodb.queryEmbeddingModel",
			{ cfg: cfgWith({ queryEmbeddingModel: SENTINEL_URI }) },
		],
		[
			"MEMONGO_CONVERSATION_EVIDENCE_MODE",
			{ env: { MEMONGO_CONVERSATION_EVIDENCE_MODE: SENTINEL_URI } },
		],
		["memory.backend", { cfg: cfgWith({}, SENTINEL_URI) }],
		[
			"memory.mongodb.deploymentProfile",
			{ cfg: cfgWith({ deploymentProfile: SENTINEL_URI }) },
		],
		[
			"MEMONGO_MONGODB_FUSION_METHOD",
			{ env: { MEMONGO_MONGODB_FUSION_METHOD: SENTINEL_URI } },
		],
	]

	it.each(
		refusals,
	)("the resolver error for %s carries no sentinel", (_setting, input) => {
		for (const [key, value] of Object.entries(input.env ?? {})) {
			vi.stubEnv(key, value)
		}
		let thrown: unknown
		try {
			resolveMemoryBackendConfig({
				cfg: input.cfg ?? cfgWith({}),
				agentId: "main",
			})
		} catch (err) {
			thrown = err
		}
		expect(thrown).toBeInstanceOf(Error)
		expectNoSentinel((thrown as Error).message)
	})

	it.each(
		refusals,
	)("getMemorySearchManager refuses %s without leaking it into the result or a log", async (_setting, input) => {
		for (const [key, value] of Object.entries(input.env ?? {})) {
			vi.stubEnv(key, value)
		}
		vi.stubEnv("MEMONGO_MONGODB_URI", "mongodb://localhost:27017")

		const result = await getMemorySearchManager({
			cfg: input.cfg ?? cfgWith({}),
			agentId: "main",
		})

		expect(result.manager).toBeNull()
		expect(result.error).toEqual(expect.any(String))
		expectNoSentinel(result.error ?? "")
		expectNoSentinel((result.cause as Error).message)
		expect(consoleLines.length).toBeGreaterThan(0)
		expectNoSentinel(consoleLines.join("\n"))
	})

	it("an invalid search default scope names the setting, not the value", () => {
		expect(() => resolveSearchDefaultScope(SENTINEL_URI)).toThrow(
			/MEMONGO_SEARCH_DEFAULT_SCOPE is not a valid memory scope/,
		)
		try {
			resolveSearchDefaultScope(SENTINEL_URI)
		} catch (err) {
			expectNoSentinel((err as Error).message)
		}
	})

	it("an invalid default scope names the setting, not the value", () => {
		expect(() =>
			resolveDefaultScope({ value: SENTINEL_URI, applyTo: "read" }),
		).toThrow(/MEMONGO_DEFAULT_SCOPE is not a valid memory scope/)
		try {
			resolveDefaultScope({ value: SENTINEL_URI, applyTo: "read" })
		} catch (err) {
			expectNoSentinel((err as Error).message)
		}
	})

	it("the legacy-scope conflict warning does not echo the legacy value", () => {
		const warn = vi.fn()
		expect(
			resolveDefaultScope({
				value: "global",
				legacyValue: SENTINEL_URI,
				applyTo: "read",
				warn,
			}),
		).toBe("global")
		expect(warn).toHaveBeenCalledTimes(1)
		expect(warn.mock.calls[0]?.[0]).toContain("MEMONGO_DEFAULT_SCOPE")
		expectNoSentinel(String(warn.mock.calls[0]?.[0]))
	})
})
