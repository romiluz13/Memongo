import { describe, expect, it } from "vitest"

import proofPackBaseline from "./proof-pack-baseline.js"

describe("proof-pack-baseline", () => {
	it("requires the advanced and projection proof surfaces", () => {
		expect(proofPackBaseline.requiredPaths).toEqual(
			expect.arrayContaining([
				"/v1/search",
				"/v1/search-detailed",
				"/v1/hydrate-active-slate",
				"/v1/discovery-projection",
				"/v1/context-bundle",
			]),
		)
		expect(proofPackBaseline.requiredChecks).toEqual(
			expect.arrayContaining([
				"searchDetailed",
				"hydrateActiveSlate",
				"discoveryProjection",
				"contextBundle",
			]),
		)
	})
})
