import { describe, expect, it } from "vitest"
import {
	isTransactionTooLargeForCache,
	isTransactionUnsupported,
	withTransactionBatched,
} from "./mongodb-transactions.js"

describe("isTransactionUnsupported", () => {
	it("recognizes standalone topology errors", () => {
		const error = Object.assign(
			new Error(
				"Transaction numbers are only allowed on a replica set member or mongos",
			),
			{ code: 20 },
		)

		expect(isTransactionUnsupported(error)).toBe(true)
	})

	it.each([
		[251, "NoSuchTransaction"],
		[263, "OperationNotSupportedInTransaction"],
		[225, "TransactionTooLargeForCache"],
		[11000, "duplicate key"],
	])("does not downgrade code %i (%s) to sequential writes", (code, message) => {
		expect(
			isTransactionUnsupported(Object.assign(new Error(message), { code })),
		).toBe(false)
	})
})

describe("isTransactionTooLargeForCache", () => {
	it("recognizes code 225", () => {
		expect(
			isTransactionTooLargeForCache(
				Object.assign(new Error("TransactionTooLargeForCache"), { code: 225 }),
			),
		).toBe(true)
	})

	it("recognizes the message without a code", () => {
		expect(
			isTransactionTooLargeForCache(new Error("TransactionTooLargeForCache")),
		).toBe(true)
	})

	it("does not match other errors", () => {
		expect(
			isTransactionTooLargeForCache(
				Object.assign(new Error("duplicate key"), { code: 11000 }),
			),
		).toBe(false)
	})
})

/** Fake session whose withTransaction simply runs the callback. */
function fakeSession(): {
	withTransaction: <T>(fn: () => Promise<T>, _options?: unknown) => Promise<T>
} {
	return {
		withTransaction: async <T>(fn: () => Promise<T>): Promise<T> => fn(),
	}
}

describe("withTransactionBatched", () => {
	it("retries by splitting the batch when TransactionTooLargeForCache is thrown", async () => {
		const executed: number[][] = []
		const runBatch = async (batch: number[]) => {
			if (batch.length > 2) {
				throw Object.assign(new Error("TransactionTooLargeForCache"), {
					code: 225,
				})
			}
			executed.push(batch)
		}

		await withTransactionBatched(fakeSession(), [1, 2, 3, 4], runBatch, {
			minBatchSize: 1,
		})

		expect(executed.flat().sort((a, b) => a - b)).toEqual([1, 2, 3, 4])
		expect(executed.every((b) => b.length <= 2)).toBe(true)
	})

	it("re-throws non-TransactionTooLargeForCache errors unchanged", async () => {
		const runBatch = async () => {
			throw Object.assign(new Error("duplicate key"), { code: 11000 })
		}

		await expect(
			withTransactionBatched(fakeSession(), [1, 2], runBatch),
		).rejects.toThrow("duplicate key")
	})

	it("re-throws at minBatchSize floor when a single op is too large", async () => {
		const runBatch = async () => {
			throw Object.assign(new Error("TransactionTooLargeForCache"), {
				code: 225,
			})
		}

		await expect(
			withTransactionBatched(fakeSession(), [1], runBatch, {
				minBatchSize: 1,
			}),
		).rejects.toThrow("TransactionTooLargeForCache")
	})

	it("runs the whole batch in one transaction when it fits", async () => {
		const executed: number[][] = []
		const runBatch = async (batch: number[]) => {
			executed.push(batch)
		}

		await withTransactionBatched(fakeSession(), [1, 2, 3], runBatch)

		expect(executed).toEqual([[1, 2, 3]])
	})
})
