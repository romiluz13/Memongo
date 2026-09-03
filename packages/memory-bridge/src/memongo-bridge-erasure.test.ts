import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// C-003 tenant erasure bridge wiring: the bridge must select the manager for
// the AUTHORIZED agentId (never a body-smuggled one) and return the engine's
// per-collection receipt unchanged.

const deleteAllForAgent = vi.fn(async () => ({
	agentId: "agent-A",
	status: "complete",
	receipts: [
		{ collection: "events", deleted: 2 },
		{ collection: "chunks", deleted: 5 },
	],
	mutationId: "mut-1",
	completedAt: new Date("2026-08-15T00:00:00.000Z"),
}))

vi.mock("@memongo/memory-engine", () => ({
	getMemorySearchManager: vi.fn(async ({ agentId }: { agentId: string }) => ({
		manager: { agentId, deleteAllForAgent },
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
import { memongoBridgeDeleteAllForAgent } from "./memongo-bridge.js"

describe("bridge tenant erasure (C-003)", () => {
	const prevAgentId = process.env.MEMONGO_AGENT_ID

	beforeEach(() => {
		delete process.env.MEMONGO_AGENT_ID
		deleteAllForAgent.mockClear()
		vi.mocked(getMemorySearchManager).mockClear()
	})

	it("delegates to the authorized agent's manager and returns the receipt", async () => {
		const receipt = await memongoBridgeDeleteAllForAgent({ agentId: "agent-A" })

		expect(vi.mocked(getMemorySearchManager)).toHaveBeenCalledWith(
			expect.objectContaining({ agentId: "agent-A" }),
		)
		expect(deleteAllForAgent).toHaveBeenCalledOnce()
		expect(receipt.status).toBe("complete")
		expect(receipt.receipts).toEqual([
			{ collection: "events", deleted: 2 },
			{ collection: "chunks", deleted: 5 },
		])
		expect(receipt.mutationId).toBe("mut-1")
	})

	it("erases the default partition when no agentId is given", async () => {
		await memongoBridgeDeleteAllForAgent({})

		expect(vi.mocked(getMemorySearchManager)).toHaveBeenCalledWith(
			expect.objectContaining({ agentId: "main" }),
		)
		expect(deleteAllForAgent).toHaveBeenCalledOnce()
	})

	it("propagates engine failures to the caller", async () => {
		deleteAllForAgent.mockRejectedValueOnce(new Error("wipe failed"))

		await expect(
			memongoBridgeDeleteAllForAgent({ agentId: "agent-A" }),
		).rejects.toThrow("wipe failed")
	})

	afterEach(() => {
		process.env.MEMONGO_AGENT_ID = prevAgentId
	})
})
