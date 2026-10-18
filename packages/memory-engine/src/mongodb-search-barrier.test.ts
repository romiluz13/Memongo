import { describe, expect, it, vi } from "vitest"
import {
	annotateUncertainCommit,
	assertSearchBarrierTargets,
	awaitSearchBarrier,
	createSearchBarrierProbe,
	isSearchBarrierUnsupportedError,
	type SearchBarrierClock,
	type SearchBarrierProbe,
	runSearchBarrier,
	searchBarrierTargets,
} from "./mongodb-search-barrier.js"

function fakeClock(options: { frozen?: boolean } = {}) {
	let now = 0
	const clock: SearchBarrierClock & {
		advance: (ms: number) => void
		elapsed: () => number
	} = {
		now: () => now,
		// Resolves on a macrotask so probes that settle on microtasks finish
		// first; an aborted sleep resolves without moving time.
		sleep: (ms, signal) =>
			new Promise((resolve) => {
				setImmediate(() => {
					if (!signal?.aborted && !options.frozen) now += ms
					resolve()
				})
			}),
		advance: (ms) => {
			now += ms
		},
		elapsed: () => now,
	}
	return clock
}

const EVENT_TARGETS = searchBarrierTargets("event")
const TOKEN = "65f0c0ffee0000000000beef"

function probeFrom(
	answer: (index: string, attempt: number) => number | Promise<number>,
) {
	const attempts = new Map<string, number>()
	const probe = vi.fn<SearchBarrierProbe>(async (target) => {
		const attempt = (attempts.get(target.index) ?? 0) + 1
		attempts.set(target.index, attempt)
		return answer(target.index, attempt)
	})
	return probe
}

