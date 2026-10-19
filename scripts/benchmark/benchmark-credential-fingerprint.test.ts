import { createHash } from "node:crypto"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { describe, expect, it } from "vitest"
import {
	assertOperationRunConfiguration,
	createOperationRunContext,
	hashOperationRunConfiguration,
} from "../../packages/memory-engine/src/mongodb-operation-accounting.js"
import {
	BENCHMARK_FINGERPRINT_KEY_ENV,
	benchmarkCredentialFingerprint,
	benchmarkCredentialKeyId,
	parseBenchmarkFingerprintKey,
} from "./benchmark-credential-fingerprint.js"
import { SYNTHETIC_BENCHMARK_HOST } from "./benchmark-run-configuration.fixture.js"
import {
	type BenchmarkCheckpoint,
	readBenchmarkCheckpoint,
	writeBenchmarkCheckpointAtomic,
} from "./mongodb-benchmark-checkpoint.js"
import { MongoDBManagerBenchmarkScenarioOps } from "./mongodb-manager-benchmark-scenario.js"

// Synthetic keys and credentials only; nothing here is a real secret.
const KEY_A = "a1".repeat(32)
const KEY_B = "b2".repeat(32)
const CREDENTIALS = {
	MEMONGO_ENRICHMENT_API_KEY: "cnryKeyedEnrichKey",
	MEMONGO_BENCHMARK_ANSWER_API_KEY: "cnryKeyedAnswerKey",
	MEMONGO_ENRICHMENT_BASE_URL: "https://enrich.invalid/v1/cnryKeyedEnrichPath",
	MEMONGO_BENCHMARK_ANSWER_BASE_URL:
		"https://answer.invalid/v1?api_key=cnryKeyedAnswerToken",
	MEMONGO_BENCHMARK_JUDGE_API_KEY: "cnryKeyedJudgeKey",
	MEMONGO_BENCHMARK_JUDGE_BASE_URL: "https://judge.invalid/cnryKeyedJudgePath",
}
const VOYAGE_KEY = "cnryKeyedVoyageKey"

/** The real producer under exactly `env`. */
function produce(env: Record<string, string>) {
	const saved = { ...process.env }
	try {
		for (const key of Object.keys(process.env))
			if (key.startsWith("MEMONGO_")) delete process.env[key]
		Object.assign(process.env, env)
		const host = structuredClone(SYNTHETIC_BENCHMARK_HOST)
		const configuration = new MongoDBManagerBenchmarkScenarioOps(
			host as never,
		).snapshotBenchmarkRunConfiguration({
			executionProfile: "shipped",
			retrievalLane: "native",
			maxResults: 10,
			minScore: 0.01,
		})
		return {
			configuration,
			configurationHash: hashOperationRunConfiguration(configuration),
		}
	} finally {
		process.env = saved
	}
}

const keyed = (key: string, extra: Record<string, string> = {}) => ({
	[BENCHMARK_FINGERPRINT_KEY_ENV]: key,
	...CREDENTIALS,
	...extra,
})

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex")

