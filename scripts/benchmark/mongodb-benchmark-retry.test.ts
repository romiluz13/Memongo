import { describe, expect, it, vi } from "vitest"
import {
	isTransientMongoBenchmarkError,
	withMongoBenchmarkRetry,
} from "./mongodb-benchmark-retry.js"

describe("MongoDB benchmark retry boundary", () => {
	it("retries transient connection failures with bounded backoff", async () => {
		const operation = vi
			.fn<() => Promise<string>>()
			.mockRejectedValueOnce(
				Object.assign(new Error("connection pool cleared"), {
					name: "MongoPoolClearedError",
				}),
			)
			.mockRejectedValueOnce(
				Object.assign(new Error("server selection failed"), {
					name: "MongoServerSelectionError",
				}),
			)
			.mockResolvedValue("ok")
		const sleep = vi.fn(async () => {})

		await expect(
			withMongoBenchmarkRetry("event evidence read", operation, {
				maxAttempts: 4,
				baseDelayMs: 10,
				sleep,
			}),
		).resolves.toBe("ok")
		expect(operation).toHaveBeenCalledTimes(3)
		expect(sleep).toHaveBeenNthCalledWith(1, 10)
		expect(sleep).toHaveBeenNthCalledWith(2, 20)
	})

	it("does not retry deterministic query failures", async () => {
		const operation = vi
			.fn<() => Promise<never>>()
			.mockRejectedValue(new Error("invalid search index definition"))

		await expect(
			withMongoBenchmarkRetry("search", operation, {
				maxAttempts: 4,
				sleep: async () => {},
			}),
		).rejects.toThrow("invalid search index definition")
		expect(operation).toHaveBeenCalledOnce()
	})

	it("recognizes transient driver errors through wrapped causes", () => {
		const wrapped = new Error("benchmark query failed", {
			cause: Object.assign(new Error("socket reset"), {
				name: "MongoNetworkError",
			}),
		})
		expect(isTransientMongoBenchmarkError(wrapped)).toBe(true)
	})
})
