import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// #101 / decision 16, resolutions R1, R3, R4: the fixed HTTP mapping of a
// search call's outcome summary, tested at the HTTP seam (request in,
// status and body out) for /v1/search, /v1/search-kb and /v1/search-detailed.

const bridge = vi.hoisted(() => ({
	memongoBridgeSearchWithDegradation: vi.fn(),
	memongoBridgeSearchKBWithDegradation: vi.fn(),
	memongoBridgeSearchDetailed: vi.fn(),
	memongoBridgeRecallConversation: vi.fn(),
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

type Row = {
	lane: string
	stage: string
	outcome: string
	reason?: string
	resultCount?: number
	pass?: number
}
type Summary = { status: "complete" | "partial" | "failed"; lanes: Row[] }

const QUERY = "where did the q3 offsite happen"

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

function post(path: string, body: Record<string, unknown> = {}) {
	return createApp().request(path, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: "Bearer fixture-admin",
		},
		body: JSON.stringify({ agentId: "owner", query: QUERY, ...body }),
	})
}

const DETAILED_METADATA = {
	mode: "auto",
	classification: "simple",
	sourceOrder: [],
	passes: [],
	queriesTried: [],
	constraintsApplied: [],
	resultsRejected: [],
	evidenceCoverage: "none",
	pathsExecuted: [],
	resultsByPath: {},
	queryRewritten: false,
	reranked: false,
}

/** Arranges one route's bridge call to resolve with this outcome summary. */
const ROUTES = [
	{
		path: "/v1/search",
		resolve(summary: Summary | undefined, extra: Record<string, unknown> = {}) {
			bridge.memongoBridgeSearchWithDegradation.mockResolvedValue({
				results: [],
				...(summary ? { outcomes: summary } : {}),
				...extra,
			})
		},
		reject(err: unknown) {
			bridge.memongoBridgeSearchWithDegradation.mockRejectedValue(err)
		},
		okOutcomes(json: Record<string, unknown>) {
			return json.outcomes
		},
	},
	{
		path: "/v1/search-kb",
		resolve(summary: Summary | undefined, extra: Record<string, unknown> = {}) {
			bridge.memongoBridgeSearchKBWithDegradation.mockResolvedValue({
				results: [],
				...(summary ? { outcomes: summary } : {}),
				...extra,
			})
		},
		reject(err: unknown) {
			bridge.memongoBridgeSearchKBWithDegradation.mockRejectedValue(err)
		},
		okOutcomes(json: Record<string, unknown>) {
			return json.outcomes
		},
	},
	{
		path: "/v1/search-detailed",
		resolve(summary: Summary | undefined, extra: Record<string, unknown> = {}) {
			bridge.memongoBridgeSearchDetailed.mockResolvedValue({
				results: [],
				metadata: {
					...DETAILED_METADATA,
					...(summary
						? { outcomeStatus: summary.status, laneOutcomes: summary.lanes }
						: {}),
					...extra,
				},
			})
		},
		reject(err: unknown) {
			bridge.memongoBridgeSearchDetailed.mockRejectedValue(err)
		},
		okOutcomes(json: Record<string, unknown>) {
			const metadata = json.metadata as Record<string, unknown>
			return { status: metadata.outcomeStatus, lanes: metadata.laneOutcomes }
		},
	},
] as const

const failed = (lane: string, reason: string): Row => ({
	lane,
	stage: "lane",
	outcome: "failed",
	reason,
})
/** M2: an admission-time index-health failure carries its own stage. */
const indexHealthFailed = (lane: string, reason: string): Row => ({
	lane,
	stage: "index-health",
	outcome: "failed",
	reason,
})
const denied = (lane: string, reason: string): Row => ({
	lane,
	stage: "lane",
	outcome: "budget-denied",
	reason,
})

/** R3 rows that end in a non-2xx: summary in, exact status and code out. */
const FAILED_ROWS: Array<{
	name: string
	lanes: Row[]
	status: number
	code: string
}> = [
	{
		name: "every failure is an unavailable reason",
		lanes: [
			failed("structured", "lane-unavailable"),
			failed("procedural", "index-missing"),
			failed("hybrid", "index-not-ready"),
			failed("graph", "query-timeout"),
			failed("episodic", "dependency-unavailable"),
		],
		status: 503,
		code: "SEARCH_LANES_UNAVAILABLE",
	},
	{
		name: "M2: index-stale and index-unavailable are retryable unavailability",
		lanes: [
			indexHealthFailed("hybrid:chunks", "index-stale"),
			indexHealthFailed("kb", "index-unavailable"),
		],
		status: 503,
		code: "SEARCH_LANES_UNAVAILABLE",
	},
	{
		name: "M2: an index-health failure and a query-error failure map to 500 (defect first)",
		lanes: [
			indexHealthFailed("structured", "index-stale"),
			failed("procedural", "query-error"),
		],
		status: 500,
		code: "SEARCH_LANES_FAILED",
	},
	{
		name: "every failure is a budget denial",
		lanes: [
			denied("structured", "budget-aggregations"),
			denied("hybrid", "budget-embeds"),
			denied("procedural", "budget-deadline"),
			denied("conversation-evidence", "budget-reservation"),
		],
		status: 503,
		code: "SEARCH_BUDGET_EXHAUSTED",
	},
	{
		name: "unavailable beats budget when both appear",
		lanes: [
			failed("structured", "lane-unavailable"),
			denied("hybrid", "budget-embeds"),
		],
		status: 503,
		code: "SEARCH_LANES_UNAVAILABLE",
	},
	{
		name: "a query-error failure wins over unavailable and budget (500 first)",
		lanes: [
			failed("structured", "lane-unavailable"),
			denied("hybrid", "budget-embeds"),
			failed("procedural", "query-error"),
		],
		status: 500,
		code: "SEARCH_LANES_FAILED",
	},
	{
		name: "an internal-error failure is a defect",
		lanes: [failed("hybrid", "internal-error")],
		status: 500,
		code: "SEARCH_LANES_FAILED",
	},
	{
		name: "R4: a failed explain row never changes the mapped status",
		lanes: [
			failed("structured", "lane-unavailable"),
			{
				lane: "structured",
				stage: "explain",
				outcome: "failed",
				reason: "query-error",
			},
		],
		status: 503,
		code: "SEARCH_LANES_UNAVAILABLE",
	},
]

describe.each(ROUTES)("$path outcome mapping (R3)", (route) => {
	it("200 complete: a healthy zero-hit answer carries every row", async () => {
		const summary: Summary = {
			status: "complete",
			lanes: [
				{
					lane: "structured",
					stage: "lane",
					outcome: "ok-empty",
					reason: "zero-hits",
					resultCount: 0,
				},
				// R1: an absent capability is visible but never makes it partial.
				{
					lane: "procedural",
					stage: "atlas-search",
					outcome: "not-applicable",
					reason: "capability-absent",
				},
			],
		}
		route.resolve(summary)

		const res = await post(route.path)

		expect(res.status).toBe(200)
		const json = (await res.json()) as Record<string, unknown>
		expect(json.results).toEqual([])
		expect(route.okOutcomes(json)).toEqual(summary)
	})

	it("200 partial: zero results with a failed lane keep every row", async () => {
		const summary: Summary = {
			status: "partial",
			lanes: [
				{
					lane: "structured",
					stage: "lane",
					outcome: "ok-empty",
					reason: "zero-hits",
				},
				failed("procedural", "query-error"),
				denied("hybrid", "budget-embeds"),
			],
		}
		route.resolve(summary)

		const res = await post(route.path)

		expect(res.status).toBe(200)
		const json = (await res.json()) as Record<string, unknown>
		expect(json.results).toEqual([])
		expect(route.okOutcomes(json)).toEqual(summary)
	})

	it("R4: a failed explain row leaves a complete answer at 200", async () => {
		const summary: Summary = {
			status: "complete",
			lanes: [
				{ lane: "hybrid", stage: "lane", outcome: "ok", resultCount: 2 },
				{
					lane: "hybrid",
					stage: "explain",
					outcome: "failed",
					reason: "query-error",
				},
			],
		}
		route.resolve(summary)

		const res = await post(route.path)

		expect(res.status).toBe(200)
		expect(
			route.okOutcomes((await res.json()) as Record<string, unknown>),
		).toEqual(summary)
	})

	it.each(FAILED_ROWS)("failed, $name → $status $code", async ({
		lanes,
		status,
		code,
	}) => {
		route.resolve({ status: "failed", lanes })

		const res = await post(route.path)

		expect(res.status).toBe(status)
		const json = (await res.json()) as {
			error: { code: string; message: string }
			outcomes: Summary
			results?: unknown
		}
		expect(json.error.code).toBe(code)
		expect(json.error.message).toMatch(/^search failed \(request id: .+\)$/)
		expect(json.outcomes).toEqual({ status: "failed", lanes })
		expect(json).not.toHaveProperty("results")
	})

	it.each([
		{
			name: "SearchLaneUnavailableError",
			err: {
				name: "SearchLaneUnavailableError",
				lane: "structured",
				stage: "lane",
				reason: "lane-unavailable",
			},
			status: 503,
			code: "SEARCH_LANES_UNAVAILABLE",
			row: failed("structured", "lane-unavailable"),
		},
		{
			name: "SearchLaneError with an unavailable reason",
			err: {
				name: "SearchLaneError",
				lane: "hybrid",
				stage: "score-fusion",
				reason: "index-not-ready",
			},
			status: 503,
			code: "SEARCH_LANES_UNAVAILABLE",
			row: {
				lane: "hybrid",
				stage: "score-fusion",
				outcome: "failed",
				reason: "index-not-ready",
			},
		},
		{
			name: "SearchLaneError with index-stale",
			err: {
				name: "SearchLaneError",
				lane: "kb",
				stage: "index-health",
				reason: "index-stale",
			},
			status: 503,
			code: "SEARCH_LANES_UNAVAILABLE",
			row: indexHealthFailed("kb", "index-stale"),
		},
		{
			name: "SearchLaneError with index-unavailable",
			err: {
				name: "SearchLaneError",
				lane: "hybrid:chunks",
				stage: "index-health",
				reason: "index-unavailable",
			},
			status: 503,
			code: "SEARCH_LANES_UNAVAILABLE",
			row: indexHealthFailed("hybrid:chunks", "index-unavailable"),
		},
		{
			name: "SearchBudgetDeniedError",
			err: {
				name: "SearchBudgetDeniedError",
				lane: "conversation-evidence",
				stage: "reservation",
				reason: "budget-reservation",
			},
			status: 503,
			code: "SEARCH_BUDGET_EXHAUSTED",
			row: {
				lane: "conversation-evidence",
				stage: "reservation",
				outcome: "budget-denied",
				reason: "budget-reservation",
			},
		},
		{
			name: "SearchLaneError with a query error and no lane (M5)",
			err: { name: "SearchLaneError", stage: "request", reason: "query-error" },
			status: 500,
			code: "SEARCH_LANES_FAILED",
			row: {
				lane: "search",
				stage: "request",
				outcome: "failed",
				reason: "query-error",
			},
		},
	])("strict mode: a thrown $name maps through the same table", async ({
		err,
		status,
		code,
		row,
	}) => {
		route.reject(
			Object.assign(new Error("typed search failure"), err, {
				name: err.name,
			}),
		)

		const res = await post(route.path)

		expect(res.status).toBe(status)
		const json = (await res.json()) as {
			error: { code: string; message: string }
			outcomes: Summary
		}
		expect(json.error.code).toBe(code)
		expect(json.outcomes).toEqual({ status: "failed", lanes: [row] })
	})

	it("an untyped failure keeps the generic internal error envelope", async () => {
		route.reject(new Error("mongodb memory unavailable"))

		const res = await post(route.path)

		expect(res.status).toBe(500)
		const json = (await res.json()) as Record<string, unknown>
		expect(json).not.toHaveProperty("outcomes")
	})

	it("A2: no row, error body or log line carries query, body or provider text", async () => {
		const CANARY = "PROVIDER-SECRET-canary-7f3a"
		const leakyRow = {
			...failed("structured", "lane-unavailable"),
			error: `${CANARY} ${QUERY}`,
			message: CANARY,
			query: QUERY,
		}
		const okRow = {
			lane: "hybrid",
			stage: "lane",
			outcome: "ok-empty",
			reason: "zero-hits",
			detail: CANARY,
		}
		for (const summary of [
			{ status: "partial", lanes: [okRow, leakyRow] },
			{ status: "failed", lanes: [leakyRow] },
		] as Summary[]) {
			route.resolve(summary)
			const res = await post(route.path)
			const text = await res.text()
			expect(text).not.toContain(CANARY)
			expect(text).not.toContain("offsite")
		}

		route.reject(
			Object.assign(new Error(`${CANARY} ${QUERY}`), {
				name: "SearchLaneError",
				lane: "hybrid",
				stage: "lane",
				reason: "query-error",
				cause: new Error(`${CANARY} provider body`),
			}),
		)
		const res = await post(route.path)
		expect(res.status).toBe(500)
		const text = await res.text()
		expect(text).not.toContain(CANARY)
		expect(text).not.toContain("offsite")
		const logged = vi
			.mocked(console.error)
			.mock.calls.map((call) => call.map(String).join(" "))
			.join("\n")
		expect(logged).not.toContain(CANARY)
		expect(logged).not.toContain("offsite")
	})
})

describe("an admission denial is a typed 503, never a 200 marker (review 1237 ruling 4)", () => {
	// The shape the engine emits on a denied admission: searchV2 returns a
	// failed budget-denied row, search() keeps it, and the throttle marker
	// rides beside it with the admission's retry hint.
	const DENIED: Summary = {
		status: "failed",
		lanes: [
			{
				lane: "search",
				stage: "request",
				outcome: "budget-denied",
				reason: "budget-embeds",
			},
		],
	}

	it.each([
		{
			path: "/v1/search",
			arrange: () =>
				bridge.memongoBridgeSearchWithDegradation.mockResolvedValue({
					results: [],
					degradation: {
						kind: "throttled",
						scope: "denied",
						retryAfterMs: 4000,
					},
					outcomes: DENIED,
				}),
		},
		{
			path: "/v1/search-detailed",
			arrange: () =>
				bridge.memongoBridgeSearchDetailed.mockResolvedValue({
					results: [],
					metadata: {
						...DETAILED_METADATA,
						throttled: { retryAfterMs: 4000 },
						laneOutcomes: DENIED.lanes,
						outcomeStatus: DENIED.status,
					},
				}),
		},
	])("$path answers 503 SEARCH_BUDGET_EXHAUSTED with the admission's Retry-After", async ({
		path,
		arrange,
	}) => {
		arrange()

		const res = await post(path)

		expect(res.status).toBe(503)
		expect(res.headers.get("Retry-After")).toBe("4")
		const json = (await res.json()) as {
			error: { code: string }
			degradation?: unknown
			outcomes: Summary
		}
		expect(json.error.code).toBe("SEARCH_BUDGET_EXHAUSTED")
		expect(json.degradation).toBeUndefined()
		expect(json.outcomes.status).toBe("failed")
		expect(json.outcomes.lanes[0]?.outcome).toBe("budget-denied")
	})
})

describe("budget 503 carries Retry-After from the denial (T11)", () => {
	const budgetError = (retryAfterMs?: number) =>
		Object.assign(new Error("typed search failure"), {
			name: "SearchBudgetDeniedError",
			lane: "kb",
			stage: "request",
			reason: "budget-embeds",
			...(retryAfterMs === undefined ? {} : { retryAfterMs }),
		})

	it.each([
		{ ms: 1, header: "1" },
		{ ms: 1000, header: "1" },
		{ ms: 1001, header: "2" },
		{ ms: 2500, header: "3" },
	])("an admission denial with retryAfterMs $ms sends Retry-After $header", async ({
		ms,
		header,
	}) => {
		bridge.memongoBridgeSearchKBWithDegradation.mockRejectedValue(
			budgetError(ms),
		)

		const res = await post("/v1/search-kb")

		expect(res.status).toBe(503)
		expect(res.headers.get("Retry-After")).toBe(header)
		const json = (await res.json()) as { error: { code: string } }
		expect(json.error.code).toBe("SEARCH_BUDGET_EXHAUSTED")
	})

	it("a per-request budget denial has no retry hint and sends no Retry-After", async () => {
		bridge.memongoBridgeSearchKBWithDegradation.mockRejectedValue(budgetError())

		const res = await post("/v1/search-kb")

		expect(res.status).toBe(503)
		expect(res.headers.get("Retry-After")).toBeNull()
	})

	it.each([
		{ ms: Number.POSITIVE_INFINITY },
		{ ms: Number.NaN },
		{ ms: 0 },
		{ ms: -5 },
	])("an unusable retryAfterMs ($ms) sends no Retry-After", async ({ ms }) => {
		bridge.memongoBridgeSearchKBWithDegradation.mockRejectedValue(
			budgetError(ms),
		)

		const res = await post("/v1/search-kb")

		expect(res.status).toBe(503)
		expect(res.headers.get("Retry-After")).toBeNull()
	})

	it("a retryable lane failure never sends Retry-After", async () => {
		bridge.memongoBridgeSearchKBWithDegradation.mockRejectedValue(
			Object.assign(new Error("typed search failure"), {
				name: "SearchLaneError",
				lane: "kb",
				stage: "lane",
				reason: "index-not-ready",
				retryAfterMs: 4000,
			}),
		)

		const res = await post("/v1/search-kb")

		expect(res.status).toBe(503)
		expect(res.headers.get("Retry-After")).toBeNull()
	})

	it("the recall route carries the header too", async () => {
		bridge.memongoBridgeRecallConversation.mockRejectedValue(
			Object.assign(budgetError(4200), { lane: "recall" }),
		)

		const res = await post("/v1/recall-conversation", {
			scope: "agent",
			scopeRef: "agent:owner",
		})

		expect(res.status).toBe(503)
		expect(res.headers.get("Retry-After")).toBe("5")
	})

	it("the OpenAPI 503 documents the Retry-After header", async () => {
		const res = await createApp().request("/openapi.json")
		const doc = (await res.json()) as {
			paths: Record<
				string,
				{
					post: {
						responses: Record<string, { headers?: Record<string, unknown> }>
					}
				}
			>
		}
		for (const path of ["/v1/search", "/v1/search-kb", "/v1/search-detailed"]) {
			expect(doc.paths[path].post.responses["503"].headers).toHaveProperty(
				"Retry-After",
			)
		}
	})
})

describe("exact-evidence rejection stays 200 (R3)", () => {
	it("serves the rejection verdict with a complete outcome", async () => {
		bridge.memongoBridgeSearchDetailed.mockResolvedValue({
			results: [],
			metadata: {
				...DETAILED_METADATA,
				noDirectEvidenceReason: "exact-evidence-not-found",
				outcomeStatus: "complete",
				laneOutcomes: [
					{
						lane: "conversation-evidence",
						stage: "lane",
						outcome: "ok",
						resultCount: 3,
					},
				],
			},
		})

		const res = await post("/v1/search-detailed", { needExactEvidence: true })

		expect(res.status).toBe(200)
		const json = (await res.json()) as {
			results: unknown[]
			metadata: Record<string, unknown>
		}
		expect(json.results).toEqual([])
		expect(json.metadata.noDirectEvidenceReason).toBe(
			"exact-evidence-not-found",
		)
		expect(json.metadata.outcomeStatus).toBe("complete")
	})

	it("a failed request overrides the rejection verdict with its non-2xx", async () => {
		bridge.memongoBridgeSearchDetailed.mockResolvedValue({
			results: [],
			metadata: {
				...DETAILED_METADATA,
				noDirectEvidenceReason: "exact-evidence-not-found",
				outcomeStatus: "failed",
				laneOutcomes: [failed("conversation-evidence", "index-not-ready")],
			},
		})

		const res = await post("/v1/search-detailed", { needExactEvidence: true })

		expect(res.status).toBe(503)
		const json = (await res.json()) as { error: { code: string } }
		expect(json.error.code).toBe("SEARCH_LANES_UNAVAILABLE")
	})
})

describe("OpenAPI documents the outcome fields and statuses (#101)", () => {
	type Schema = { properties?: Record<string, Schema>; enum?: string[] }
	type Operation = {
		responses: Record<
			string,
			{
				description?: string
				content?: { "application/json"?: { schema?: Schema } }
			}
		>
	}

	async function operation(path: string): Promise<Operation> {
		const res = await createApp().request("/openapi.json")
		const json = (await res.json()) as {
			paths: Record<string, { post: Operation }>
		}
		return json.paths[path].post
	}

	it.each([
		"/v1/search",
		"/v1/search-kb",
	])("%s documents outcomes on its 200 body", async (path) => {
		const op = await operation(path)
		const outcomes =
			op.responses["200"].content?.["application/json"]?.schema?.properties
				?.outcomes
		expect(outcomes?.properties?.status?.enum).toEqual([
			"complete",
			"partial",
			"failed",
		])
		expect(outcomes?.properties).toHaveProperty("lanes")
	})

	it("/v1/search-detailed documents laneOutcomes and outcomeStatus", async () => {
		const op = await operation("/v1/search-detailed")
		const metadata =
			op.responses["200"].content?.["application/json"]?.schema?.properties
				?.metadata
		expect(metadata?.properties).toHaveProperty("laneOutcomes")
		expect(metadata?.properties?.outcomeStatus?.enum).toEqual([
			"complete",
			"partial",
			"failed",
		])
	})

	it.each([
		"/v1/search",
		"/v1/search-kb",
		"/v1/search-detailed",
	])("%s documents index-stale and index-unavailable as 503 reasons (M2)", async (path) => {
		const op = await operation(path)
		expect(op.responses["503"]?.description).toContain("index-stale")
		expect(op.responses["503"]?.description).toContain("index-unavailable")
	})

	it("the outcome row schema enumerates both index-health reasons and stage (M2)", async () => {
		const res = await createApp().request("/openapi.json")
		const text = await res.text()
		const doc = JSON.parse(text) as {
			paths: Record<
				string,
				{
					post: {
						responses: Record<
							string,
							{
								content?: {
									"application/json"?: {
										schema?: {
											properties?: Record<
												string,
												{
													properties?: Record<
														string,
														{
															items?: {
																properties?: Record<string, { enum?: string[] }>
															}
														}
													>
												}
											>
										}
									}
								}
							}
						>
					}
				}
			>
		}
		const lanes =
			doc.paths["/v1/search"].post.responses["200"].content?.[
				"application/json"
			]?.schema?.properties?.outcomes?.properties?.lanes
		const reasons = lanes?.items?.properties?.reason?.enum ?? []
		expect(reasons).toContain("index-stale")
		expect(reasons).toContain("index-unavailable")
		expect(lanes?.items?.properties?.stage).toBeDefined()
	})

	it.each([
		"/v1/search",
		"/v1/search-kb",
		"/v1/search-detailed",
	])("%s documents the 503 and 500 search failure codes", async (path) => {
		const op = await operation(path)
		expect(op.responses["503"]?.description).toContain(
			"SEARCH_LANES_UNAVAILABLE",
		)
		expect(op.responses["503"]?.description).toContain(
			"SEARCH_BUDGET_EXHAUSTED",
		)
		expect(op.responses["500"]?.description).toContain("SEARCH_LANES_FAILED")
		expect(op.responses["503"]?.description).toContain("outcomes")
	})
})

describe("/v1/recall-conversation maps typed index-health failures (M2)", () => {
	it.each([
		"index-stale",
		"index-unavailable",
	] as const)("a recall gated on %s is a retryable 503 with the failing row", async (reason) => {
		bridge.memongoBridgeRecallConversation.mockRejectedValue(
			Object.assign(new Error("PRIVATE provider text"), {
				name: "SearchLaneError",
				lane: "search",
				stage: "index-health",
				reason,
			}),
		)

		const res = await post("/v1/recall-conversation", {
			scope: "agent",
			scopeRef: "agent:owner",
		})

		expect(res.status).toBe(503)
		const text = await res.text()
		expect(text).not.toContain("PRIVATE")
		const json = JSON.parse(text) as {
			error: { code: string }
			outcomes: Summary
		}
		expect(json.error.code).toBe("SEARCH_LANES_UNAVAILABLE")
		expect(json.outcomes).toEqual({
			status: "failed",
			lanes: [
				{ lane: "search", stage: "index-health", outcome: "failed", reason },
			],
		})
	})

	it("an untyped recall failure keeps the route's internal error envelope", async () => {
		bridge.memongoBridgeRecallConversation.mockRejectedValue(
			new Error("mongodb memory unavailable"),
		)

		const res = await post("/v1/recall-conversation", {
			scope: "agent",
			scopeRef: "agent:owner",
		})

		expect(res.status).toBe(500)
		const json = (await res.json()) as Record<string, unknown>
		expect(json).not.toHaveProperty("outcomes")
	})

	it("documents the typed failure statuses", async () => {
		const res = await createApp().request("/openapi.json")
		const json = (await res.json()) as {
			paths: Record<
				string,
				{ post: { responses: Record<string, { description?: string }> } }
			>
		}
		const responses = json.paths["/v1/recall-conversation"].post.responses
		expect(responses["503"]?.description).toContain("index-stale")
		expect(responses["503"]?.description).toContain("index-unavailable")
		expect(responses["500"]?.description).toContain("SEARCH_LANES_FAILED")
	})
})
