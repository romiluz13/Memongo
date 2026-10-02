import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { startConsolidationHeartbeat } from "./consolidation-heartbeat.js"

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe("consolidation heartbeat lifetime", () => {
	it("renews periodically and stops without leaving a timer", async () => {
		const renew = vi.fn(async () => {})
		const heartbeat = startConsolidationHeartbeat({ leaseMs: 3000, renew })
		await vi.advanceTimersByTimeAsync(2100)
		expect(renew).toHaveBeenCalledTimes(2)
		await heartbeat.stop()
		expect(vi.getTimerCount()).toBe(0)
		await vi.advanceTimersByTimeAsync(3000)
		expect(renew).toHaveBeenCalledTimes(2)
	})
	it("coalesces ticks behind a slow write and awaits pending renewal on stop", async () => {
		let release = () => {}
		const waiting = new Promise<void>((resolve) => {
			release = resolve
		})
		const renew = vi.fn(async () => {})
		const heartbeat = startConsolidationHeartbeat({ leaseMs: 3000, renew })
		const write = heartbeat.enqueue(() => waiting)
		await vi.advanceTimersByTimeAsync(5000)
		expect(renew).not.toHaveBeenCalled()
		let stopped = false
		const stop = heartbeat.stop().then(() => {
			stopped = true
		})
		await Promise.resolve()
		expect(stopped).toBe(false)
		release()
		await write
		await stop
		expect(renew).toHaveBeenCalledTimes(1)
		expect(vi.getTimerCount()).toBe(0)
	})
	it("keeps ordinary write errors from poisoning later queued work", async () => {
		const fault = new Error("content fault")
		const heartbeat = startConsolidationHeartbeat({
			leaseMs: 3000,
			renew: async () => {},
		})
		await expect(
			heartbeat.enqueue(async () => {
				throw fault
			}),
		).rejects.toBe(fault)
		await expect(
			heartbeat.enqueue(async () => {
				heartbeat.throwIfFailed()
				return 42
			}),
		).resolves.toBe(42)
		await vi.advanceTimersByTimeAsync(1000)
		expect(() => heartbeat.throwIfFailed()).not.toThrow()
		await heartbeat.stop()
	})
	it("preserves the first renewal error and blocks later guarded effects", async () => {
		const fault = new Error("renewal fault")
		const renew = vi.fn(async () => {
			throw fault
		})
		const effect = vi.fn(async () => {})
		const heartbeat = startConsolidationHeartbeat({ leaseMs: 3000, renew })
		await vi.advanceTimersByTimeAsync(1000)
		await expect(
			heartbeat.enqueue(async () => {
				heartbeat.throwIfFailed()
				await effect()
			}),
		).rejects.toBe(fault)
		expect(effect).not.toHaveBeenCalled()
		await vi.advanceTimersByTimeAsync(4000)
		expect(renew).toHaveBeenCalledTimes(1)
		await expect(heartbeat.enqueue(async () => "incurred-spend")).resolves.toBe(
			"incurred-spend",
		)
		await heartbeat.stop()
		expect(vi.getTimerCount()).toBe(0)
	})
	it("remembers even an undefined rejection without masking cleanup", async () => {
		const heartbeat = startConsolidationHeartbeat({
			leaseMs: 3000,
			renew: () => Promise.reject(undefined),
		})
		await vi.advanceTimersByTimeAsync(1000)
		await expect(
			heartbeat.enqueue(async () => {
				heartbeat.throwIfFailed()
			}),
		).rejects.toBeUndefined()
		await heartbeat.stop()
		expect(vi.getTimerCount()).toBe(0)
	})
	it.each([
		0,
		-1,
		2.5,
		2999,
		Number.NaN,
		Number.POSITIVE_INFINITY,
	])("does not create a fast timer for duration %s", async (leaseMs) => {
		const renew = vi.fn(async () => {})
		const heartbeat = startConsolidationHeartbeat({ leaseMs, renew })
		expect(vi.getTimerCount()).toBe(0)
		await heartbeat.stop()
		expect(renew).not.toHaveBeenCalled()
	})
	it("caps huge timer delays instead of letting Node reset them to one millisecond", async () => {
		const renew = vi.fn(async () => {})
		const heartbeat = startConsolidationHeartbeat({
			leaseMs: 10_000_000_000,
			renew,
		})
		await vi.advanceTimersByTimeAsync(2_147_483_646)
		expect(renew).not.toHaveBeenCalled()
		await vi.advanceTimersByTimeAsync(1)
		expect(renew).toHaveBeenCalledTimes(1)
		await heartbeat.stop()
	})
})
