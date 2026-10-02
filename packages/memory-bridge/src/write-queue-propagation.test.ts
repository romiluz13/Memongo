import { afterEach, beforeEach, expect, it, vi } from "vitest"
import type { Db } from "mongodb"
import {
	enqueueBoundedWrite,
	WriteQueueFullError,
} from "../../memory-engine/src/mongodb-manager-write.js"
const mocks = vi.hoisted(() => ({ getManager: vi.fn() }))
vi.mock("@memongo/memory-engine", () => ({
	getMemorySearchManager: mocks.getManager,
	closeAllMemorySearchManagers: vi.fn(),
}))
vi.mock("@memongo/memory-engine/internal", () => ({
	materializeBlocks: vi.fn(),
}))
vi.mock("./memory-config.js", () => ({
	resolveBridgeConfig: vi.fn(() => ({})),
}))
import {
	memongoBridgeAdd,
	memongoBridgeWriteConversationEvent,
	memongoBridgeWriteConversationEventsBatch,
} from "./memongo-bridge.js"
beforeEach(() => {
	mocks.getManager.mockReset()
	vi.stubEnv("MEMONGO_WRITE_QUEUE_MAX_DEPTH", "1")
	vi.stubEnv("MEMONGO_TELEMETRY_ENABLED", "false")
})
afterEach(() => vi.unstubAllEnvs())
it.each([
	() => memongoBridgeAdd({ agentId: "owner", content: "synthetic" }),
	() =>
		memongoBridgeWriteConversationEvent({
			agentId: "owner",
			role: "user",
			body: "synthetic",
		}),
	() =>
		memongoBridgeWriteConversationEventsBatch({
			agentId: "owner",
			events: [{ role: "user", body: "synthetic" }],
		}),
])("propagates the exact real queue rejection through the real bridge", async (write) => {
	const host = {
		db: {} as Db,
		prefix: "fixture_",
		agentId: "owner",
		writeQueue: Promise.resolve(),
		writeQueueDepth: 1,
	}
	const execute = vi.fn(async () => ({ eventId: "never", chunkCreated: true }))
	let reason: unknown
	const admit = vi.fn(() => {
		try {
			return enqueueBoundedWrite(host, execute)
		} catch (err) {
			reason = err
			throw err
		}
	})
	mocks.getManager.mockResolvedValue({
		manager: {
			writeConversationEvent: admit,
			writeConversationEventsBatch: admit,
		},
		error: null,
	})
	const caught = await write().catch((err: unknown) => err)
	expect(caught).toBeInstanceOf(WriteQueueFullError)
	expect(caught).toBe(reason)
	expect(caught).toMatchObject({
		name: "WriteQueueFullError",
		code: "WRITE_QUEUE_FULL",
		queueDepth: 1,
		maxDepth: 1,
	})
	expect(admit).toHaveBeenCalledTimes(1)
	expect(mocks.getManager).toHaveBeenCalledExactlyOnceWith(
		expect.objectContaining({ agentId: "owner" }),
	)
	expect(execute).not.toHaveBeenCalled()
	expect(host.writeQueueDepth).toBe(1)
})
