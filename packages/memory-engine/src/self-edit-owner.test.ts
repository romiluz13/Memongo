import type { Collection, Db, Document, MongoClient } from "mongodb"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { selfEditBlock } from "./mongodb-self-edit.js"
import { structuredMemCollection } from "./mongodb-schema.js"
import { writeStructuredMemory } from "./mongodb-structured-memory.js"

vi.mock("./mongodb-schema.js", () => ({ structuredMemCollection: vi.fn() }))
vi.mock("./mongodb-structured-memory.js", () => ({
	writeStructuredMemory: vi.fn(async () => ({ upserted: true, id: "fixture" })),
}))
beforeEach(() => vi.clearAllMocks())

const rows = [
	{
		agentId: "agent1",
		scope: "user",
		scopeRef: "user:other",
		type: "preference",
		key: "core:user",
		value: "Foreign value",
	},
	{
		agentId: "agent1",
		scope: "agent",
		scopeRef: "agent:agent1",
		type: "preference",
		key: "core:user",
		value: "Owned value",
	},
]
function setup(owned = true, documents: Document[] = rows) {
	const findOne = vi.fn(
		async (filter: Document) =>
			(owned ? documents : documents.slice(0, 1)).find((row) =>
				Object.entries(filter).every(
					([key, value]) =>
						key in row && row[key as keyof typeof row] === value,
				),
			) ?? null,
	)
	vi.mocked(structuredMemCollection).mockReturnValue({
		findOne,
	} as unknown as Collection<Document>)
	const endSession = vi.fn(async () => {})
	const session = {
		withTransaction: vi.fn(async (fn: () => Promise<void>) => fn()),
		endSession,
	}
	const client = { startSession: () => session } as unknown as MongoClient
	return { findOne, client, session, endSession }
}
const base = {
	db: {} as Db,
	prefix: "test_",
	agentId: "agent1",
	embeddingMode: "automated" as const,
	block: "user" as const,
	content: "New value",
}
describe("agent-only self-edit owner selection", () => {
	it.each([
		[false, "append", "Owned value\nNew value"],
		[false, "prepend", "New value\nOwned value"],
		[true, "append", "Owned value\nNew value"],
		[true, "prepend", "New value\nOwned value"],
	] as const)("transaction=%s %s reads the owner it writes", async (transaction, action, value) => {
		const { client, findOne, endSession } = setup()
		await selfEditBlock({ ...base, action, ...(transaction ? { client } : {}) })
		expect(findOne).toHaveBeenCalledOnce()
		expect(findOne.mock.calls[0]?.[0]).toEqual(
			expect.objectContaining({
				agentId: "agent1",
				scope: "agent",
				scopeRef: "agent:agent1",
				type: "preference",
				key: "core:user",
			}),
		)
		const entry = vi.mocked(writeStructuredMemory).mock.calls[0]?.[0].entry
		expect(entry).not.toHaveProperty("scope")
		expect(entry).not.toHaveProperty("scopeRef")
		expect(writeStructuredMemory).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({
				entry: expect.objectContaining({ agentId: "agent1", value }),
			}),
		)
		if (transaction) expect(endSession).toHaveBeenCalledOnce()
	})
	it.each([
		false,
		true,
	])("does not copy a foreign-only block, transaction=%s", async (transaction) => {
		const { client } = setup(false)
		await selfEditBlock({
			...base,
			action: "append",
			...(transaction ? { client } : {}),
		})
		expect(writeStructuredMemory).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({
				entry: expect.objectContaining({ value: "New value" }),
			}),
		)
	})
	it("replace retains its existing no-read behavior", async () => {
		const { findOne } = setup()
		await selfEditBlock({ ...base, action: "replace" })
		expect(findOne).not.toHaveBeenCalled()
		expect(writeStructuredMemory).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({
				entry: expect.objectContaining({ value: "New value" }),
			}),
		)
	})
	it("preserves the existing merge of an invalidated owner row", async () => {
		setup(true, [{ ...rows[1], state: "invalidated" }])
		await selfEditBlock({ ...base, action: "append" })
		expect(writeStructuredMemory).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({
				entry: expect.objectContaining({ value: "Owned value\nNew value" }),
			}),
		)
	})
	it("leaves a legacy row without owner fields out of canonical appends", async () => {
		setup(true, [
			{
				agentId: "agent1",
				type: "preference",
				key: "core:user",
				value: "Legacy value",
			},
		])
		await selfEditBlock({ ...base, action: "append" })
		expect(writeStructuredMemory).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({
				entry: expect.objectContaining({ value: "New value" }),
			}),
		)
	})
})
