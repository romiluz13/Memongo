import { describe, expect, it } from "vitest"
import {
	createFakeClock,
	createFakeContext,
	httpError,
	type Json,
	recordInputs,
	sentTo,
} from "./fake-api.ts"
import { planProbeD, runProbeD } from "./probe-d.ts"

type Options = {
	ignoreTimezone?: boolean
	naiveDay?: boolean
	ascending?: boolean
	ignoreValidity?: boolean
	ignoreAsOfCap?: boolean
	leakRange?: boolean
	neverIndexed?: boolean
	failWriteAt?: number
	failRecall?: boolean
	ignorePhrase?: boolean
	wallClockPhrase?: boolean
	standardOnly?: boolean
	controlLagReads?: number
}

const DAY_MS = 86_400_000
const BASE_QUERY = "Dated archive log entry"

function phraseOrigin(query: string, at: number): number | undefined {
	const text = query.toLowerCase()
	const date = new Date(at)
	const dayStart = Math.floor(at / DAY_MS) * DAY_MS
	const weekStart = dayStart - ((date.getUTCDay() + 6) % 7) * DAY_MS
	const year = date.getUTCFullYear()
	const month = date.getUTCMonth()
	if (text.includes("last week")) return weekStart - 7 * DAY_MS
	if (text.includes("this week")) return weekStart
	if (text.includes("today")) return dayStart
	if (text.includes("yesterday")) return dayStart - DAY_MS
	if (text.includes("last month")) return Date.UTC(year, month - 1, 1)
	if (text.includes("this month")) return Date.UTC(year, month, 1)
	return undefined
}

type Stored = {
	eventId: string
	body: string
	timestamp: string
	validAt: string
	invalidAt?: string
	seq: number
}

function offsetMs(at: number, timeZone: string): number {
	const parts = new Intl.DateTimeFormat("en-US", {
		timeZone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		hourCycle: "h23",
	}).formatToParts(new Date(at))
	const v = Object.fromEntries(
		parts
			.filter((part) => part.type !== "literal")
			.map((part) => [part.type, part.value]),
	)
	return (
		Date.UTC(
			Number(v.year),
			Number(v.month) - 1,
			Number(v.day),
			Number(v.hour),
			Number(v.minute),
			Number(v.second),
		) - at
	)
}

function zonedMidnight(
	y: number,
	m: number,
	d: number,
	timeZone: string,
): number {
	const guess = Date.UTC(y, m - 1, d)
	const first = guess - offsetMs(guess, timeZone)
	const second = guess - offsetMs(first, timeZone)
	return second
}

function boundary(
	input: string,
	edge: "start" | "end",
	timeZone: string | undefined,
	options: Options,
): number {
	if (input.includes("T")) return Date.parse(input)
	const [y, m, d] = input.split("-").map(Number) as [number, number, number]
	const zone = options.ignoreTimezone ? undefined : timeZone
	if (!zone) {
		return Date.parse(
			`${input}T${edge === "start" ? "00:00:00.000" : "23:59:59.999"}Z`,
		)
	}
	if (edge === "start") return zonedMidnight(y, m, d, zone)
	if (options.naiveDay) return zonedMidnight(y, m, d, zone) + 86_400_000 - 1
	return zonedMidnight(y, m, d + 1, zone) - 1
}

