import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// M2 review D3: a typed failure that arrives after the operation committed
// work keeps its status, code and outcome rows, and its error body says what
// the operation committed. The bridge is the seam: each failing call throws the
// error shape the engine produces (a typed Search failure or a KBRefreshError
// carrying `commitState` and `commit`), and the HTTP answer is asserted.

const bridge = vi.hoisted(() => ({
	memongoBridgeConsolidate: vi.fn(),
	memongoBridgeSync: vi.fn(),
}))
vi.mock(
	"@memongo/memory-bridge",
	() =>
		new Proxy(bridge, {
			get(target, key) {
				if (key === "then") return undefined
				if (key in target) return target[key as keyof typeof target]
				return vi.fn(() => {
					throw new Error("unexpected bridge call")
				})
			},
		}),
)

import { createApp } from "./app.js"

type Body = {
	error?: {
		code: string
		message: string
		commitState?: string
		commit?: Record<string, unknown>
	}
	outcomes?: { status: string; lanes: Array<Record<string, unknown>> }
}

beforeEach(() => {
	vi.resetAllMocks()
	vi.stubEnv("MEMONGO_API_KEY", "fixture-admin")
	vi.stubEnv("MEMONGO_API_SCOPED_KEYS", "")
	vi.stubEnv("MEMONGO_API_RATE_LIMIT", "0")
	vi.spyOn(console, "error").mockImplementation(() => {})
})
afterEach(() => {
	vi.restoreAllMocks()
	vi.unstubAllEnvs()
})

const AUTH = { Authorization: "Bearer fixture-admin" }
const RUN_ID = "0f4c6b1e-8a35-4d7e-9b52-6c1d2e3f4a5b"

async function call(route: "consolidate" | "sync") {
	const response = await createApp().request(`/v1/${route}`, {
		method: "POST",
		headers: { "Content-Type": "application/json", ...AUTH },
		body: JSON.stringify({ agentId: "owner" }),
	})
	return {
		status: response.status,
		retryAfter: response.headers.get("Retry-After"),
		text: await response.clone().text(),
		body: (await response.json()) as Body,
	}
}

function consolidateCommit(over: Record<string, unknown> = {}) {
	return {
		operation: "consolidate",
		runId: RUN_ID,
		eventsProcessed: 1,
		factsPromoted: 1,
		factsInferred: 0,
		factsMerged: 0,
		factsPruned: 0,
		...over,
	}
}

function searchFailure(
	name: string,
	reason: string,
	extra: Record<string, unknown> = {},
) {
	return Object.assign(new Error("private provider detail sk-secret-1"), {
		name,
		lane: "vector",
		stage: "vector",
		reason,
		...extra,
	})
}

