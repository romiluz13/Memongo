import { describe, expect, it } from "vitest"
import {
	LONGMEMEVAL_RELEASE_V1,
	LOCOMO_RELEASE_V1,
	resolveRegisteredBenchmarkQualityContract,
} from "./benchmark-quality-contracts.js"

describe("resolveRegisteredBenchmarkQualityContract", () => {
	it("accepts an exact built-in contract bound to its dataset digest", () => {
		expect(
			resolveRegisteredBenchmarkQualityContract({
				declared: { ...LONGMEMEVAL_RELEASE_V1.thresholds },
				datasetSha256: LONGMEMEVAL_RELEASE_V1.datasetSha256,
			}),
		).toEqual(LONGMEMEVAL_RELEASE_V1.thresholds)
	})

	it("rejects a caller-authored lower threshold under a registered identity", () => {
		expect(() =>
			resolveRegisteredBenchmarkQualityContract({
				declared: {
					...LONGMEMEVAL_RELEASE_V1.thresholds,
					minHitRate: 0,
				},
				datasetSha256: LONGMEMEVAL_RELEASE_V1.datasetSha256,
			}),
		).toThrow(/does not match the immutable registered contract/i)
	})

	it("rejects unknown contract identities", () => {
		expect(() =>
			resolveRegisteredBenchmarkQualityContract({
				declared: {
					...LONGMEMEVAL_RELEASE_V1.thresholds,
					version: "unknown",
				},
				datasetSha256: LONGMEMEVAL_RELEASE_V1.datasetSha256,
			}),
		).toThrow(/unknown benchmark quality contract/i)
	})

	it("rejects a registered contract against different dataset bytes", () => {
		expect(() =>
			resolveRegisteredBenchmarkQualityContract({
				declared: { ...LOCOMO_RELEASE_V1.thresholds },
				datasetSha256: "a".repeat(64),
			}),
		).toThrow(/is bound to dataset/i)
	})
})