describe("search barrier runner", () => {
	it("reports searchable once every target returns the written token", async () => {
		const probe = probeFrom(() => 1)
		const result = await runSearchBarrier({
			targets: EVENT_TARGETS,
			token: TOKEN,
			probe,
			clock: fakeClock(),
		})
		expect(result).toEqual({
			committed: true,
			status: "searchable",
			targets: [
				{ index: "events_text", status: "confirmed", attempts: 1 },
				{ index: "events_vector", status: "confirmed", attempts: 1 },
				{ index: "chunks_text", status: "confirmed", attempts: 1 },
				{ index: "chunks_vector", status: "confirmed", attempts: 1 },
			],
		})
		for (const call of probe.mock.calls) expect(call[1]).toBe(TOKEN)
	})

	it("latches confirmed targets and probes only the unconfirmed ones", async () => {
		const probe = probeFrom((index, attempt) =>
			index === "chunks_vector" ? (attempt >= 3 ? 1 : 0) : 1,
		)
		const result = await runSearchBarrier({
			targets: EVENT_TARGETS,
			token: TOKEN,
			probe,
			clock: fakeClock(),
		})
		expect(result.status).toBe("searchable")
		expect(result.targets).toEqual([
			{ index: "events_text", status: "confirmed", attempts: 1 },
			{ index: "events_vector", status: "confirmed", attempts: 1 },
			{ index: "chunks_text", status: "confirmed", attempts: 1 },
			{ index: "chunks_vector", status: "confirmed", attempts: 3 },
		])
		expect(probe).toHaveBeenCalledTimes(6)
	})

	it("times out after the default 10 s bound with at most 10 attempts per index", async () => {
		const clock = fakeClock()
		const probe = probeFrom((index) => (index === "events_text" ? 1 : 0))
		const result = await runSearchBarrier({
			targets: EVENT_TARGETS,
			token: TOKEN,
			probe,
			clock,
		})
		expect(result).toEqual({
			committed: true,
			status: "not-yet-searchable",
			reason: "timeout",
			targets: [
				{ index: "events_text", status: "confirmed", attempts: 1 },
				{ index: "events_vector", status: "pending", attempts: 10 },
				{ index: "chunks_text", status: "pending", attempts: 10 },
				{ index: "chunks_vector", status: "pending", attempts: 10 },
			],
		})
		expect(clock.elapsed()).toBeLessThanOrEqual(10_000)
	})

	it("never exceeds 10 attempts per index even when the clock does not move", async () => {
		const probe = probeFrom(() => 0)
		const result = await runSearchBarrier({
			targets: searchBarrierTargets("structured"),
			token: TOKEN,
			probe,
			clock: fakeClock({ frozen: true }),
		})
		expect(result.status).toBe("not-yet-searchable")
		expect(result.reason).toBe("timeout")
		expect(result.targets.map((target) => target.attempts)).toEqual([10, 10])
		expect(probe).toHaveBeenCalledTimes(20)
	})

	it.each([
		{ timeoutMs: 2_500, attempts: 3 },
		{ timeoutMs: 1_000, attempts: 1 },
		{ timeoutMs: 1, attempts: 1 },
		{ timeoutMs: 0, attempts: 1 },
		{ timeoutMs: 60_000, attempts: 10 },
	])("clamps timeoutMs $timeoutMs into [1000, 10000] ms and stops after $attempts attempt(s)", async ({
		timeoutMs,
		attempts,
	}) => {
		const clock = fakeClock()
		const result = await runSearchBarrier({
			targets: searchBarrierTargets("procedure"),
			token: TOKEN,
			timeoutMs,
			probe: probeFrom(() => 0),
			clock,
		})
		expect(result.reason).toBe("timeout")
		expect(result.targets).toEqual([
			{ index: "procedures_text", status: "pending", attempts },
			{ index: "procedures_vector", status: "pending", attempts },
		])
		expect(clock.elapsed()).toBeLessThanOrEqual(
			Math.min(10_000, Math.max(1_000, timeoutMs)),
		)
	})

	it("spaces rounds by the fixed 1 s interval", async () => {
		const clock = fakeClock()
		const roundTimes: number[] = []
		await runSearchBarrier({
			targets: searchBarrierTargets("procedure"),
			token: TOKEN,
			timeoutMs: 3_000,
			probe: probeFrom((index) => {
				if (index === "procedures_text") roundTimes.push(clock.now())
				return 0
			}),
			clock,
		})
		expect(roundTimes).toEqual([0, 1_000, 2_000])
	})

	it("classifies a probe error after commit as committed probe-failed", async () => {
		const probe = probeFrom((index) => {
			if (index === "events_vector") {
				throw new Error("$vectorSearch exact is not supported: provider text")
			}
			return 0
		})
		const result = await runSearchBarrier({
			targets: EVENT_TARGETS,
			token: TOKEN,
			probe,
			clock: fakeClock(),
		})
		expect(result).toEqual({
			committed: true,
			status: "not-yet-searchable",
			reason: "probe-failed",
			targets: [
				{ index: "events_text", status: "pending", attempts: 1 },
				{ index: "events_vector", status: "failed", attempts: 1 },
				{ index: "chunks_text", status: "pending", attempts: 1 },
				{ index: "chunks_vector", status: "pending", attempts: 1 },
			],
		})
		expect(probe).toHaveBeenCalledTimes(4)
	})

	it("never counts an empty or multi-document probe answer as confirmation", async () => {
		const probe = probeFrom((index) => (index === "events_text" ? 2 : 0))
		const result = await runSearchBarrier({
			targets: EVENT_TARGETS,
			token: TOKEN,
			timeoutMs: 1_000,
			probe,
			clock: fakeClock(),
		})
		expect(result.status).toBe("not-yet-searchable")
		expect(result.targets.every((target) => target.status === "pending")).toBe(
			true,
		)
	})

	it("times out at the deadline when a probe never answers", async () => {
		const clock = fakeClock()
		const probe = vi.fn<SearchBarrierProbe>(async (target) =>
			target.index === "chunks_vector" ? new Promise<number>(() => {}) : 1,
		)
		const result = await runSearchBarrier({
			targets: EVENT_TARGETS,
			token: TOKEN,
			probe,
			clock,
		})
		expect(result.status).toBe("not-yet-searchable")
		expect(result.reason).toBe("timeout")
		expect(result.targets[3]).toEqual({
			index: "chunks_vector",
			status: "pending",
			attempts: 1,
		})
		expect(clock.elapsed()).toBe(10_000)
	})

	it("reports cancelled when the abort signal fires during the wait", async () => {
		const controller = new AbortController()
		const probe = probeFrom((_index, attempt) => {
			if (attempt === 2) controller.abort()
			return 0
		})
		const result = await runSearchBarrier({
			targets: searchBarrierTargets("structured"),
			token: TOKEN,
			probe,
			clock: fakeClock(),
			signal: controller.signal,
		})
		expect(result).toEqual({
			committed: true,
			status: "cancelled",
			reason: "cancelled",
			targets: [
				{ index: "structured_mem_text", status: "pending", attempts: 2 },
				{ index: "structured_mem_vector", status: "pending", attempts: 2 },
			],
		})
	})

	it("reports cancelled without probing when the signal already fired", async () => {
		const controller = new AbortController()
		controller.abort()
		const probe = probeFrom(() => 1)
		const result = await runSearchBarrier({
			targets: searchBarrierTargets("structured"),
			token: TOKEN,
			probe,
			clock: fakeClock(),
			signal: controller.signal,
		})
		expect(result.status).toBe("cancelled")
		expect(result.reason).toBe("cancelled")
		expect(probe).not.toHaveBeenCalled()
	})
})

