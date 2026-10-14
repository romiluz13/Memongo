import { randomUUID } from "node:crypto"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import path from "node:path"
import {
	type OperationRunConfiguration,
	hashOperationRunConfiguration,
} from "../../packages/memory-engine/src/mongodb-operation-accounting.js"
import type {
	BenchmarkCostAccounting,
	BenchmarkTenantStorageMeasurement,
} from "../../packages/memory-engine/src/types.js"
import { hasCompleteConfigurationCoverage } from "./benchmark-run-configuration-schema.js"
import type { BenchmarkCaseExecution } from "./mongodb-benchmark-runner.js"

export { BENCHMARK_CONFIGURATION_COVERAGE } from "./benchmark-run-configuration-schema.js"

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
	version: 2
	runId: string
	datasetSha256: string
	configurationHash: string
	/** The exact run configuration hashed into configurationHash. */
	configuration: OperationRunConfiguration
	/** computeExecutableDigest captured once at run admission; resume requires the same value. */
	executableDigest: string
	totalScenarios: number
	scenarioIds: string[]
	completedScenarios: BenchmarkCheckpointScenario[]
	accounting: BenchmarkCostAccounting
	updatedAt: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

const CONFIGURATION_FIELDS = [
	"executionProfile",
	"maxResults",
	"minScore",
	"retrievalLane",
	"settings",
]

function finiteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value)
}

/**
 * The persisted manifest when it has the exact top-level shape, complete
 * supported settings coverage (benchmark-run-configuration-schema) and hashes
 * to configurationHash; otherwise null. -0 is accepted as 0, which is how it
 * hashes. Never reports values.
 */
export function parseBoundRunConfiguration(
	value: unknown,
	configurationHash: unknown,
): OperationRunConfiguration | null {
	if (
		!isRecord(value) ||
		Object.keys(value).sort().join() !== CONFIGURATION_FIELDS.join() ||
		(value.executionProfile !== "shipped" &&
			value.executionProfile !== "diagnostic") ||
		(value.retrievalLane !== "native" &&
			value.retrievalLane !== "raw-session") ||
		!finiteNumber(value.maxResults) ||
		!finiteNumber(value.minScore) ||
		!isRecord(value.settings) ||
		!hasCompleteConfigurationCoverage(value.settings)
	)
		return null
	const configuration = value as OperationRunConfiguration
	return hashOperationRunConfiguration(configuration) === configurationHash
		? configuration
		: null
}

function assertCheckpointShape(
	value: unknown,
): asserts value is BenchmarkCheckpoint {
	if (isRecord(value) && value.version === 1) {
		throw new Error(
			"benchmark checkpoint version 1 is not bound to executable source; analyze it as historical only and start a new run",
		)
	}
	if (!isRecord(value) || value.version !== 2) {
		throw new Error("benchmark checkpoint has an unsupported format")
	}
	for (const field of [
		"runId",
		"datasetSha256",
		"configurationHash",
		"executableDigest",
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
		/** null when the current executable identity cannot be computed. */
		executableDigest: string | null
		scenarioIds: string[]
	},
): Promise<BenchmarkCheckpoint> {
	if (expected.executableDigest === null) {
		throw new Error(
			"benchmark resume refused: the current executable identity is unavailable (run from a git work tree)",
		)
	}
	const parsed: unknown = JSON.parse(await readFile(checkpointPath, "utf8"))
	assertCheckpointShape(parsed)
	if (parsed.datasetSha256 !== expected.datasetSha256) {
		throw new Error("benchmark checkpoint dataset digest does not match")
	}
	if (parsed.configurationHash !== expected.configurationHash) {
		throw new Error("benchmark checkpoint configuration hash does not match")
	}
	if (
		!parseBoundRunConfiguration(parsed.configuration, parsed.configurationHash)
	) {
		throw new Error(
			"benchmark checkpoint configuration manifest is missing, unsupported or does not match its hash; analyze it as historical only and start a new run",
		)
	}
	if (parsed.executableDigest !== expected.executableDigest) {
		throw new Error(
			"benchmark checkpoint executable digest does not match: source, lockfile or runtime changed since it was written",
		)
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
