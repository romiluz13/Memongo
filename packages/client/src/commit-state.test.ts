import { afterEach, describe, expect, it, vi } from "vitest"
import { MemongoClient, MemongoClientError } from "./client.js"
import type { MemongoCommitDetail, MemongoCommitState } from "./types.js"

// M2 review D3: a failed operation that had already committed work says so on
// its error body. The SDK carries `commitState` and the bounded `commit`
// detail on MemongoClientError, in the documented shape only.

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

const body = (error: Record<string, unknown>, extra: object = {}) =>
	JSON.stringify({ error: { message: "failed", ...error }, ...extra })

afterEach(() => vi.unstubAllGlobals())

describe("MemongoClientError commit state", () => {
	it("parses the commit state and consolidation detail of a typed Search failure beside its outcomes", () => {
		const err = new MemongoClientError(
			503,
			body(
				{
					code: "SEARCH_LANES_UNAVAILABLE",
					commitState: "committed",
					commit: CONSOLIDATE_COMMIT,
				},
				{
					outcomes: {
						status: "failed",
						lanes: [
							{
								lane: "vector",
								stage: "vector",
								outcome: "failed",
								reason: "index-stale",
							},
						],
					},
				},
			),
		)

		expect(err.code).toBe("SEARCH_LANES_UNAVAILABLE")
		expect(err.outcomes?.status).toBe("failed")
		expect(err.commitState).toBe("committed")
		expect(err.commit).toEqual(CONSOLIDATE_COMMIT)
	})

	it("parses the committed file sync and the import counts of a failed refresh", () => {
		const err = new MemongoClientError(
			500,
			body({
				code: "KB_REFRESH_FAILED",
				commitState: "committed",
				commit: SYNC_COMMIT,
			}),
		)

		expect(err.commitState).toBe("committed")
		expect(err.commit).toEqual(SYNC_COMMIT)
	})

	it("a sync detail without KB counts stays without them: absent means not known", () => {
		const err = new MemongoClientError(
			500,
			body({
				code: "KB_REFRESH_FAILED",
				commitState: "committed",
				commit: {
					operation: "sync",
					fileSync: { filesFailed: 0, enumerationComplete: true },
				},
			}),
		)

		expect(err.commit).toEqual({
			operation: "sync",
			fileSync: { filesFailed: 0, enumerationComplete: true },
		})
		expect(err.commit).not.toHaveProperty("kbImport")
	})

	it.each<MemongoCommitState>([
		"none",
		"unknown",
	])("parses the %s state", (state) => {
		const err = new MemongoClientError(
			500,
			body({ code: "CONSOLIDATE_FAILED", commitState: state }),
		)

		expect(err.commitState).toBe(state)
		expect(err.commit).toBeUndefined()
	})

	it("leaves both fields undefined for an ordinary error envelope: no claim is not none", () => {
		const err = new MemongoClientError(400, body({ code: "VALIDATION_ERROR" }))

		expect(err.commitState).toBeUndefined()
		expect(err.commit).toBeUndefined()
	})

	it.each([
		["an unrecognized state", { commitState: "rolled-back" }],
		["a non-string state", { commitState: true }],
	])("ignores %s", (_label, fields) => {
		const err = new MemongoClientError(
			500,
			body({ code: "SYNC_FAILED", ...fields, commit: CONSOLIDATE_COMMIT }),
		)

		expect(err.commitState).toBeUndefined()
		expect(err.commit).toBeUndefined()
	})

	it.each<[string, Record<string, unknown>]>([
		["an unknown operation", { operation: "erase" }],
		["a run id that is not a UUID", { runId: "not-a-uuid" }],
		["a negative count", { factsPromoted: -1 }],
		["a fractional count", { factsPromoted: 0.5 }],
		["a missing count", { factsPruned: undefined }],
	])("drops a malformed detail with %s and keeps the state", (_label, over) => {
		const err = new MemongoClientError(
			500,
			body({
				code: "CONSOLIDATE_FAILED",
				commitState: "committed",
				commit: { ...CONSOLIDATE_COMMIT, ...over },
			}),
		)

		expect(err.commitState).toBe("committed")
		expect(err.commit).toBeUndefined()
	})

	it("keeps only the documented fields of the detail", () => {
		const err = new MemongoClientError(
			500,
			body({
				code: "CONSOLIDATE_FAILED",
				commitState: "committed",
				commit: { ...CONSOLIDATE_COMMIT, error: "private detail" },
			}),
		)

		expect(err.commit).toEqual(CONSOLIDATE_COMMIT)
	})

	it("a non-JSON body has no commit state", () => {
		const err = new MemongoClientError(502, "<html>bad gateway</html>")

		expect(err.commitState).toBeUndefined()
		expect(err.commit).toBeUndefined()
	})

	it("types the detail as a union discriminated by operation", () => {
		const detail: MemongoCommitDetail = SYNC_COMMIT
		if (detail.operation === "sync") {
			expect(detail.fileSync.enumerationComplete).toBe(true)
		}
	})
})

describe("a failed sync and consolidate reject with the commit state", () => {
	function stub(status: number, text: string) {
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(text, {
						status,
						headers: { "Content-Type": "application/json" },
					}),
			),
		)
	}
	const client = () =>
		new MemongoClient({ baseUrl: "http://127.0.0.1:3100", maxRetries: 0 })

	it("sync rejects with a MemongoClientError that carries the committed file sync", async () => {
		stub(
			500,
			body({
				code: "KB_REFRESH_FAILED",
				commitState: "committed",
				commit: SYNC_COMMIT,
			}),
		)

		const failure = await client()
			.sync()
			.catch((err: unknown) => err)

		expect(failure).toBeInstanceOf(MemongoClientError)
		expect(failure).toMatchObject({
			status: 500,
			code: "KB_REFRESH_FAILED",
			commitState: "committed",
			commit: SYNC_COMMIT,
		})
	})

	it("consolidate rejects with a MemongoClientError that carries the run identity", async () => {
		stub(
			503,
			body({
				code: "SEARCH_LANES_UNAVAILABLE",
				commitState: "committed",
				commit: CONSOLIDATE_COMMIT,
			}),
		)

		const failure = await client()
			.consolidate()
			.catch((err: unknown) => err)

		expect(failure).toBeInstanceOf(MemongoClientError)
		expect(failure).toMatchObject({
			status: 503,
			commitState: "committed",
			commit: CONSOLIDATE_COMMIT,
		})
	})
})
