import fc from "fast-check"
import { afterEach, describe, expect, it, vi } from "vitest"
import { resolveRetryConfig, retryAsync, type RetryInfo } from "./retry.js"

afterEach(() => {
	vi.useRealTimers()
})

describe("retry: resolveRetryConfig", () => {
	it("returns documented defaults when no overrides are given", () => {
		expect(resolveRetryConfig()).toEqual({
			attempts: 3,
			minDelayMs: 300,
			maxDelayMs: 30_000,
			jitter: 0,
		})
	})

	it("clamps attempts to [1, 100] and rounds", () => {
		expect(resolveRetryConfig(undefined, { attempts: 0 }).attempts).toBe(1)
		expect(resolveRetryConfig(undefined, { attempts: -5 }).attempts).toBe(1)
		expect(resolveRetryConfig(undefined, { attempts: 1000 }).attempts).toBe(100)
		expect(resolveRetryConfig(undefined, { attempts: 2.6 }).attempts).toBe(3)
	})

	it("clamps delays to their documented ceilings", () => {
		const resolved = resolveRetryConfig(undefined, {
			minDelayMs: -10,
			maxDelayMs: 10_000_000,
		})
		expect(resolved.minDelayMs).toBe(0)
		expect(resolved.maxDelayMs).toBe(600_000)
		expect(
			resolveRetryConfig(undefined, { minDelayMs: 999_999 }).minDelayMs,
		).toBe(300_000)
	})

	it("raises maxDelayMs to at least minDelayMs", () => {
		const resolved = resolveRetryConfig(undefined, {
			minDelayMs: 1_000,
			maxDelayMs: 10,
		})
		expect(resolved.maxDelayMs).toBe(1_000)
	})

	it("clamps jitter to [0, 1]", () => {
		expect(resolveRetryConfig(undefined, { jitter: -1 }).jitter).toBe(0)
		expect(resolveRetryConfig(undefined, { jitter: 5 }).jitter).toBe(1)
	})

	it("falls back to defaults for non-finite overrides", () => {
		const resolved = resolveRetryConfig(undefined, {
			attempts: Number.NaN,
			minDelayMs: Number.POSITIVE_INFINITY,
			maxDelayMs: Number.NaN,
			jitter: Number.NEGATIVE_INFINITY,
		})
		expect(resolved).toEqual({
			attempts: 3,
			minDelayMs: 300,
			maxDelayMs: 30_000,
			jitter: 0,
		})
	})

	it("respects caller-supplied defaults", () => {
		const resolved = resolveRetryConfig(
			{ attempts: 5, minDelayMs: 10, maxDelayMs: 100, jitter: 0.5 },
			{},
		)
		expect(resolved).toEqual({
			attempts: 5,
			minDelayMs: 10,
			maxDelayMs: 100,
			jitter: 0.5,
		})
	})

	it("keeps every resolved config within documented bounds (property)", () => {
		fc.assert(
			fc.property(
				fc.record(
					{
						attempts: fc.double(),
						minDelayMs: fc.double(),
						maxDelayMs: fc.double(),
						jitter: fc.double(),
					},
					{ requiredKeys: [] },
				),
				(overrides) => {
					const resolved = resolveRetryConfig(undefined, overrides)
					expect(Number.isInteger(resolved.attempts)).toBe(true)
					expect(resolved.attempts).toBeGreaterThanOrEqual(1)
					expect(resolved.attempts).toBeLessThanOrEqual(100)
					expect(resolved.minDelayMs).toBeGreaterThanOrEqual(0)
					expect(resolved.minDelayMs).toBeLessThanOrEqual(300_000)
					expect(resolved.maxDelayMs).toBeGreaterThanOrEqual(
						resolved.minDelayMs,
					)
					expect(resolved.maxDelayMs).toBeLessThanOrEqual(600_000)
					expect(resolved.jitter).toBeGreaterThanOrEqual(0)
					expect(resolved.jitter).toBeLessThanOrEqual(1)
				},
			),
		)
	})
})

