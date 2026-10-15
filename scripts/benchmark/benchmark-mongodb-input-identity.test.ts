import { createHash } from "node:crypto"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { hashOperationRunConfiguration } from "../../packages/memory-engine/src/mongodb-operation-accounting.js"
import {
	BENCHMARK_FINGERPRINT_KEY_ENV,
	benchmarkCredentialFingerprint,
	parseBenchmarkFingerprintKey,
} from "./benchmark-credential-fingerprint.js"
import {
	SYNTHETIC_BENCHMARK_HOST,
	SYNTHETIC_FINGERPRINT_KEY,
} from "./benchmark-run-configuration.fixture.js"
import {
	type BenchmarkCheckpoint,
	readBenchmarkCheckpoint,
	writeBenchmarkCheckpointAtomic,
} from "./mongodb-benchmark-checkpoint.js"
import { MongoDBManagerBenchmarkScenarioOps } from "./mongodb-manager-benchmark-scenario.js"

// Synthetic URIs and credentials only; the producer never parses or connects.
const USER = "cnryMongoUser"
const PASSWORD = "cnryMongoPass"
const SESSION_TOKEN = "cnryMongoSessionToken"
const TLS_PASSWORD = "cnryMongoTlsPass"
const URI = `mongodb+srv://${USER}:${PASSWORD}@cluster.identity.invalid/memdb?retryWrites=true&authMechanismProperties=AWS_SESSION_TOKEN:${SESSION_TOKEN}&tlsCertificateKeyFilePassword=${TLS_PASSWORD}`

type MongoOverrides = Record<string, unknown>

