import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { describe, expect, it } from "vitest"
import {
	readBenchmarkCheckpoint,
	writeBenchmarkCheckpointAtomic,
	type BenchmarkCheckpoint,
} from "./mongodb-benchmark-checkpoint.js"

function checkpoint(): BenchmarkCheckpoint {
	return {
		version: 2,
		runId: "run-1",
		datasetSha256: "a".repeat(64),
		configurationHash: "b".repeat(64),
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
					configurationHash: "b".repeat(64),
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
					configurationHash: "b".repeat(64),
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
					configurationHash: "b".repeat(64),
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
					configurationHash: "b".repeat(64),
					executableDigest: "d".repeat(64),
					scenarioIds: ["scenario-1", "scenario-2"],
				}),
			).rejects.toThrow("not bound to executable source")
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	})
})
