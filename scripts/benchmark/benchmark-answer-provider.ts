/**
 * B1: decouple the benchmark answer model from the extraction model.
 *
 * Until now the benchmark answerer was resolved from the enrichment env
 * (`MEMONGO_ENRICHMENT_*`), which the memory job path also uses for LLM fact
 * extraction — so "extraction off" could only be emulated by unsetting the
 * provider, which also disabled answer generation and made the B20
 * extraction-on/off ablation impossible.
 *
 * Two seams live here:
 *
 *   1. `MEMONGO_BENCHMARK_ANSWER_*` (API_KEY, BASE_URL, MODEL, plus optional
 *      AUTH_STYLE / TOKEN_PARAM) configures a dedicated answerer. When unset,
 *      the answer path falls back to the enrichment provider config — which
 *      `MEMONGO_EXTRACTION_LLM=off` (engine side) leaves untouched.
 *   2. `benchmarkAnswerModelName` is the single source for the answer model
 *      NAME in reports, judge-distinctness checks, and cost attribution, so a
 *      dedicated answerer is compared and disclosed correctly.
 */

import { resolveEnrichmentProvider } from "../../packages/memory-engine/src/mongodb-llm-enrichment.js"
import type { EnrichmentProvider } from "../../packages/memory-engine/src/mongodb-llm-enrichment.js"
import { createSubsystemLogger } from "@memongo/lib"

const log = createSubsystemLogger("benchmark:answer")

export function benchmarkAnswerModelName(
	env: Record<string, string | undefined>,
): string {
	const explicit = env.MEMONGO_BENCHMARK_ANSWER_MODEL?.trim()
	if (explicit) return explicit
	return env.MEMONGO_ENRICHMENT_MODEL?.trim() ?? ""
}

/**
 * F-B1-2: which provider config the answerer resolved from, recorded in the
 * run configuration manifest so a fallback run is never mistaken for a
 * dedicated-answerer run.
 */
export function benchmarkAnswerProviderSource(
	env: Record<string, string | undefined>,
): "dedicated" | "enrichment-fallback" {
	return env.MEMONGO_BENCHMARK_ANSWER_API_KEY?.trim()
		? "dedicated"
		: "enrichment-fallback"
}

export function resolveBenchmarkAnswerProvider(
	env: Record<string, string | undefined>,
): EnrichmentProvider | null {
	const apiKey = env.MEMONGO_BENCHMARK_ANSWER_API_KEY?.trim()
	if (!apiKey) {
		// No separately configured answerer: the answer path shares the
		// enrichment provider config. Extraction-off (engine side) does not
		// unset it, so the answerer survives the B20 ablation.
		// F-B1-2: a half-configured dedicated answerer must not fall back
		// silently — ANSWER_MODEL / ANSWER_BASE_URL without ANSWER_API_KEY
		// would otherwise send the answer model name to the enrichment
		// endpoint without any trace.
		const ignoredConfig = [
			env.MEMONGO_BENCHMARK_ANSWER_MODEL?.trim()
				? "MEMONGO_BENCHMARK_ANSWER_MODEL"
				: null,
			env.MEMONGO_BENCHMARK_ANSWER_BASE_URL?.trim()
				? "MEMONGO_BENCHMARK_ANSWER_BASE_URL"
				: null,
		].filter((entry): entry is string => entry !== null)
		if (ignoredConfig.length > 0) {
			log.warn(
				"benchmark answerer falls back to the enrichment provider: MEMONGO_BENCHMARK_ANSWER_API_KEY is unset",
				{
					answerProviderSource: "enrichment-fallback",
					ignoredConfig,
				},
			)
		}
		return resolveEnrichmentProvider(env)
	}
	// Reuse the enrichment resolver's validation and construction by mapping
	// the answer env onto it, so a dedicated answerer gets the same
	// misconfiguration errors (missing BASE_URL / MODEL) and the same
	// auth-style / token-param / private-network handling.
	return resolveEnrichmentProvider({
		...env,
		MEMONGO_ENRICHMENT_API_KEY: apiKey,
		MEMONGO_ENRICHMENT_BASE_URL: env.MEMONGO_BENCHMARK_ANSWER_BASE_URL,
		MEMONGO_ENRICHMENT_MODEL: env.MEMONGO_BENCHMARK_ANSWER_MODEL,
		MEMONGO_ENRICHMENT_PROVIDER: env.MEMONGO_BENCHMARK_ANSWER_PROVIDER,
		MEMONGO_ENRICHMENT_AUTH_STYLE: env.MEMONGO_BENCHMARK_ANSWER_AUTH_STYLE,
		MEMONGO_ENRICHMENT_TOKEN_PARAM: env.MEMONGO_BENCHMARK_ANSWER_TOKEN_PARAM,
		MEMONGO_ENRICHMENT_ALLOW_PRIVATE_NETWORK:
			env.MEMONGO_BENCHMARK_ANSWER_ALLOW_PRIVATE_NETWORK,
	})
}