function createFakeD(options: Options = {}) {
	const clock = createFakeClock()
	const events: Stored[] = []
	const queries: { query: string; asOf: unknown; limit: unknown }[] = []
	let writes = 0
	let controlReads = 0
	const hybrid = (input: Json) => {
		const query = input.query as string
		queries.push({ query, asOf: input.asOf, limit: input.limit })
		const asOf = Date.parse(input.asOf as string)
		if (query === BASE_QUERY) controlReads += 1
		const lagging =
			query === BASE_QUERY && controlReads <= (options.controlLagReads ?? 0)
		const eligible = events
			.filter(
				(item) =>
					Date.parse(item.timestamp) <= asOf &&
					Date.parse(item.validAt) <= asOf &&
					(item.invalidAt === undefined || Date.parse(item.invalidAt) > asOf),
			)
			.slice(0, lagging ? -2 : undefined)
		const origin = options.ignorePhrase
			? undefined
			: phraseOrigin(
					query,
					options.wallClockPhrase ? Date.parse("2026-10-19T09:00:00Z") : asOf,
				)
		const textOrder = [...eligible].sort((a, b) =>
			origin === undefined
				? a.seq - b.seq
				: Math.abs(Date.parse(a.timestamp) - origin) -
						Math.abs(Date.parse(b.timestamp) - origin) || a.seq - b.seq,
		)
		return {
			results: textOrder.map((item, index) => ({
				citation: {
					eventId: item.eventId,
					role: "user",
					timestamp: item.timestamp,
					preview: item.body,
				},
				matchType: "hybrid",
				...(options.standardOnly
					? {}
					: {
							scoreDetails: {
								value: 0.03,
								details: [
									{
										inputPipelineName: "vector",
										rank: ((item.seq * 7) % 19) + 1,
										weight: 1,
										value: 0.01,
									},
									{
										inputPipelineName: "text",
										rank: index + 1,
										weight: 1,
										value: 0.01,
									},
								],
							},
						}),
			})),
			metadata: {
				totalMatched: textOrder.length,
				queryUsed: query,
				filtersApplied: [],
				searchMethod: options.standardOnly ? "standard" : "hybrid",
			},
		}
	}
	const api = {
		writeEvent: async (input: Json) => {
			const body = input.body as string
			writes += 1
			if (writes === options.failWriteAt) throw httpError(500, "BOOM")
			const eventId = `ev-${events.length + 1}`
			events.push({
				eventId,
				body,
				timestamp: input.timestamp as string,
				validAt: input.validAt as string,
				...(input.invalidAt ? { invalidAt: input.invalidAt as string } : {}),
				seq: events.length,
			})
			return { ok: true, eventId, chunkCreated: true }
		},
		recallConversation: async (input: Json) => {
			if (options.failRecall) throw httpError(503, "SEARCH_LANES_UNAVAILABLE")
			if (typeof input.query === "string" && input.query !== "") {
				return hybrid(input)
			}
			const asOf = Date.parse(input.asOf as string)
			const zone = input.timezone as string | undefined
			const start = input.startTime
				? boundary(input.startTime as string, "start", zone, options)
				: -Infinity
			let end = input.endTime
				? boundary(input.endTime as string, "end", zone, options)
				: asOf
			if (!options.ignoreAsOfCap && end > asOf) end = asOf
			const limit = (input.limit as number | undefined) ?? 50
			const rows =
				start > end
					? []
					: events
							.filter((item) => {
								const at = Date.parse(item.timestamp)
								if (at < start || at > end) return false
								if (options.ignoreValidity) return true
								return (
									Date.parse(item.validAt) <= asOf &&
									(item.invalidAt === undefined ||
										Date.parse(item.invalidAt) > asOf)
								)
							})
							.sort(
								(a, b) =>
									(Date.parse(b.timestamp) - Date.parse(a.timestamp) ||
										b.seq - a.seq) * (options.ascending ? -1 : 1),
							)
							.slice(0, limit)
			return {
				results: rows.map((item) => ({
					citation: {
						eventId: item.eventId,
						role: "user",
						timestamp: item.timestamp,
						preview: item.body,
					},
					matchType: "filter",
				})),
				metadata: {
					totalMatched: rows.length,
					filtersApplied: [],
					searchMethod: "standard",
				},
			}
		},
		searchDetailed: async (input: Json) => {
			const range = input.timeRange as
				| { start: string; end: string }
				| undefined
			const rows = options.neverIndexed
				? []
				: events.filter((item) => {
						if (!range || options.leakRange) return true
						const at = Date.parse(item.timestamp)
						return at >= Date.parse(range.start) && at <= Date.parse(range.end)
					})
			return {
				results: rows.map((item) => ({ snippet: item.body })),
				metadata: { outcomeStatus: "complete", laneOutcomes: [] },
			}
		},
	}
	return { api, clock, events, queries }
}

function context(options: Options = {}) {
	const fake = createFakeD(options)
	return { fake, ctx: createFakeContext(fake.api, { clock: fake.clock }) }
}

