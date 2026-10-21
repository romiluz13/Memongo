import { describe, expect, it } from "vitest"
import {
	buildReaderContext,
	estimateTokens,
	READER_BUDGET_TOKENIZER,
	type ReaderUnit,
} from "./reader-budget.js"

// D: the custom-v3 reader budget. Fictional strings only.

describe("estimateTokens (o200k_base)", () => {
	// Expected counts come from OpenAI's reference tiktoken 0.14.0
	// (`tiktoken.get_encoding("o200k_base")`), not from js-tiktoken.
	it("counts multibyte text like the reference o200k_base encoder", () => {
		expect(READER_BUDGET_TOKENIZER).toBe("js-tiktoken@1.0.21/o200k_base")
		expect(estimateTokens("hello world")).toBe(2)
		expect(estimateTokens("Zoë’s café ☕")).toBe(6)
		expect(estimateTokens("שלום")).toBe(1)
		expect(estimateTokens("👩‍👩‍👧")).toBe(8)
		expect(estimateTokens("東京タワー")).toBe(4)
		expect(estimateTokens("Session Date: 2031/01/20 (Mon) 10:00")).toBe(17)
		expect(estimateTokens("")).toBe(0)
	})
})

function unit(
	id: string,
	rank: number,
	sessionId: string,
	turnOrder: number | null,
	passage: string,
	sessionDates: string[] = [],
): ReaderUnit {
	return { id, rank, sessionId, turnOrder, passage, sessionDates }
}

const WIDE = 100_000

describe("buildReaderContext presentation", () => {
	it("renders the exact official-form user content for one fixture", () => {
		const context = buildReaderContext({
			units: [
				unit(
					"round:event:m3|event:m4",
					1,
					"sess-mill",
					3,
					"User: Did the miller fix the wheel?\nAssistant: Yes, on Tuesday.",
					["2031/01/20 (Mon) 10:00"],
				),
				unit(
					"single:event:h1",
					2,
					"sess-harbor",
					1,
					"User: The ferry to Quillmarsh leaves at noon.",
					["2030/11/02 (Sat) 18:45"],
				),
				unit(
					"single:event:m1",
					3,
					"sess-mill",
					1,
					"User: The mill sits on Brindle creek.",
					["2031/01/20 (Mon) 10:00"],
				),
				unit("single:event:n1", 4, "sess-note", 1, "User: An undated note."),
			],
			question: "When was the wheel fixed?",
			questionDate: "2031/02/14 (Fri) 09:30",
			budget: WIDE,
		})
		expect(context.userContent).toBe(
			[
				"History Chats:",
				"",
				"### Session 1:",
				"Session Content:",
				"User: An undated note.",
				"",
				"### Session 2:",
				"Session Date: 2030/11/02 (Sat) 18:45",
				"Session Content:",
				"User: The ferry to Quillmarsh leaves at noon.",
				"",
				"### Session 3:",
				"Session Date: 2031/01/20 (Mon) 10:00",
				"Session Content:",
				"User: The mill sits on Brindle creek.",
				"User: Did the miller fix the wheel?",
				"Assistant: Yes, on Tuesday.",
				"",
				"Current Date: 2031/02/14 (Fri) 09:30",
				"Question: When was the wheel fixed?",
				'Return only {"answer":"..."}.',
			].join("\n"),
		)
		expect(context.estimatedContextTokens).toBe(
			estimateTokens(context.userContent),
		)
	})

	it("puts undated sessions first by relevance and never invents a date", () => {
		const context = buildReaderContext({
			units: [
				unit("single:event:d1", 1, "sess-dated", 1, "User: Dated line.", [
					"2030/05/01 (Wed) 08:00",
				]),
				unit("single:event:u2", 3, "sess-undated-b", 1, "User: Lower note."),
				unit("single:event:u1", 2, "sess-undated-a", 1, "User: Higher note."),
			],
			question: "Which note?",
			questionDate: "2031/02/14 (Fri) 09:30",
			budget: WIDE,
		})
		expect(context.userContent).toBe(
			[
				"History Chats:",
				"",
				"### Session 1:",
				"Session Content:",
				"User: Higher note.",
				"",
				"### Session 2:",
				"Session Content:",
				"User: Lower note.",
				"",
				"### Session 3:",
				"Session Date: 2030/05/01 (Wed) 08:00",
				"Session Content:",
				"User: Dated line.",
				"",
				"Current Date: 2031/02/14 (Fri) 09:30",
				"Question: Which note?",
				'Return only {"answer":"..."}.',
			].join("\n"),
		)
	})

	it("omits the Current Date line when the question has no date", () => {
		const context = buildReaderContext({
			units: [unit("single:event:d1", 1, "sess-dated", 1, "User: Dated line.")],
			question: "Which note?",
			budget: WIDE,
		})
		expect(
			context.userContent.endsWith(
				'User: Dated line.\n\nQuestion: Which note?\nReturn only {"answer":"..."}.',
			),
		).toBe(true)
		expect(context.userContent).not.toContain("Current Date")
	})
})

