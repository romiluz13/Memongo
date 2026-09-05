import { describe, expect, it } from "vitest"
import {
	LONGMEMEVAL_RELEASE_V1,
	LONGMEMEVAL_RELEASE_V2,
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

	it("accepts the V2 longmemeval contract and binds it to the same dataset bytes", () => {
		expect(LONGMEMEVAL_RELEASE_V2.datasetSha256).toBe(
			LONGMEMEVAL_RELEASE_V1.datasetSha256,
		)
		expect(
			resolveRegisteredBenchmarkQualityContract({
				declared: { ...LONGMEMEVAL_RELEASE_V2.thresholds },
				datasetSha256: LONGMEMEVAL_RELEASE_V2.datasetSha256,
			}),
		).toEqual(LONGMEMEVAL_RELEASE_V2.thresholds)
	})

	it("rejects a weakened answer clause under the V2 identity", () => {
		expect(() =>
			resolveRegisteredBenchmarkQualityContract({
				declared: {
					...LONGMEMEVAL_RELEASE_V2.thresholds,
					minAnswerAccuracy: 0,
				},
				datasetSha256: LONGMEMEVAL_RELEASE_V2.datasetSha256,
			}),
		).toThrow(/does not match the immutable registered contract/i)
	})

	it("keeps V1 (retrieval-only) and V2 (answer-accuracy) distinct identities", () => {
		expect(LONGMEMEVAL_RELEASE_V1.thresholds.version).toBe("1")
		expect(LONGMEMEVAL_RELEASE_V2.thresholds.version).toBe("2")
		expect("minAnswerAccuracy" in LONGMEMEVAL_RELEASE_V1.thresholds).toBe(false)
		expect(LONGMEMEVAL_RELEASE_V2.thresholds.minAnswerAccuracy).toBe(0.8)
	})
})