describe("benchmark credential fingerprint scheme", () => {
	it("matches the fixed known-answer vector", () => {
		const key = parseBenchmarkFingerprintKey({
			[BENCHMARK_FINGERPRINT_KEY_ENV]: "00".repeat(32),
		})
		expect(
			benchmarkCredentialFingerprint(
				key,
				"MEMONGO_BENCHMARK_JUDGE_API_KEY",
				"cnryJudgeKey",
			),
		).toBe("71df7a9dd419a1a4a75f567165d88cbf99985167ed75d21d38ea79bc9af39656")
		expect(benchmarkCredentialKeyId(key)).toBe(
			"c5f44024030fc9ea9185881060bba1d76eb1ff32237cc90702ed6706ec327187",
		)
	})

	it("reads a padded or upper-case key as the same 32 bytes", () => {
		const lower = parseBenchmarkFingerprintKey({
			[BENCHMARK_FINGERPRINT_KEY_ENV]: KEY_A,
		})
		const upper = parseBenchmarkFingerprintKey({
			[BENCHMARK_FINGERPRINT_KEY_ENV]: ` ${KEY_A.toUpperCase()}\n`,
		})
		expect(lower).toHaveLength(32)
		expect(upper.equals(lower)).toBe(true)
	})

	it.each([
		["absent", undefined],
		["blank", "   "],
		["63 hex characters", "a".repeat(63)],
		["65 hex characters", "a".repeat(65)],
		[
			"a non-hex character at position 40",
			`${"a".repeat(40)}g${"a".repeat(23)}`,
		],
		["an embedded space", `${"a".repeat(32)} ${"a".repeat(31)}`],
		["a 0x prefix", `0x${"a".repeat(62)}`],
	])("refuses a key that is %s without echoing it", (_name, value) => {
		let message = ""
		try {
			parseBenchmarkFingerprintKey({ [BENCHMARK_FINGERPRINT_KEY_ENV]: value })
		} catch (error) {
			message = (error as Error).message
		}
		expect(message).toContain(BENCHMARK_FINGERPRINT_KEY_ENV)
		if (value?.trim()) expect(message).not.toContain(value.trim())
	})

	it("separates fields: one value under two names gives two fingerprints", () => {
		const key = parseBenchmarkFingerprintKey({
			[BENCHMARK_FINGERPRINT_KEY_ENV]: KEY_A,
		})
		expect(
			benchmarkCredentialFingerprint(
				key,
				"MEMONGO_BENCHMARK_ANSWER_API_KEY",
				"same",
			),
		).not.toBe(
			benchmarkCredentialFingerprint(
				key,
				"MEMONGO_BENCHMARK_JUDGE_API_KEY",
				"same",
			),
		)
	})
})

describe("keyed credential identity from the real producer", () => {
	const key = parseBenchmarkFingerprintKey({
		[BENCHMARK_FINGERPRINT_KEY_ENV]: KEY_A,
	})
	const INPUTS: Array<[setting: string, field: string, value: string]> = [
		...Object.entries(CREDENTIALS).map(
			([name, value]) =>
				[`env.${name}.hmac`, name, value] as [string, string, string],
		),
	]

	it("never records a credential, its plain SHA-256 or the key", () => {
		const text = JSON.stringify(produce(keyed(KEY_A)).configuration)
		const guessable = INPUTS.filter(
			([, , value]) => text.includes(value) || text.includes(sha256(value)),
		).map(([, field]) => field)
		expect(guessable).toEqual([])
		expect(text.toLowerCase()).not.toContain(KEY_A)
	})

	it("records keyed fingerprints of the effective values", () => {
		const { settings } = produce(keyed(KEY_A)).configuration
		expect(settings.credentialFingerprintKeyId).toBe(
			benchmarkCredentialKeyId(key),
		)
		for (const [setting, field, value] of INPUTS)
			expect(settings[setting]).toBe(
				benchmarkCredentialFingerprint(key, field, value),
			)
	})

	it.each(
		INPUTS,
	)("binds a change of %s to exactly that fingerprint", (setting, field) => {
		const base = produce(keyed(KEY_A))
		const changed = produce(
			keyed(KEY_A, {
				[field]: `${CREDENTIALS[field as keyof typeof CREDENTIALS]}x`,
			}),
		)
		expect(changed.configurationHash).not.toBe(base.configurationHash)
		const differing = Object.keys(base.configuration.settings).filter(
			(name) =>
				base.configuration.settings[name] !==
				changed.configuration.settings[name],
		)
		expect(differing).toEqual([setting])
	})

	it("records an absent credential as null under the same key domain", () => {
		const { configuration } = produce({
			[BENCHMARK_FINGERPRINT_KEY_ENV]: KEY_A,
		})
		for (const [setting] of INPUTS)
			expect(configuration.settings[setting]).toBeNull()
		expect(configuration.settings.credentialFingerprintKeyId).toBe(
			benchmarkCredentialKeyId(key),
		)
	})

	it("treats padded env values and key case as the same effective input", () => {
		const padded = Object.fromEntries(
			Object.entries(CREDENTIALS).map(([name, value]) => [name, ` ${value}\n`]),
		)
		expect(
			produce({
				...keyed(KEY_A.toUpperCase()),
				...padded,
			}).configurationHash,
		).toBe(produce(keyed(KEY_A)).configurationHash)
	})

	it("changes the key id and every present fingerprint under another key", () => {
		const a = produce(keyed(KEY_A)).configuration.settings
		const b = produce(keyed(KEY_B)).configuration.settings
		for (const [setting] of INPUTS) expect(b[setting]).not.toBe(a[setting])
		expect(b.credentialFingerprintKeyId).not.toBe(a.credentialFingerprintKeyId)
	})

	it.each([
		["absent", undefined],
		["malformed", "a".repeat(63)],
	])("refuses to produce identity with an %s key", (_name, value) => {
		const env: Record<string, string> = { ...CREDENTIALS }
		if (value !== undefined) env[BENCHMARK_FINGERPRINT_KEY_ENV] = value
		expect(() => produce(env)).toThrow(BENCHMARK_FINGERPRINT_KEY_ENV)
	})

	it("refuses mid-run key drift as a configuration change", () => {
		const context = createOperationRunContext({
			runId: "run-drift",
			configuration: produce(keyed(KEY_A)).configuration,
		})
		expect(() =>
			assertOperationRunConfiguration(
				context,
				produce(keyed(KEY_A)).configuration,
			),
		).not.toThrow()
		expect(() =>
			assertOperationRunConfiguration(
				context,
				produce(keyed(KEY_B)).configuration,
			),
		).toThrow("operation configuration changed during execution")
	})
})