describe("retry: retryAsync (number form)", () => {
	it("returns the value on first success without retrying", async () => {
		const fn = vi.fn().mockResolvedValue("ok")
		await expect(retryAsync(fn, 3, 1)).resolves.toBe("ok")
		expect(fn).toHaveBeenCalledTimes(1)
	})

	it("retries until success and returns the eventual value", async () => {
		const fn = vi
			.fn()
			.mockRejectedValueOnce(new Error("one"))
			.mockRejectedValueOnce(new Error("two"))
			.mockResolvedValue("third")
		await expect(retryAsync(fn, 5, 1)).resolves.toBe("third")
		expect(fn).toHaveBeenCalledTimes(3)
	})

	it("throws the last error after exhausting attempts", async () => {
		const errors = [new Error("e1"), new Error("e2"), new Error("e3")]
		const fn = vi
			.fn()
			.mockRejectedValueOnce(errors[0])
			.mockRejectedValueOnce(errors[1])
			.mockRejectedValueOnce(errors[2])
		await expect(retryAsync(fn, 3, 1)).rejects.toBe(errors[2])
		expect(fn).toHaveBeenCalledTimes(3)
	})

	it("runs exactly once when attempts is 1", async () => {
		const err = new Error("boom")
		const fn = vi.fn().mockRejectedValue(err)
		await expect(retryAsync(fn, 1, 1)).rejects.toBe(err)
		expect(fn).toHaveBeenCalledTimes(1)
	})

	it("waits initialDelayMs * 2^i between attempts", async () => {
		vi.useFakeTimers()
		const fn = vi
			.fn()
			.mockRejectedValueOnce(new Error("one"))
			.mockRejectedValueOnce(new Error("two"))
			.mockResolvedValue("done")
		const promise = retryAsync(fn, 3, 1_000)
		await vi.advanceTimersByTimeAsync(0)
		expect(fn).toHaveBeenCalledTimes(1)
		// First backoff: 1000ms.
		await vi.advanceTimersByTimeAsync(999)
		expect(fn).toHaveBeenCalledTimes(1)
		await vi.advanceTimersByTimeAsync(1)
		expect(fn).toHaveBeenCalledTimes(2)
		// Second backoff: 2000ms.
		await vi.advanceTimersByTimeAsync(1_999)
		expect(fn).toHaveBeenCalledTimes(2)
		await vi.advanceTimersByTimeAsync(1)
		expect(fn).toHaveBeenCalledTimes(3)
		await expect(promise).resolves.toBe("done")
	})
})

