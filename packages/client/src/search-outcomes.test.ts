import { afterEach, describe, expect, it, vi } from "vitest"
import { MemongoClient, MemongoClientError } from "./client.js"
import type { MemongoSearchLaneOutcome } from "./types.js"

// #101 / decision 16 (matrix sections 4 step 8 and 5): the SDK carries the
// search outcome summary on 200 responses, on MemongoClientError, and on the
// silent-mode degradation marker.

const FAILED_OUTCOMES = {
	status: "failed",
	lanes: [
		{
			lane: "structured",
			stage: "lane",
			outcome: "failed",
			reason: "lane-unavailable",
		},
	],
} as const

const failureBody = (code: string) =>
	JSON.stringify({
		error: { code, message: "search failed (request id: r-1)" },
		outcomes: FAILED_OUTCOMES,
	})

afterEach(() => vi.unstubAllGlobals())

describe("MemongoClientError search outcomes", () => {
	it("parses code and outcomes from a search failure body", () => {
		const err = new MemongoClientError(
			503,
			failureBody("SEARCH_LANES_UNAVAILABLE"),
		)

		expect(err.code).toBe("SEARCH_LANES_UNAVAILABLE")
		expect(err.outcomes).toEqual(FAILED_OUTCOMES)
	})

	it("leaves outcomes undefined for an ordinary error envelope", () => {
		const err = new MemongoClientError(
			400,
			JSON.stringify({ error: { code: "VALIDATION_ERROR", message: "no" } }),
		)

		expect(err.outcomes).toBeUndefined()
	})

	it("ignores a malformed outcomes field", () => {
		const err = new MemongoClientError(
			500,
			JSON.stringify({
				error: { code: "SEARCH_LANES_FAILED", message: "x" },
				outcomes: { status: "exploded", lanes: "nope" },
			}),
		)

		expect(err.outcomes).toBeUndefined()
	})
})

function stubResponse(status: number, body: string) {
	vi.stubGlobal(
		"fetch",
		vi.fn(
			async () =>
				new Response(body, {
					status,
					headers: { "Content-Type": "application/json" },
				}),
		),
	)
}

const silentClient = () =>
	new MemongoClient({
		baseUrl: "http://127.0.0.1:3100",
		silent: true,
		maxRetries: 0,
	})

describe("silent mode keeps degradation and adds code and outcomes", () => {
	it.each([
		{ status: 503, code: "SEARCH_LANES_UNAVAILABLE" },
		{ status: 503, code: "SEARCH_BUDGET_EXHAUSTED" },
		{ status: 500, code: "SEARCH_LANES_FAILED" },
	])("search swallows a $status $code with its marker", async ({
		status,
		code,
	}) => {
		stubResponse(status, failureBody(code))

		await expect(silentClient().search({ query: "q" })).resolves.toEqual({
			results: [],
			degradation: {
				kind: "unavailable",
				status,
				code,
				outcomes: FAILED_OUTCOMES,
			},
		})
	})

	it("searchKB and searchDetailed carry the same marker", async () => {
		stubResponse(503, failureBody("SEARCH_LANES_UNAVAILABLE"))
		const client = silentClient()

		const kb = await client.searchKB({ query: "q" })
		const detailed = await client.searchDetailed({ query: "q" })

		for (const out of [kb, detailed]) {
			expect(out.results).toEqual([])
			expect(out.degradation).toEqual({
				kind: "unavailable",
				status: 503,
				code: "SEARCH_LANES_UNAVAILABLE",
				outcomes: FAILED_OUTCOMES,
			})
		}
	})

	it("a 200 partial with zero results passes through untouched", async () => {
		const partial = {
			results: [],
			outcomes: {
				status: "partial",
				lanes: [
					{
						lane: "structured",
						stage: "lane",
						outcome: "ok-empty",
						reason: "zero-hits",
					},
					{
						lane: "procedural",
						stage: "lane",
						outcome: "failed",
						reason: "query-error",
					},
				],
			},
		}
		stubResponse(200, JSON.stringify(partial))

		await expect(silentClient().search({ query: "q" })).resolves.toEqual(
			partial,
		)
	})

	it("searchDetailed exposes the per-pass outcome rows and status", async () => {
		const laneOutcomes: MemongoSearchLaneOutcome[] = [
			{ lane: "hybrid", stage: "lane", outcome: "ok", resultCount: 1, pass: 0 },
		]
		stubResponse(
			200,
			JSON.stringify({
				results: [],
				metadata: { outcomeStatus: "complete", laneOutcomes },
			}),
		)

		const out = await silentClient().searchDetailed({ query: "q" })

		expect(out.metadata.outcomeStatus).toBe("complete")
		expect(out.metadata.laneOutcomes).toEqual(laneOutcomes)
	})

	it("a non-silent client rejects with the typed error carrying outcomes", async () => {
		stubResponse(500, failureBody("SEARCH_LANES_FAILED"))
		const client = new MemongoClient({
			baseUrl: "http://127.0.0.1:3100",
			maxRetries: 0,
		})

		await expect(client.search({ query: "q" })).rejects.toMatchObject({
			name: "MemongoClientError",
			status: 500,
			code: "SEARCH_LANES_FAILED",
			outcomes: FAILED_OUTCOMES,
		})
	})
})

