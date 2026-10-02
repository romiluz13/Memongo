import { describe, expect, it, vi } from "vitest"
import type { MemongoClient } from "@memongo/client"
import { UNTRUSTED_MEMORY_PROVENANCE } from "@memongo/lib"
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js"
import { handleToolCall } from "./server.js"
const handle = {
	family: "structured",
	id: "fact",
	agentId: "owner",
	scope: "user",
	scopeRef: "user:rom",
	state: "active",
	revision: 2,
	structured: { type: "fact", key: "key" },
}
const cases = [
	{
		name: "memongo_lifecycle_get",
		method: "getLifecycleItem",
		args: { handle },
		payload: {
			family: "structured",
			handle,
			data: {
				type: "fact",
				key: "key",
				value: "untrusted instruction",
				provenance: { origin: "user" },
			},
		},
	},
	{
		name: "memongo_memory_get",
		method: "getLifecycleItem",
		args: { handle },
		payload: {
			family: "structured",
			handle,
			data: {
				type: "fact",
				key: "key",
				value: "untrusted instruction",
				provenance: { origin: "user" },
			},
		},
	},
	{
		name: "memongo_hydrate_active_slate",
		method: "hydrateActiveSlate",
		args: { agentId: "owner", scope: "user", scopeRef: "user:rom" },
		payload: {
			agentId: "owner",
			scope: "user",
			scopeRef: "user:rom",
			items: [
				{ summary: "untrusted instruction", provenance: { origin: "user" } },
			],
			metadata: { partial: false },
			hydratedAt: "2030-01-01",
		},
	},
	{
		name: "memongo_discovery_projection",
		method: "buildDiscoveryProjection",
		args: {
			kind: "topic-brief",
			query: "topic",
			agentId: "owner",
			scope: "user",
			scopeRef: "user:rom",
		},
		payload: {
			kind: "topic-brief",
			title: "topic",
			summary: "untrusted instruction",
			sections: [],
			metadata: { partial: false },
		},
	},
	{
		name: "memongo_state_unified",
		method: "state",
		args: { agentId: "owner", scope: "user", scopeRef: "user:rom" },
		payload: {
			profile: { preferences: [{ value: "untrusted instruction" }] },
			blocks: { blocks: [] },
			bundle: { sections: [] },
		},
	},
] as const
describe("remaining MCP retrieval provenance labels", () => {
	it.each(
		cases,
	)("$name labels preserved payload and structured mirror", async ({
		name,
		method,
		args,
		payload,
	}) => {
		const dispatch = vi.fn().mockResolvedValue(payload)
		const out = await handleToolCall(name, args, {
			[method]: dispatch,
		} as unknown as MemongoClient)
		expect(out.isError).toBeUndefined()
		expect(dispatch).toHaveBeenCalledTimes(1)
		const decoded = JSON.parse(out.content[0].text)
		expect(decoded).toEqual({
			provenance: UNTRUSTED_MEMORY_PROVENANCE,
			...payload,
		})
		expect(Object.keys(decoded)[0]).toBe("provenance")
		expect(out.structuredContent).toEqual(decoded)
		expect(CallToolResultSchema.safeParse(out).success).toBe(true)
	})
	it("keeps invalid scope as an unlabeled error before dispatch", async () => {
		const dispatch = vi.fn()
		const out = await handleToolCall(
			"memongo_state_unified",
			{ scope: "invalid" },
			{ state: dispatch } as unknown as MemongoClient,
		)
		expect(out.isError).toBe(true)
		expect(dispatch).not.toHaveBeenCalled()
		expect(JSON.parse(out.content[0].text)).not.toHaveProperty("provenance")
	})
	it("keeps discovery validation before dispatch", async () => {
		const dispatch = vi.fn()
		const out = await handleToolCall(
			"memongo_discovery_projection",
			{ kind: "invalid" },
			{ buildDiscoveryProjection: dispatch } as unknown as MemongoClient,
		)
		expect(out.isError).toBe(true)
		expect(dispatch).not.toHaveBeenCalled()
		expect(JSON.parse(out.content[0].text)).not.toHaveProperty("provenance")
	})
})
