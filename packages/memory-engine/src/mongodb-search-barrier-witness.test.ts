import type { Collection, Db, Document } from "mongodb"
import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("./mongodb-schema.js", () => ({
	eventsCollection: vi.fn(),
	chunksCollection: vi.fn(),
	projectionRunsCollection: vi.fn(() => ({
		insertOne: vi.fn(async () => ({ acknowledged: true })),
	})),
	telemetryCollection: vi.fn(() => ({
		insertOne: vi.fn(async () => ({ acknowledged: true })),
	})),
}))

import {
	type CanonicalEvent,
	projectEventChunk,
	writeEvent,
} from "./mongodb-events.js"
import { chunksCollection, eventsCollection } from "./mongodb-schema.js"
import {
	createSearchBarrierProbe,
	mintSearchWriteToken,
	runSearchBarrier,
	searchBarrierTargets,
} from "./mongodb-search-barrier.js"

const db = {} as Db

function updateRecorder(result: Document) {
	return vi.fn(
		async (_filter: Document, _update: Document, _options?: Document) => result,
	)
}

const EVENT: CanonicalEvent = {
	eventId: "evt-barrier",
	agentId: "agent-1",
	role: "user",
	body: "the deploy key rotates on Fridays",
	scope: "agent",
	scopeRef: "agent:agent-1",
	timestamp: new Date("2026-10-18T10:00:00.000Z"),
	validAt: new Date("2026-10-18T10:00:00.000Z"),
}

describe("search barrier witness stamping", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		vi.mocked(eventsCollection).mockReturnValue({
			bsonOptions: {},
			updateOne: updateRecorder({ upsertedCount: 1, matchedCount: 0 }),
			updateMany: vi.fn(async () => ({ modifiedCount: 1 })),
		} as unknown as Collection)
	})

	it("stamps the token on the event in the same update that writes its content", async () => {
		const token = mintSearchWriteToken()
		await writeEvent({
			db,
			prefix: "test_",
			session: {} as never,
			event: { ...EVENT, searchWriteToken: token },
		})
		const updateOne = vi.mocked(eventsCollection).mock.results[0]?.value
			.updateOne as ReturnType<typeof updateRecorder>
		expect(updateOne).toHaveBeenCalledTimes(1)
		const update = updateOne.mock.calls[0]?.[1]
		expect(update?.$setOnInsert).toMatchObject({
			body: EVENT.body,
			searchWriteToken: token,
		})
	})

	it("writes no token field on an ordinary event write", async () => {
		await writeEvent({
			db,
			prefix: "test_",
			session: {} as never,
			event: EVENT,
		})
		const updateOne = vi.mocked(eventsCollection).mock.results[0]?.value
			.updateOne as ReturnType<typeof updateRecorder>
		expect(updateOne.mock.calls[0]?.[1]?.$setOnInsert).not.toHaveProperty(
			"searchWriteToken",
		)
	})

	it("stamps the chunk in $set so a re-projection re-stamps it", async () => {
		const chunkUpdate = updateRecorder({ upsertedCount: 1, matchedCount: 0 })
		vi.mocked(chunksCollection).mockReturnValue({
			updateOne: chunkUpdate,
		} as unknown as Collection)
		const token = mintSearchWriteToken()
		await projectEventChunk({
			db,
			prefix: "test_",
			event: EVENT,
			session: {} as never,
			recordRun: false,
			searchWriteToken: token,
		})
		const update = chunkUpdate.mock.calls[0]?.[1]
		expect(update?.$set).toMatchObject({ searchWriteToken: token })
		expect(update?.$setOnInsert).not.toHaveProperty("searchWriteToken")
	})

	it("leaves the chunk update unchanged on an ordinary projection", async () => {
		const chunkUpdate = updateRecorder({ upsertedCount: 1, matchedCount: 0 })
		vi.mocked(chunksCollection).mockReturnValue({
			updateOne: chunkUpdate,
		} as unknown as Collection)
		await projectEventChunk({
			db,
			prefix: "test_",
			event: EVENT,
			session: {} as never,
			recordRun: false,
		})
		const update = chunkUpdate.mock.calls[0]?.[1]
		expect(update?.$set).toEqual({
			validAt: EVENT.validAt,
			invalidAt: null,
		})
	})

	it("mints a fresh opaque token per write", () => {
		const first = mintSearchWriteToken()
		const second = mintSearchWriteToken()
		expect(first).toMatch(/^[0-9a-f]{24}$/)
		expect(second).not.toBe(first)
	})
})

describe("search barrier witness semantics", () => {
	// A search index that lags the collection: it serves whatever version it
	// last indexed. The probe evaluates the barrier's own pipeline against it.
	function laggingIndexDb(indexed: { current: Document }) {
		const matches = (pipeline: Document[]) => {
			const stage = pipeline[0] ?? {}
			const token = stage.$search
				? stage.$search.equals.value
				: stage.$vectorSearch.filter.searchWriteToken
			return indexed.current.searchWriteToken === token ? [{ _id: 1 }] : []
		}
		return {
			collection: () => ({
				aggregate: (pipeline: Document[]) => ({
					toArray: async () => matches(pipeline),
				}),
			}),
		} as unknown as Db
	}

	function immediateClock() {
		let now = 0
		return {
			now: () => now,
			sleep: (ms: number, signal?: AbortSignal) =>
				new Promise<void>((resolve) =>
					setImmediate(() => {
						if (!signal?.aborted) now += ms
						resolve()
					}),
				),
		}
	}

	it("an indexed older version never satisfies the newer write's token", async () => {
		const v1Token = mintSearchWriteToken()
		const v2Token = mintSearchWriteToken()
		// Same _id, older content still in the index: storage presence and _id
		// presence prove nothing about the new version.
		const indexed = {
			current: { _id: "doc-1", value: "v1", searchWriteToken: v1Token },
		}
		const probe = createSearchBarrierProbe(laggingIndexDb(indexed), "test_")
		const stale = await runSearchBarrier({
			targets: searchBarrierTargets("structured"),
			token: v2Token,
			timeoutMs: 2_000,
			probe,
			clock: immediateClock(),
		})
		expect(stale.status).toBe("not-yet-searchable")
		expect(stale.reason).toBe("timeout")

		indexed.current = { _id: "doc-1", value: "v2", searchWriteToken: v2Token }
		const caughtUp = await runSearchBarrier({
			targets: searchBarrierTargets("structured"),
			token: v2Token,
			probe,
			clock: immediateClock(),
		})
		expect(caughtUp.status).toBe("searchable")
	})
})
