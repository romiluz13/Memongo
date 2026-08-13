import { describe, expect, it } from "vitest"
import { resolveConversationEvidenceMode } from "./mongodb-conversation-evidence-mode.js"

describe("resolveConversationEvidenceMode", () => {
	it("defaults to parallel execution", () => {
		expect(resolveConversationEvidenceMode(undefined)).toBe("parallel")
		expect(resolveConversationEvidenceMode("")).toBe("parallel")
	})

	it("accepts every rollback mode case-insensitively", () => {
		expect(resolveConversationEvidenceMode("PARALLEL")).toBe("parallel")
		expect(resolveConversationEvidenceMode(" serial ")).toBe("serial")
		expect(resolveConversationEvidenceMode("disabled")).toBe("disabled")
	})

	it("rejects unrecognized modes", () => {
		expect(() => resolveConversationEvidenceMode("maybe")).toThrow(
			/MEMONGO_CONVERSATION_EVIDENCE_MODE/,
		)
	})
})