function caseOf(result: Awaited<ReturnType<typeof runProbeD>>, id: string) {
	const found = result.cases.find((item) => item.caseId === id)
	if (!found) throw new Error(`missing ${id}`)
	return found
}

describe("runProbeD", () => {
	it("passes every checkable case against a correct engine and stays incomplete because phrase gaps are open", async () => {
		const { ctx } = context()
		const result = await runProbeD(ctx)
		const open = result.cases.filter((item) => item.outcome !== "pass")
		expect(open.map((item) => item.caseId)).toEqual([
			"D/relative/day-offset",
			"D/relative/weekday",
			"D/relative/relative-year",
		])
		expect(open.every((item) => item.reason?.startsWith("declared-gap:"))).toBe(
			true,
		)
		expect(result.cases).toHaveLength(20)
		expect(result.outcome).toBe("inconclusive")
		expect(result.extra?.coverageGaps).toBeDefined()
	})

	it("resolves relative phrases through recallConversation with the fixture asOf and a bounded limit", async () => {
		const { ctx, fake } = context()
		await runProbeD(ctx)
		const phrased = fake.queries.filter((item) => item.query !== BASE_QUERY)
		expect(phrased.map((item) => item.query)).toEqual([
			`${BASE_QUERY} yesterday`,
			`${BASE_QUERY} today`,
			`${BASE_QUERY} this week`,
			`${BASE_QUERY} last week`,
			`${BASE_QUERY} this month`,
			`${BASE_QUERY} last month`,
		])
		for (const item of fake.queries) {
			expect(item.asOf).toBe("2026-03-20T12:00:00.000Z")
			expect(item.limit).toBe(50)
		}
	})

	it("fails every supported phrase when the engine ignores relative phrases", async () => {
		const { ctx } = context({ ignorePhrase: true })
		const result = await runProbeD(ctx)
		const failed = result.cases
			.filter((item) => item.outcome === "fail")
			.map((item) => item.caseId)
		expect(failed).toEqual(
			[
				"yesterday",
				"today",
				"this-week",
				"last-week",
				"this-month",
				"last-month",
			].map((id) => `D/relative/${id}`),
		)
		expect(result.outcome).toBe("fail")
	})

	it("fails the phrases when they are resolved against the wall clock instead of asOf", async () => {
		const { ctx } = context({ wallClockPhrase: true })
		const result = await runProbeD(ctx)
		expect(caseOf(result, "D/relative/yesterday").outcome).toBe("fail")
		expect(caseOf(result, "D/recall/full-window").outcome).toBe("pass")
		expect(result.outcome).toBe("fail")
	})

	it("is inconclusive, not failed, when a querying recall is not a hybrid recall", async () => {
		const { ctx } = context({ standardOnly: true })
		const result = await runProbeD(ctx)
		const found = caseOf(result, "D/relative/yesterday")
		expect(found.outcome).toBe("inconclusive")
		expect(found.reason).toBe("unassessable:not-hybrid")
		expect(result.cases.some((item) => item.outcome === "fail")).toBe(false)
	})

	it("polls the unphrased control until every eligible event is returned", async () => {
		const { ctx, fake } = context({ controlLagReads: 3 })
		const result = await runProbeD(ctx)
		expect(
			fake.queries.filter((item) => item.query === BASE_QUERY),
		).toHaveLength(4)
		expect(caseOf(result, "D/relative/yesterday").outcome).toBe("pass")
	})

	it("stays within the planned call counts", async () => {
		const { ctx } = context()
		await runProbeD(ctx)
		const plan = planProbeD()
		const counted = ctx.budget.snapshot().calls
		expect(counted["api-write"]).toBe(plan["api-write"])
		expect(counted["api-read"]).toBeLessThanOrEqual(plan["api-read"])
	})

	it("writes every fixture event in order with its explicit timestamps", async () => {
		const { ctx, fake } = context()
		await runProbeD(ctx)
		expect(fake.events).toHaveLength(19)
		expect(fake.events[0]?.timestamp).toBe("2026-03-08T07:59:59.999Z")
		expect(fake.events.find((item) => item.invalidAt)?.invalidAt).toBeDefined()
	})

	it("fails the timezone queries when the engine ignores the timezone", async () => {
		const { ctx } = context({ ignoreTimezone: true })
		const result = await runProbeD(ctx)
		const failed = result.cases
			.filter((item) => item.outcome === "fail")
			.map((item) => item.caseId)
		expect(failed).toEqual(
			expect.arrayContaining([
				"D/recall/tz-tokyo",
				"D/recall/tz-kolkata",
				"D/recall/tz-los-angeles",
			]),
		)
		expect(caseOf(result, "D/recall/utc-day").outcome).toBe("pass")
		expect(result.outcome).toBe("fail")
	})

	it("fails only the daylight-saving day when the engine assumes 24-hour days", async () => {
		const { ctx } = context({ naiveDay: true })
		const result = await runProbeD(ctx)
		const failed = result.cases
			.filter((item) => item.outcome === "fail")
			.map((item) => item.caseId)
		expect(failed).toContain("D/recall/tz-la-dst-day")
		expect(failed).not.toContain("D/recall/tz-los-angeles")
		expect(caseOf(result, "D/recall/tz-la-dst-day").predicate).toBe(
			"set-mismatch",
		)
	})

	it("fails the full window when results come back oldest first", async () => {
		const { ctx } = context({ ascending: true })
		const result = await runProbeD(ctx)
		expect(caseOf(result, "D/recall/full-window").predicate).toBe(
			"order-mismatch",
		)
	})

	it("fails when invalid or not-yet-valid events are returned", async () => {
		const { ctx } = context({ ignoreValidity: true })
		const result = await runProbeD(ctx)
		const detail = caseOf(result, "D/recall/full-window").detail as {
			extra: string[]
		}
		expect(detail.extra).toEqual(expect.arrayContaining(["V1", "V2", "V3"]))
	})

	it("fails when an event recorded after asOf is returned", async () => {
		const { ctx } = context({ ignoreAsOfCap: true })
		const result = await runProbeD(ctx)
		expect(caseOf(result, "D/recall/tz-tokyo").detail).toMatchObject({
			extra: ["T1"],
		})
	})

	it("fails the range soundness check when searchDetailed ignores the range", async () => {
		const { ctx } = context({ leakRange: true })
		const result = await runProbeD(ctx)
		const detailed = caseOf(result, "D/searchDetailed/timeRange")
		expect(detailed.outcome).toBe("fail")
		expect(detailed.predicate).toBe("out-of-window-returned")
	})

	it("keeps the exact ranged request that was sent as the evidence of an unsound range", async () => {
		const { ctx } = context({ leakRange: true })
		const sent = recordInputs(ctx)
		const result = await runProbeD(ctx)
		const detailed = caseOf(result, "D/searchDetailed/timeRange")
		const request = detailed.evidence?.request
		expect(sentTo(sent, "searchDetailed")).toContainEqual(request)
		expect(request).toHaveProperty("timeRange")
	})

	it("is inconclusive when the events never become searchable", async () => {
		const { ctx } = context({ neverIndexed: true })
		const result = await runProbeD(ctx)
		expect(caseOf(result, "D/searchDetailed/timeRange").outcome).toBe(
			"inconclusive",
		)
		expect(result.outcome).toBe("inconclusive")
	})

	it("is inconclusive for queries that need a fixture event whose write failed", async () => {
		const { ctx } = context({ failWriteAt: 8 })
		const result = await runProbeD(ctx)
		const utc = caseOf(result, "D/recall/utc-day")
		expect(utc.outcome).toBe("inconclusive")
		expect(utc.reason).toBe("fixture-not-acknowledged:E4")
		expect(caseOf(result, "D/recall/tz-tokyo").outcome).toBe("pass")
		expect(result.outcome).toBe("inconclusive")
		expect(result.reasons).toContain("write-failed:E4")
	})

	it("is inconclusive when recall is unavailable", async () => {
		const { ctx } = context({ failRecall: true })
		const result = await runProbeD(ctx)
		expect(
			result.cases
				.filter((item) => item.caseId.startsWith("D/recall/"))
				.every((item) => item.outcome === "inconclusive"),
		).toBe(true)
		expect(result.outcome).toBe("inconclusive")
	})
})