describe("retry: retryAsync (options form)", () => {
	it("retries up to attempts and throws the last error", async () => {
		const last = new Error("last")
		const fn = vi
			.fn()
			.mockRejectedValueOnce(new Error("first"))
			.mockRejectedValue(last)
		await expect(retryAsync(fn, { attempts: 3, minDelayMs: 0 })).rejects.toBe(
			last,
		)
		expect(fn).toHaveBeenCalledTimes(3)
	})

	it("stops immediately when shouldRetry rejects the error", async () => {
		const err = new Error("fatal")
		const fn = vi.fn().mockRejectedValue(err)
		const shouldRetry = vi.fn().mockReturnValue(false)
		await expect(
			retryAsync(fn, { attempts: 5, minDelayMs: 0, shouldRetry }),
		).rejects.toBe(err)
		expect(fn).toHaveBeenCalledTimes(1)
		expect(shouldRetry).toHaveBeenCalledWith(err, 1)
	})

	it("passes the 1-based attempt number to shouldRetry", async () => {
		const attemptsSeen: number[] = []
		const fn = vi.fn().mockRejectedValue(new Error("x"))
		await retryAsync(fn, {
			attempts: 3,
			minDelayMs: 0,
			shouldRetry: (_err, attempt) => {
				attemptsSeen.push(attempt)
				return true
			},
		}).catch(() => {})
		expect(attemptsSeen).toEqual([1, 2])
	})

	it("reports retries through onRetry with delay, error, and label", async () => {
		const infos: RetryInfo[] = []
		const err = new Error("transient")
		const fn = vi.fn().mockRejectedValueOnce(err).mockResolvedValue("ok")
		await retryAsync(fn, {
			attempts: 3,
			minDelayMs: 0,
			label: "unit-test",
			onRetry: (info) => infos.push(info),
		})
		expect(infos).toHaveLength(1)
		expect(infos[0].attempt).toBe(1)
		expect(infos[0].maxAttempts).toBe(3)
		expect(infos[0].err).toBe(err)
		expect(infos[0].label).toBe("unit-test")
		expect(infos[0].delayMs).toBeGreaterThanOrEqual(0)
	})

	it("follows an exponential backoff schedule capped by maxDelayMs", async () => {
		const delays: number[] = []
		const fn = vi.fn().mockRejectedValue(new Error("x"))
		await retryAsync(fn, {
			attempts: 4,
			minDelayMs: 1,
			maxDelayMs: 3,
			onRetry: (info) => delays.push(info.delayMs),
		}).catch(() => {})
		// Raw schedule 1, 2, 4 — the 4 is capped to maxDelayMs 3.
		expect(delays).toEqual([1, 2, 3])
	})

	it("honors retryAfterMs over the exponential schedule", async () => {
		const delays: number[] = []
		const fn = vi.fn().mockRejectedValue(new Error("rate limited"))
		await retryAsync(fn, {
			attempts: 2,
			minDelayMs: 2,
			maxDelayMs: 50,
			retryAfterMs: () => 20,
			onRetry: (info) => delays.push(info.delayMs),
		}).catch(() => {})
		expect(delays).toEqual([20])
	})

	it("never delays less than minDelayMs even when retryAfterMs is smaller", async () => {
		const delays: number[] = []
		const fn = vi.fn().mockRejectedValue(new Error("x"))
		await retryAsync(fn, {
			attempts: 2,
			minDelayMs: 10,
			maxDelayMs: 50,
			retryAfterMs: () => 1,
			onRetry: (info) => delays.push(info.delayMs),
		}).catch(() => {})
		expect(delays).toEqual([10])
	})

	it("ignores non-finite retryAfterMs and falls back to exponential", async () => {
		const delays: number[] = []
		const fn = vi.fn().mockRejectedValue(new Error("x"))
		await retryAsync(fn, {
			attempts: 3,
			minDelayMs: 1,
			retryAfterMs: () => Number.NaN,
			onRetry: (info) => delays.push(info.delayMs),
		}).catch(() => {})
		expect(delays).toEqual([1, 2])
	})

	it("keeps jittered delays within [minDelayMs, maxDelayMs]", async () => {
		for (let i = 0; i < 10; i += 1) {
			const delays: number[] = []
			const fn = vi.fn().mockRejectedValue(new Error("x"))
			await retryAsync(fn, {
				attempts: 2,
				minDelayMs: 10,
				maxDelayMs: 20,
				jitter: 0.9,
				onRetry: (info) => delays.push(info.delayMs),
			}).catch(() => {})
			expect(delays).toHaveLength(1)
			expect(delays[0]).toBeGreaterThanOrEqual(10)
			expect(delays[0]).toBeLessThanOrEqual(20)
		}
	})

	it("actually sleeps for the computed delay before retrying", async () => {
		vi.useFakeTimers()
		const fn = vi
			.fn()
			.mockRejectedValueOnce(new Error("boom"))
			.mockResolvedValue("ok")
		const promise = retryAsync(fn, { attempts: 2, minDelayMs: 1_000 })
		await vi.advanceTimersByTimeAsync(0)
		expect(fn).toHaveBeenCalledTimes(1)
		await vi.advanceTimersByTimeAsync(999)
		expect(fn).toHaveBeenCalledTimes(1)
		await vi.advanceTimersByTimeAsync(1)
		expect(fn).toHaveBeenCalledTimes(2)
		await expect(promise).resolves.toBe("ok")
	})

	it("preserves non-Error thrown values", async () => {
		const fn = vi.fn().mockRejectedValue("string failure")
		await expect(retryAsync(fn, { attempts: 2, minDelayMs: 0 })).rejects.toBe(
			"string failure",
		)
	})
})
