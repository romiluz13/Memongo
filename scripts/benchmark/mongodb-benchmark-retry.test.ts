import { afterEach, describe, expect, it, vi } from "vitest"
import {
	isTransientMongoBenchmarkError,
	withMongoBenchmarkRetry,
} from "./mongodb-benchmark-retry.js"

describe("MongoDB benchmark retry boundary", () => {
	afterEach(() => vi.restoreAllMocks())

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

	it.each([
		["vector convergence", "vector-convergence-timeout"],
		["search convergence", "text-convergence-timeout"],
	])("retains terminal %s metadata without private content", async (kind, reason) => {
		const output = vi.spyOn(console, "error").mockImplementation(() => {})
		const error = Object.freeze(
			new Error(`benchmark events ${kind} timed out: agentId=PRIVATE`),
		)
		const operation = vi.fn<() => Promise<never>>().mockRejectedValue(error)

		await expect(
			withMongoBenchmarkRetry("search convergence for PRIVATE", operation, {
				maxAttempts: 3,
			}),
		).rejects.toBe(error)
		expect(operation).toHaveBeenCalledOnce()
		expect(output).toHaveBeenCalledExactlyOnceWith(
			`[memory:mongodb:benchmark-failure] ${JSON.stringify({
				operation: "search convergence",
				attempt: 1,
				maxAttempts: 3,
				errorType: "Error",
				reason,
			})}`,
		)
		expect(JSON.stringify(output.mock.calls)).not.toContain("PRIVATE")
	})

	it("reports exhausted retries once and preserves the original error", async () => {
		const output = vi.spyOn(console, "error").mockImplementation(() => {})
		const error = Object.freeze(
			Object.assign(new Error("PRIVATE"), {
				name: "MongoNetworkTimeoutError",
			}),
		)
		const operation = vi.fn<() => Promise<never>>().mockRejectedValue(error)
		const sleep = vi.fn(async () => {})

		await expect(
			withMongoBenchmarkRetry("events vector index readiness", operation, {
				maxAttempts: 2,
				baseDelayMs: 10,
				sleep,
			}),
		).rejects.toBe(error)
		expect(operation).toHaveBeenCalledTimes(2)
		expect(sleep).toHaveBeenCalledExactlyOnceWith(10)
		expect(output).toHaveBeenCalledExactlyOnceWith(
			`[memory:mongodb:benchmark-failure] ${JSON.stringify({
				operation: "events vector index readiness",
				attempt: 2,
				maxAttempts: 2,
				errorType: "MongoNetworkTimeoutError",
				reason: "unclassified",
			})}`,
		)
	})

	it.each([
		"benchmark event evidence",
		"event evidence",
		"raw-session search",
		"decomposed search",
		"original decomposed search",
		"relevance search",
		"search",
		"events vector convergence source read",
		"chunks text convergence source read",
		"session_chunks text index readiness",
		"memory_evidence vector index readiness",
	])("retains the known operation %s", async (label) => {
		const output = vi.spyOn(console, "error").mockImplementation(() => {})
		const error = new Error("PRIVATE")
		await expect(
			withMongoBenchmarkRetry(`${label} for PRIVATE`, async () => {
				throw error
			}),
		).rejects.toBe(error)
		const diagnostic = JSON.parse(
			String(output.mock.calls[0]?.[0]).split("] ")[1],
		)
		expect(diagnostic.operation).toBe(label)
		expect(JSON.stringify(output.mock.calls)).not.toContain("PRIVATE")
	})

	it.each([
		Object.assign(new Error("PRIVATE"), { name: "PRIVATE" }),
		"PRIVATE",
	])("does not emit unknown labels, names or thrown values", async (error) => {
		const output = vi.spyOn(console, "error").mockImplementation(() => {})
		await expect(
			withMongoBenchmarkRetry(
				"PRIVATE",
				async () => {
					throw error
				},
				{ maxAttempts: 1 },
			),
		).rejects.toBe(error)
		expect(output).toHaveBeenCalledExactlyOnceWith(
			`[memory:mongodb:benchmark-failure] ${JSON.stringify({
				operation: "unknown",
				attempt: 1,
				maxAttempts: 1,
				errorType: "UnknownError",
				reason: "unclassified",
			})}`,
		)
	})

	it("does not report a terminal failure after a successful retry", async () => {
		const output = vi.spyOn(console, "error").mockImplementation(() => {})
		const operation = vi
			.fn<() => Promise<string>>()
			.mockRejectedValueOnce(
				Object.assign(new Error("PRIVATE"), {
					name: "MongoNetworkError",
				}),
			)
			.mockResolvedValue("ok")
		await expect(
			withMongoBenchmarkRetry("search", operation, {
				sleep: async () => {},
			}),
		).resolves.toBe("ok")
		expect(output).not.toHaveBeenCalled()
	})
})
