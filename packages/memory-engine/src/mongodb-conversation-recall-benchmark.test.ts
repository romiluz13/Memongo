import type { Collection, Db, Document } from "mongodb"
import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("./mongodb-schema.js", () => ({
	eventsCollection: vi.fn(),
}))

import { recallConversation } from "./mongodb-conversation-recall.js"
import { eventsCollection } from "./mongodb-schema.js"

type BenchmarkRole = "user" | "assistant" | "system" | "tool"

type BenchmarkEvent = {
	_id: string
	eventId: string
	agentId: string
	sessionId: string
	role: BenchmarkRole
	body: string
	scope: "agent"
	scopeRef: string
	timestamp: Date
	sourceRef?: string
}

function mockDb(): Db {
	return {} as Db
}

function matchesScalarFilter(value: unknown, filter: unknown): boolean {
	if (
		filter &&
		typeof filter === "object" &&
		!Array.isArray(filter) &&
		!("source" in (filter as Record<string, unknown>))
	) {
		const operator = filter as Record<string, unknown>
		if ("$eq" in operator) {
			return value === operator.$eq
		}
		if ("$in" in operator && Array.isArray(operator.$in)) {
			return operator.$in.includes(value)
		}
		if ("$ne" in operator) {
			return value !== operator.$ne
		}
	}

	return value === filter
}

function matchesTimestamp(value: Date, filter: unknown): boolean {
	if (!(filter && typeof filter === "object" && !Array.isArray(filter))) {
		return true
	}

	const operator = filter as Record<string, unknown>
	const millis = value.getTime()
	if (operator.$gte instanceof Date && millis < operator.$gte.getTime()) {
		return false
	}
	if (operator.$lte instanceof Date && millis > operator.$lte.getTime()) {
		return false
	}
	return true
}

function matchesBody(value: string, filter: unknown): boolean {
	if (
		filter &&
		typeof filter === "object" &&
		!Array.isArray(filter) &&
		(filter as Record<string, unknown>).$regex instanceof RegExp
	) {
		return (filter as Record<string, RegExp>).$regex.test(value)
	}
	return true
}

function matchesFilter(doc: BenchmarkEvent, filter: Document): boolean {
	return Object.entries(filter).every(([key, value]) => {
		switch (key) {
			case "agentId":
				return matchesScalarFilter(doc.agentId, value)
			case "sessionId":
				return matchesScalarFilter(doc.sessionId, value)
			case "role":
				return matchesScalarFilter(doc.role, value)
			case "timestamp":
				return matchesTimestamp(doc.timestamp, value)
			case "body":
				return matchesBody(doc.body, value)
			default:
				return true
		}
	})
}

function compareDesc(left: BenchmarkEvent, right: BenchmarkEvent): number {
	const timestampDelta = right.timestamp.getTime() - left.timestamp.getTime()
	if (timestampDelta !== 0) {
		return timestampDelta
	}
	return right._id.localeCompare(left._id)
}

function makeCorpusCollection(docs: BenchmarkEvent[]): Collection {
	const find = vi.fn((filter: Document) => {
		const matched = docs.filter((doc) => matchesFilter(doc, filter))
		return {
			sort: vi.fn(() => ({
				limit: vi.fn((value?: number) => ({
					toArray: vi.fn(async () =>
						[...matched].sort(compareDesc).slice(0, value ?? matched.length),
					),
				})),
			})),
		}
	}) as unknown as Collection["find"]

	return {
		find,
		aggregate: vi.fn(() => ({
			toArray: vi.fn(async () => []),
		})),
	} as unknown as Collection
}

function makeEvent(params: {
	agentId: string
	sessionId: string
	role: BenchmarkRole
	body: string
	timestamp: string
	sourceRef?: string
}): BenchmarkEvent {
	const stamp = new Date(params.timestamp)
	return {
		_id: `${params.sessionId}-${stamp.toISOString()}-${params.role}`,
		eventId: `${params.sessionId}-${stamp.toISOString()}-${params.role}`,
		agentId: params.agentId,
		sessionId: params.sessionId,
		role: params.role,
		body: params.body,
		scope: "agent",
		scopeRef: `agent:${params.agentId}`,
		timestamp: stamp,
		...(params.sourceRef ? { sourceRef: params.sourceRef } : {}),
	}
}