function tokensOf(units: ReaderUnit[], question = "Q?"): number {
	return buildReaderContext({ units, question, budget: WIDE })
		.estimatedContextTokens
}

describe("buildReaderContext admission", () => {
	const keyNote = unit(
		"single:event:a1",
		1,
		"sess-a",
		1,
		"User: The key is under the blue pot.",
	)
	const bigNote = unit(
		"single:event:a2",
		2,
		"sess-a",
		2,
		`User: ${"A very long ramble about lanterns. ".repeat(40)}`,
	)
	const gateNote = unit(
		"single:event:a3",
		3,
		"sess-a",
		3,
		"User: The gate code is 4417.",
	)
	const fenceNote = unit(
		"single:event:a4",
		4,
		"sess-a",
		4,
		"User: The fence paint is teal.",
	)

	it("admits evidence above the budget line, skips what does not fit and keeps going", () => {
		const budget = tokensOf([keyNote, gateNote])
		const context = buildReaderContext({
			units: [keyNote, bigNote, gateNote, fenceNote],
			question: "Q?",
			budget,
		})
		expect(context.admitted.map((u) => u.id)).toEqual([
			"single:event:a1",
			"single:event:a3",
		])
		expect(context.userContent).toContain("The gate code is 4417.")
		expect(context.userContent).not.toContain("The fence paint is teal.")
		expect(context.userContent).not.toContain("lanterns")
		expect(context.estimatedContextTokens).toBe(budget)
		expect(context.budgetEstimatedTokens).toBe(budget)
		expect(context.budgetExceededByFirstUnit).toBe(false)
		expect(context.counts).toEqual({
			candidates: 4,
			admitted: 2,
			deduplicated: 0,
			skipped: 2,
		})
		expect(context.skippedRanks).toEqual([2, 4])
	})

	it("always admits the first unit, even one larger than the whole budget", () => {
		const budget = tokensOf([keyNote])
		const firstIsHuge = { ...bigNote, rank: 1, id: "single:event:a0" }
		const context = buildReaderContext({
			units: [{ ...keyNote, rank: 2 }, firstIsHuge, { ...gateNote, rank: 3 }],
			question: "Q?",
			budget,
		})
		expect(context.admitted.map((u) => u.id)).toEqual(["single:event:a0"])
		expect(context.budgetExceededByFirstUnit).toBe(true)
		expect(context.estimatedContextTokens).toBeGreaterThan(budget)
		expect(context.userContent).toContain("lanterns")
		expect(context.skippedRanks).toEqual([2, 3])
	})

	it("drops duplicate unit ids and duplicate texts, keeping the best rank", () => {
		const context = buildReaderContext({
			units: [
				{ ...gateNote, rank: 5 },
				keyNote,
				{ ...keyNote, id: "single:event:a9", rank: 2, turnOrder: 9 },
				gateNote,
			],
			question: "Q?",
			budget: WIDE,
		})
		expect(context.admitted).toEqual([keyNote, gateNote])
		expect(context.counts).toEqual({
			candidates: 4,
			admitted: 2,
			deduplicated: 2,
			skipped: 0,
		})
		expect(context.userContent.match(/blue pot/g)).toHaveLength(1)
	})

	it("gives ten sessions breadth first: five best sessions when five fit", () => {
		// Session k (01 newest .. 10 oldest) holds ranks 2k-1 and 2k, so a
		// pure rank cut would spend the budget on sessions 01-03 only.
		const units = Array.from({ length: 10 }, (_, i) => {
			const k = String(i + 1).padStart(2, "0")
			const date = [`2030/01/${String(20 - i).padStart(2, "0")} (Mon) 08:00`]
			return [
				unit(
					`single:event:${k}a`,
					2 * i + 1,
					`sess-${k}`,
					1,
					`User: Heron fact ${k} first.`,
					date,
				),
				unit(
					`single:event:${k}b`,
					2 * i + 2,
					`sess-${k}`,
					2,
					`User: Heron fact ${k} second.`,
					date,
				),
			]
		}).flat()
		const bestOfFive = units.filter((u) => u.rank <= 9 && u.rank % 2 === 1)
		const context = buildReaderContext({
			units,
			question: "Q?",
			budget: tokensOf(bestOfFive),
		})
		expect(context.admitted.map((u) => u.id)).toEqual([
			"single:event:05a",
			"single:event:04a",
			"single:event:03a",
			"single:event:02a",
			"single:event:01a",
		])
		expect(context.skippedRanks).toEqual([
			11, 13, 15, 17, 19, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20,
		])
	})

	it("fills a five-unit session in rank order and presents it in turn order", () => {
		const dateA = ["2030/03/01 (Fri) 09:00"]
		const dateB = ["2030/02/01 (Fri) 09:00"]
		const a = (rank: number, turn: number) =>
			unit(
				`single:event:a-t${turn}`,
				rank,
				"sess-a",
				turn,
				`User: Owl turn ${turn}.`,
				dateA,
			)
		const b = (rank: number, turn: number) =>
			unit(
				`single:event:b-t${turn}`,
				rank,
				"sess-b",
				turn,
				`User: Wren turn ${turn}.`,
				dateB,
			)
		const units = [
			a(1, 8),
			b(2, 3),
			a(3, 2),
			a(4, 6),
			b(5, 1),
			a(6, 4),
			a(7, 10),
		]
		const fit = units.filter((u) => u.rank <= 5)
		const context = buildReaderContext({
			units,
			question: "Q?",
			budget: tokensOf(fit),
		})
		expect(context.admitted.map((u) => u.id)).toEqual([
			"single:event:b-t1",
			"single:event:b-t3",
			"single:event:a-t2",
			"single:event:a-t6",
			"single:event:a-t8",
		])
		expect(context.skippedRanks).toEqual([6, 7])
	})

	it("keeps the newest session when it ranks well under a tight budget (tail-drop guard)", () => {
		// Sessions d01 (oldest) .. d10 (newest); the newest ranks second.
		const ranks = [1, 4, 5, 6, 7, 8, 9, 10, 3, 2]
		const units = ranks.map((rank, i) => {
			const k = String(i + 1).padStart(2, "0")
			return unit(
				`single:event:d${k}`,
				rank,
				`sess-d${k}`,
				1,
				`User: Lark note ${k}.`,
				[`2030/04/${k} (Mon) 08:00`],
			)
		})
		const context = buildReaderContext({
			units,
			question: "Q?",
			budget: tokensOf(units.filter((u) => u.rank <= 3)),
		})
		expect(context.admitted.map((u) => u.id)).toEqual([
			"single:event:d01",
			"single:event:d09",
			"single:event:d10",
		])
		expect(context.userContent).toMatch(/Lark note 10\.\n\nQuestion: Q\?/)
		expect(context.skippedRanks).toEqual([4, 5, 6, 7, 8, 9, 10])
	})

	it("counts a session header when the session's first unit is admitted", () => {
		const date = ["2030/06/01 (Sat) 08:00"]
		const a1 = unit(
			"single:event:h-a1",
			1,
			"sess-a",
			1,
			"User: Moth one.",
			date,
		)
		const b1 = unit(
			"single:event:h-b1",
			2,
			"sess-b",
			1,
			"User: Moth two.",
			date,
		)
		const a2 = unit(
			"single:event:h-a2",
			3,
			"sess-a",
			2,
			"User: Moth six.",
			date,
		)
		expect(estimateTokens(b1.passage)).toBe(estimateTokens(a2.passage))
		const context = buildReaderContext({
			units: [a1, b1, a2],
			question: "Q?",
			budget: tokensOf([a1, a2]),
		})
		// b1 costs a2's tokens plus a new session header, so only a2 fits.
		expect(context.admitted.map((u) => u.id)).toEqual([
			"single:event:h-a1",
			"single:event:h-a2",
		])
		expect(context.skippedRanks).toEqual([2])
		expect(context.userContent.match(/### Session/g)).toHaveLength(1)
	})

	it("admits and presents identical bytes for any input order", () => {
		const date = (d: string) => [`2030/07/${d} (Tue) 08:00`]
		const units = [
			unit("single:event:s1", 1, "sess-x", 2, "User: Kite one.", date("02")),
			unit("single:event:s2", 2, "sess-y", 1, "User: Kite two.", date("01")),
			unit("single:event:s3", 2, "sess-z", 1, "User: Kite three.", date("01")),
			unit("single:event:s4", 3, "sess-x", 1, "User: Kite four.", date("02")),
			unit(
				"single:event:s5",
				3,
				"sess-y",
				null,
				"User: Kite five.",
				date("01"),
			),
			unit("single:event:s6", 4, "sess-w", 1, "User: Kite six."),
			unit("single:event:s6", 4, "sess-w", 1, "User: Kite six again."),
			unit("single:event:s7", 5, "sess-v", 1, "User: Kite one."),
		]
		const budget = tokensOf(units.slice(0, 4))
		const reference = buildReaderContext({ units, question: "Q?", budget })
		let seed = 7
		for (let round = 0; round < 25; round++) {
			const shuffled = [...units]
			for (let i = shuffled.length - 1; i > 0; i--) {
				seed = (seed * 1103515245 + 12345) % 2147483648
				const j = seed % (i + 1)
				;[shuffled[i], shuffled[j]] = [
					shuffled[j] as ReaderUnit,
					shuffled[i] as ReaderUnit,
				]
			}
			expect(
				buildReaderContext({ units: shuffled, question: "Q?", budget }),
			).toEqual(reference)
		}
	})
})
