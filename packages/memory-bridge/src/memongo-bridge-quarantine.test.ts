import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// C-004 quarantine review bridge wiring: the bridge must select the manager
// for the AUTHORIZED agentId (never a body-smuggled one), forward
// quarantineId/reviewer metadata to the engine methods, and return the
// engine's results unchanged.

const listQuarantined = vi.fn(async () => [
	{
		quarantineId: "q-1",
		agentId: "agent-A",
		content: "I prefer tabs over spaces",
		status: "pending-review",
		matchedPatterns: ["instruction-override"],
		createdAt: new Date("2026-08-15T00:00:00.000Z"),
	},
])

const promoteQuarantined = vi.fn(async () => ({
	quarantineId: "q-1",
	agentId: "agent-A",
	status: "promoted",
	reviewedAt: new Date("2026-08-15T01:00:00.000Z"),
	memoryId: "mem-1",
	mutationId: "mut-1",
}))

const rejectQuarantined = vi.fn(async () => ({
	quarantineId: "q-2",
	agentId: "agent-A",
	status: "rejected",
	reviewedAt: new Date("2026-08-15T01:00:00.000Z"),
	mutationId: "mut-2",
}))

vi.mock("@memongo/memory-engine", () => ({
	getMemorySearchManager: vi.fn(async ({ agentId }: { agentId: string }) => ({
		manager: {
			agentId,
			listQuarantined,
			promoteQuarantined,
			rejectQuarantined,
		},
		error: null,
	})),
	closeAllMemorySearchManagers: vi.fn(),
}))

vi.mock("@memongo/memory-engine/internal", () => ({
	materializeBlocks: vi.fn(),
}))

vi.mock("./memory-config.js", () => ({
	resolveBridgeConfig: vi.fn(() => ({})),
}))

import { getMemorySearchManager } from "@memongo/memory-engine"
import {
	memongoBridgeListQuarantined,
	memongoBridgePromoteQuarantined,
	memongoBridgeRejectQuarantined,
} from "./memongo-bridge.js"

describe("bridge quarantine review (C-004)", () => {
	const prevAgentId = process.env.MEMONGO_AGENT_ID

	beforeEach(() => {
		delete process.env.MEMONGO_AGENT_ID
		listQuarantined.mockClear()
		promoteQuarantined.mockClear()
		rejectQuarantined.mockClear()
		vi.mocked(getMemorySearchManager).mockClear()
	})

	it("lists the authorized agent's review queue with status and limit filters", async () => {
		const entries = await memongoBridgeListQuarantined({
			agentId: "agent-A",
			status: "pending-review",
			limit: 10,
		})

		expect(vi.mocked(getMemorySearchManager)).toHaveBeenCalledWith(
			expect.objectContaining({ agentId: "agent-A" }),
		)
		expect(listQuarantined).toHaveBeenCalledWith({
			status: "pending-review",
			limit: 10,
		})
		expect(entries).toHaveLength(1)
		expect(entries[0]).toMatchObject({
			quarantineId: "q-1",
			status: "pending-review",
		})
	})

	it("promotes through the authorized agent's manager with review metadata", async () => {
		const receipt = await memongoBridgePromoteQuarantined({
			agentId: "agent-A",
			quarantineId: "q-1",
			reviewerId: "reviewer-7",
			reviewNotes: "false positive",
		})

		expect(vi.mocked(getMemorySearchManager)).toHaveBeenCalledWith(
			expect.objectContaining({ agentId: "agent-A" }),
		)
		expect(promoteQuarantined).toHaveBeenCalledWith({
			quarantineId: "q-1",
			reviewerId: "reviewer-7",
			reviewNotes: "false positive",
		})
		expect(receipt).toMatchObject({ status: "promoted", memoryId: "mem-1" })
	})

	it("rejects through the authorized agent's manager with review metadata", async () => {
		const receipt = await memongoBridgeRejectQuarantined({
			agentId: "agent-A",
			quarantineId: "q-2",
			reviewerId: "reviewer-7",
			reviewNotes: "confirmed injection",
		})

		expect(rejectQuarantined).toHaveBeenCalledWith({
			quarantineId: "q-2",
			reviewerId: "reviewer-7",
			reviewNotes: "confirmed injection",
		})
		expect(receipt).toMatchObject({ status: "rejected", mutationId: "mut-2" })
	})

	it("defaults to the main partition when no agentId is given", async () => {
		await memongoBridgeListQuarantined({})

		expect(vi.mocked(getMemorySearchManager)).toHaveBeenCalledWith(
			expect.objectContaining({ agentId: "main" }),
		)
	})

	it("propagates engine failures to the caller", async () => {
		promoteQuarantined.mockRejectedValueOnce(
			new Error("already reviewed (status=promoted)"),
		)

		await expect(
			memongoBridgePromoteQuarantined({
				agentId: "agent-A",
				quarantineId: "q-1",
			}),
		).rejects.toThrow("already reviewed")
	})

	afterEach(() => {
		process.env.MEMONGO_AGENT_ID = prevAgentId
	})
})
