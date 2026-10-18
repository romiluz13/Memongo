import { beforeEach, describe, expect, it, vi } from "vitest"

const SEARCHABLE = { committed: true, status: "searchable", targets: [] }

const manager = vi.hoisted(() => ({
	writeConversationEvent: vi.fn(),
	writeStructuredMemory: vi.fn(),
	writeProcedure: vi.fn(),
}))

vi.mock("@memongo/memory-engine", () => ({
	getMemorySearchManager: vi.fn(async ({ agentId }: { agentId: string }) => ({
		manager: { agentId, ...manager },
		error: null,
	})),
	closeAllMemorySearchManagers: vi.fn(),
	materializeBlocks: vi.fn(),
}))

vi.mock("./memory-config.js", () => ({
	resolveBridgeConfig: vi.fn(() => ({})),
}))

import {
	memongoBridgeAdd,
	memongoBridgeWriteConversationEvent,
	memongoBridgeWriteProcedure,
	memongoBridgeWriteStructuredMemory,
} from "./memongo-bridge.js"

describe("bridge search barrier forwarding", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		manager.writeConversationEvent.mockResolvedValue({
			eventId: "evt-1",
			chunkCreated: true,
			searchBarrier: SEARCHABLE,
		})
		manager.writeStructuredMemory.mockResolvedValue({
			upserted: true,
			id: "k",
			searchBarrier: SEARCHABLE,
		})
		manager.writeProcedure.mockResolvedValue({
			upserted: true,
			id: "p",
			searchBarrier: SEARCHABLE,
		})
	})

	it("forwards the barrier request on add and write-event and returns its result", async () => {
		const signal = new AbortController().signal
		const added = await memongoBridgeAdd({
			agentId: "a1",
			content: "hello",
			searchBarrier: { timeoutMs: 2_000, signal },
		})
		expect(added.searchBarrier).toEqual(SEARCHABLE)
		expect(manager.writeConversationEvent.mock.calls[0]?.[2]).toEqual({
			searchBarrier: { timeoutMs: 2_000, signal },
		})
		const written = await memongoBridgeWriteConversationEvent({
			agentId: "a1",
			role: "assistant",
			body: "hi",
			searchBarrier: {},
		})
		expect(written.searchBarrier).toEqual(SEARCHABLE)
		expect(manager.writeConversationEvent.mock.calls[1]?.[2]).toEqual({
			searchBarrier: {},
		})
	})

	it("forwards the barrier request on structured and procedure writes", async () => {
		const structured = await memongoBridgeWriteStructuredMemory({
			agentId: "a1",
			entry: { type: "fact", key: "k", value: "v", agentId: "a1" },
			searchBarrier: { timeoutMs: 1_000 },
		})
		expect(structured.searchBarrier).toEqual(SEARCHABLE)
		expect(manager.writeStructuredMemory.mock.calls[0]?.[1]).toEqual({
			searchBarrier: { timeoutMs: 1_000 },
		})
		const procedure = await memongoBridgeWriteProcedure({
			agentId: "a1",
			entry: {
				procedureId: "p",
				name: "P",
				steps: [],
				agentId: "a1",
				scope: "agent",
				scopeRef: "agent:a1",
			},
			searchBarrier: {},
		})
		expect(procedure.searchBarrier).toEqual(SEARCHABLE)
		expect(manager.writeProcedure.mock.calls[0]?.[1]).toEqual({
			searchBarrier: {},
		})
	})

	it("calls the engine exactly as before when no barrier is requested", async () => {
		await memongoBridgeAdd({ agentId: "a1", content: "hello" })
		await memongoBridgeWriteStructuredMemory({
			agentId: "a1",
			entry: { type: "fact", key: "k", value: "v", agentId: "a1" },
		})
		await memongoBridgeWriteProcedure({
			agentId: "a1",
			entry: {
				procedureId: "p",
				name: "P",
				steps: [],
				agentId: "a1",
				scope: "agent",
				scopeRef: "agent:a1",
			},
		})
		expect(manager.writeConversationEvent.mock.calls[0]).toHaveLength(1)
		expect(manager.writeStructuredMemory.mock.calls[0]).toHaveLength(1)
		expect(manager.writeProcedure.mock.calls[0]).toHaveLength(1)
	})
})
