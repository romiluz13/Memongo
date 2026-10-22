import { describe, expect, it } from "vitest"
import { hiddenOutputTokens } from "./mongodb-e2e-qa-calls.js"

// The live probe: max_tokens 16 on a thinking model returned no content,
// prompt_tokens 6, completion_tokens 0, total_tokens 18.

describe("hidden output tokens", () => {
	it("derives total minus prompt minus completion", () => {
		expect(
			hiddenOutputTokens({ inputTokens: 6, outputTokens: 0, totalTokens: 18 }),
		).toEqual({ hiddenOutputTokens: 12 })
		expect(
			hiddenOutputTokens({ inputTokens: 6, outputTokens: 12, totalTokens: 18 }),
		).toEqual({ hiddenOutputTokens: 0 })
	})

	it("records null with a reason instead of guessing", () => {
		expect(hiddenOutputTokens({ inputTokens: 6, outputTokens: 0 })).toEqual({
			hiddenOutputTokens: null,
			reason: "total-tokens-not-reported",
		})
		expect(hiddenOutputTokens(undefined)).toEqual({
			hiddenOutputTokens: null,
			reason: "usage-not-reported",
		})
		expect(
			hiddenOutputTokens({ inputTokens: 6, outputTokens: 13, totalTokens: 18 }),
		).toEqual({
			hiddenOutputTokens: null,
			reason: "total-below-prompt-plus-completion",
		})
	})
})
