import { describe, expect, it } from "vitest"
import type { MemongoClient } from "./client.js"
import type {
	MemongoQuarantinedMemory,
	MemongoQuarantineReviewReceipt,
} from "./types.js"

const row: MemongoQuarantinedMemory = {
	quarantineId: "fixture",
	agentId: "agent1",
	content: "Fixture content",
	classification: "injection-likely",
	matchedPatterns: [],
	status: "promoting",
	createdAt: "2026-10-01T00:00:00.000Z",
}
const filter: Parameters<MemongoClient["listQuarantined"]>[0] = {
	status: row.status,
}
const decision: MemongoQuarantineReviewReceipt["status"] = "promoted"
// @ts-expect-error In-flight rows are not completed review decisions.
const inFlightDecision: MemongoQuarantineReviewReceipt["status"] = "promoting"
describe("quarantine row and decision types", () => {
	it("represents an in-flight list row without widening decision receipts", () => {
		expect(row.status).toBe("promoting")
		expect(filter?.status).toBe("promoting")
		expect(decision).toBe("promoted")
		expect(inFlightDecision).toBe("promoting")
	})
})