describe("POST /v1/consolidate: a typed Search failure reports what the run committed", () => {
	it("keeps its 503 status, code and outcome row and adds the run identity and committed work", async () => {
		bridge.memongoBridgeConsolidate.mockRejectedValue(
			searchFailure("SearchLaneError", "index-unavailable", {
				commitState: "committed",
				commit: consolidateCommit(),
			}),
		)

		const { status, body, text } = await call("consolidate")

		expect(status).toBe(503)
		expect(body.error?.code).toBe("SEARCH_LANES_UNAVAILABLE")
		expect(body.outcomes).toEqual({
			status: "failed",
			lanes: [
				{
					lane: "vector",
					stage: "vector",
					outcome: "failed",
					reason: "index-unavailable",
				},
			],
		})
		expect(body.error?.commitState).toBe("committed")
		expect(body.error?.commit).toEqual(consolidateCommit())
		expect(text).not.toContain("sk-secret-1")
	})

	it("keeps 500 SEARCH_LANES_FAILED for a defect and reports none when nothing committed", async () => {
		bridge.memongoBridgeConsolidate.mockRejectedValue(
			searchFailure("SearchLaneError", "query-error", {
				commitState: "none",
				commit: consolidateCommit({ eventsProcessed: 0, factsPromoted: 0 }),
			}),
		)

		const { status, body } = await call("consolidate")

		expect(status).toBe(500)
		expect(body.error?.code).toBe("SEARCH_LANES_FAILED")
		expect(body.error?.commitState).toBe("none")
		expect(body.error?.commit).toEqual(
			consolidateCommit({ eventsProcessed: 0, factsPromoted: 0 }),
		)
	})

	it("keeps Retry-After on a budget denial and still reports the commit state", async () => {
		bridge.memongoBridgeConsolidate.mockRejectedValue(
			searchFailure("SearchBudgetDeniedError", "budget-embeds", {
				retryAfterMs: 2500,
				commitState: "committed",
				commit: consolidateCommit({ factsPromoted: 3, eventsProcessed: 3 }),
			}),
		)

		const { status, body, retryAfter } = await call("consolidate")

		expect(status).toBe(503)
		expect(retryAfter).toBe("3")
		expect(body.error?.code).toBe("SEARCH_BUDGET_EXHAUSTED")
		expect(body.error?.commitState).toBe("committed")
		expect(body.error?.commit).toMatchObject({ factsPromoted: 3 })
	})

	it("reports an uncertain commit as unknown, never zero", async () => {
		bridge.memongoBridgeConsolidate.mockRejectedValue(
			searchFailure("SearchLaneError", "dependency-unavailable", {
				commitState: "unknown",
				commit: consolidateCommit({ factsPromoted: 0, eventsProcessed: 0 }),
			}),
		)

		const { body } = await call("consolidate")

		expect(body.error?.commitState).toBe("unknown")
	})

	it("an error that carries only the barrier's commitState reports it with no detail", async () => {
		bridge.memongoBridgeConsolidate.mockRejectedValue(
			searchFailure("SearchLaneError", "internal-error", {
				commitState: "unknown",
			}),
		)

		const { body } = await call("consolidate")

		expect(body.error?.commitState).toBe("unknown")
		expect(body.error).not.toHaveProperty("commit")
	})

	it("a typed failure with no commit information claims none: the body carries neither field", async () => {
		bridge.memongoBridgeConsolidate.mockRejectedValue(
			searchFailure("SearchLaneError", "index-stale"),
		)

		const { status, body } = await call("consolidate")

		expect(status).toBe(503)
		expect(body.error).not.toHaveProperty("commitState")
		expect(body.error).not.toHaveProperty("commit")
	})

	it("an unexpected error after a commit stays CONSOLIDATE_FAILED and reports the commit state", async () => {
		bridge.memongoBridgeConsolidate.mockRejectedValue(
			Object.assign(new Error("private provider detail sk-secret-2"), {
				commitState: "committed",
				commit: consolidateCommit(),
			}),
		)

		const { status, body, text } = await call("consolidate")

		expect(status).toBe(500)
		expect(body.error?.code).toBe("CONSOLIDATE_FAILED")
		expect(body.error?.commitState).toBe("committed")
		expect(body.error?.commit).toEqual(consolidateCommit())
		expect(text).not.toContain("sk-secret-2")
	})

	it.each([
		["an unknown state", { commitState: "rolled-back" }],
		["a free-text state", { commitState: "sk-secret-3 committed" }],
		["a non-string state", { commitState: true }],
	])("%s is not echoed", async (_label, fields) => {
		bridge.memongoBridgeConsolidate.mockRejectedValue(
			searchFailure("SearchLaneError", "index-stale", {
				...fields,
				commit: consolidateCommit(),
			}),
		)

		const { status, body, text } = await call("consolidate")

		expect(status).toBe(503)
		expect(body.error).not.toHaveProperty("commitState")
		expect(body.error).not.toHaveProperty("commit")
		expect(text).not.toContain("sk-secret-3")
	})

	it.each([
		["a run id that is not a UUID", { runId: "sk-secret-4 not-a-uuid" }],
		["a negative count", { factsPromoted: -1 }],
		["a fractional count", { factsPromoted: 1.5 }],
		["a non-numeric count", { factsPromoted: "1; DROP" }],
		["a missing count", { factsPruned: undefined }],
	])("%s drops the detail and keeps the state", async (_label, over) => {
		bridge.memongoBridgeConsolidate.mockRejectedValue(
			searchFailure("SearchLaneError", "index-stale", {
				commitState: "committed",
				commit: consolidateCommit(over),
			}),
		)

		const { status, body, text } = await call("consolidate")

		expect(status).toBe(503)
		expect(body.error?.commitState).toBe("committed")
		expect(body.error).not.toHaveProperty("commit")
		expect(text).not.toContain("sk-secret-4")
	})

	it("forwards only the documented fields of the detail", async () => {
		bridge.memongoBridgeConsolidate.mockRejectedValue(
			searchFailure("SearchLaneError", "index-stale", {
				commitState: "committed",
				commit: consolidateCommit({
					error: "private provider detail sk-secret-5",
					candidates: [{ body: "private memory text" }],
				}),
			}),
		)

		const { body, text } = await call("consolidate")

		expect(body.error?.commit).toEqual(consolidateCommit())
		expect(text).not.toContain("sk-secret-5")
		expect(text).not.toContain("private memory text")
	})
})