function textIndex(name: string, overrides: Record<string, unknown> = {}) {
	return {
		name,
		type: "search",
		status: "READY",
		queryable: true,
		latestDefinition: {
			mappings: {
				dynamic: false,
				fields: {
					body: { type: "string" },
					searchWriteToken: { type: "token" },
				},
			},
		},
		...overrides,
	}
}

function vectorIndex(name: string, overrides: Record<string, unknown> = {}) {
	return {
		name,
		type: "vectorSearch",
		status: "READY",
		queryable: true,
		latestDefinition: {
			fields: [
				{ type: "autoEmbed", path: "text" },
				{ type: "filter", path: "searchWriteToken" },
			],
		},
		...overrides,
	}
}

function eventIndexListing(
	replace: Record<string, Record<string, unknown> | null> = {},
) {
	const all: Record<string, Record<string, unknown>[]> = {
		test_events: [
			textIndex("test_events_text"),
			vectorIndex("test_events_vector"),
		],
		test_chunks: [
			textIndex("test_chunks_text"),
			vectorIndex("test_chunks_vector"),
		],
	}
	return vi.fn(async (collectionName: string) =>
		(all[collectionName] ?? []).flatMap((index) => {
			const name = String(index.name)
			if (!(name in replace)) return [index]
			const next = replace[name]
			return next ? [{ ...index, ...next }] : []
		}),
	)
}

async function rejection(promise: Promise<unknown>) {
	try {
		await promise
	} catch (err) {
		return err as { name?: string; reason?: string; code?: string }
	}
	throw new Error("expected a rejection")
}

describe("search barrier static target check", () => {
	const db = {} as import("mongodb").Db

	it("accepts targets that exist, are queryable and map the token", async () => {
		const listIndexes = eventIndexListing()
		await expect(
			assertSearchBarrierTargets({
				db,
				prefix: "test_",
				family: "event",
				listIndexes,
			}),
		).resolves.toBeUndefined()
		expect(listIndexes.mock.calls.map((call) => call[0])).toEqual([
			"test_events",
			"test_chunks",
		])
	})

	it.each([
		"batch-event",
		"import",
		"file-sync",
		"kb",
		"lifecycle-update",
		"constructor",
	])("rejects the %s family before listing anything", async (family) => {
		const listIndexes = eventIndexListing()
		const err = await rejection(
			assertSearchBarrierTargets({ db, prefix: "test_", family, listIndexes }),
		)
		expect(err).toMatchObject({
			name: "SearchBarrierUnsupportedError",
			code: "BARRIER_UNSUPPORTED",
			reason: "write-family-unsupported",
		})
		expect(isSearchBarrierUnsupportedError(err)).toBe(true)
		expect(listIndexes).not.toHaveBeenCalled()
	})

	it.each([
		{ name: "test_chunks_vector", replace: null, reason: "target-missing" },
		{
			name: "test_events_text",
			replace: { status: "BUILDING", queryable: false },
			reason: "target-not-queryable",
		},
		{
			name: "test_events_text",
			replace: {
				latestDefinition: {
					mappings: { dynamic: false, fields: { body: { type: "string" } } },
				},
			},
			reason: "target-not-filter-capable",
		},
		{
			name: "test_chunks_vector",
			replace: {
				latestDefinition: {
					fields: [
						{ type: "autoEmbed", path: "text" },
						{ type: "filter", path: "agentId" },
					],
				},
				// The first definition mapped the token, but the latest one is
				// what the index serves.
				definition: {
					fields: [{ type: "filter", path: "searchWriteToken" }],
				},
			},
			reason: "target-not-filter-capable",
		},
	])("rejects $name as $reason", async ({ name, replace, reason }) => {
		const err = await rejection(
			assertSearchBarrierTargets({
				db,
				prefix: "test_",
				family: "event",
				listIndexes: eventIndexListing({ [name]: replace }),
			}),
		)
		expect(err).toMatchObject({ code: "BARRIER_UNSUPPORTED", reason })
	})

	it("fails closed as target-missing when the index listing errors", async () => {
		const err = await rejection(
			assertSearchBarrierTargets({
				db,
				prefix: "test_",
				family: "structured",
				listIndexes: async () => {
					throw new Error("Search Index Management service unavailable")
				},
			}),
		)
		expect(err).toMatchObject({ reason: "target-missing" })
	})
})