/** The real producer for a host whose resolved MongoDB config has `overrides`. */
function produce(overrides: MongoOverrides = {}) {
	const saved = { ...process.env }
	try {
		for (const key of Object.keys(process.env))
			if (key.startsWith("MEMONGO_")) delete process.env[key]
		process.env[BENCHMARK_FINGERPRINT_KEY_ENV] = SYNTHETIC_FINGERPRINT_KEY
		const host = structuredClone(SYNTHETIC_BENCHMARK_HOST)
		Object.assign(host.config.mongodb, { uri: URI }, overrides)
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

function checkpoint(produced: ReturnType<typeof produce>): BenchmarkCheckpoint {
	return {
		version: 2,
		failedLines: 0,
		runId: "run-mongodb-input",
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
	const dir = await mkdtemp(path.join(os.tmpdir(), "memongo-mongodb-input-"))
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

const HISTORICAL = "configuration manifest is missing, unsupported"
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex")

describe("configured MongoDB connection inputs bind run identity", () => {
	it("records a keyed fingerprint of the exact URI and never the URI or its parts", () => {
		const { settings } = produce().configuration
		const key = parseBenchmarkFingerprintKey({
			[BENCHMARK_FINGERPRINT_KEY_ENV]: SYNTHETIC_FINGERPRINT_KEY,
		})
		expect(settings.mongodbUriHmac).toBe(
			benchmarkCredentialFingerprint(key, "mongodb.uri", URI),
		)
		const text = JSON.stringify(settings)
		for (const secret of [
			URI,
			USER,
			PASSWORD,
			SESSION_TOKEN,
			TLS_PASSWORD,
			encodeURIComponent(URI),
			sha256(URI),
			sha256(PASSWORD),
		])
			expect(text).not.toContain(secret)
	})

	it("records the configured client options as typed values, null when unset", () => {
		const { settings } = produce({
			maxConnecting: 3,
			networkFamily: 6,
			serverMonitoringMode: "poll",
		}).configuration
		expect(
			Object.fromEntries(
				Object.entries(settings).filter(([key]) =>
					key.startsWith("configuredMongoClient."),
				),
			),
		).toEqual({
			"configuredMongoClient.serverSelectionTimeoutMs": 10_000,
			"configuredMongoClient.connectTimeoutMs": 10_000,
			"configuredMongoClient.maxPoolSize": 10,
			"configuredMongoClient.minPoolSize": 2,
			"configuredMongoClient.maxConnecting": 3,
			"configuredMongoClient.maxIdleTimeMs": null,
			"configuredMongoClient.networkFamily": 6,
			"configuredMongoClient.socketTimeoutMs": null,
			"configuredMongoClient.heartbeatFrequencyMs": null,
			"configuredMongoClient.serverMonitoringMode": "poll",
			"configuredMongoClient.waitQueueTimeoutMs": null,
		})
	})

	it("resumes the same configured inputs", async () => {
		const run = produce()
		expect(produce().configurationHash).toBe(run.configurationHash)
		await expect(
			resume(checkpoint(run), produce().configurationHash),
		).resolves.toMatchObject({ runId: "run-mongodb-input" })
	})

	it.each([
		[
			"a different default auth database in the path",
			"mongodb://u:p@synthetic.invalid/authA",
			"mongodb://u:p@synthetic.invalid/authB",
		],
		[
			"a mixed-case repeated tag key",
			"mongodb://synthetic.invalid/?readPreference=secondary&readPreferenceTags=zone:a&READPREFERENCETAGS=zone:b",
			"mongodb://synthetic.invalid/?readPreference=secondary&readPreferenceTags=zone:a&readPreferenceTags=zone:b",
		],
		["a password rotation", URI, URI.replace(PASSWORD, "cnryMongoPass2")],
		["another principal", URI, URI.replace(USER, "cnryMongoOther")],
		["a read preference", URI, `${URI}&readPreference=secondary`],
		["a read concern", URI, `${URI}&readConcernLevel=available`],
		["the SRV scheme", URI, URI.replace("mongodb+srv://", "mongodb://")],
		[
			"reordered options",
			"mongodb://synthetic.invalid/?retryWrites=true&w=majority",
			"mongodb://synthetic.invalid/?w=majority&retryWrites=true",
		],
	])("refuses to resume across %s", async (_name, before, after) => {
		const run = produce({ uri: before, database: "memdb" })
		const next = produce({ uri: after, database: "memdb" })
		expect(next.configuration.settings.deploymentIdentitySha256).toBe(
			run.configuration.settings.deploymentIdentitySha256,
		)
		await expect(
			resume(checkpoint(run), next.configurationHash),
		).rejects.toThrow("configuration hash does not match")
	})

	it.each([
		["serverSelectionTimeoutMs", 20_000],
		["connectTimeoutMs", 20_000],
		["maxPoolSize", 50],
		["minPoolSize", 0],
		["maxConnecting", 4],
		["maxIdleTimeMs", 60_000],
		["networkFamily", 4],
		["socketTimeoutMs", 30_000],
		["heartbeatFrequencyMs", 5_000],
		["serverMonitoringMode", "stream"],
		["waitQueueTimeoutMs", 2_000],
	])("refuses to resume across a configured %s change", async (option, value) => {
		const run = produce()
		const next = produce({ [option]: value })
		expect(next.configurationHash).not.toBe(run.configurationHash)
		await expect(
			resume(checkpoint(run), next.configurationHash),
		).rejects.toThrow("configuration hash does not match")
	})

	it("keeps a b02-keyed-v1 manifest without connection inputs historical", async () => {
		const stored = checkpoint(produce())
		const settings = stored.configuration.settings
		for (const key of Object.keys(settings))
			if (key === "mongodbUriHmac" || key.startsWith("configuredMongoClient."))
				Reflect.deleteProperty(settings, key)
		settings.configurationCoverage = "b02-keyed-v1"
		stored.configurationHash = hashOperationRunConfiguration(
			stored.configuration,
		)
		await expect(
			resume(stored, stored.configurationHash, true),
		).rejects.toThrow(HISTORICAL)
	})

	it("resumes an unmodified rehashed manifest written the same raw way", async () => {
		const stored = checkpoint(produce())
		stored.configurationHash = hashOperationRunConfiguration(
			stored.configuration,
		)
		await expect(
			resume(stored, stored.configurationHash, true),
		).resolves.toMatchObject({ runId: "run-mongodb-input" })
	})

	it.each([
		["mongodbUriHmac", null],
		["mongodbUriHmac", "f".repeat(63)],
		["mongodbUriHmac", "F".repeat(64)],
		["configuredMongoClient.serverSelectionTimeoutMs", null],
		["configuredMongoClient.connectTimeoutMs", 0],
		["configuredMongoClient.maxPoolSize", "10"],
		["configuredMongoClient.maxPoolSize", 1.5],
		["configuredMongoClient.minPoolSize", -1],
		["configuredMongoClient.minPoolSize", null],
		["configuredMongoClient.maxConnecting", 0],
		["configuredMongoClient.maxIdleTimeMs", "60000"],
		["configuredMongoClient.networkFamily", 5],
		["configuredMongoClient.networkFamily", "4"],
		["configuredMongoClient.socketTimeoutMs", -5],
		["configuredMongoClient.heartbeatFrequencyMs", Number.MAX_SAFE_INTEGER + 2],
		["configuredMongoClient.serverMonitoringMode", "always"],
		["configuredMongoClient.waitQueueTimeoutMs", true],
	])("refuses a rehashed manifest whose %s is %j", async (key, value) => {
		const stored = checkpoint(produce())
		stored.configuration.settings[key] = value as never
		stored.configurationHash = hashOperationRunConfiguration(
			stored.configuration,
		)
		await expect(
			resume(stored, stored.configurationHash, true),
		).rejects.toThrow(HISTORICAL)
	})

	it("cannot qualify a run whose resolved config lacks a required client input", async () => {
		const run = produce({ maxPoolSize: undefined })
		expect(
			run.configuration.settings["configuredMongoClient.maxPoolSize"],
		).toBeNull()
		await expect(
			resume(checkpoint(run), run.configurationHash, true),
		).rejects.toThrow(HISTORICAL)
	})
})
