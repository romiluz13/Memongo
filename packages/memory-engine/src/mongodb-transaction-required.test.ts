/* eslint-disable @typescript-eslint/unbound-method */

import type { Collection, Db, MongoClient } from "mongodb"
import { describe, expect, it, vi } from "vitest"

vi.mock("./mongodb-telemetry.js", () => ({
	emitTelemetry: vi.fn(),
}))

import { upsertRelation } from "./mongodb-graph.js"
import {
	invalidateProcedureByHandle,
	writeProcedure,
} from "./mongodb-procedures.js"
import {
	invalidateStructuredMemoryByHandle,
	writeStructuredMemory,
} from "./mongodb-structured-memory.js"
import {
	TransactionUnsupportedError,
	typedTransactionError,
} from "./mongodb-transactions.js"
import type {
	MemoryProcedureStableHandle,
	MemoryStructuredStableHandle,
} from "./types.js"

// The standalone-deployment error: transactions need a replica set or mongos.
function standaloneError(): Error {
	return Object.assign(
		new Error(
			"Transaction numbers are only allowed on a replica set member or mongos",
		),
		{ code: 20 },
	)
}

function standaloneClient(error: unknown = standaloneError()): MongoClient {
	const session = {
		withTransaction: vi.fn(async () => {
			throw error
		}),
		endSession: vi.fn(async () => {}),
	}
	return { startSession: vi.fn(() => session) } as unknown as MongoClient
}

function collections() {
	const created = new Map<string, Collection>()
	const make = (): Collection =>
		({
			findOne: vi.fn(async () => null),
			find: vi.fn(() => ({ toArray: vi.fn(async () => []) })),
			updateOne: vi.fn(async () => ({
				upsertedCount: 1,
				matchedCount: 1,
				modifiedCount: 1,
			})),
			updateMany: vi.fn(async () => ({ matchedCount: 0, modifiedCount: 0 })),
			insertOne: vi.fn(async () => ({ acknowledged: true })),
			deleteMany: vi.fn(async () => ({ deletedCount: 0 })),
			aggregate: vi.fn(() => ({ toArray: vi.fn(async () => []) })),
		}) as unknown as Collection
	const db = {
		collection: vi.fn((name: string) => {
			let col = created.get(name)
			if (!col) {
				col = make()
				created.set(name, col)
			}
			return col
		}),
	} as unknown as Db
	const writes = () =>
		[...created.values()].flatMap((col) => [
			...vi.mocked(col.updateOne).mock.calls,
			...vi.mocked(col.updateMany).mock.calls,
			...vi.mocked(col.insertOne).mock.calls,
			...vi.mocked(col.deleteMany).mock.calls,
		])
	return { db, writes }
}

const structuredHandle: MemoryStructuredStableHandle = {
	family: "structured",
	id: "structured:main:agent:main:decision:k",
	agentId: "main",
	scope: "agent",
	scopeRef: "main",
	revision: 0,
	structured: { type: "decision", key: "k" },
}

const procedureHandle: MemoryProcedureStableHandle = {
	family: "procedure",
	id: "procedure:main:agent:main:p",
	agentId: "main",
	scope: "agent",
	scopeRef: "main",
	revision: 0,
	procedure: { procedureId: "p" },
}

describe("typedTransactionError", () => {
	it("types only the unsupported-deployment error and passes others through", () => {
		const unsupported = standaloneError()
		const typed = typedTransactionError(unsupported)
		expect(typed).toBeInstanceOf(TransactionUnsupportedError)
		expect((typed as TransactionUnsupportedError).code).toBe(
			"TRANSACTION_UNSUPPORTED",
		)
		expect((typed as TransactionUnsupportedError).cause).toBe(unsupported)

		const duplicate = Object.assign(new Error("dup"), { code: 11000 })
		expect(typedTransactionError(duplicate)).toBe(duplicate)
	})
})

describe("a write path that needs a transaction on a deployment without one", () => {
	it("writeStructuredMemory rejects typed and writes nothing", async () => {
		const { db, writes } = collections()
		await expect(
			writeStructuredMemory({
				db,
				prefix: "t_",
				entry: { type: "decision", key: "k", value: "v", agentId: "main" },
				embeddingMode: "automated",
				client: standaloneClient(),
			}),
		).rejects.toBeInstanceOf(TransactionUnsupportedError)
		expect(writes()).toHaveLength(0)
	})

	it("invalidateStructuredMemoryByHandle rejects typed and writes nothing", async () => {
		const { db, writes } = collections()
		await expect(
			invalidateStructuredMemoryByHandle({
				db,
				prefix: "t_",
				handle: structuredHandle,
				client: standaloneClient(),
			}),
		).rejects.toBeInstanceOf(TransactionUnsupportedError)
		expect(writes()).toHaveLength(0)
	})

	it("writeProcedure rejects typed and writes nothing", async () => {
		const { db, writes } = collections()
		await expect(
			writeProcedure({
				db,
				prefix: "t_",
				entry: {
					procedureId: "p",
					name: "P",
					intentTags: ["t"],
					triggerQueries: ["q"],
					steps: ["s"],
					successSignals: ["ok"],
					agentId: "main",
				},
				embeddingMode: "automated",
				client: standaloneClient(),
			}),
		).rejects.toBeInstanceOf(TransactionUnsupportedError)
		expect(writes()).toHaveLength(0)
	})

	it("invalidateProcedureByHandle rejects typed and writes nothing", async () => {
		const { db, writes } = collections()
		await expect(
			invalidateProcedureByHandle({
				db,
				prefix: "t_",
				handle: procedureHandle,
				client: standaloneClient(),
			}),
		).rejects.toBeInstanceOf(TransactionUnsupportedError)
		expect(writes()).toHaveLength(0)
	})

	it("upsertRelation rejects typed and writes nothing", async () => {
		const { db, writes } = collections()
		await expect(
			upsertRelation({
				db,
				prefix: "t_",
				relation: {
					fromEntityId: "a",
					toEntityId: "b",
					type: "works_on",
					agentId: "main",
					scope: "agent",
					updatedAt: new Date("2026-01-01"),
				},
				client: standaloneClient(),
			}),
		).rejects.toBeInstanceOf(TransactionUnsupportedError)
		expect(writes()).toHaveLength(0)
	})

	it("another transaction error passes through unchanged", async () => {
		const { db } = collections()
		const duplicate = Object.assign(new Error("dup"), { code: 11000 })
		await expect(
			writeStructuredMemory({
				db,
				prefix: "t_",
				entry: { type: "decision", key: "k", value: "v", agentId: "main" },
				embeddingMode: "automated",
				client: standaloneClient(duplicate),
			}),
		).rejects.toBe(duplicate)
	})
})
