import { describe, expect, it } from "vitest"
import { applyHardConstraintRejections } from "./mongodb-search-executor.js"
import { mapEventSearchDocToResult } from "./mongodb-search-ranking.js"

function mapped(
	body: string,
	lane: "turn-vector" | "turn-text" = "turn-text",
	role = "user",
) {
	const result = mapEventSearchDocToResult(
		{
			eventId: "turn-1",
			body,
			score: 0.9,
			role,
			sessionId: "s1",
			timestamp: new Date("2026-01-01T12:00:00Z"),
		},
		lane,
	)
	if (!result) throw new Error("fixture result missing")
	return result
}

function admitted(
	result: NonNullable<ReturnType<typeof mapEventSearchDocToResult>>,
) {
	return applyHardConstraintRejections({
		request: { query: 'find "alpha"', needExactEvidence: true },
		results: [result],
	})
}

describe("available full text in exact-evidence admission", () => {
	it.each([
		"turn-vector",
		"turn-text",
	] as const)("admits an anchor after the preview in %s", (lane) => {
		const result = mapped(`${"x ".repeat(400)}alpha`, lane)
		expect(result.snippet).not.toContain("alpha")
		expect(result.text).toContain("alpha")
		expect(admitted(result).accepted).toHaveLength(1)
	})
	it("admits an anchor ending at the mapper text cap", () => {
		const result = mapped(`${"x ".repeat(7997)} alpha`)
		expect(result.text).toHaveLength(16000)
		expect(result.text?.endsWith("alpha")).toBe(true)
		expect(admitted(result).accepted).toHaveLength(1)
	})
	it("rejects an anchor beyond the existing retained text cap", () => {
		const result = mapped(`${"x ".repeat(8001)} alpha`)
		expect(result.text).toHaveLength(16000)
		expect(result.text).not.toContain("alpha")
		expect(admitted(result).rejected[0]?.reason).toBe(
			"missing requested entity/value anchor",
		)
	})
	it("rejects a missing anchor in a long body", () => {
		expect(admitted(mapped("x ".repeat(7000))).accepted).toHaveLength(0)
	})
	it("retains preview-only matching for legacy results", () => {
		const { text: _text, ...result } = mapped("alpha")
		expect(admitted(result).accepted).toHaveLength(1)
	})
	it("does not make an assistant result exact because its text matches", () => {
		const result = admitted(
			mapped(`${"x ".repeat(400)}alpha`, "turn-text", "assistant"),
		)
		expect(result.rejected[0]?.reason).toBe(
			"exact evidence requires user-authored or reference span",
		)
	})
	it("retains conversation scope rejection when full text matches", () => {
		const result = applyHardConstraintRejections({
			request: {
				query: 'find "alpha"',
				needExactEvidence: true,
				conversationScope: { sessionKey: "other-session" },
			},
			results: [mapped(`${"x ".repeat(400)}alpha`)],
		})
		expect(result.rejected[0]?.reason).toBe(
			"outside requested conversation scope",
		)
	})
	it("retains time-range rejection when full text matches", () => {
		const result = applyHardConstraintRejections({
			request: { query: 'find "alpha"', needExactEvidence: true },
			timeRange: {
				start: new Date("2026-02-01T00:00:00Z"),
				end: new Date("2026-02-02T00:00:00Z"),
			},
			results: [mapped(`${"x ".repeat(400)}alpha`)],
		})
		expect(result.rejected[0]?.reason).toBe("outside requested time range")
	})
	it("does not match a phrase across the preview and full-text junction", () => {
		const result = mapped(`beta ${"x ".repeat(345)}alphayyyyy`)
		expect(result.snippet.endsWith("alpha")).toBe(true)
		expect(result.text).not.toMatch(/alpha\s+beta/i)
		const verdict = applyHardConstraintRejections({
			request: { query: 'find "alpha beta"', needExactEvidence: true },
			results: [result],
		})
		expect(verdict.rejected[0]?.reason).toBe(
			"missing requested entity/value anchor",
		)
	})
	it("does not promote a role-absent derived result with matching text", () => {
		const result = mapped(`${"x ".repeat(400)}alpha`, "turn-text", "")
		expect(result.derivation).toBe("derived")
		expect(admitted(result).rejected[0]?.reason).toBe(
			"exact evidence requires user-authored or reference span",
		)
	})
	it("preserves Unicode lowercasing for a full-text anchor", () => {
		const result = mapped(`${"x ".repeat(400)}İzmir`)
		const verdict = applyHardConstraintRejections({
			request: { query: 'find "i\u0307zmir"', needExactEvidence: true },
			results: [result],
		})
		expect(verdict.accepted).toHaveLength(1)
	})
})
