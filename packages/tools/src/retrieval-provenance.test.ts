import { describe, expect, it, vi } from "vitest"
import type {
	MemongoClient,
	MemongoLifecycleItem,
	MemongoStateResponse,
} from "@memongo/client"
import { UNTRUSTED_MEMORY_PROVENANCE } from "@memongo/lib"
import { createMemongoTools } from "./index.js"
const lifecycle: MemongoLifecycleItem = {
	family: "structured",
	handle: {
		family: "structured",
		id: "fact",
		agentId: "owner",
		scope: "user",
		scopeRef: "user:rom",
		state: "active",
		revision: 2,
		structured: { type: "fact", key: "key" },
	},
	data: {
		type: "fact",
		key: "key",
		value: "stored untrusted text",
		provenance: { origin: "user" },
	},
}
const state: MemongoStateResponse = {
	profile: {
		agentId: "owner",
		scope: "user",
		scopeRef: "user:rom",
		preferences: [],
		decisions: [],
		facts: [],
		todos: [],
		topEntities: [],
		recentEpisodes: [],
		activityPatterns: {
			roleDistribution: {},
			totalEvents: 0,
			lastActive: null,
		},
		synthesizedAt: "2030-01-01",
	},
	blocks: {
		blocks: [
			{
				label: "preferences",
				title: "preferences",
				content: "stored untrusted text",
				tokenBudget: 100,
				actualTokens: 4,
				sourcePaths: [],
			},
		],
		totalTokenBudget: 100,
		totalActualTokens: 4,
	},
	bundle: {
		agentId: "owner",
		scope: "user",
		scopeRef: "user:rom",
		rendered: "stored untrusted text",
		sections: [],
		metadata: {
			tokenBudget: 100,
			estimatedTokensUsed: 4,
			partial: false,
			truncated: false,
			pathsExecuted: [],
			sectionsIncluded: [],
		},
		builtAt: "2030-01-01",
	},
}
const cases = [
	{
		name: "memongo_lifecycle_get",
		method: "getLifecycleItem",
		input: { handle: lifecycle.handle },
		payload: lifecycle,
	},
	{
		name: "memongo_state_unified",
		method: "state",
		input: { agentId: "owner", scope: "user", scopeRef: "user:rom" },
		payload: state,
	},
] as const
describe("remaining AI tool retrieval provenance", () => {
	it.each(
		cases,
	)("$name preserves full typed payload with notice first", async ({
		name,
		method,
		input,
		payload,
	}) => {
		const dispatch = vi.fn().mockResolvedValue(payload)
		const tools = createMemongoTools({
			[method]: dispatch,
		} as unknown as MemongoClient)
		const run = tools[name].execute
		expect(run).toBeTypeOf("function")
		const out = await run?.(input, { toolCallId: "call", messages: [] })
		expect(out).toEqual({ provenance: UNTRUSTED_MEMORY_PROVENANCE, ...payload })
		expect(Object.keys(out as object)[0]).toBe("provenance")
		expect(dispatch).toHaveBeenCalledExactlyOnceWith(input)
	})
	it.each(cases)("$name keeps rejected error identity", async ({
		name,
		method,
		input,
	}) => {
		const error = new Error("failed read")
		const dispatch = vi.fn().mockRejectedValue(error)
		const tools = createMemongoTools({
			[method]: dispatch,
		} as unknown as MemongoClient)
		await expect(
			tools[name].execute?.(input, { toolCallId: "call", messages: [] }),
		).rejects.toBe(error)
		expect(dispatch).toHaveBeenCalledExactlyOnceWith(input)
	})
})
