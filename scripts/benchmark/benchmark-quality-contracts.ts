import type { BenchmarkQualityThresholds } from "../../packages/memory-engine/src/types.js"

export const LONGMEMEVAL_RELEASE_V1 = {
	datasetSha256:
		"d6f21ea9d60a0d56f34a05b609c79c88a451d2ae03597821ea3d5a9678c3a442",
	thresholds: {
		contractId: "longmemeval-release",
		version: "1",
		datasetKind: "longmemeval",
		minHitRate: 0.8,
		maxEmptyRate: 0.2,
		minRAt5: 0.8,
		minNdcgAt10: 0.8,
		maxP95LatencyMs: 1_000,
		minSessionRecallAnyAt10: 0.8,
		minSessionNdcgAnyAt10: 0.8,
	},
} as const satisfies {
	datasetSha256: string
	thresholds: BenchmarkQualityThresholds
}

/**
 * C-039: V2 adds LLM-judged answer accuracy to the LongMemEval contract so
 * published numbers are comparable to the official protocol (retrieval score
 * + J-scored answer accuracy, with abstention graded by refusal and the
 * judge calibrated by decoy false-positive probes). The answer bar mirrors
 * LOCOMO_RELEASE_V1 so both dataset kinds publish under one answer-quality
 * standard. Same dataset bytes as V1; only the quality bar moved.
 */
export const LONGMEMEVAL_RELEASE_V2 = {
	datasetSha256: LONGMEMEVAL_RELEASE_V1.datasetSha256,
	thresholds: {
		contractId: "longmemeval-release",
		version: "2",
		datasetKind: "longmemeval",
		minHitRate: 0.8,
		maxEmptyRate: 0.2,
		minRAt5: 0.8,
		minNdcgAt10: 0.8,
		maxP95LatencyMs: 1_000,
		minSessionRecallAnyAt10: 0.8,
		minSessionNdcgAnyAt10: 0.8,
		minAnswerAccuracy: 0.8,
		maxJudgeFalsePositiveRate: 0.05,
		minAnswerCoverage: 1,
	},
} as const satisfies {
	datasetSha256: string
	thresholds: BenchmarkQualityThresholds
}

export const LOCOMO_RELEASE_V1 = {
	datasetSha256:
		"79fa87e90f04081343b8c8debecb80a9a6842b76a7aa537dc9fdf651ea698ff4",
	thresholds: {
		contractId: "locomo-release",
		version: "1",
		datasetKind: "locomo",
		minHitRate: 0.8,
		maxEmptyRate: 0.2,
		minRAt5: 0.8,
		minNdcgAt10: 0.8,
		maxP95LatencyMs: 1_000,
		minSessionEvidenceRecallAt10: 0.8,
		minAnswerAccuracy: 0.8,
		maxJudgeFalsePositiveRate: 0.05,
		minAnswerCoverage: 1,
	},
} as const satisfies {
	datasetSha256: string
	thresholds: BenchmarkQualityThresholds
}

export function resolveRegisteredBenchmarkQualityContract(params: {
	declared: BenchmarkQualityThresholds
	datasetSha256: string
}): BenchmarkQualityThresholds {
	const registered = [
		LONGMEMEVAL_RELEASE_V1,
		LONGMEMEVAL_RELEASE_V2,
		LOCOMO_RELEASE_V1,
	].find(
		(contract) =>
			contract.thresholds.contractId === params.declared.contractId &&
			contract.thresholds.version === params.declared.version,
	)
	if (!registered) {
		throw new Error(
			`unknown benchmark quality contract ${params.declared.contractId}@${params.declared.version}`,
		)
	}
	if (registered.datasetSha256 !== params.datasetSha256) {
		throw new Error(
			`benchmark quality contract ${params.declared.contractId}@${params.declared.version} is bound to dataset ${registered.datasetSha256}, not ${params.datasetSha256}`,
		)
	}
	const expected = registered.thresholds as Record<string, unknown>
	const declared = params.declared as unknown as Record<string, unknown>
	const expectedKeys = Object.keys(expected).toSorted()
	const declaredKeys = Object.keys(declared).toSorted()
	if (
		expectedKeys.length !== declaredKeys.length ||
		expectedKeys.some(
			(key, index) =>
				key !== declaredKeys[index] || !Object.is(expected[key], declared[key]),
		)
	) {
		throw new Error(
			`benchmark quality contract payload does not match the immutable registered contract ${params.declared.contractId}@${params.declared.version}`,
		)
	}
	return { ...registered.thresholds } as BenchmarkQualityThresholds
}