// M2 decision 8: both admission-time index-health reasons are part of the
// SDK's typed vocabulary. A silent client keeps the code and the rows, so a
// swallowed index-stale or index-unavailable never reads as "no memories".
describe("index-health reasons (M2)", () => {
	const INDEX_HEALTH_ROWS: MemongoSearchLaneOutcome[] = [
		{
			lane: "hybrid:chunks",
			stage: "index-health",
			outcome: "failed",
			reason: "index-stale",
		},
		{
			lane: "kb",
			stage: "index-health",
			outcome: "failed",
			reason: "index-unavailable",
		},
	]
	const indexHealthBody = JSON.stringify({
		error: {
			code: "SEARCH_LANES_UNAVAILABLE",
			message: "search failed (request id: r-2)",
		},
		outcomes: { status: "failed", lanes: INDEX_HEALTH_ROWS },
	})

	it("MemongoClientError carries both reasons on a 503 failure body", () => {
		const err = new MemongoClientError(503, indexHealthBody)

		expect(err.code).toBe("SEARCH_LANES_UNAVAILABLE")
		expect(err.outcomes?.lanes).toEqual(INDEX_HEALTH_ROWS)
	})

	it("silent search, searchKB and searchDetailed keep the code and both rows", async () => {
		stubResponse(503, indexHealthBody)
		const client = silentClient()

		const results = [
			await client.search({ query: "q" }),
			await client.searchKB({ query: "q" }),
			await client.searchDetailed({ query: "q" }),
		]

		for (const out of results) {
			expect(out.results).toEqual([])
			expect(out.degradation).toEqual({
				kind: "unavailable",
				status: 503,
				code: "SEARCH_LANES_UNAVAILABLE",
				outcomes: { status: "failed", lanes: INDEX_HEALTH_ROWS },
			})
		}
	})

	it("silent recallConversation keeps the code and both rows on an index-health failure", async () => {
		stubResponse(503, indexHealthBody)

		const out = await silentClient().recallConversation({
			scope: "agent",
			scopeRef: "agent:a1",
			query: "q",
		})

		expect(out.results).toEqual([])
		expect(out.degradation).toEqual({
			kind: "unavailable",
			status: 503,
			code: "SEARCH_LANES_UNAVAILABLE",
			outcomes: { status: "failed", lanes: INDEX_HEALTH_ROWS },
		})
	})

	it("a non-silent recallConversation rejects with the typed error carrying the rows", async () => {
		stubResponse(503, indexHealthBody)
		const client = new MemongoClient({
			baseUrl: "http://127.0.0.1:3100",
			maxRetries: 0,
		})

		await expect(
			client.recallConversation({
				scope: "agent",
				scopeRef: "agent:a1",
				query: "q",
			}),
		).rejects.toMatchObject({
			name: "MemongoClientError",
			status: 503,
			code: "SEARCH_LANES_UNAVAILABLE",
			outcomes: { status: "failed", lanes: INDEX_HEALTH_ROWS },
		})
	})

	it("a 200 partial keeps an index-health row beside a healthy sibling", async () => {
		const partial = {
			results: [],
			outcomes: {
				status: "partial",
				lanes: [
					{
						lane: "structured",
						stage: "lane",
						outcome: "ok-empty",
						reason: "zero-hits",
					},
					INDEX_HEALTH_ROWS[0],
				],
			},
		}
		stubResponse(200, JSON.stringify(partial))

		await expect(silentClient().search({ query: "q" })).resolves.toEqual(
			partial,
		)
	})
})
