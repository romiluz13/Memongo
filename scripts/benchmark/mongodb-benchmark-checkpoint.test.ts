import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { hashOperationRunConfiguration } from "../../packages/memory-engine/src/mongodb-operation-accounting.js"
import { producedRunConfiguration } from "./benchmark-run-configuration.fixture.js"
import { hasCompleteConfigurationCoverage } from "./benchmark-run-configuration-schema.js"
import {
	readBenchmarkCheckpoint,
	writeBenchmarkCheckpointAtomic,
	type BenchmarkCheckpoint,
} from "./mongodb-benchmark-checkpoint.js"

const { configuration: CONFIGURATION, configurationHash: CONFIGURATION_HASH } =
	producedRunConfiguration()

function checkpoint(): BenchmarkCheckpoint {
	return {
		version: 2,
		failedLines: 0,
		runId: "run-1",
		datasetSha256: "a".repeat(64),
		configurationHash: CONFIGURATION_HASH,
		configuration: structuredClone(CONFIGURATION),
		executableDigest: "d".repeat(64),
		totalScenarios: 2,
		scenarioIds: ["scenario-1", "scenario-2"],
		completedScenarios: [
			{
				index: 0,
				scenarioId: "scenario-1",
				executionsByPass: [[]],
				ingest: {
					conversationsIngested: 1,
					turnsIngested: 2,
					skippedConversations: 0,
					failedTurns: 0,
				},
				expectedSessionEntries: [["case-1", ["session-1"]]],
				expectedTurnEntries: [["case-1", ["turn-1"]]],
				storageCollections: [],
			},
		],
		accounting: {
			currency: null,
			totalCost: null,
			unavailableReason: "prices unavailable",
			operations: [],
		},
		updatedAt: "2026-08-12T12:00:00.000Z",
	}
}