describe("search barrier after a write", () => {
	const db = {} as import("mongodb").Db

	it("returns committed projection-failed without probing when the chunk projection failed", async () => {
		const probe = probeFrom(() => 1)
		const result = await awaitSearchBarrier({
			db,
			prefix: "test_",
			family: "event",
			token: TOKEN,
			request: {},
			projectionFailed: true,
			probe,
			clock: fakeClock(),
		})
		expect(result).toEqual({
			committed: true,
			status: "not-yet-searchable",
			reason: "projection-failed",
			targets: [
				{ index: "events_text", status: "pending", attempts: 0 },
				{ index: "events_vector", status: "pending", attempts: 0 },
				{ index: "chunks_text", status: "pending", attempts: 0 },
				{ index: "chunks_vector", status: "pending", attempts: 0 },
			],
		})
		expect(probe).not.toHaveBeenCalled()
	})

	it("passes the caller's timeout and abort signal to the bounded probe loop", async () => {
		const controller = new AbortController()
		controller.abort()
		const cancelled = await awaitSearchBarrier({
			db,
			prefix: "test_",
			family: "structured",
			token: TOKEN,
			request: { signal: controller.signal },
			probe: probeFrom(() => 1),
			clock: fakeClock(),
		})
		expect(cancelled.status).toBe("cancelled")
		const lowered = await awaitSearchBarrier({
			db,
			prefix: "test_",
			family: "structured",
			token: TOKEN,
			request: { timeoutMs: 2_000 },
			probe: probeFrom(() => 0),
			clock: fakeClock(),
		})
		expect(lowered.targets.map((target) => target.attempts)).toEqual([2, 2])
	})

	it("logs only bounded reasons, never the token or provider text", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
		const error = vi.spyOn(console, "error").mockImplementation(() => {})
		const info = vi.spyOn(console, "log").mockImplementation(() => {})
		try {
			await awaitSearchBarrier({
				db,
				prefix: "test_",
				family: "procedure",
				token: TOKEN,
				request: {},
				probe: async () => {
					throw new Error("provider said: secret-provider-text")
				},
				clock: fakeClock(),
			})
			const printed = [
				...warn.mock.calls,
				...error.mock.calls,
				...info.mock.calls,
			]
				.flat()
				.map((value) =>
					typeof value === "string" ? value : JSON.stringify(value),
				)
				.join("\n")
			expect(printed).toContain("probe-failed")
			expect(printed).not.toContain("secret-provider-text")
			expect(printed).not.toContain(TOKEN)
		} finally {
			warn.mockRestore()
			error.mockRestore()
			info.mockRestore()
		}
	})
})