describe("POST /v1/sync: a failed KB refresh says the file sync committed", () => {
	function refreshFailure(
		reason: string,
		over: Record<string, unknown> = {},
		commit: Record<string, unknown> | undefined = {
			operation: "sync",
			fileSync: { filesFailed: 0, enumerationComplete: true },
			kbImport: { documentsProcessed: 2, chunksCreated: 7, skipped: 1 },
		},
	) {
		return Object.assign(
			new Error("KB auto-refresh failed: private provider detail sk-secret-1"),
			{
				name: "KBRefreshError",
				code: "KB_REFRESH_FAILED",
				reason,
				documentsProcessed: 2,
				chunksCreated: 7,
				skipped: 1,
				errors: ["doc.md: private provider detail sk-secret-1"],
				commitState: "committed",
				...(commit ? { commit } : {}),
				...over,
			},
		)
	}

	it("answers 500 KB_REFRESH_FAILED, says the file sync committed and carries the import's real counts", async () => {
		bridge.memongoBridgeSync.mockRejectedValue(refreshFailure("import-errors"))

		const { status, body, text } = await call("sync")

		expect(status).toBe(500)
		expect(body.error?.code).toBe("KB_REFRESH_FAILED")
		expect(body.error?.message).toContain("the file sync committed")
		expect(body.error?.message).toContain("2 documents")
		expect(body.error?.commitState).toBe("committed")
		expect(body.error?.commit).toEqual({
			operation: "sync",
			fileSync: { filesFailed: 0, enumerationComplete: true },
			kbImport: { documentsProcessed: 2, chunksCreated: 7, skipped: 1 },
		})
		expect(text).not.toContain("sk-secret-1")
	})

	it("a rejected import has no KB counts: the body names the committed file sync and no counts", async () => {
		bridge.memongoBridgeSync.mockRejectedValue(
			refreshFailure(
				"import-rejected",
				{
					documentsProcessed: undefined,
					chunksCreated: undefined,
					skipped: undefined,
					errors: [],
				},
				{
					operation: "sync",
					fileSync: { filesFailed: 0, enumerationComplete: true },
				},
			),
		)

		const { status, body } = await call("sync")

		expect(status).toBe(500)
		expect(body.error?.code).toBe("KB_REFRESH_FAILED")
		expect(body.error?.message).toContain("the file sync committed")
		expect(body.error?.message).not.toContain("documents")
		expect(body.error?.commit).toEqual({
			operation: "sync",
			fileSync: { filesFailed: 0, enumerationComplete: true },
		})
		expect(body.error?.commit).not.toHaveProperty("kbImport")
	})

	it("a file sync that finished dirty says so", async () => {
		bridge.memongoBridgeSync.mockRejectedValue(
			refreshFailure(
				"import-errors",
				{},
				{
					operation: "sync",
					fileSync: { filesFailed: 2, enumerationComplete: false },
					kbImport: { documentsProcessed: 0, chunksCreated: 0, skipped: 0 },
				},
			),
		)

		const { body } = await call("sync")

		expect(body.error?.commit).toMatchObject({
			fileSync: { filesFailed: 2, enumerationComplete: false },
		})
	})

	it("an error with no commit information does not claim a committed file sync", async () => {
		bridge.memongoBridgeSync.mockRejectedValue(
			refreshFailure("import-errors", { commitState: undefined }, undefined),
		)

		const { status, body } = await call("sync")

		expect(status).toBe(500)
		expect(body.error?.code).toBe("KB_REFRESH_FAILED")
		expect(body.error?.message).not.toContain("the file sync committed")
		expect(body.error).not.toHaveProperty("commitState")
		expect(body.error).not.toHaveProperty("commit")
	})

	it.each([
		["a non-boolean enumeration flag", { enumerationComplete: "yes" }],
		["a negative failed count", { filesFailed: -1 }],
	])("%s drops the detail and keeps the state", async (_label, fileSync) => {
		bridge.memongoBridgeSync.mockRejectedValue(
			refreshFailure(
				"import-errors",
				{},
				{
					operation: "sync",
					fileSync: {
						filesFailed: 0,
						enumerationComplete: true,
						...fileSync,
					},
				},
			),
		)

		const { body } = await call("sync")

		expect(body.error?.commitState).toBe("committed")
		expect(body.error).not.toHaveProperty("commit")
	})

	it("a failure before the import started stays SYNC_FAILED and reports the committed file sync", async () => {
		bridge.memongoBridgeSync.mockRejectedValue(
			Object.assign(new Error("private provider detail sk-secret-6"), {
				commitState: "committed",
				commit: {
					operation: "sync",
					fileSync: { filesFailed: 0, enumerationComplete: true },
				},
			}),
		)

		const { status, body, text } = await call("sync")

		expect(status).toBe(500)
		expect(body.error?.code).toBe("SYNC_FAILED")
		expect(body.error?.commitState).toBe("committed")
		expect(body.error?.commit).toEqual({
			operation: "sync",
			fileSync: { filesFailed: 0, enumerationComplete: true },
		})
		expect(text).not.toContain("sk-secret-6")
	})
})

