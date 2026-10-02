import type { MemongoClient } from "@memongo/client"
import { describe, expect, it, vi } from "vitest"
import { handleToolCall } from "./server.js"

function payload(result: { content: Array<{ text?: string }> }) {
	return JSON.parse(result.content[0]?.text ?? "null")
}

describe("MCP explicit erasure target", () => {
	it.each([
		undefined,
		null,
		"",
		" \t",
		3,
	])("rejects missing target %s before client dispatch", async (agentId) => {
		const eraseAgent = vi.fn(async () => ({ status: "complete" }))
		const result = await handleToolCall(
			"memongo_erase_agent",
			{ confirm: "erase", agentId },
			{ eraseAgent } as unknown as MemongoClient,
		)
		expect(result.isError).toBe(true)
		expect(payload(result)).toEqual({
			error: "agentId must be explicitly provided for erasure",
		})
		expect(eraseAgent).not.toHaveBeenCalled()
	})
	it("preserves normalized explicit targets and takeover", async () => {
		const eraseAgent = vi.fn(async () => ({ status: "complete" }))
		const result = await handleToolCall(
			"memongo_erase_agent",
			{ confirm: "erase", agentId: " agent-42 ", recovery: "takeover" },
			{ eraseAgent } as unknown as MemongoClient,
		)
		expect(result.isError).not.toBe(true)
		expect(eraseAgent).toHaveBeenCalledExactlyOnceWith({
			confirm: "erase",
			agentId: "agent-42",
			recovery: "takeover",
		})
	})
})