function makeMultiSessionCorpus(agentId: string): BenchmarkEvent[] {
	return [
		...Array.from({ length: 10 }, (_, index) =>
			makeEvent({
				agentId,
				sessionId: "A",
				role: index % 2 === 0 ? "user" : "assistant",
				body: `Roadmap work discussion ${index + 1}`,
				timestamp: `2026-04-${String(7 + Math.floor(index / 5)).padStart(2, "0")}T0${index % 5}:00:00.000Z`,
			}),
		),
		...Array.from({ length: 10 }, (_, index) =>
			makeEvent({
				agentId,
				sessionId: "B",
				role: index % 2 === 0 ? "user" : "assistant",
				body: `Personal planning conversation ${index + 1}`,
				timestamp: `2026-04-${String(9 + Math.floor(index / 5)).padStart(2, "0")}T1${index % 5}:00:00.000Z`,
			}),
		),
		...Array.from({ length: 10 }, (_, index) =>
			makeEvent({
				agentId,
				sessionId: "C",
				role: index % 2 === 0 ? "user" : "assistant",
				body: `Technical debugging thread ${index + 1}`,
				timestamp: `2026-04-11T${String(10 + index).padStart(2, "0")}:00:00.000Z`,
			}),
		),
	]
}

describe("conversation recall regression suite", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("preserves multi-session recall boundaries", async () => {
		const agentId = "benchmark-recall-01"
		const col = makeCorpusCollection(makeMultiSessionCorpus(agentId))
		vi.mocked(eventsCollection).mockReturnValue(col)

		const debugging = await recallConversation({
			db: mockDb(),
			prefix: "mem_",
			request: {
				agentId,
				query: "debugging",
				asOf: new Date("2026-04-12T00:00:00.000Z"),
				limit: 20,
			},
			capabilities: {
				vectorSearch: false,
				textSearch: false,
				rankFusion: false,
				scoreFusion: false,
			},
		})
		const sessionOnly = await recallConversation({
			db: mockDb(),
			prefix: "mem_",
			request: {
				agentId,
				sessionId: "B",
				limit: 20,
			},
		})

		expect(debugging.results).toHaveLength(10)
		expect(
			new Set(debugging.results.map((result) => result.citation.sessionId)),
		).toEqual(new Set(["C"]))
		expect(sessionOnly.results).toHaveLength(10)
		expect(
			new Set(sessionOnly.results.map((result) => result.citation.sessionId)),
		).toEqual(new Set(["B"]))
	})

	it("applies role and tool-message filters deterministically", async () => {
		const agentId = "benchmark-recall-02"
		const docs: BenchmarkEvent[] = [
			...Array.from({ length: 4 }, (_, index) =>
				makeEvent({
					agentId,
					sessionId: "filtering",
					role: "user",
					body: `User turn ${index + 1}`,
					timestamp: `2026-04-08T0${index}:00:00.000Z`,
				}),
			),
			...Array.from({ length: 4 }, (_, index) =>
				makeEvent({
					agentId,
					sessionId: "filtering",
					role: "assistant",
					body: `Assistant turn ${index + 1}`,
					timestamp: `2026-04-08T1${index}:00:00.000Z`,
				}),
			),
			...Array.from({ length: 3 }, (_, index) =>
				makeEvent({
					agentId,
					sessionId: "filtering",
					role: "tool",
					body: `Tool turn ${index + 1}`,
					timestamp: `2026-04-08T2${index}:00:00.000Z`,
				}),
			),
		]
		const col = makeCorpusCollection(docs)
		vi.mocked(eventsCollection).mockReturnValue(col)

		const defaultRecall = await recallConversation({
			db: mockDb(),
			prefix: "mem_",
			request: { agentId, limit: 20 },
		})
		const includeTools = await recallConversation({
			db: mockDb(),
			prefix: "mem_",
			request: { agentId, includeToolMessages: true, limit: 20 },
		})
		const usersOnly = await recallConversation({
			db: mockDb(),
			prefix: "mem_",
			request: { agentId, roles: ["user"], limit: 20 },
		})

		expect(defaultRecall.results).toHaveLength(8)
		expect(includeTools.results).toHaveLength(11)
		expect(usersOnly.results).toHaveLength(4)
		expect(
			usersOnly.results.every((result) => result.citation.role === "user"),
		).toBe(true)
	})

	it("treats UTC date-only ranges as inclusive full-day boundaries", async () => {
		const agentId = "benchmark-recall-03"
		const docs = [
			makeEvent({
				agentId,
				sessionId: "utc-boundary",
				role: "assistant",
				body: "Before boundary",
				timestamp: "2026-04-07T23:59:59.000Z",
			}),
			makeEvent({
				agentId,
				sessionId: "utc-boundary",
				role: "assistant",
				body: "Start boundary",
				timestamp: "2026-04-08T00:00:00.000Z",
			}),
			makeEvent({
				agentId,
				sessionId: "utc-boundary",
				role: "assistant",
				body: "Midday",
				timestamp: "2026-04-08T12:00:00.000Z",
			}),
			makeEvent({
				agentId,
				sessionId: "utc-boundary",
				role: "assistant",
				body: "End boundary",
				timestamp: "2026-04-08T23:59:59.999Z",
			}),
			makeEvent({
				agentId,
				sessionId: "utc-boundary",
				role: "assistant",
				body: "After boundary",
				timestamp: "2026-04-09T00:00:00.000Z",
			}),
		]
		const col = makeCorpusCollection(docs)
		vi.mocked(eventsCollection).mockReturnValue(col)

		const response = await recallConversation({
			db: mockDb(),
			prefix: "mem_",
			request: {
				agentId,
				startTime: "2026-04-08",
				endTime: "2026-04-08",
				limit: 10,
			},
		})

		expect(response.results.map((result) => result.citation.preview)).toEqual([
			"Assistant: End boundary",
			"Assistant: Midday",
			"Assistant: Start boundary",
		])
	})

	it("resolves date-only ranges in the requested timezone", async () => {
		const agentId = "benchmark-recall-04"
		const docs = [
			makeEvent({
				agentId,
				sessionId: "timezone-boundary",
				role: "assistant",
				body: "Before EDT day",
				timestamp: "2026-04-08T00:00:00.000Z",
			}),
			makeEvent({
				agentId,
				sessionId: "timezone-boundary",
				role: "assistant",
				body: "Midday EDT",
				timestamp: "2026-04-08T12:00:00.000Z",
			}),
			makeEvent({
				agentId,
				sessionId: "timezone-boundary",
				role: "assistant",
				body: "Late EDT",
				timestamp: "2026-04-08T23:59:59.999Z",
			}),
			makeEvent({
				agentId,
				sessionId: "timezone-boundary",
				role: "assistant",
				body: "Evening EDT still same local day",
				timestamp: "2026-04-09T00:00:00.000Z",
			}),
		]
		const col = makeCorpusCollection(docs)
		vi.mocked(eventsCollection).mockReturnValue(col)

		const response = await recallConversation({
			db: mockDb(),
			prefix: "mem_",
			request: {
				agentId,
				startTime: "2026-04-08",
				endTime: "2026-04-08",
				timezone: "America/New_York",
				limit: 10,
				asOf: new Date("2026-04-10T00:00:00.000Z"),
			},
		})

		expect(response.results.map((result) => result.citation.preview)).toEqual([
			"Assistant: Evening EDT still same local day",
			"Assistant: Late EDT",
			"Assistant: Midday EDT",
		])
	})

	it("caps recall at the asOf timestamp", async () => {
		const agentId = "benchmark-recall-05"
		const docs = [
			makeEvent({
				agentId,
				sessionId: "temporal-gate",
				role: "assistant",
				body: "T1",
				timestamp: "2026-04-08T10:00:00.000Z",
			}),
			makeEvent({
				agentId,
				sessionId: "temporal-gate",
				role: "assistant",
				body: "T2",
				timestamp: "2026-04-08T11:00:00.000Z",
			}),
			makeEvent({
				agentId,
				sessionId: "temporal-gate",
				role: "assistant",
				body: "T3",
				timestamp: "2026-04-08T12:00:00.000Z",
			}),
		]
		const col = makeCorpusCollection(docs)
		vi.mocked(eventsCollection).mockReturnValue(col)

		const response = await recallConversation({
			db: mockDb(),
			prefix: "mem_",
			request: {
				agentId,
				asOf: new Date("2026-04-08T11:00:00.000Z"),
				limit: 10,
			},
		})

		expect(response.results.map((result) => result.citation.preview)).toEqual([
			"Assistant: T2",
			"Assistant: T1",
		])
	})

	it("returns complete citations for every recalled result", async () => {
		const agentId = "benchmark-recall-06"
		const docs = [
			makeEvent({
				agentId,
				sessionId: "citations",
				role: "assistant",
				body: "Reference architecture note",
				timestamp: "2026-04-08T09:00:00.000Z",
				sourceRef: "doc://architecture/001",
			}),
			makeEvent({
				agentId,
				sessionId: "citations",
				role: "user",
				body: "Please remember this deployment detail.",
				timestamp: "2026-04-08T10:00:00.000Z",
				sourceRef: "doc://architecture/002",
			}),
		]
		const col = makeCorpusCollection(docs)
		vi.mocked(eventsCollection).mockReturnValue(col)

		const response = await recallConversation({
			db: mockDb(),
			prefix: "mem_",
			request: {
				agentId,
				limit: 10,
			},
		})

		expect(response.results).toHaveLength(2)
		for (const result of response.results) {
			expect(result.citation.eventId.length).toBeGreaterThan(0)
			expect(result.citation.role.length).toBeGreaterThan(0)
			expect(result.citation.timestamp).toBeInstanceOf(Date)
			expect(result.citation.preview.length).toBeGreaterThan(0)
			expect(result.citation.preview.length).toBeLessThanOrEqual(500)
		}
		expect(response.results[0]?.citation.sourceRef).toBe(
			"doc://architecture/002",
		)
	})
})
