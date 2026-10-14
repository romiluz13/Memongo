import { createHash } from "node:crypto"
import type {
	BenchmarkCleanupCollectionResult,
	BenchmarkCleanupRegistry,
	BenchmarkScenarioCleanupOutcome,
	BenchmarkScenarioCleanupReport,
} from "../../packages/memory-engine/src/types.js"

export function cleanupRegistry(
	suffixes: readonly string[],
): BenchmarkCleanupRegistry {
	return {
		version: 1,
		digest: createHash("sha256").update(suffixes.join("\n")).digest("hex"),
		collections: suffixes.length,
	}
}

/** Driver error name and code only; the message can carry URIs or data. */
export function sanitizedCleanupError(error: unknown): {
	errorName: string
	errorCode?: string | number
} {
	if (!(error instanceof Error)) return { errorName: "unknown" }
	const code = (error as { code?: unknown }).code
	return {
		errorName: /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(error.name)
			? error.name
			: "unknown",
		...(typeof code === "number" ||
		(typeof code === "string" && /^[A-Za-z0-9_]{1,64}$/.test(code))
			? { errorCode: code }
			: {}),
	}
}

export function summarizeScenarioCleanup(
	scenarios: BenchmarkScenarioCleanupReport["scenarios"],
): BenchmarkScenarioCleanupReport {
	const statuses = scenarios.map((scenario) => scenario.status)
	return {
		version: 1,
		status: statuses.includes("failed")
			? "failed"
			: statuses.length > 0 &&
					statuses.every((status) => status === "acknowledged")
				? "acknowledged"
				: "incomplete",
		coverage: "registered-scenario-collections",
		scenarios,
	}
}

/** Short, value-free text for an error that is already propagating. */
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

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isCollectionResult(
	value: unknown,
): value is BenchmarkCleanupCollectionResult {
	if (!isRecord(value) || typeof value.suffix !== "string") return false
	if (value.status === "acknowledged")
		return Number.isInteger(value.deletedCount)
	if (value.status === "unacknowledged") return true
	return value.status === "rejected" && typeof value.errorName === "string"
}

/**
 * A checkpointed outcome when it is a well-formed v1 record for this run,
 * scenario and collection registry; otherwise unknown, which is never clean.
 */
export function restoreScenarioCleanup(
	value: unknown,
	expected: {
		runId: string
		scenarioId: string
		registry: BenchmarkCleanupRegistry
	},
): BenchmarkScenarioCleanupReport["scenarios"][number] {
	if (
		isRecord(value) &&
		value.version === 1 &&
		value.runId === expected.runId &&
		value.scenarioId === expected.scenarioId &&
		(value.agentId === null || typeof value.agentId === "string") &&
		["acknowledged", "failed", "retained", "not-attempted"].includes(
			value.status as string,
		) &&
		isRecord(value.registry) &&
		value.registry.version === expected.registry.version &&
		value.registry.digest === expected.registry.digest &&
		value.registry.collections === expected.registry.collections &&
		Array.isArray(value.collections) &&
		value.collections.every(isCollectionResult) &&
		(value.status !== "acknowledged" ||
			(value.collections.length > 0 &&
				value.collections.length === value.registry.collections &&
				value.collections.every((entry) => entry.status === "acknowledged")))
	)
		return value as BenchmarkScenarioCleanupOutcome
	return { scenarioId: expected.scenarioId, status: "unknown" }
}
