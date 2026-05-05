import { describe, it, expect, vi, beforeEach } from "vitest"

// ---------------------------------------------------------------------------
// Mocks — selfEditBlock reads from structuredMemCollection and writes via
// writeStructuredMemory, both of which we mock.
// ---------------------------------------------------------------------------

vi.mock("./mongodb-schema.js", () => ({
	structuredMemCollection: vi.fn(),
}))

vi.mock("./mongodb-structured-memory.js", () => ({
	writeStructuredMemory: vi.fn(async () => ({
		upserted: true,
		id: "mock-id",
	})),
}))

import { structuredMemCollection } from "./mongodb-schema.js"
import { writeStructuredMemory } from "./mongodb-structured-memory.js"
import type { MemorySelfEditBlock, MemorySelfEditAction } from "./types.js"
import { selfEditBlock } from "./mongodb-self-edit.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFakeFindOne(existing: { value: string } | null) {
	return vi.fn().mockResolvedValue(existing)
}

function setupCollection(existing: { value: string } | null) {
	const findOne = makeFakeFindOne(existing)
	vi.mocked(structuredMemCollection).mockReturnValue({
		findOne,
	} as any)
	return { findOne }
}

const baseParams = {
	db: {} as any,
	prefix: "test_",
	agentId: "agent-1",
	embeddingMode: "automated" as const,
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("selfEditBlock", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("replace: writes new value directly", async () => {
		setupCollection(null)

		const result = await selfEditBlock({
			...baseParams,
			block: "user",
			action: "replace",
			content: "User likes TypeScript",
		})

		expect(result).toEqual({ upserted: expect.any(Boolean), id: "core:user" })
		expect(writeStructuredMemory).toHaveBeenCalledWith(
			expect.objectContaining({
				entry: expect.objectContaining({
					type: "preference",
					key: "core:user",
					value: "User likes TypeScript",
					confidence: 1.0,
					salience: "critical",
					sourceAgent: { id: "agent-1", name: "user" },
				}),
			}),
		)
	})

	it("append: appends to existing value with newline separator", async () => {
		setupCollection({ value: "Existing content" })

		const result = await selfEditBlock({
			...baseParams,
			block: "user",
			action: "append",
			content: "New content",
		})

		expect(result.id).toBe("core:user")
		expect(writeStructuredMemory).toHaveBeenCalledWith(
			expect.objectContaining({
				entry: expect.objectContaining({
					value: "Existing content\nNew content",
				}),
			}),
		)
	})

	it("append with client: uses a transaction and passes the session to the write path", async () => {
		const { findOne } = setupCollection({ value: "Existing content" })
		const withTransaction = vi.fn(async (fn: () => Promise<void>) => {
			await fn()
		})
		const endSession = vi.fn(async () => {})
		const session = { withTransaction, endSession } as any
		const client = {
			startSession: vi.fn(() => session),
		} as any

		await selfEditBlock({
			...baseParams,
			client,
			block: "user",
			action: "append",
			content: "New content",
		})

		expect(client.startSession).toHaveBeenCalledTimes(1)
		expect(findOne).toHaveBeenCalledWith(
			{ agentId: "agent-1", type: "preference", key: "core:user" },
			{ session },
		)
		expect(writeStructuredMemory).toHaveBeenCalledWith(
			expect.objectContaining({
				session,
				entry: expect.objectContaining({
					value: "Existing content\nNew content",
				}),
			}),
		)
		expect(withTransaction).toHaveBeenCalledTimes(1)
		expect(endSession).toHaveBeenCalledTimes(1)
	})

	it("prepend: prepends to existing value with newline separator", async () => {
		setupCollection({ value: "Existing content" })

		const result = await selfEditBlock({
			...baseParams,
			block: "persona",
			action: "prepend",
			content: "New content",
		})

		expect(result.id).toBe("core:persona")
		expect(writeStructuredMemory).toHaveBeenCalledWith(
			expect.objectContaining({
				entry: expect.objectContaining({
					type: "identity",
					key: "core:persona",
					value: "New content\nExisting content",
				}),
			}),
		)
	})

	it("append on non-existing doc: creates with just the content", async () => {
		setupCollection(null)

		const result = await selfEditBlock({
			...baseParams,
			block: "instructions",
			action: "append",
			content: "Follow these rules",
		})

		expect(result.id).toBe("core:instructions")
		expect(writeStructuredMemory).toHaveBeenCalledWith(
			expect.objectContaining({
				entry: expect.objectContaining({
					type: "instruction",
					key: "core:instructions",
					value: "Follow these rules",
				}),
			}),
		)
	})

	it("sets confidence=1.0 and sourceAgent.name='user'", async () => {
		setupCollection(null)

		await selfEditBlock({
			...baseParams,
			block: "user",
			action: "replace",
			content: "Anything",
		})

		expect(writeStructuredMemory).toHaveBeenCalledWith(
			expect.objectContaining({
				entry: expect.objectContaining({
					confidence: 1.0,
					sourceAgent: { id: "agent-1", name: "user" },
				}),
			}),
		)
	})

	it("maps block 'persona' to type 'identity' and key 'core:persona'", async () => {
		setupCollection(null)

		await selfEditBlock({
			...baseParams,
			block: "persona",
			action: "replace",
			content: "I am helpful",
		})

		expect(writeStructuredMemory).toHaveBeenCalledWith(
			expect.objectContaining({
				entry: expect.objectContaining({
					type: "identity",
					key: "core:persona",
				}),
			}),
		)
	})

	it("maps block 'instructions' to type 'instruction' and key 'core:instructions'", async () => {
		setupCollection(null)

		await selfEditBlock({
			...baseParams,
			block: "instructions",
			action: "replace",
			content: "Always be concise",
		})

		expect(writeStructuredMemory).toHaveBeenCalledWith(
			expect.objectContaining({
				entry: expect.objectContaining({
					type: "instruction",
					key: "core:instructions",
				}),
			}),
		)
	})
})
