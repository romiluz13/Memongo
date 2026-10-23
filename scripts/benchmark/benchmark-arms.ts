/**
 * Paired benchmark arms: one ingest per question, then every arm searches,
 * answers and judges against the same stored data before cleanup. An arm
 * fixes the two query-time settings under test, the QA protocol and session
 * turn recall, so ingestion and enrichment noise cannot differ between arms.
 *
 * Syntax: MEMONGO_BENCHMARK_ARMS=name=protocol[+recall],... in run order;
 * the first arm is the paired report's baseline. Example:
 *   v1=custom-v1,v2=custom-v2,v3=custom-v3,v3r=custom-v3+recall
 * or, for the reader contract, v3r=custom-v3+recall,v4r=custom-v4+recall
 */
import {
	type OperationRunConfiguration,
	hashOperationRunConfiguration,
} from "../../packages/memory-engine/src/mongodb-operation-accounting.js"
import type { E2eQaProtocol } from "../mongodb-e2e-qa.js"

export const BENCHMARK_ARMS_ENV = "MEMONGO_BENCHMARK_ARMS"

export type BenchmarkArm = {
	name: string
	protocol: E2eQaProtocol
	sessionTurnRecall: boolean
}

const ARM_PROTOCOLS: readonly E2eQaProtocol[] = [
	"custom-v1",
	"custom-v2",
	"custom-v3",
	"custom-v4",
]
const DURABLE_PROTOCOLS = new Set(["official", "custom-judge"])
const ARM_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/

function parseArm(entry: string): BenchmarkArm {
	const separator = entry.indexOf("=")
	const name = entry.slice(0, separator).trim()
	if (separator < 0 || name === "") {
		throw new Error(
			`${BENCHMARK_ARMS_ENV} entry "${entry}" is not name=protocol[+recall]`,
		)
	}
	if (!ARM_NAME.test(name)) {
		throw new Error(
			`arm name "${name}" must match ${ARM_NAME.source} (letters, digits, _ or -)`,
		)
	}
	const [protocol = "", ...modifiers] = entry
		.slice(separator + 1)
		.split("+")
		.map((part) => part.trim())
	if (DURABLE_PROTOCOLS.has(protocol)) {
		throw new Error(
			`arm ${name} uses ${protocol}: official and custom-judge cannot run as paired arms`,
		)
	}
	if (!(ARM_PROTOCOLS as readonly string[]).includes(protocol)) {
		throw new Error(
			`arm ${name} has unknown protocol "${protocol}"; arms take ${ARM_PROTOCOLS.join(", ")}`,
		)
	}
	const unknown = modifiers.find((modifier) => modifier !== "recall")
	if (unknown !== undefined || modifiers.length > 1) {
		throw new Error(
			`arm ${name} has unknown modifier "${unknown ?? modifiers.join("+")}"; the only modifier is +recall`,
		)
	}
	return {
		name,
		protocol: protocol as E2eQaProtocol,
		sessionTurnRecall: modifiers.length === 1,
	}
}

export function parseBenchmarkArms(raw: string): BenchmarkArm[] {
	if (raw.trim() === "") {
		throw new Error(`${BENCHMARK_ARMS_ENV} is set but names no arms`)
	}
	const arms = raw.split(",").map((entry) => parseArm(entry.trim()))
	const seen = new Set<string>()
	for (const arm of arms) {
		if (seen.has(arm.name)) {
			throw new Error(`duplicate arm name "${arm.name}"`)
		}
		seen.add(arm.name)
	}
	if (arms.length < 2) {
		throw new Error(`a paired run needs at least two arms; got ${arms.length}`)
	}
	return arms
}

/**
 * The arms the run executes, or undefined when the setting is absent. A set
 * but blank value is refused, as is any env setting an arm would override.
 */
export function resolveBenchmarkArms(
	env: Record<string, string | undefined>,
): BenchmarkArm[] | undefined {
	const raw = env[BENCHMARK_ARMS_ENV]
	if (raw === undefined) return undefined
	const arms = parseBenchmarkArms(raw)
	if (env.MEMONGO_BENCHMARK_QA_PROTOCOL?.trim()) {
		throw new Error(
			`${BENCHMARK_ARMS_ENV} fixes each arm's QA protocol: unset MEMONGO_BENCHMARK_QA_PROTOCOL`,
		)
	}
	if (env.MEMONGO_SESSION_TURN_RECALL?.trim()) {
		throw new Error(
			`${BENCHMARK_ARMS_ENV} fixes session turn recall per arm: unset MEMONGO_SESSION_TURN_RECALL`,
		)
	}
	return arms
}

/** CLI preflight: the refusal message, or null when the run may proceed. */
export function benchmarkArmsRunError(
	env: Record<string, string | undefined>,
	options: { publishable: boolean },
): string | null {
	let arms: BenchmarkArm[] | undefined
	try {
		arms = resolveBenchmarkArms(env)
	} catch (error) {
		return error instanceof Error ? error.message : String(error)
	}
	if (arms && options.publishable) {
		return `${BENCHMARK_ARMS_ENV} cannot run on the publishable full500 run: use --questions or --sample`
	}
	return null
}

/**
 * The arm's own configuration identity: the run's, naming the arm and its
 * QA protocol, with the turn recall mode the arm's searches use.
 */
export function benchmarkArmConfiguration(
	run: OperationRunConfiguration,
	arm: BenchmarkArm,
): { configuration: OperationRunConfiguration; configurationHash: string } {
	const configuration: OperationRunConfiguration = {
		...run,
		settings: {
			...run.settings,
			benchmarkArm: arm.name,
			benchmarkArmQaProtocol: arm.protocol,
			effectiveSessionTurnRecall: arm.sessionTurnRecall,
		},
	}
	return {
		configuration,
		configurationHash: hashOperationRunConfiguration(configuration),
	}
}
