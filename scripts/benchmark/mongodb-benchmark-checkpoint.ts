import { randomUUID } from "node:crypto"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import path from "node:path"
import type {
	BenchmarkCostAccounting,
	BenchmarkTenantStorageMeasurement,
} from "../../packages/memory-engine/src/types.js"
import type { BenchmarkCaseExecution } from "./mongodb-benchmark-runner.js"

export type BenchmarkCheckpointIngest = {
	conversationsIngested: number
	turnsIngested: number
	skippedConversations: number
	failedTurns: number
}

export type BenchmarkCheckpointScenario = {
	index: number
	scenarioId: string
	executionsByPass: BenchmarkCaseExecution[][]
	ingest: BenchmarkCheckpointIngest
	expectedSessionEntries: Array<[string, string[]]>
	expectedTurnEntries: Array<[string, string[]]>
	storageCollections: BenchmarkTenantStorageMeasurement["collections"]
	storageFailure?: string
}

export type BenchmarkCheckpoint = {
	version: 1
	runId: string
	datasetSha256: string
	configurationHash: string
	totalScenarios: number
	scenarioIds: string[]
	completedScenarios: BenchmarkCheckpointScenario[]
	accounting: BenchmarkCostAccounting
	updatedAt: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

function assertCheckpointShape(
	value: unknown,
): asserts value is BenchmarkCheckpoint {
	if (!isRecord(value) || value.version !== 1) {
		throw new Error("benchmark checkpoint has an unsupported format")
	}
	for (const field of [
		"runId",
		"datasetSha256",
		"configurationHash",
		"updatedAt",
	] as const) {
		if (typeof value[field] !== "string" || value[field].length === 0) {
			throw new Error(`benchmark checkpoint field ${field} is invalid`)
		}
	}
	if (
		!Number.isInteger(value.totalScenarios) ||
		(value.totalScenarios as number) < 0 ||
		!Array.isArray(value.scenarioIds) ||
		!value.scenarioIds.every((entry) => typeof entry === "string") ||
		!Array.isArray(value.completedScenarios) ||
		!isRecord(value.accounting)
	) {
		throw new Error("benchmark checkpoint is incomplete")
	}
}

export async function readBenchmarkCheckpoint(
	checkpointPath: string,
	expected: {
		datasetSha256: string
		configurationHash: string
		scenarioIds: string[]
	},
): Promise<BenchmarkCheckpoint> {
	const parsed: unknown = JSON.parse(await readFile(checkpointPath, "utf8"))
	assertCheckpointShape(parsed)
	if (parsed.datasetSha256 !== expected.datasetSha256) {
		throw new Error("benchmark checkpoint dataset digest does not match")
	}
	if (parsed.configurationHash !== expected.configurationHash) {
		throw new Error("benchmark checkpoint configuration hash does not match")
	}
	if (
		parsed.totalScenarios !== expected.scenarioIds.length ||
		parsed.scenarioIds.length !== expected.scenarioIds.length ||
		parsed.scenarioIds.some(
			(scenarioId, index) => scenarioId !== expected.scenarioIds[index],
		)
	) {
		throw new Error("benchmark checkpoint scenario manifest does not match")
	}
	const seen = new Set<number>()
	for (const scenario of parsed.completedScenarios) {
		if (
			!isRecord(scenario) ||
			!Number.isInteger(scenario.index) ||
			typeof scenario.scenarioId !== "string" ||
			scenario.index < 0 ||
			scenario.index >= expected.scenarioIds.length ||
			expected.scenarioIds[scenario.index] !== scenario.scenarioId ||
			seen.has(scenario.index)
		) {
			throw new Error("benchmark checkpoint completed scenario is invalid")
		}
		seen.add(scenario.index)
	}
	return parsed
}

export async function writeBenchmarkCheckpointAtomic(
	checkpointPath: string,
	checkpoint: BenchmarkCheckpoint,
): Promise<void> {
	const directory = path.dirname(checkpointPath)
	await mkdir(directory, { recursive: true })
	const temporaryPath = path.join(
		directory,
		`.${path.basename(checkpointPath)}.${process.pid}.${randomUUID()}.tmp`,
	)
	await writeFile(temporaryPath, `${JSON.stringify(checkpoint, null, 2)}\n`, {
		encoding: "utf8",
		flag: "wx",
	})
	await rename(temporaryPath, checkpointPath)
}