describe("OpenAPI documents the commit state of the failed operations (D3)", () => {
	type Spec = {
		paths: Record<
			string,
			Record<string, { responses: Record<string, { description?: string }> }>
		>
		components: { schemas: { ApiError: unknown } }
	}

	async function spec(): Promise<Spec> {
		const res = await createApp().request("/openapi.json")
		return (await res.json()) as Spec
	}

	it("the shared ApiError envelope declares commitState and the commit detail", async () => {
		const { components } = await spec()
		const error = (
			components.schemas.ApiError as {
				properties: {
					error: { properties: Record<string, Record<string, unknown>> }
				}
			}
		).properties.error.properties

		expect(error.commitState).toMatchObject({
			type: "string",
			enum: ["none", "committed", "unknown"],
		})
		const detail = error.commit as { oneOf: Array<Record<string, unknown>> }
		expect(detail.oneOf).toHaveLength(2)
		expect(JSON.stringify(detail.oneOf)).toContain("consolidate")
		expect(JSON.stringify(detail.oneOf)).toContain("fileSync")
		expect(JSON.stringify(detail.oneOf)).toContain("kbImport")
	})

	it("/v1/sync 500 and /v1/consolidate 500 and 503 say the body carries the commit state", async () => {
		const { paths } = await spec()

		expect(paths["/v1/sync"].post.responses["500"].description).toContain(
			"commitState",
		)
		for (const status of ["500", "503"]) {
			expect(
				paths["/v1/consolidate"].post.responses[status].description,
			).toContain("commitState")
		}
	})
})
