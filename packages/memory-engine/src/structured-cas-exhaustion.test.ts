import type { Db } from "mongodb"
import { expect, it, vi } from "vitest"
import {
	applyStructuredMemoryFeedbackByHandle,
	StructuredMemoryRevisionConflictError,
} from "./mongodb-structured-memory.js"

it("propagates the real conflict class after three sessionless confirmation CAS misses", async () => {
	const doc = {
		type: "fact",
		key: "key",
		value: "synthetic",
		agentId: "owner",
		scope: "agent",
		scopeRef: "agent:owner",
		revision: 1,
		state: "active",
		reinforcementCount: 1,
		createdAt: new Date("2026-01-01T00:00:00Z"),
	}
	const findOne = vi.fn().mockResolvedValue(doc)
	const findOneAndUpdate = vi.fn().mockResolvedValue(null)
	const collection = vi.fn((name: string) => {
		expect(name).toBe("test_structured_mem")
		return { findOne, findOneAndUpdate }
	})
	const operation = applyStructuredMemoryFeedbackByHandle({
		db: { collection } as unknown as Db,
		prefix: "test_",
		handle: {
			family: "structured",
			id: "memory",
			agentId: "owner",
			scope: "agent",
			scopeRef: "agent:owner",
			revision: 1,
			state: "active",
			structured: { type: "fact", key: "key" },
		},
		signal: "confirm",
		embeddingMode: "automated",
	})
	const reason = await operation.then(
		() => null,
		(error: unknown) => error,
	)
	expect(reason).toBeInstanceOf(StructuredMemoryRevisionConflictError)
	expect(
		(reason as StructuredMemoryRevisionConflictError).hasErrorLabel(
			"TransientTransactionError",
		),
	).toBe(true)
	expect(findOne).toHaveBeenCalledTimes(3)
	expect(findOneAndUpdate).toHaveBeenCalledTimes(3)
	for (const [filter] of findOneAndUpdate.mock.calls)
		expect(filter).toMatchObject({
			revision: 1,
			agentId: "owner",
			scopeRef: "agent:owner",
		})
})