describe("search barrier uncertain commit", () => {
	function labelled(label: string) {
		return Object.assign(new Error("commit outcome lost"), {
			name: "MongoServerError",
			hasErrorLabel: (candidate: string) => candidate === label,
		})
	}

	it.each([
		[
			"an unknown transaction commit result",
			labelled("UnknownTransactionCommitResult"),
		],
		[
			"a network error after send",
			Object.assign(new Error("socket closed"), { name: "MongoNetworkError" }),
		],
		[
			"a network timeout",
			Object.assign(new Error("timed out"), {
				name: "MongoNetworkTimeoutError",
			}),
		],
		[
			"a write concern failure",
			Object.assign(new Error("waiting for replication timed out"), {
				name: "MongoWriteConcernError",
			}),
		],
		[
			"a wrapped network error",
			new Error("write failed", {
				cause: Object.assign(new Error("reset"), { name: "MongoNetworkError" }),
			}),
		],
	])("annotates %s with commitState unknown and keeps the error", (_label, err) => {
		expect(annotateUncertainCommit(err)).toBe(err)
		expect(err).toHaveProperty("commitState", "unknown")
	})

	it.each([
		[
			"an erasure conflict",
			Object.assign(new Error("gate"), { name: "ErasureGateConflictError" }),
		],
		[
			"an idempotency conflict",
			Object.assign(new Error("key"), { name: "IdempotencyConflictError" }),
		],
		["a transient label only", labelled("TransientTransactionError")],
		[
			"a server selection failure before send",
			Object.assign(new Error("no primary"), {
				name: "MongoServerSelectionError",
			}),
		],
	])("leaves %s unannotated", (_label, err) => {
		annotateUncertainCommit(err)
		expect(err).not.toHaveProperty("commitState")
	})
})

describe("search barrier probes", () => {
	type Stage = Record<string, Record<string, unknown>>

	function fakeDb(rows: unknown[] | Error) {
		const aggregate = vi.fn((_pipeline: Stage[], _options?: unknown) => ({
			toArray: async () => {
				if (rows instanceof Error) throw rows
				return rows
			},
		}))
		const collection = vi.fn((_name: string) => ({ aggregate }))
		return {
			db: { collection } as unknown as import("mongodb").Db,
			aggregate,
			collection,
		}
	}

	it("probes a text target with equals on the token and $limit 1", async () => {
		const { db, aggregate, collection } = fakeDb([{ _id: 1 }])
		const probe = createSearchBarrierProbe(db, "test_")
		const text = searchBarrierTargets("event")[0]
		if (!text) throw new Error("missing target")
		await expect(probe(text, TOKEN)).resolves.toBe(1)
		expect(collection).toHaveBeenCalledWith("test_events")
		expect(aggregate.mock.calls[0]?.[0]).toEqual([
			{
				$search: {
					index: "test_events_text",
					equals: { path: "searchWriteToken", value: TOKEN },
				},
			},
			{ $limit: 1 },
			{ $project: { _id: 1 } },
		])
	})

	it("probes a vector target with exact ENN, limit 1, the token filter and constant text", async () => {
		const { db, aggregate, collection } = fakeDb([])
		const vector = searchBarrierTargets("event")[3]
		if (!vector) throw new Error("missing target")
		await expect(
			createSearchBarrierProbe(db, "test_")(vector, TOKEN),
		).resolves.toBe(0)
		expect(collection).toHaveBeenCalledWith("test_chunks")
		const stage = aggregate.mock.calls[0]?.[0][0]?.$vectorSearch
		expect(stage).toMatchObject({
			index: "test_chunks_vector",
			path: "text",
			exact: true,
			limit: 1,
			filter: { searchWriteToken: TOKEN },
			query: { text: expect.any(String) },
		})
		expect(stage).not.toHaveProperty("numCandidates")
		const second = fakeDb([])
		await createSearchBarrierProbe(second.db, "test_")(vector, "another-token")
		expect(
			second.aggregate.mock.calls[0]?.[0][0]?.$vectorSearch?.query,
		).toEqual(stage?.query)
	})

	it("classifies an exact:true rejection and an empty answer as never searchable", async () => {
		const rejected = await runSearchBarrier({
			targets: searchBarrierTargets("procedure"),
			token: TOKEN,
			probe: createSearchBarrierProbe(
				fakeDb(new Error("exact is not supported for autoEmbed")).db,
				"test_",
			),
			clock: fakeClock(),
		})
		expect(rejected).toMatchObject({
			committed: true,
			status: "not-yet-searchable",
			reason: "probe-failed",
		})
		const unanswered = await runSearchBarrier({
			targets: searchBarrierTargets("procedure"),
			token: TOKEN,
			timeoutMs: 1_000,
			probe: createSearchBarrierProbe(fakeDb([]).db, "test_"),
			clock: fakeClock(),
		})
		expect(unanswered).toMatchObject({
			committed: true,
			status: "not-yet-searchable",
			reason: "timeout",
		})
	})
})
