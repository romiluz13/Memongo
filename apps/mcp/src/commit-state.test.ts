import { describe, expect, it, vi } from "vitest"
import { type MemongoClient, MemongoClientError } from "@memongo/client"
import { handleToolCall } from "./server.js"

// M2 review D3: a failed memongo_sync or memongo_consolidate reaches the agent
// as a tool error that keeps its status and code and also carries what the
// operation had already committed, so a retry is not mistaken for a first try.

const RUN_ID = "0f4c6b1e-8a35-4d7e-9b52-6c1d2e3f4a5b"

const CONSOLIDATE_COMMIT = {
	operation: "consolidate",
	runId: RUN_ID,
	eventsProcessed: 1,
	factsPromoted: 1,
	factsInferred: 0,
	factsMerged: 0,
	factsPruned: 0,
} as const

const SYNC_COMMIT = {
	operation: "sync",
	fileSync: { filesFailed: 0, enumerationComplete: true },
	kbImport: { documentsProcessed: 2, chunksCreated: 7, skipped: 1 },
} as const

function failure(status: number, error: Record<string, unknown>, extra = {}) {
	return new MemongoClientError(
		status,
		JSON.stringify({ error: { message: "failed", ...error }, ...extra }),
	)
}

describe("MCP tool errors carry the commit state of the failed operation (D3)", () => {
	it("memongo_consolidate keeps its status, code and outcomes and adds the run identity and committed work", async () => {
		const outcomes = {
			status: "failed",
			lanes: [
				{
					lane: "vector",
					stage: "vector",
					outcome: "failed",
					reason: "index-stale",
				},
			],
		}
		const consolidate = vi.fn().mockRejectedValue(
			failure(
				503,
				{
					code: "SEARCH_LANES_UNAVAILABLE",
					commitState: "committed",
					commit: CONSOLIDATE_COMMIT,
				},
				{ outcomes },
			),
		)

		const out = await handleToolCall("memongo_consolidate", {}, {
			consolidate,
		} as unknown as MemongoClient)

		expect(out.isError).toBe(true)
		const payload = JSON.parse(out.content[0].text)
		expect(payload.status).toBe(503)
		expect(payload.code).toBe("SEARCH_LANES_UNAVAILABLE")
		expect(payload.outcomes).toEqual(outcomes)
		expect(payload.commitState).toBe("committed")
		expect(payload.commit).toEqual(CONSOLIDATE_COMMIT)
		expect(out.structuredContent).toMatchObject({
			commitState: "committed",
			commit: CONSOLIDATE_COMMIT,
		})
	})

	it("memongo_sync says the file sync committed when the KB refresh failed", async () => {
		const sync = vi.fn().mockRejectedValue(
			failure(500, {
				code: "KB_REFRESH_FAILED",
				commitState: "committed",
				commit: SYNC_COMMIT,
			}),
		)

		const out = await handleToolCall("memongo_sync", {}, {
			sync,
		} as unknown as MemongoClient)

		expect(out.isError).toBe(true)
		const payload = JSON.parse(out.content[0].text)
		expect(payload.code).toBe("KB_REFRESH_FAILED")
		expect(payload.commitState).toBe("committed")
		expect(payload.commit).toEqual(SYNC_COMMIT)
	})

	it.each([
		"none",
		"unknown",
	])("carries the %s state with no detail", async (state) => {
		const sync = vi
			.fn()
			.mockRejectedValue(
				failure(500, { code: "SYNC_FAILED", commitState: state }),
			)

		const out = await handleToolCall("memongo_sync", {}, {
			sync,
		} as unknown as MemongoClient)

		const payload = JSON.parse(out.content[0].text)
		expect(payload.commitState).toBe(state)
		expect(payload).not.toHaveProperty("commit")
	})

	it("an error with no commit claim carries neither field", async () => {
		const sync = vi
			.fn()
			.mockRejectedValue(failure(500, { code: "SYNC_FAILED" }))

		const out = await handleToolCall("memongo_sync", {}, {
			sync,
		} as unknown as MemongoClient)

		const payload = JSON.parse(out.content[0].text)
		expect(payload.code).toBe("SYNC_FAILED")
		expect(payload).not.toHaveProperty("commitState")
		expect(payload).not.toHaveProperty("commit")
	})
})
