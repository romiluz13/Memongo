// M2 T5 (#114): the HTTP reranker is gone. Enabling rerank at boot fails typed
// as `rerank-unsupported`; each removed `reranking.*` key fails boot as
// `config-removed`, naming the key. `reranking.temporalProximityBoost` stays.
import type { MemongoConfig } from "@memongo/lib"
import { afterEach, describe, expect, it, vi } from "vitest"
import { resolveMemoryBackendConfig } from "./backend-config.js"
import { MemongoBootError } from "./mongodb-boot-errors.js"

function resolveWith(
	reranking: unknown,
	env: Record<string, string> = {},
): ReturnType<typeof resolveMemoryBackendConfig> {
	for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value)
	return resolveMemoryBackendConfig({
		cfg: {
			memory: {
				backend: "mongodb",
				mongodb: {
					uri: "mongodb://localhost:27017",
					...(reranking === undefined ? {} : { reranking }),
				},
			},
		} as unknown as MemongoConfig,
		agentId: "main",
	})
}

function failureOf(run: () => unknown): MemongoBootError {
	try {
		run()
	} catch (err) {
		expect(err).toBeInstanceOf(MemongoBootError)
		return err as MemongoBootError
	}
	throw new Error("expected boot configuration to fail")
}

afterEach(() => {
	vi.unstubAllEnvs()
})

describe("explicitly enabling rerank is rerank-unsupported at boot", () => {
	it("rejects reranking.enabled: true", () => {
		const err = failureOf(() => resolveWith({ enabled: true }))
		expect(err.code).toBe("rerank-unsupported")
		expect(err.setting).toBe("memory.mongodb.reranking.enabled")
		expect(err.message).toContain("memory.mongodb.reranking.enabled")
	})

	it.each([
		"true",
		"1",
		"yes",
		"on",
		"enabled",
	])("rejects MEMONGO_RERANKING_ENABLED=%s", (value) => {
		const err = failureOf(() =>
			resolveWith(undefined, { MEMONGO_RERANKING_ENABLED: value }),
		)
		expect(err.code).toBe("rerank-unsupported")
		expect(err.setting).toBe("MEMONGO_RERANKING_ENABLED")
		expect(err.message).toContain("MEMONGO_RERANKING_ENABLED")
	})

	it("rejects an enabling config even when the env says false", () => {
		const err = failureOf(() =>
			resolveWith({ enabled: true }, { MEMONGO_RERANKING_ENABLED: "false" }),
		)
		expect(err.code).toBe("rerank-unsupported")
		expect(err.setting).toBe("memory.mongodb.reranking.enabled")
	})

	it("rejects a non-boolean reranking.enabled instead of reading it as true", () => {
		const err = failureOf(() => resolveWith({ enabled: "yes" }))
		expect(err.code).toBe("config-invalid")
		expect(err.setting).toBe("memory.mongodb.reranking.enabled")
	})

	it("says native $rerank is not available yet, so the operator knows why", () => {
		const err = failureOf(() => resolveWith({ enabled: true }))
		expect(err.message).toMatch(/native \$rerank/)
	})
})

describe("rerank off is the only accepted state", () => {
	it.each([
		["absent", undefined, {}],
		["reranking.enabled false", { enabled: false }, {}],
		["env false", undefined, { MEMONGO_RERANKING_ENABLED: "false" }],
		["env 0", undefined, { MEMONGO_RERANKING_ENABLED: "0" }],
	] as const)("boots with %s and resolves no HTTP rerank settings", (_label, reranking, env) => {
		const resolved = resolveWith(reranking, { ...env })
		expect(resolved.mongodb?.reranking).toEqual({
			temporalProximityBoost: 0.1,
		})
	})

	it("keeps reranking.temporalProximityBoost, including its 0 off-switch", () => {
		expect(
			resolveWith({ temporalProximityBoost: 0.4 }).mongodb?.reranking
				.temporalProximityBoost,
		).toBe(0.4)
		expect(
			resolveWith({ temporalProximityBoost: 0 }).mongodb?.reranking
				.temporalProximityBoost,
		).toBe(0)
	})

	it("does not read VOYAGE_API_KEY into the reranking config", () => {
		const resolved = resolveWith(undefined, { VOYAGE_API_KEY: "pa-secret" })
		expect(JSON.stringify(resolved.mongodb?.reranking)).not.toContain(
			"pa-secret",
		)
	})
})

describe("removed reranking keys fail boot naming the key", () => {
	it.each([
		["model", "rerank-2.5"],
		["topN", 10],
		["minScore", 0.3],
		["voyageApiKey", "pa-secret"],
		["instruction", "prefer recent facts"],
		["recencyBoost", 0.5],
		["accessBoost", 0],
	] as const)("rejects reranking.%s", (key, value) => {
		const err = failureOf(() => resolveWith({ [key]: value }))
		expect(err.code).toBe("config-removed")
		expect(err.setting).toBe(`memory.mongodb.reranking.${key}`)
		expect(err.message).toContain(`memory.mongodb.reranking.${key}`)
		expect(err.message).not.toContain("pa-secret")
	})

	it("rejects a removed key even next to an accepted false", () => {
		const err = failureOf(() =>
			resolveWith({ enabled: false, model: "rerank-3" }),
		)
		expect(err.code).toBe("config-removed")
		expect(err.setting).toBe("memory.mongodb.reranking.model")
	})

	it("rejects MEMONGO_RERANK_MIN_SCORE with any value", () => {
		for (const value of ["0.05", "0", "not-a-number"]) {
			const err = failureOf(() =>
				resolveWith(undefined, { MEMONGO_RERANK_MIN_SCORE: value }),
			)
			expect(err.code).toBe("config-removed")
			expect(err.setting).toBe("MEMONGO_RERANK_MIN_SCORE")
			expect(err.message).toContain("MEMONGO_RERANK_MIN_SCORE")
		}
	})
})
