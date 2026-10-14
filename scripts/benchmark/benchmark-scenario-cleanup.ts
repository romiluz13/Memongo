import { createHash } from "node:crypto"
import type {
	BenchmarkCleanupCollectionResult,
	BenchmarkCleanupRegistry,
	BenchmarkScenarioCleanupOutcome,
	BenchmarkScenarioCleanupReport,
} from "../../packages/memory-engine/src/types.js"

/** The fixed registry of collections a scenario cleanup deletes from. */
export const BENCHMARK_SCENARIO_COLLECTION_SUFFIXES = [
	"events",
	"chunks",
	"session_chunks",
	"memory_evidence",
	"structured_mem",
	"structured_mem_revisions",
	"procedures",
	"procedure_revisions",
	"entities",
	"relations",
	"entity_links",
	"episodes",
	"ingest_runs",
	"projection_runs",
	"lane_coverage",
	"relevance_runs",
	"relevance_regressions",
	"relevance_artifacts",
	"recall_traces",
	"memory_jobs",
	"consolidation_runs",
	"memory_mutations",
] as const

export function cleanupRegistry(
	suffixes: readonly string[],
): BenchmarkCleanupRegistry {
	return {
		version: 1,
		digest: createHash("sha256").update(suffixes.join("\n")).digest("hex"),
		collections: suffixes.length,
	}
}

const CURRENT_REGISTRY = cleanupRegistry(BENCHMARK_SCENARIO_COLLECTION_SUFFIXES)
const REGISTERED_SUFFIXES = new Set<string>(
	BENCHMARK_SCENARIO_COLLECTION_SUFFIXES,
)

// mongodb 7.x error classes a deleteMany can surface. Any other name, even
// identifier-shaped, may be caller-controlled text and is reported as unknown.
const KNOWN_CLEANUP_ERROR_NAMES = new Set([
	"MongoAPIError",
	"MongoClientClosedError",
	"MongoDriverError",
	"MongoError",
	"MongoExpiredSessionError",
	"MongoInvalidArgumentError",
	"MongoNetworkError",
	"MongoNetworkTimeoutError",
	"MongoNotConnectedError",
	"MongoOperationTimeoutError",
	"MongoRuntimeError",
	"MongoServerClosedError",
	"MongoServerError",
	"MongoServerSelectionError",
	"MongoStalePrimaryError",
	"MongoTopologyClosedError",
	"MongoWriteConcernError",
])

function isSafeErrorName(value: unknown): value is string {
	return (
		value === "unknown" ||
		(typeof value === "string" && KNOWN_CLEANUP_ERROR_NAMES.has(value))
	)
}

function isCount(value: unknown): value is number {
	return Number.isSafeInteger(value) && (value as number) >= 0
}

