const DEFAULT_BENCHMARK_PREFIX_BASE = "memongo_bench_"
const MAX_RUN_ID_SEGMENT_LENGTH = 64

export type BenchmarkCollectionPrefixResolution = {
	collectionPrefix: string
	source: "explicit" | "derived"
}

export function normalizeBenchmarkRunIdForPrefix(runId: string): string {
	const normalized = runId
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "_")
		.replace(/^_+|_+$/g, "")
		.replace(/_+/g, "_")
		.slice(0, MAX_RUN_ID_SEGMENT_LENGTH)
		.replace(/_+$/g, "")
	return normalized || "run"
}

export function validateBenchmarkCollectionPrefix(prefix: string): void {
	if (!prefix) {
		throw new Error("benchmark collection prefix must not be empty")
	}
	if (!prefix.startsWith("memongo_bench_")) {
		throw new Error(
			`benchmark collection prefix must start with memongo_bench_, got ${prefix}`,
		)
	}
	if (!prefix.endsWith("_")) {
		throw new Error(
			`benchmark collection prefix must end with _, got ${prefix}`,
		)
	}
	if (!/^[a-z0-9_]+$/.test(prefix)) {
		throw new Error(
			`benchmark collection prefix must contain only lowercase letters, numbers, and underscores, got ${prefix}`,
		)
	}
}

export function resolveBenchmarkCollectionPrefix(params: {
	runId: string
	explicitPrefix?: string
}): BenchmarkCollectionPrefixResolution {
	const explicit = params.explicitPrefix?.trim()
	if (explicit) {
		validateBenchmarkCollectionPrefix(explicit)
		return { collectionPrefix: explicit, source: "explicit" }
	}
	const collectionPrefix = `${DEFAULT_BENCHMARK_PREFIX_BASE}${normalizeBenchmarkRunIdForPrefix(params.runId)}_`
	validateBenchmarkCollectionPrefix(collectionPrefix)
	return { collectionPrefix, source: "derived" }
}
