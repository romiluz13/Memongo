import { describe, expect, it } from "vitest"
import type { MemorySearchResult } from "../../packages/memory-engine/src/types.js"
import { buildRoundUnits } from "./round-units.js"

// C-2: a retrieved turn becomes its round, the way the official reader
// expands it. Fictional data only.

function turn(
	id: string,
	role: "user" | "assistant",
	text: string,
	partner?: MemorySearchResult["roundPartner"],
): MemorySearchResult {
	return {
		path: `events/${id}`,
		startLine: 0,
		endLine: 0,
		score: 0.5,
		snippet: text.slice(0, 20),
		text,
		source: "conversation",
		canonicalId: `event:${id}`,
		sessionId: "s-oak",
		role,
		timestamp: new Date("2031-04-02T10:00:00.000Z"),
		...(partner !== undefined ? { roundPartner: partner } : {}),
	}
}

const ANSWER = {
	canonicalId: "event:a1",
	role: "assistant" as const,
	text: "The lighthouse tour starts at nine.",
	timestamp: new Date("2031-04-02T10:01:00.000Z"),
}

describe("buildRoundUnits", () => {
	it("puts a user turn and its next-turn partner in one labeled passage", () => {
		const units = buildRoundUnits([
			turn("u1", "user", "When does the lighthouse tour start?", ANSWER),
		])
		expect(units).toEqual([
			{
				key: "round:event:u1|event:a1",
				turns: [
					{
						canonicalId: "event:u1",
						role: "user",
						text: "When does the lighthouse tour start?",
						timestamp: new Date("2031-04-02T10:00:00.000Z"),
					},
					ANSWER,
				],
				passage:
					"User: When does the lighthouse tour start?\nAssistant: The lighthouse tour starts at nine.",
			},
		])
	})
	it("puts an assistant turn after its previous-turn partner", () => {
		const [unit] = buildRoundUnits([
			turn("a1", "assistant", "The lighthouse tour starts at nine.", {
				canonicalId: "event:u1",
				role: "user",
				text: "When does the lighthouse tour start?",
			}),
		])
		expect(unit?.key).toBe("round:event:u1|event:a1")
		expect(unit?.passage).toBe(
			"User: When does the lighthouse tour start?\nAssistant: The lighthouse tour starts at nine.",
		)
	})
	it("merges two results that form the same round into one unit, at the first one's place", () => {
		const question = {
			canonicalId: "event:u1",
			role: "user" as const,
			text: "When does the lighthouse tour start?",
		}
		const units = buildRoundUnits([
			turn("a1", "assistant", "The lighthouse tour starts at nine.", question),
			turn("u9", "user", "Is the ferry running?", {
				canonicalId: "event:a9",
				role: "assistant",
				text: "Only on weekends.",
			}),
			turn("u1", "user", "When does the lighthouse tour start?", ANSWER),
		])
		expect(units.map((unit) => unit.key)).toEqual([
			"round:event:u1|event:a1",
			"round:event:u9|event:a9",
		])
	})
	it("never doubles a role label the turn text already carries (B9-2)", () => {
		const [unit] = buildRoundUnits([
			turn("u1", "user", "User: When does the lighthouse tour start?", {
				...ANSWER,
				text: "Assistant : The lighthouse tour starts at nine.",
			}),
		])
		expect(unit?.passage).toBe(
			"User: When does the lighthouse tour start?\nAssistant : The lighthouse tour starts at nine.",
		)
	})
	it("keeps a turn without a partner as a single-turn unit and records why", () => {
		const units = buildRoundUnits([
			{
				...turn("u7", "user", "Is the ferry running?", null),
				roundPartnerMissing: "session-end",
			},
			{
				path: "chunks/c1",
				startLine: 0,
				endLine: 0,
				score: 0.4,
				snippet: "Ferry timetable, spring edition.",
				source: "reference",
				canonicalId: "chunk:c1",
			},
		])
		expect(units).toEqual([
			{
				key: "single:event:u7",
				turns: [
					{
						canonicalId: "event:u7",
						role: "user",
						text: "Is the ferry running?",
						timestamp: new Date("2031-04-02T10:00:00.000Z"),
					},
				],
				passage: "User: Is the ferry running?",
				roundPartnerMissing: "session-end",
			},
			{
				key: "single:chunk:c1",
				turns: [
					{
						canonicalId: "chunk:c1",
						text: "Ferry timetable, spring edition.",
					},
				],
				passage: "Ferry timetable, spring edition.",
			},
		])
	})
})