describe("keyed identity at checkpoint resume", () => {
	function checkpoint(
		produced: ReturnType<typeof produce>,
	): BenchmarkCheckpoint {
		return {
			version: 2,
			failedLines: 0,
			runId: "run-keyed",
			datasetSha256: "a".repeat(64),
			configurationHash: produced.configurationHash,
			configuration: structuredClone(produced.configuration),
			executableDigest: "d".repeat(64),
			totalScenarios: 1,
			scenarioIds: ["scenario-1"],
			completedScenarios: [],
			accounting: {
				currency: null,
				totalCost: null,
				unavailableReason: "prices unavailable",
				operations: [],
			},
			updatedAt: "2026-10-14T00:00:00.000Z",
		}
	}

	async function resume(
		stored: BenchmarkCheckpoint,
		expectedHash: string,
		raw = false,
	) {
		const dir = await mkdtemp(path.join(os.tmpdir(), "memongo-keyed-"))
		const file = path.join(dir, "checkpoint.json")
		try {
			if (raw) await writeFile(file, JSON.stringify(stored))
			else await writeBenchmarkCheckpointAtomic(file, stored)
			return await readBenchmarkCheckpoint(file, {
				datasetSha256: "a".repeat(64),
				configurationHash: expectedHash,
				executableDigest: "d".repeat(64),
				scenarioIds: ["scenario-1"],
			})
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	}

	it("resumes under the same key", async () => {
		const run = produce(keyed(KEY_A))
		await expect(
			resume(checkpoint(run), produce(keyed(KEY_A)).configurationHash),
		).resolves.toMatchObject({ runId: "run-keyed" })
	})

	it("refuses to resume under a different key", async () => {
		const run = produce(keyed(KEY_A))
		await expect(
			resume(checkpoint(run), produce(keyed(KEY_B)).configurationHash),
		).rejects.toThrow("configuration hash does not match")
	})

	it("keeps a plain-SHA b02-judge-v1 manifest historical only", async () => {
		const stored = checkpoint(produce(keyed(KEY_A)))
		const settings = stored.configuration.settings
		for (const [name, value] of Object.entries(CREDENTIALS)) {
			Reflect.deleteProperty(settings, `env.${name}.hmac`)
			settings[`env.${name}.sha256`] = sha256(value)
		}
		Reflect.deleteProperty(settings, "rerankerApiKeyHmac")
		Reflect.deleteProperty(settings, "credentialFingerprintKeyId")
		settings.rerankerApiKeySha256 = sha256(VOYAGE_KEY)
		settings.configurationCoverage = "b02-judge-v1"
		stored.configurationHash = hashOperationRunConfiguration(
			stored.configuration,
		)
		await expect(
			resume(stored, stored.configurationHash, true),
		).rejects.toThrow("analyze it as historical only")
	})
})
