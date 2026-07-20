import { beforeEach, describe, expect, it, vi } from "vitest"

// Issue #42: the write bridge selects the manager (collection prefix) from the
// AUTHORIZED top-level agentId, but historically stored `entry.agentId ?? id`,
// letting a request body override the authorized identity. These tests pin the
// invariant: the stored agentId is ALWAYS the authorized identity.

const writeStructuredMemory = vi.fn(async (entry: { agentId?: string }) => ({
	id: "s1",
	...entry,
}))
const writeProcedure = vi.fn(async (entry: { agentId?: string }) => ({
	id: "p1",
	...entry,
}))

vi.mock("@memongo/memory-engine", () => ({
	getMemorySearchManager: vi.fn(async ({ agentId }: { agentId: string }) => ({
		manager: { agentId, writeStructuredMemory, writeProcedure },
		error: null,
	})),
	closeAllMemorySearchManagers: vi.fn(),
	materializeBlocks: vi.fn(),
}))

vi.mock("./memory-config.js", () => ({
	resolveBridgeConfig: vi.fn(() => ({})),
}))

import { getMemorySearchManager } from "@memongo/memory-engine"
import {
	memongoBridgeWriteProcedure,
	memongoBridgeWriteStructuredMemory,
} from "./memongo-bridge.js"

describe("bridge tenant identity (issue #42)", () => {
	beforeEach(() => {
		writeStructuredMemory.mockClear()
		writeProcedure.mockClear()
		vi.mocked(getMemorySearchManager).mockClear()
	})

	it("forces stored agentId to the authorized identity, ignoring entry.agentId (structured memory)", async () => {
		await memongoBridgeWriteStructuredMemory({
			agentId: "agent-A",
			// A caller authorized as agent-A tries to stamp agent-B into the body.
			entry: { agentId: "agent-B", key: "k", value: "v" } as never,
		})
		expect(writeStructuredMemory).toHaveBeenCalledOnce()
		expect(
			(writeStructuredMemory.mock.calls[0]?.[0] as { agentId?: string })
				.agentId,
		).toBe("agent-A")
		// The manager (collection partition) must also be selected for the
		// authorized identity, never the body-supplied one.
		expect(vi.mocked(getMemorySearchManager)).toHaveBeenCalledWith(
			expect.objectContaining({ agentId: "agent-A" }),
		)
	})

	it("forces stored agentId to the authorized identity, ignoring entry.agentId (procedure)", async () => {
		await memongoBridgeWriteProcedure({
			agentId: "agent-A",
			entry: { agentId: "agent-B", name: "n" } as never,
		})
		expect(writeProcedure).toHaveBeenCalledOnce()
		expect(
			(writeProcedure.mock.calls[0]?.[0] as { agentId?: string }).agentId,
		).toBe("agent-A")
	})

	it("forces stored scope/scopeRef to the authorized values, ignoring nested entry smuggle (structured memory)", async () => {
		await memongoBridgeWriteStructuredMemory({
			agentId: "agent-A",
			// Authorized scope coordinates (resolved from the request under top-level
			// precedence, matching what auth validated).
			scope: "agent" as never,
			scopeRef: "ref-A",
			// The body tries to smuggle a different tenant boundary.
			entry: {
				agentId: "agent-A",
				scope: "tenant",
				scopeRef: "ref-B",
				key: "k",
				value: "v",
			} as never,
		})
		expect(writeStructuredMemory).toHaveBeenCalledOnce()
		const stored = writeStructuredMemory.mock.calls[0]?.[0] as {
			scope?: string
			scopeRef?: string
		}
		expect(stored.scope).toBe("agent")
		expect(stored.scopeRef).toBe("ref-A")
	})

	it("leaves entry scope untouched when the caller resolved no scope (unscoped caller)", async () => {
		await memongoBridgeWriteStructuredMemory({
			agentId: "agent-A",
			entry: {
				agentId: "agent-A",
				scope: "tenant",
				scopeRef: "ref-B",
				key: "k",
				value: "v",
			} as never,
		})
		const stored = writeStructuredMemory.mock.calls[0]?.[0] as {
			scope?: string
			scopeRef?: string
		}
		// No authorized scope was provided — do not wipe the entry's own value.
		expect(stored.scope).toBe("tenant")
		expect(stored.scopeRef).toBe("ref-B")
	})
})