/** A known driver error name and numeric code only; never the message. */
export function sanitizedCleanupError(error: unknown): {
	errorName: string
	errorCode?: number
} {
	if (!(error instanceof Error)) return { errorName: "unknown" }
	const code = (error as { code?: unknown }).code
	return {
		errorName: isSafeErrorName(error.name) ? error.name : "unknown",
		...(isCount(code) ? { errorCode: code } : {}),
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

function parseCollectionResult(
	value: unknown,
): BenchmarkCleanupCollectionResult | null {
	if (
		!isRecord(value) ||
		typeof value.suffix !== "string" ||
		!REGISTERED_SUFFIXES.has(value.suffix)
	)
		return null
	const suffix = value.suffix
	if (value.status === "acknowledged")
		return isCount(value.deletedCount)
			? { suffix, status: "acknowledged", deletedCount: value.deletedCount }
			: null
	if (value.status === "unacknowledged")
		return { suffix, status: "unacknowledged" }
	if (value.status !== "rejected" || !isSafeErrorName(value.errorName))
		return null
	if (value.errorCode !== undefined && !isCount(value.errorCode)) return null
	return {
		suffix,
		status: "rejected",
		errorName: value.errorName,
		...(value.errorCode !== undefined ? { errorCode: value.errorCode } : {}),
	}
}

/**
 * A rebuilt outcome when the value is a structurally consistent v1 record over
 * the current registry: acknowledged covers every registered collection once,
 * in order, with an agent; failed shows a failure; retained and not-attempted
 * carry no deletes. Otherwise null. Only validated fields are copied.
 */
export function parseScenarioCleanupOutcome(
	value: unknown,
): BenchmarkScenarioCleanupOutcome | null {
	if (
		!isRecord(value) ||
		value.version !== 1 ||
		typeof value.runId !== "string" ||
		value.runId.length === 0 ||
		typeof value.scenarioId !== "string" ||
		!isRecord(value.registry) ||
		value.registry.version !== CURRENT_REGISTRY.version ||
		value.registry.digest !== CURRENT_REGISTRY.digest ||
		value.registry.collections !== CURRENT_REGISTRY.collections ||
		!Array.isArray(value.collections) ||
		(value.agentId !== null &&
			(typeof value.agentId !== "string" || value.agentId.length === 0)) ||
		(value.errorName !== undefined && !isSafeErrorName(value.errorName))
	)
		return null
	const collections = value.collections.map(parseCollectionResult)
	if (collections.some((entry) => entry === null)) return null
	const entries = collections as BenchmarkCleanupCollectionResult[]
	const suffixes = entries.map((entry) => entry.suffix)
	if (new Set(suffixes).size !== suffixes.length) return null
	const status = value.status
	const agentId = value.agentId as string | null
	const errorName = value.errorName as string | undefined
	if (status === "acknowledged") {
		if (
			agentId === null ||
			errorName !== undefined ||
			suffixes.join("\n") !==
				BENCHMARK_SCENARIO_COLLECTION_SUFFIXES.join("\n") ||
			entries.some((entry) => entry.status !== "acknowledged")
		)
			return null
	} else if (status === "failed") {
		if (
			agentId === null ||
			(errorName === undefined &&
				entries.every((entry) => entry.status === "acknowledged"))
		)
			return null
	} else if (status === "retained" || status === "not-attempted") {
		if (entries.length > 0 || errorName !== undefined) return null
	} else {
		return null
	}
	return {
		version: 1,
		runId: value.runId,
		scenarioId: value.scenarioId,
		agentId,
		status,
		registry: { ...CURRENT_REGISTRY },
		collections: entries,
		...(errorName !== undefined ? { errorName } : {}),
	}
}

/** The summary status is derived from consistent outcomes only. */
export function summarizeScenarioCleanup(
	scenarios: BenchmarkScenarioCleanupReport["scenarios"],
): BenchmarkScenarioCleanupReport {
	const checked = scenarios.map(
		(scenario): BenchmarkScenarioCleanupReport["scenarios"][number] =>
			scenario.status === "unknown"
				? scenario
				: (parseScenarioCleanupOutcome(scenario) ?? {
						scenarioId: scenario.scenarioId,
						status: "unknown",
					}),
	)
	const statuses = checked.map((scenario) => scenario.status)
	return {
		version: 1,
		status: statuses.includes("failed")
			? "failed"
			: statuses.length > 0 &&
					statuses.every((status) => status === "acknowledged")
				? "acknowledged"
				: "incomplete",
		coverage: "registered-scenario-collections",
		scenarios: checked,
	}
}

/** Short, value-free text for a cleanup failure. */
export function describeScenarioCleanupFailure(
	outcome: BenchmarkScenarioCleanupOutcome,
): string {
	const failed = outcome.collections
		.filter((entry) => entry.status !== "acknowledged")
		.map((entry) =>
			entry.status === "rejected"
				? `${entry.suffix}=${entry.errorName}${entry.errorCode !== undefined ? `(${entry.errorCode})` : ""}`
				: `${entry.suffix}=${entry.status}`,
		)
	return `benchmark scenario cleanup ${outcome.status}: scenario=${outcome.scenarioId}${failed.length > 0 ? ` collections=${failed.join(",")}` : ""}${outcome.errorName ? ` error=${outcome.errorName}` : ""}`
}

/**
 * A checkpointed outcome when it is consistent and belongs to this run and
 * scenario; otherwise unknown, which is never clean.
 */
export function restoreScenarioCleanup(
	value: unknown,
	expected: { runId: string; scenarioId: string },
): BenchmarkScenarioCleanupReport["scenarios"][number] {
	const outcome = parseScenarioCleanupOutcome(value)
	return outcome &&
		outcome.runId === expected.runId &&
		outcome.scenarioId === expected.scenarioId
		? outcome
		: { scenarioId: expected.scenarioId, status: "unknown" }
}
