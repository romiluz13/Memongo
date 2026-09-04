/* eslint-disable @typescript-eslint/unbound-method -- Vitest mock method assertions */
import type { Collection } from "mongodb"
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import {
	MongoDBChangeStreamWatcher,
	type ChangeStreamCallback,
	isResumeTokenInvalid,
} from "./mongodb-change-stream.js"

// ---------------------------------------------------------------------------
// Mock change stream
// ---------------------------------------------------------------------------

type EventHandler = (event: unknown) => void

function createMockStream() {
	const handlers = new Map<string, EventHandler[]>()
	return {
		on: vi.fn((event: string, handler: EventHandler) => {
			if (!handlers.has(event)) {
				handlers.set(event, [])
			}
			const eventHandlers = handlers.get(event)
			if (eventHandlers) {
				eventHandlers.push(handler)
			}
		}),
		close: vi.fn(async () => {}),
		emit(event: string, data: unknown) {
			for (const handler of handlers.get(event) ?? []) {
				handler(data)
			}
		},
	}
}

function createMockCollection(
	stream: ReturnType<typeof createMockStream>,
): Collection {
	return {
		watch: vi.fn(() => stream),
	} as unknown as Collection
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("MongoDBChangeStreamWatcher", () => {
	let mockStream: ReturnType<typeof createMockStream>
	let mockCol: Collection
	let callback: ChangeStreamCallback
	let callbackArgs: Array<{
		operationType: string
		paths: string[]
		timestamp: Date
		resumeToken?: unknown
	}>

	beforeEach(() => {
		vi.useFakeTimers()
		mockStream = createMockStream()
		mockCol = createMockCollection(mockStream)
		callbackArgs = []
		callback = (event) => callbackArgs.push(event)
	})

	afterEach(async () => {
		vi.useRealTimers()
	})

	it("starts watching the collection", async () => {
		const watcher = new MongoDBChangeStreamWatcher(mockCol, callback, 100)
		const started = await watcher.start()

		expect(started).toBe(true)
		expect(mockCol.watch).toHaveBeenCalledTimes(1)
		expect(watcher.isActive).toBe(true)

		await watcher.close()
	})

	it("debounces change events", async () => {
		const watcher = new MongoDBChangeStreamWatcher(mockCol, callback, 100)
		await watcher.start()

		// Emit 3 rapid changes
		mockStream.emit("change", {
			operationType: "update",
			fullDocument: { path: "memory/a.md" },
			documentKey: { _id: "memory/a.md:1:5" },
		})
		mockStream.emit("change", {
			operationType: "update",
			fullDocument: { path: "memory/b.md" },
			documentKey: { _id: "memory/b.md:1:3" },
		})
		mockStream.emit("change", {
			operationType: "insert",
			fullDocument: { path: "memory/c.md" },
			documentKey: { _id: "memory/c.md:1:2" },
		})

		// No callback yet (debouncing)
		expect(callbackArgs.length).toBe(0)

		// Advance past debounce window
		vi.advanceTimersByTime(150)

		// Single batched callback
		expect(callbackArgs.length).toBe(1)
		expect(callbackArgs[0].paths).toContain("memory/a.md")
		expect(callbackArgs[0].paths).toContain("memory/b.md")
		expect(callbackArgs[0].paths).toContain("memory/c.md")
		expect(callbackArgs[0].operationType).toBe("insert")

		await watcher.close()
	})

	it("extracts path from delete events using _id composite key", async () => {
		const watcher = new MongoDBChangeStreamWatcher(mockCol, callback, 50)
		await watcher.start()

		// Delete event has no fullDocument
		mockStream.emit("change", {
			operationType: "delete",
			documentKey: { _id: "sessions/old.jsonl:1:10" },
		})

		vi.advanceTimersByTime(100)

		expect(callbackArgs.length).toBe(1)
		expect(callbackArgs[0].paths).toContain("sessions/old.jsonl")
		expect(callbackArgs[0].operationType).toBe("delete")

		await watcher.close()
	})

	it("exposes resume token on callback events", async () => {
		const watcher = new MongoDBChangeStreamWatcher(mockCol, callback, 50)
		await watcher.start()

		const token = { _data: "825F..." }
		mockStream.emit("change", {
			_id: token,
			operationType: "insert",
			fullDocument: { path: "memory/resume.md" },
			documentKey: { _id: "memory/resume.md:1:1" },
		})

		vi.advanceTimersByTime(100)

		expect(callbackArgs.length).toBe(1)
		expect(callbackArgs[0].resumeToken).toEqual(token)
		expect(watcher.lastResumeToken).toEqual(token)

		await watcher.close()
	})

	it("closes cleanly", async () => {
		const watcher = new MongoDBChangeStreamWatcher(mockCol, callback, 100)
		await watcher.start()
		expect(watcher.isActive).toBe(true)

		await watcher.close()
		expect(watcher.isActive).toBe(false)
		expect(mockStream.close).toHaveBeenCalled()
	})

	it("is idempotent on close", async () => {
		const watcher = new MongoDBChangeStreamWatcher(mockCol, callback, 100)
		await watcher.start()

		await watcher.close()
		await watcher.close() // second close should not throw
		expect(mockStream.close).toHaveBeenCalledTimes(1)
	})

	it("returns false on start when change streams not supported", async () => {
		const col = {
			watch: vi.fn(() => {
				throw new Error(
					"The $changeStream stage is only supported on replica sets",
				)
			}),
		} as unknown as Collection

		const watcher = new MongoDBChangeStreamWatcher(col, callback)
		const started = await watcher.start()

		expect(started).toBe(false)
		expect(watcher.isActive).toBe(false)
	})

	it("does not start after close", async () => {
		const watcher = new MongoDBChangeStreamWatcher(mockCol, callback, 100)
		await watcher.close()

		const started = await watcher.start()
		expect(started).toBe(false)
	})

	it("handles callback errors gracefully", async () => {
		const failingCallback: ChangeStreamCallback = () => {
			throw new Error("callback failed")
		}
		const watcher = new MongoDBChangeStreamWatcher(mockCol, failingCallback, 50)
		await watcher.start()

		mockStream.emit("change", {
			operationType: "insert",
			fullDocument: { path: "memory/test.md" },
			documentKey: { _id: "memory/test.md:1:1" },
		})

		// Should not throw
		vi.advanceTimersByTime(100)

		await watcher.close()
	})
})

// ---------------------------------------------------------------------------
// Resume token resilience (isResumeTokenInvalid + re-stream on stale token)
// ---------------------------------------------------------------------------

describe("isResumeTokenInvalid", () => {
	it("recognizes ChangeStreamHistoryLost (code 286) with the real errmsg", () => {
		const err = Object.assign(
			new Error(
				"Resume of change stream was not possible, as the resume point may no longer be in the oplog (resumeTimestamp: Timestamp(1730000000, 1))",
			),
			{ code: 286, codeName: "ChangeStreamHistoryLost" },
		)
		expect(isResumeTokenInvalid(err)).toBe(true)
	})

	it("recognizes InvalidResumeToken (code 260) via code", () => {
		const err = Object.assign(
			new Error(
				"Attempting to resume a change stream using 'resumeAfter' is not allowed",
			),
			{ code: 260, codeName: "InvalidResumeToken" },
		)
		expect(isResumeTokenInvalid(err)).toBe(true)
	})

	it("recognizes the real errmsg by case-insensitive substring (fallback)", () => {
		expect(
			isResumeTokenInvalid(
				new Error(
					"RESUME OF CHANGE STREAM WAS NOT POSSIBLE, AS THE RESUME POINT MAY NO LONGER BE IN THE OPLOG",
				),
			),
		).toBe(true)
	})

	it("does not match unrelated errors", () => {
		expect(
			isResumeTokenInvalid(
				Object.assign(new Error("The $changeStream stage is only supported"), {
					code: 303,
				}),
			),
		).toBe(false)
		expect(isResumeTokenInvalid(new Error("network timeout"))).toBe(false)
	})

	it("does NOT match ChangeStreamInvalidated (code 346) — different semantics", () => {
		const err = Object.assign(new Error("The collection was dropped"), {
			code: 346,
			codeName: "ChangeStreamInvalidated",
		})
		expect(isResumeTokenInvalid(err)).toBe(false)
	})
})

describe("MongoDBChangeStreamWatcher — resume token resilience", () => {
	let mockStream: ReturnType<typeof createMockStream>
	let callback: ChangeStreamCallback
	let callbackArgs: Array<{
		operationType: string
		paths: string[]
		timestamp: Date
		resumeToken?: unknown
		gapDetected?: { reason: string; from: "startup" | "midstream" }
	}>

	beforeEach(() => {
		vi.useFakeTimers()
		mockStream = createMockStream()
		callbackArgs = []
		callback = (event) => callbackArgs.push(event)
	})

	afterEach(async () => {
		vi.useRealTimers()
	})

	it("re-opens from now and signals a gap when the resume token is stale at startup", async () => {
		let watchCallCount = 0
		const col = {
			watch: vi.fn(() => {
				watchCallCount++
				if (watchCallCount === 1) {
					throw Object.assign(
						new Error(
							"Resume of change stream was not possible, as the resume point may no longer be in the oplog",
						),
						{ code: 286, codeName: "ChangeStreamHistoryLost" },
					)
				}
				return mockStream
			}),
		} as unknown as Collection

		const watcher = new MongoDBChangeStreamWatcher(col, callback, 100)
		const started = await watcher.start({ _data: "stale-token" })

		expect(started).toBe(true)
		expect(watchCallCount).toBe(2) // first failed, second succeeded from now
		expect(callbackArgs.some((e) => e.gapDetected?.from === "startup")).toBe(
			true,
		)

		await watcher.close()
	})

	it("re-opens from now and signals a gap on ChangeStreamInvalidated (346)", async () => {
		// Collection drop/rename closes the cursor; previously code 346 landed
		// in the log-only branch and the watcher went silently dark.
		let watchCallCount = 0
		const stream1 = createMockStream()
		const stream2 = createMockStream()
		const col = {
			watch: vi.fn(() => {
				watchCallCount++
				return watchCallCount === 1 ? stream1 : stream2
			}),
		} as unknown as Collection

		const watcher = new MongoDBChangeStreamWatcher(col, callback, 100)
		await watcher.start()

		stream1.emit(
			"error",
			Object.assign(new Error("change stream invalidated"), {
				code: 346,
				codeName: "ChangeStreamInvalidated",
			}),
		)

		expect(watchCallCount).toBe(2)
		expect(callbackArgs.some((e) => e.gapDetected?.from === "midstream")).toBe(
			true,
		)
		await watcher.close()
	})

	it("re-opens from now when the stream closes without an error event", async () => {
		let watchCallCount = 0
		const stream1 = createMockStream()
		const stream2 = createMockStream()
		const col = {
			watch: vi.fn(() => {
				watchCallCount++
				return watchCallCount === 1 ? stream1 : stream2
			}),
		} as unknown as Collection

		const watcher = new MongoDBChangeStreamWatcher(col, callback, 100)
		await watcher.start()

		stream1.emit("close", undefined)

		expect(watchCallCount).toBe(2)
		expect(callbackArgs.some((e) => e.gapDetected?.from === "midstream")).toBe(
			true,
		)

		// A deliberate close must NOT trigger another re-open.
		await watcher.close()
		stream2.emit("close", undefined)
		expect(watchCallCount).toBe(2)
	})

	it("re-opens from now and signals a gap on a mid-stream 'Resume Token Not Found' error", async () => {
		let watchCallCount = 0
		const stream1 = createMockStream()
		const stream2 = createMockStream()
		const col = {
			watch: vi.fn(() => {
				watchCallCount++
				return watchCallCount === 1 ? stream1 : stream2
			}),
		} as unknown as Collection

		const watcher = new MongoDBChangeStreamWatcher(col, callback, 100)
		await watcher.start()
		expect(watchCallCount).toBe(1)

		// Simulate a mid-stream token-invalid error using the real server code
		stream1.emit(
			"error",
			Object.assign(
				new Error(
					"Resume of change stream was not possible, as the resume point may no longer be in the oplog",
				),
				{ code: 286, codeName: "ChangeStreamHistoryLost" },
			),
		)

		expect(watchCallCount).toBe(2) // re-opened from now
		expect(callbackArgs.some((e) => e.gapDetected?.from === "midstream")).toBe(
			true,
		)

		await watcher.close()
	})
})

// ---------------------------------------------------------------------------
// C-016: supervision — exponential-backoff re-open (uncapped attempts,
// ceiling-bounded delay) + liveness surface
// ---------------------------------------------------------------------------

describe("MongoDBChangeStreamWatcher — supervision (backoff + liveness)", () => {
	let callback: ChangeStreamCallback
	let callbackArgs: Array<{
		operationType: string
		paths: string[]
		timestamp: Date
		resumeToken?: unknown
		gapDetected?: { reason: string; from: "startup" | "midstream" }
	}>

	/** Collection whose watch() returns a FRESH mock stream per call. */
	function createPerCallStreams() {
		const streams: ReturnType<typeof createMockStream>[] = []
		const col = {
			watch: vi.fn(() => {
				const stream = createMockStream()
				streams.push(stream)
				return stream
			}),
		} as unknown as Collection
		return { col, streams }
	}

	function historyLost(): Error {
		return Object.assign(
			new Error(
				"Resume of change stream was not possible, as the resume point may no longer be in the oplog",
			),
			{ code: 286, codeName: "ChangeStreamHistoryLost" },
		)
	}

	beforeEach(() => {
		vi.useFakeTimers()
		callbackArgs = []
		callback = (event) => callbackArgs.push(event)
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	it("re-opens immediately once, then backs off exponentially with a ceiling", async () => {
		const { col, streams } = createPerCallStreams()
		const watcher = new MongoDBChangeStreamWatcher(col, callback, 100, {
			baseDelayMs: 100,
			maxDelayMs: 400,
		})
		await watcher.start()

		// Kill #1 → attempt 1 re-opens IMMEDIATELY (delay 0)
		streams[0].emit("error", historyLost())
		expect(col.watch).toHaveBeenCalledTimes(2)

		// Kill #2 → attempt 2 waits baseDelayMs (100)
		streams[1].emit("error", historyLost())
		expect(col.watch).toHaveBeenCalledTimes(2)
		const recovering = watcher.liveness
		expect(recovering.active).toBe(false)
		expect(recovering.state).toBe("recovering")
		expect(recovering.reopenAttempts).toBe(2)
		expect(recovering.nextReopenDelayMs).toBe(100)
		vi.advanceTimersByTime(100)
		expect(col.watch).toHaveBeenCalledTimes(3)

		// Kill #3 → attempt 3 waits 2*base (200)
		streams[2].emit("error", historyLost())
		vi.advanceTimersByTime(199)
		expect(col.watch).toHaveBeenCalledTimes(3)
		vi.advanceTimersByTime(1)
		expect(col.watch).toHaveBeenCalledTimes(4)

		// Kill #4 → attempt 4 waits 4*base (400) = ceiling
		streams[3].emit("error", historyLost())
		vi.advanceTimersByTime(399)
		expect(col.watch).toHaveBeenCalledTimes(4)
		vi.advanceTimersByTime(1)
		expect(col.watch).toHaveBeenCalledTimes(5)

		// Kill #5 → attempt 5 stays at the ceiling (400, not 800)
		streams[4].emit("error", historyLost())
		vi.advanceTimersByTime(400)
		expect(col.watch).toHaveBeenCalledTimes(6)

		await watcher.close()
	})

	it("keeps re-opening under sustained failure — no permanent stop after 3 attempts (C-016)", async () => {
		const { col, streams } = createPerCallStreams()
		const watcher = new MongoDBChangeStreamWatcher(col, callback, 100, {
			baseDelayMs: 10,
			maxDelayMs: 20,
		})
		await watcher.start()

		// Pre-C-016 the watcher closed itself after 3 re-opens and went dark.
		for (let kill = 0; kill < 8; kill++) {
			streams[kill].emit("error", historyLost())
			vi.advanceTimersByTime(20)
		}
		expect(col.watch).toHaveBeenCalledTimes(9) // initial + 8 re-opens
		const liveness = watcher.liveness
		expect(liveness.state).not.toBe("stopped")
		expect(liveness.reopenAttempts).toBe(8)

		await watcher.close()
	})

	it("resets the backoff budget after a real change event proves the stream alive", async () => {
		const { col, streams } = createPerCallStreams()
		const watcher = new MongoDBChangeStreamWatcher(col, callback, 100, {
			baseDelayMs: 100,
			maxDelayMs: 400,
		})
		await watcher.start()

		// Kill #1 → immediate re-open
		streams[0].emit("error", historyLost())
		expect(col.watch).toHaveBeenCalledTimes(2)
		expect(watcher.liveness.reopenAttempts).toBe(1)

		// A real change event on the re-opened stream proves it alive
		streams[1].emit("change", {
			operationType: "insert",
			fullDocument: { path: "memory/x.md" },
			documentKey: { _id: "memory/x.md:1:1" },
		})
		vi.advanceTimersByTime(150) // debounce flush
		expect(watcher.liveness.reopenAttempts).toBe(0)

		// Kill again → immediate re-open, budget reset (not 200ms backoff)
		streams[1].emit("error", historyLost())
		expect(col.watch).toHaveBeenCalledTimes(3)
		expect(watcher.liveness).toEqual({
			active: true,
			state: "active",
			reopenAttempts: 1,
			nextReopenDelayMs: null,
		})

		await watcher.close()
	})

	it("signals the gap immediately even when the re-open is delayed by backoff", async () => {
		const { col, streams } = createPerCallStreams()
		const watcher = new MongoDBChangeStreamWatcher(col, callback, 100, {
			baseDelayMs: 5000,
			maxDelayMs: 30_000,
		})
		await watcher.start()

		streams[0].emit("error", historyLost()) // immediate re-open
		streams[1].emit("error", historyLost()) // delayed re-open (5s)

		// Both gaps fired synchronously; the re-scan must not wait for backoff
		expect(
			callbackArgs.filter((event) => event.gapDetected?.from === "midstream"),
		).toHaveLength(2)
		expect(col.watch).toHaveBeenCalledTimes(2) // second re-open still pending

		await watcher.close()
	})

	it("close() cancels a scheduled re-open — no resurrection", async () => {
		const { col, streams } = createPerCallStreams()
		const watcher = new MongoDBChangeStreamWatcher(col, callback, 100, {
			baseDelayMs: 100,
			maxDelayMs: 400,
		})
		await watcher.start()

		streams[0].emit("error", historyLost()) // immediate re-open
		streams[1].emit("error", historyLost()) // re-open scheduled at +100ms
		expect(watcher.liveness.state).toBe("recovering")

		await watcher.close()
		vi.advanceTimersByTime(1000)
		expect(col.watch).toHaveBeenCalledTimes(2) // scheduled re-open never fired
		expect(watcher.liveness).toEqual({
			active: false,
			state: "stopped",
			reopenAttempts: 2,
			nextReopenDelayMs: null,
		})
	})

	it("reports liveness active while streaming and stopped after close", async () => {
		const { col } = createPerCallStreams()
		const watcher = new MongoDBChangeStreamWatcher(col, callback, 100)
		await watcher.start()

		expect(watcher.liveness).toEqual({
			active: true,
			state: "active",
			reopenAttempts: 0,
			nextReopenDelayMs: null,
		})

		await watcher.close()
		expect(watcher.liveness).toEqual({
			active: false,
			state: "stopped",
			reopenAttempts: 0,
			nextReopenDelayMs: null,
		})
	})

	it("closes for good on a standalone-topology error mid-stream", async () => {
		const { col, streams } = createPerCallStreams()
		const watcher = new MongoDBChangeStreamWatcher(col, callback, 100, {
			baseDelayMs: 100,
			maxDelayMs: 400,
		})
		await watcher.start()

		streams[0].emit(
			"error",
			new Error("The $changeStream stage is only supported on replica sets"),
		)

		expect(watcher.liveness.state).toBe("stopped")
		vi.advanceTimersByTime(10_000)
		expect(col.watch).toHaveBeenCalledTimes(1) // never retried
	})

	it("retries under backoff when re-opening throws synchronously (gap not re-emitted)", async () => {
		let watchCallCount = 0
		const stream1 = createMockStream()
		const col = {
			watch: vi.fn(() => {
				watchCallCount++
				if (watchCallCount === 2) {
					throw new Error("connection lost")
				}
				return stream1
			}),
		} as unknown as Collection

		const watcher = new MongoDBChangeStreamWatcher(col, callback, 100, {
			baseDelayMs: 100,
			maxDelayMs: 400,
		})
		await watcher.start()

		// Kill #1 → attempt 1 opens immediately but watch() throws
		stream1.emit("error", historyLost())
		expect(col.watch).toHaveBeenCalledTimes(2) // the failed attempt
		expect(watcher.liveness.state).toBe("recovering") // retry scheduled

		// The internal retry must NOT re-emit the gap (re-scan already running)
		expect(callbackArgs.filter((e) => e.gapDetected)).toHaveLength(1)

		vi.advanceTimersByTime(100)
		expect(col.watch).toHaveBeenCalledTimes(3) // attempt 2 succeeded
		expect(watcher.liveness.state).toBe("active")

		await watcher.close()
	})
})
