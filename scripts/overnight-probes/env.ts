import type { UnitPrice } from "./budget.ts"
import type { ProbeLetter } from "./types.ts"

export class EnvRefusal extends Error {
	override name = "EnvRefusal"
	constructor(
		readonly missing: string[],
		readonly invalid: string[],
		readonly overrides: string[],
	) {
		const parts: string[] = []
		if (missing.length > 0) parts.push(`missing: ${missing.join(", ")}`)
		if (invalid.length > 0) parts.push(`unusable: ${invalid.join(", ")}`)
		if (overrides.length > 0) {
			parts.push(`refused target overrides: ${overrides.join(", ")}`)
		}
		super(`environment refused (${parts.join("; ")}); values are never printed`)
	}
}

export const URI_ALTERNATIVES = "MEMONGO_MONGODB_URI|MEMONGO_FORCE_MONGODB_URI"
const OVERRIDE_VARIABLES = [
	"MEMONGO_API_URL",
	"MEMONGO_MONGODB_DATABASE",
] as const
const ANSWER_VARIABLES = [
	"MEMONGO_BENCHMARK_ANSWER_API_KEY",
	"MEMONGO_BENCHMARK_ANSWER_BASE_URL",
	"MEMONGO_BENCHMARK_ANSWER_MODEL",
] as const
const PRICE_INPUT = "MEMONGO_PROBE_ANSWER_PRICE_INPUT_USD_PER_MTOK"
const PRICE_OUTPUT = "MEMONGO_PROBE_ANSWER_PRICE_OUTPUT_USD_PER_MTOK"

export type ResolvedEnvironment = {
	mongoUri: string
	answer?: { model: string; price: UnitPrice }
}

type Env = Readonly<Record<string, string | undefined>>

function present(env: Env, name: string): string | undefined {
	const value = env[name]?.trim()
	return value ? value : undefined
}

function positiveFinite(raw: string | undefined): number | undefined {
	if (raw === undefined) return undefined
	const value = Number(raw)
	return Number.isFinite(value) && value > 0 ? value : undefined
}

export function resolveEnvironment(
	env: Env,
	probes: readonly ProbeLetter[],
): ResolvedEnvironment {
	const missing: string[] = []
	const invalid: string[] = []
	const overrides = OVERRIDE_VARIABLES.filter((name) => present(env, name))

	const mongoUri =
		present(env, "MEMONGO_FORCE_MONGODB_URI") ??
		present(env, "MEMONGO_MONGODB_URI")
	if (!mongoUri) missing.push(URI_ALTERNATIVES)
	if (!present(env, "VOYAGE_API_KEY")) missing.push("VOYAGE_API_KEY")

	let answer: ResolvedEnvironment["answer"]
	if (probes.includes("B")) {
		for (const name of ANSWER_VARIABLES) {
			if (!present(env, name)) missing.push(name)
		}
		const rawInput = present(env, PRICE_INPUT)
		const rawOutput = present(env, PRICE_OUTPUT)
		if (rawInput === undefined) missing.push(PRICE_INPUT)
		else if (positiveFinite(rawInput) === undefined) invalid.push(PRICE_INPUT)
		if (rawOutput === undefined) missing.push(PRICE_OUTPUT)
		else if (positiveFinite(rawOutput) === undefined) invalid.push(PRICE_OUTPUT)
		const model = present(env, "MEMONGO_BENCHMARK_ANSWER_MODEL")
		const inputPrice = positiveFinite(rawInput)
		const outputPrice = positiveFinite(rawOutput)
		if (model && inputPrice !== undefined && outputPrice !== undefined) {
			answer = {
				model,
				price: {
					inputUsdPerMTok: inputPrice,
					outputUsdPerMTok: outputPrice,
					source: "operator-env",
				},
			}
		}
	}

	if (missing.length > 0 || invalid.length > 0 || overrides.length > 0) {
		throw new EnvRefusal(missing, invalid, overrides)
	}
	return { mongoUri: mongoUri as string, ...(answer ? { answer } : {}) }
}
