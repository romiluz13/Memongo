import type { MemongoClient } from "@memongo/client"
import { describe, expect, it, vi } from "vitest"
import { handleToolCall } from "./server.js"

describe("quarantine promoting list filter", () => {
	it.each([
		"pending-review",
		"promoting",
		"promoted",
		"rejected",
	])("forwards %s", async (status) => {
		const listQuarantined = vi.fn(
			async (_params: Record<string, unknown>) => [],
		)
		const result = await handleToolCall(
			"memongo_quarantine_list",
			{ agentId: "agent1", status, limit: 5 },
			{ listQuarantined } as unknown as MemongoClient,
		)
		expect(result.isError).not.toBe(true)
		expect(listQuarantined).toHaveBeenCalledExactlyOnceWith({
			agentId: "agent1",
			status,
			limit: 5,
		})
	})
	it("rejects unsupported status before calling the client", async () => {
		const listQuarantined = vi.fn(
			async (_params: Record<string, unknown>) => [],
		)
		const result = await handleToolCall(
			"memongo_quarantine_list",
			{ status: "archived" },
			{ listQuarantined } as unknown as MemongoClient,
		)
		expect(result.isError).toBe(true)
		expect(result.structuredContent).toEqual({
			error: "status must be pending-review|promoting|promoted|rejected",
		})
		expect(listQuarantined).not.toHaveBeenCalled()
	})
})