describe("QA protocol resume identity", () => {
	it("records custom-v2 as covered and never resumes it as custom-v1", async () => {
		const v1 = producedRunConfiguration({
			MEMONGO_BENCHMARK_QA_PROTOCOL: "custom-v1",
		})
		const v2 = producedRunConfiguration({
			MEMONGO_BENCHMARK_QA_PROTOCOL: "custom-v2",
		})
		expect(v2.configuration.settings["env.MEMONGO_BENCHMARK_QA_PROTOCOL"]).toBe(
			"custom-v2",
		)
		expect(hasCompleteConfigurationCoverage(v2.configuration.settings)).toBe(
			true,
		)
		expect(
			hasCompleteConfigurationCoverage({
				...v2.configuration.settings,
				"env.MEMONGO_BENCHMARK_QA_PROTOCOL": "custom-v4",
			}),
		).toBe(false)
		expect(v2.configurationHash).not.toBe(v1.configurationHash)

		const dir = await mkdtemp(path.join(os.tmpdir(), "memongo-checkpoint-"))
		const checkpointPath = path.join(dir, "release.json")
		try {
			await writeBenchmarkCheckpointAtomic(checkpointPath, {
				...checkpoint(),
				configurationHash: v2.configurationHash,
				configuration: structuredClone(v2.configuration),
			})
			const expected = {
				datasetSha256: "a".repeat(64),
				executableDigest: "d".repeat(64),
				scenarioIds: ["scenario-1", "scenario-2"],
			}
			await expect(
				readBenchmarkCheckpoint(checkpointPath, {
					...expected,
					configurationHash: v2.configurationHash,
				}),
			).resolves.toMatchObject({ runId: "run-1" })
			await expect(
				readBenchmarkCheckpoint(checkpointPath, {
					...expected,
					configurationHash: v1.configurationHash,
				}),
			).rejects.toThrow("configuration hash does not match")
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	})
})

describe("benchmark scenario checkpoint", () => {
	it("writes atomically and restores only an identical run configuration", async () => {
		const dir = await mkdtemp(path.join(os.tmpdir(), "memongo-checkpoint-"))
		const checkpointPath = path.join(dir, "release.json")
		try {
			await writeBenchmarkCheckpointAtomic(checkpointPath, checkpoint())

			const parsed = JSON.parse(await readFile(checkpointPath, "utf8"))
			expect(parsed.completedScenarios).toHaveLength(1)
			await expect(
				readBenchmarkCheckpoint(checkpointPath, {
					datasetSha256: "a".repeat(64),
					configurationHash: CONFIGURATION_HASH,
					executableDigest: "d".repeat(64),
					scenarioIds: ["scenario-1", "scenario-2"],
				}),
			).resolves.toMatchObject({
				runId: "run-1",
				completedScenarios: [{ index: 0, scenarioId: "scenario-1" }],
			})
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	})

	it("rejects a checkpoint from a different configuration", async () => {
		const dir = await mkdtemp(path.join(os.tmpdir(), "memongo-checkpoint-"))
		const checkpointPath = path.join(dir, "release.json")
		try {
			await writeBenchmarkCheckpointAtomic(checkpointPath, checkpoint())
			await expect(
				readBenchmarkCheckpoint(checkpointPath, {
					datasetSha256: "a".repeat(64),
					configurationHash: "c".repeat(64),
					executableDigest: "d".repeat(64),
					scenarioIds: ["scenario-1", "scenario-2"],
				}),
			).rejects.toThrow("configuration hash does not match")
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	})

	it("rejects a checkpoint written by different executable source", async () => {
		const dir = await mkdtemp(path.join(os.tmpdir(), "memongo-checkpoint-"))
		const checkpointPath = path.join(dir, "release.json")
		try {
			await writeBenchmarkCheckpointAtomic(checkpointPath, checkpoint())
			await expect(
				readBenchmarkCheckpoint(checkpointPath, {
					datasetSha256: "a".repeat(64),
					configurationHash: CONFIGURATION_HASH,
					executableDigest: "e".repeat(64),
					scenarioIds: ["scenario-1", "scenario-2"],
				}),
			).rejects.toThrow("executable digest does not match")
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	})

	it("refuses to resume when the current executable identity is unavailable", async () => {
		const dir = await mkdtemp(path.join(os.tmpdir(), "memongo-checkpoint-"))
		const checkpointPath = path.join(dir, "release.json")
		try {
			await writeBenchmarkCheckpointAtomic(checkpointPath, checkpoint())
			await expect(
				readBenchmarkCheckpoint(checkpointPath, {
					datasetSha256: "a".repeat(64),
					configurationHash: CONFIGURATION_HASH,
					executableDigest: null,
					scenarioIds: ["scenario-1", "scenario-2"],
				}),
			).rejects.toThrow("executable identity is unavailable")
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	})

	it("keeps an unbound version 1 checkpoint historical instead of resuming it", async () => {
		const dir = await mkdtemp(path.join(os.tmpdir(), "memongo-checkpoint-"))
		const checkpointPath = path.join(dir, "release.json")
		try {
			const { executableDigest: _digest, ...legacy } = checkpoint()
			await writeFile(checkpointPath, JSON.stringify({ ...legacy, version: 1 }))
			await expect(
				readBenchmarkCheckpoint(checkpointPath, {
					datasetSha256: "a".repeat(64),
					configurationHash: CONFIGURATION_HASH,
					executableDigest: "d".repeat(64),
					scenarioIds: ["scenario-1", "scenario-2"],
				}),
			).rejects.toThrow("not bound to executable source")
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	})

	it.each([
		[
			"missing",
			(cp: BenchmarkCheckpoint) => Reflect.deleteProperty(cp, "configuration"),
		],
		[
			"tampered",
			(cp: BenchmarkCheckpoint) =>
				Reflect.set(cp.configuration.settings, "numCandidates", 999),
		],
		[
			"incomplete rehashed",
			(cp: BenchmarkCheckpoint) => {
				Reflect.deleteProperty(
					cp.configuration.settings,
					"env.MEMONGO_BENCHMARK_JUDGE_BASE_URL.hmac",
				)
				cp.configurationHash = hashOperationRunConfiguration(cp.configuration)
			},
		],
		[
			"older-coverage",
			(cp: BenchmarkCheckpoint) =>
				Reflect.deleteProperty(
					cp.configuration.settings,
					"configurationCoverage",
				),
		],
	])("refuses to resume a %s configuration manifest", async (_name, edit) => {
		const dir = await mkdtemp(path.join(os.tmpdir(), "memongo-checkpoint-"))
		const checkpointPath = path.join(dir, "release.json")
		try {
			const stored = checkpoint()
			edit(stored)
			await writeFile(checkpointPath, JSON.stringify(stored))
			await expect(
				readBenchmarkCheckpoint(checkpointPath, {
					datasetSha256: "a".repeat(64),
					configurationHash: stored.configurationHash,
					executableDigest: "d".repeat(64),
					scenarioIds: ["scenario-1", "scenario-2"],
				}),
			).rejects.toThrow("configuration manifest is missing")
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	})
})

describe("checkpoint ingest integrity", () => {
	it.each([
		undefined,
		null,
		-1,
		0.5,
		"0",
		Number.NaN,
	])("refuses malformed resumed failure counts (%s)", async (bad) => {
		const dir = await mkdtemp(path.join(os.tmpdir(), "checkpoint-count-"))
		const file = path.join(dir, "checkpoint.json")
		try {
			const cp = checkpoint()
			Reflect.set(cp.completedScenarios[0]!.ingest, "failedTurns", bad)
			await writeBenchmarkCheckpointAtomic(file, cp)
			await expect(
				readBenchmarkCheckpoint(file, {
					datasetSha256: cp.datasetSha256,
					configurationHash: cp.configurationHash,
					executableDigest: cp.executableDigest,
					scenarioIds: cp.scenarioIds,
				}),
			).rejects.toThrow("ingest")
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	})
	it("binds the timestamp policy into the produced configuration", () => {
		expect(CONFIGURATION.settings.timestampPolicyVersion).toBe(
			"benchmark-timestamp-utc-fields-literal12h-v1",
		)
	})
})

describe("timestamp policy resume identity", () => {
	it("refuses a self-consistent checkpoint from another timestamp policy", async () => {
		const cp = checkpoint()
		cp.configuration.settings.timestampPolicyVersion = "older-policy"
		cp.configurationHash = hashOperationRunConfiguration(cp.configuration)
		const dir = await mkdtemp(path.join(os.tmpdir(), "checkpoint-policy-"))
		try {
			const file = path.join(dir, "checkpoint.json")
			await writeBenchmarkCheckpointAtomic(file, cp)
			await expect(
				readBenchmarkCheckpoint(file, {
					datasetSha256: cp.datasetSha256,
					configurationHash: CONFIGURATION_HASH,
					executableDigest: cp.executableDigest,
					scenarioIds: cp.scenarioIds,
				}),
			).rejects.toThrow("configuration hash does not match")
			await expect(
				readBenchmarkCheckpoint(file, {
					datasetSha256: cp.datasetSha256,
					configurationHash: cp.configurationHash,
					executableDigest: cp.executableDigest,
					scenarioIds: cp.scenarioIds,
				}),
			).rejects.toThrow("manifest")
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	})
})

describe("checkpoint line counter admission", () => {
	it.each([
		undefined,
		null,
		-1,
		0.5,
		"0",
	])("rejects invalid failedLines %s", async (failedLines) => {
		const dir = await mkdtemp(path.join(os.tmpdir(), "checkpoint-lines-"))
		try {
			const file = path.join(dir, "checkpoint.json")
			await writeFile(file, JSON.stringify({ ...checkpoint(), failedLines }))
			await expect(
				readBenchmarkCheckpoint(file, {
					datasetSha256: "a".repeat(64),
					configurationHash: CONFIGURATION_HASH,
					executableDigest: "d".repeat(64),
					scenarioIds: ["scenario-1", "scenario-2"],
				}),
			).rejects.toThrow("failedLines")
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	})
})

describe("checkpoint rejection counter admission", () => {
	it.each([
		["rejectedTurns", -1],
		["rejectedTurns", null],
		["rejectedConversations", 0.5],
		["rejectedConversations", "0"],
	])("rejects invalid %s %s", async (field, count) => {
		const dir = await mkdtemp(path.join(os.tmpdir(), "checkpoint-rejections-"))
		try {
			const file = path.join(dir, "checkpoint.json")
			await writeFile(file, JSON.stringify({ ...checkpoint(), [field]: count }))
			await expect(
				readBenchmarkCheckpoint(file, {
					datasetSha256: "a".repeat(64),
					configurationHash: CONFIGURATION_HASH,
					executableDigest: "d".repeat(64),
					scenarioIds: ["scenario-1", "scenario-2"],
				}),
			).rejects.toThrow(field)
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	})
})

describe("checkpoint adapter diagnostics totals admission (#94)", () => {
	const totals = {
		rejectedTurns: 1,
		rejectedSessions: 0,
		emptiedSessions: 0,
		rejectedQuestions: 2,
		rejectedQaItems: 0,
		informationalSkips: 12,
	}
	const read = async (adapterDiagnosticsTotals: unknown) => {
		const dir = await mkdtemp(path.join(os.tmpdir(), "checkpoint-adapter-"))
		try {
			const file = path.join(dir, "checkpoint.json")
			await writeFile(
				file,
				JSON.stringify({ ...checkpoint(), adapterDiagnosticsTotals }),
			)
			return await readBenchmarkCheckpoint(file, {
				datasetSha256: "a".repeat(64),
				configurationHash: CONFIGURATION_HASH,
				executableDigest: "d".repeat(64),
				scenarioIds: ["scenario-1", "scenario-2"],
			})
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	}

	it("restores exactly the six totals", async () => {
		expect((await read(totals)).adapterDiagnosticsTotals).toEqual(totals)
	})

	it.each([
		["not an object", 3],
		["missing a key", { ...totals, informationalSkips: undefined }],
		["carrying an extra key", { ...totals, rejectedDialogs: 0 }],
		["negative", { ...totals, rejectedTurns: -1 }],
		["fractional", { ...totals, rejectedQuestions: 0.5 }],
	])("rejects totals that are %s", async (_label, value) => {
		await expect(read(value)).rejects.toThrow("adapterDiagnosticsTotals")
	})
})
