import {
	writeSessionEvidenceOptionA,
	writeSessionEvidenceOptionB,
} from "../../packages/memory-engine/src/mongodb-session-evidence.js"
import { describe, expect, it } from "vitest"
import {
	parseBenchmarkTimestamp,
	normalizeBenchmarkConversationTimestamps,
} from "./benchmark-timestamp.js"

describe("benchmark timestamp grammar", () => {
	it.each([
		["2024-02-29", "2024-02-29T00:00:00.000Z"],
		["2024-03-01T01:59:59.123+02:00", "2024-02-29T23:59:59.123Z"],
		["0050/06/01 (Wed) 00:00", "0050-06-01T00:00:00.000Z"],
		["2024/06/15 (Sat) 14:30", "2024-06-15T14:30:00.000Z"],
	])("maps %s to a host-independent instant", (value, expected) => {
		const result = parseBenchmarkTimestamp("longmemeval", value)
		expect(result.ok && result.instant.toISOString()).toBe(expected)
	})
	it.each([
		null,
		undefined,
		42,
		"",
		"yesterday",
		"2024/02/30 (Fri) 01:00",
		"2023/02/29 (Wed) 01:00",
		"2024/01/01 (Mon) 24:00",
		"2024/01/01 (Mon) 00:60",
		"2024-02-30",
		"2024-01-01T10:00:00",
	])("rejects malformed or impossible values (%s)", (value) => {
		expect(parseBenchmarkTimestamp("longmemeval", value).ok).toBe(false)
	})
	it("retains numeric calendar fields and reports a weekday mismatch", () => {
		const result = parseBenchmarkTimestamp(
			"longmemeval",
			"2024/06/15 (Mon) 14:30",
		)
		expect(result.ok && result.instant.toISOString()).toBe(
			"2024-06-15T14:30:00.000Z",
		)
		expect(result.ok && result.weekdayMismatch).toBe(true)
	})
	it("keeps corpus grammars out of generic imports", () => {
		expect(
			parseBenchmarkTimestamp("generic", "2024/06/15 (Sat) 14:30").ok,
		).toBe(false)
	})
	it("normalizes evidence inputs without changing the source used in prompts", () => {
		const conversations = [
			{
				turns: [
					{
						role: "user" as const,
						body: "synthetic",
						timestamp: "2024/06/15 (Sat) 14:30",
					},
				],
			},
		]
		const normalized = normalizeBenchmarkConversationTimestamps(
			conversations,
			"longmemeval",
		)
		expect(normalized[0]?.turns[0]?.timestamp).toBe("2024-06-15T14:30:00.000Z")
		expect(conversations[0]?.turns[0]?.timestamp).toBe("2024/06/15 (Sat) 14:30")
	})
})

describe("pinned LoCoMo grammar with literal twelve-hour labels", () => {
	it.each([
		["1:56 pm on 8 May, 2023", "2023-05-08T13:56:00.000Z"],
		["12:05 am on 8 May, 2023", "2023-05-08T00:05:00.000Z"],
		["12:05 pm on 8 May, 2023", "2023-05-08T12:05:00.000Z"],
	])("maps %s without silently correcting the published label", (raw, expected) => {
		const result = parseBenchmarkTimestamp("locomo", raw)
		expect(result.ok && result.instant.toISOString()).toBe(expected)
		expect(result.ok && result.literalMidnightLabel).toBe(
			raw.includes("12:05 am"),
		)
	})
	it.each([
		"0:01 am on 8 May, 2023",
		"13:01 pm on 8 May, 2023",
		"1:60 pm on 8 May, 2023",
		"1:01 pm on 31 April, 2023",
		"1:01 pm on 29 February, 2023",
		"1:01 PM on 8 May, 2023",
	])("refuses %s", (raw) => {
		expect(parseBenchmarkTimestamp("locomo", raw).ok).toBe(false)
	})
})

it.each([
	"A",
	"B",
])("session evidence option %s persists the same parsed instant", async (mode) => {
	const source = [
		{
			sessionId: "s",
			turns: [
				{
					role: "user" as const,
					body: "synthetic",
					timestamp: "12:05 am on 8 May, 2023",
				},
			],
		},
	]
	const conversations = normalizeBenchmarkConversationTimestamps(
		source,
		"locomo",
	)
	const written: Array<{ timestamp: Date }> = []
	const collection = {
		insertMany: async (documents: Array<{ timestamp: Date }>) => {
			written.push(...documents)
		},
	}
	const params = {
		conversations,
		agentId: "a",
		scope: "agent" as const,
		scopeRef: "a",
		eventIds: new Map([["s", ["event"]]]),
	}
	if (mode === "A")
		await writeSessionEvidenceOptionA({
			...params,
			chunksCollection: collection as never,
		})
	else
		await writeSessionEvidenceOptionB({
			...params,
			sessionChunksCollection: collection as never,
		})
	expect(written.map((doc) => doc.timestamp.toISOString())).toEqual([
		"2023-05-08T00:05:00.000Z",
	])
	expect(source[0]?.turns[0]?.timestamp).toBe("12:05 am on 8 May, 2023")
})
