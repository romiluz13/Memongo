import { describe, expect, it } from "vitest"
import type { MemorySearchResult } from "../../packages/memory-engine/src/types.js"
import { buildReaderUnits } from "./reader-units.js"

// custom-v3 reader units from searched results with round partners.
// Fictional data only.

const evidence = {
	sessionIds: new Map([
		["e-u2", "sess-pond"],
		["e-a2", "sess-pond"],
		["e-u7", "sess-reeds"],
	]),
	turnIds: new Map([
		["e-u2", "sess-pond::turn_3"],
		["e-a2", "sess-pond::turn_4"],
		["e-u7", "sess-reeds::turn_1"],
	]),
}

const DATES: Record<string, string[]> = {
	"sess-pond": ["2031/01/20 (Mon) 10:00"],
	"sess-reeds": ["2030/11/02 (Sat) 18:45"],
}

function event(
	eventId: string,
	role: "user" | "assistant",
	text: string,
	score: number,
	partner?: MemorySearchResult["roundPartner"],
): MemorySearchResult {
	return {
		path: `events/${eventId}`,
		startLine: 0,
		endLine: 0,
		score,
		snippet: text.slice(0, 10),
		text,
		source: "conversation",
		canonicalId: `event:${eventId}`,
		role,
		sourceEventIds: [eventId],
		...(partner !== undefined ? { roundPartner: partner } : {}),
	}
}

const resolve = (map: Map<string, string>) => (result: MemorySearchResult) => [
	...new Set(
		(result.sourceEventIds ?? []).flatMap((id) => {
			const value = map.get(id)
			return value ? [value] : []
		}),
	),
]

function build(results: MemorySearchResult[]) {
	return buildReaderUnits({
		results,
		evidence,
		collectSourceEventIds: (result) => result.sourceEventIds ?? [],
		resolveSessionIds: resolve(evidence.sessionIds),
		resolveTurnIds: resolve(evidence.turnIds),
		sessionDates: (sessionId) => DATES[sessionId] ?? [],
	})
}

describe("buildReaderUnits", () => {
	it("turns ranked results into units with rank, session, dates, turn order and lineage", () => {
		const question = {
			canonicalId: "event:e-u2",
			role: "user" as const,
			text: "Where did the heron nest?",
		}
		const answer = {
			canonicalId: "event:e-a2",
			role: "assistant" as const,
			text: "By Quillmarsh pond.",
		}
		const { units, lineage } = build([
			event("e-u2", "user", "Where did the heron nest?", 0.9, answer),
			event("e-a2", "assistant", "By Quillmarsh pond.", 0.8, question),
			{
				...event("e-u7", "user", "Brindlewick reeds are tall.", 0.7, null),
				roundPartnerMissing: "session-end",
			},
			{
				path: "chunks/c8",
				startLine: 0,
				endLine: 0,
				score: 0.6,
				snippet: "   ",
				source: "reference",
				canonicalId: "chunk:c8",
			},
			{
				path: "chunks/c9",
				startLine: 0,
				endLine: 0,
				score: 0.5,
				snippet: "Ferry timetable, spring edition.",
				source: "reference",
				canonicalId: "chunk:c9",
			},
		])
		expect(units).toEqual([
			{
				id: "round:event:e-u2|event:e-a2",
				passage:
					"User: Where did the heron nest?\nAssistant: By Quillmarsh pond.",
				rank: 1,
				sessionId: "sess-pond",
				sessionDates: ["2031/01/20 (Mon) 10:00"],
				turnOrder: 3,
			},
			{
				id: "single:event:e-u7",
				passage: "User: Brindlewick reeds are tall.",
				rank: 3,
				sessionId: "sess-reeds",
				sessionDates: ["2030/11/02 (Sat) 18:45"],
				turnOrder: 1,
			},
			{
				id: "single:chunk:c9",
				passage: "Ferry timetable, spring edition.",
				rank: 5,
				sessionId: "single:chunk:c9",
				sessionDates: [],
				turnOrder: null,
			},
		])
		expect(lineage).toEqual([
			{
				retrievedRank: 1,
				memoryId: "round:event:e-u2|event:e-a2",
				score: 0.9,
				sessionIds: ["sess-pond"],
				turnIds: ["sess-pond::turn_3", "sess-pond::turn_4"],
				provenance: "complete",
			},
			{
				retrievedRank: 3,
				memoryId: "single:event:e-u7",
				score: 0.7,
				sessionIds: ["sess-reeds"],
				turnIds: ["sess-reeds::turn_1"],
				provenance: "complete",
			},
			{
				retrievedRank: 5,
				memoryId: "single:chunk:c9",
				score: 0.5,
				sessionIds: [],
				turnIds: [],
				provenance: "none",
			},
		])
	})

	it("counts a partner outside the evidence as an untraced turn", () => {
		const { lineage } = build([
			event("e-u7", "user", "Brindlewick reeds are tall.", 0.7, {
				canonicalId: "event:e-unknown",
				role: "assistant",
				text: "Indeed.",
			}),
		])
		expect(lineage[0]?.provenance).toBe("partial")
		expect(lineage[0]?.turnIds).toEqual(["sess-reeds::turn_1"])
	})
})
