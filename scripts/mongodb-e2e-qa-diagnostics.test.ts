import { describe, expect, it, vi } from "vitest"
import type { EnrichmentProvider } from "../packages/memory-engine/src/mongodb-llm-enrichment.js"
import type {
	GoldSessionTarget,
	GoldTurnTarget,
	Pass0ContextDiagnostics,
	ResultLineage,
} from "./benchmark/benchmark-context-diagnostics.js"
import { runE2eQa } from "./mongodb-e2e-qa.js"

function answerProvider(): EnrichmentProvider {
	return {
		name: "mock",
		chatCompletion: vi.fn<EnrichmentProvider["chatCompletion"]>(
			async ({ messages }) => {
				const system = messages.find((m) => m.role === "system")?.content ?? ""
				return {
					content: system.includes("answer the QUESTION")
						? JSON.stringify({ answer: "violet" })
						: JSON.stringify({ correct: true, rationale: "ok" }),
				}
			},
		),
	}
}

function lineage(
	retrievedRank: number,
	overrides: Partial<ResultLineage> = {},
): ResultLineage {
	return {
		retrievedRank,
		memoryId: `memory-${retrievedRank}`,
		score: 1 / retrievedRank,
		sessionIds: [],
		turnIds: [],
		provenance: "none",
		...overrides,
	}
}

function diagnosticsFor(
	sentCandidates: ResultLineage[],
	gold: Pass0ContextDiagnostics["gold"] = {
		applicable: false,
		reason: "no-has-answer-marker",
	},
): Pass0ContextDiagnostics {
	return {
		sentCandidates,
		retrievedSessionRanks: new Map(),
		retrievedTurnRanks: new Map(),
		gold,
	}
}

describe("runE2eQa context diagnostics", () => {
	it("records one entry per passage sent to the answerer, with ranks, hash and a 200 character preview, after the 20 passage cap", async () => {
		const passages = [
			"passage 0",
			"😀".repeat(250),
			...Array.from({ length: 20 }, (_, i) => `passage ${i + 2}`),
		]
		const envelope = await runE2eQa({
			provider: answerProvider(),
			model: "m",
			cases: [
				{
					caseId: "cap",
					question: "What color?",
					goldAnswer: "violet",
					contextPassages: passages,
					diagnostics: diagnosticsFor(
						passages.map((_, i) =>
							lineage((i + 1) * 2, {
								sessionIds: [`session-${i}`],
								turnIds: [`session-${i}::turn_1`],
								provenance: "complete",
							}),
						),
					),
				},
			],
		})
		const result = envelope.caseResults[0]
		expect(result.passagesSentCount).toBe(20)
		expect(result.contextPassages).toHaveLength(20)
		expect(result.contextPassages?.[0]).toEqual({
			sentRank: 1,
			retrievedRank: 2,
			memoryId: "memory-2",
			sessionIds: ["session-0"],
			turnIds: ["session-0::turn_1"],
			provenance: "complete",
			score: 0.5,
			sha256:
				"5fade554909b57eea179d73812aa4dee027d1566f500271ee97f0428a717f611",
			preview: "passage 0",
		})
		expect(result.contextPassages?.[1]).toMatchObject({
			sentRank: 2,
			retrievedRank: 4,
			sha256:
				"8ea11838b5bb4323b4cc889142e2ae8b667104832d89a850bac3ed7ed6cd7443",
			preview: "😀".repeat(200),
		})
		expect(result.contextPassages?.[19]).toMatchObject({
			sentRank: 20,
			retrievedRank: 40,
		})
		expect(result.matchRule).toBe("containment-v2")
	})

	it("marks a case without a has_answer target not-applicable while keeping its real verdict", async () => {
		const envelope = await runE2eQa({
			provider: answerProvider(),
			model: "m",
			cases: [
				{
					caseId: "plain",
					question: "What color?",
					goldAnswer: "violet",
					contextPassages: ["the sky is violet"],
					diagnostics: diagnosticsFor([lineage(1)]),
				},
			],
		})
		const result = envelope.caseResults[0]
		expect(result.correct).toBe(true)
		expect(result.gold).toEqual({
			status: "not-applicable",
			reason: "no-has-answer-marker",
			sessions: [],
			turns: [],
		})
		expect(result.goldSessionInContext).toBeUndefined()
		expect(result.goldTurnInContext).toBeUndefined()
	})

	it("names the failure when the diagnostics step throws an error with an empty message", async () => {
		const envelope = await runE2eQa({
			provider: answerProvider(),
			model: "m",
			cases: [
				{
					caseId: "silent",
					question: "What color?",
					goldAnswer: "violet",
					contextPassages: ["the sky is violet"],
					diagnostics: {
						get sentCandidates(): never {
							throw new Error("")
						},
						retrievedSessionRanks: new Map(),
						retrievedTurnRanks: new Map(),
						gold: { applicable: false, reason: "abstention" },
					},
				},
			],
		})
		expect(envelope.caseResults[0]?.diagnosticsError).toBe(
			"diagnostics failed: Error",
		)
		expect(envelope.caseResults[0]?.correct).toBe(true)
	})
})

describe("runE2eQa gold sent status (containment-v2)", () => {
	const GOLD_TEXT = "I adopted a cat named Miso last spring."
	const turn = (
		over: Partial<GoldTurnTarget> = {},
		text = GOLD_TEXT,
	): GoldTurnTarget => ({
		admittedSessionIndex: 0,
		sessionId: "q::s1",
		turnIndex: 2,
		turnId: "q::s1::turn_3",
		text,
		...over,
	})
	const session = (
		sessionId = "q::s1",
		admittedSessionIndex = 0,
	): GoldSessionTarget => ({ admittedSessionIndex, sessionId })

	async function run(params: {
		passages: string[]
		sent: ResultLineage[]
		turns?: GoldTurnTarget[]
		sessions?: GoldSessionTarget[]
		retrievedSessions?: Array<[string, number]>
		retrievedTurns?: Array<[string, number]>
	}) {
		const envelope = await runE2eQa({
			provider: answerProvider(),
			model: "m",
			cases: [
				{
					caseId: "gold",
					question: "What pet?",
					goldAnswer: "violet",
					contextPassages: params.passages,
					diagnostics: {
						sentCandidates: params.sent,
						retrievedSessionRanks: new Map(params.retrievedSessions ?? []),
						retrievedTurnRanks: new Map(params.retrievedTurns ?? []),
						gold: {
							applicable: true,
							sessions: params.sessions ?? [session()],
							turns: params.turns ?? [turn()],
						},
					},
				},
			],
		})
		return envelope.caseResults[0]
	}

	const complete = (
		retrievedRank: number,
		turnIds: string[],
		sessionIds = ["q::s1"],
	) => lineage(retrievedRank, { provenance: "complete", turnIds, sessionIds })

	it("finds the full turn text in a sent passage after whitespace collapse and trim only", async () => {
		const result = await run({
			passages: [
				"unrelated",
				`  Earlier\n${GOLD_TEXT.replace(/ /g, "  \t")}\n  later `,
			],
			sent: [lineage(1), lineage(2)],
			retrievedSessions: [["q::s1", 2]],
		})
		expect(result.gold).toMatchObject({
			status: "applicable",
			turns: [
				{
					turnId: "q::s1::turn_3",
					turnIndex: 2,
					sentStatus: "present",
					sentRank: 2,
					candidateDefect: false,
				},
			],
			counts: {
				candidate: 0,
				present: 1,
				unknown: 0,
				absentSessionNotRetrieved: 0,
			},
		})
		expect(result.goldTurnInContext).toEqual({ any: true, all: true })
	})

	it("does not fold case or punctuation when matching the turn text", async () => {
		const result = await run({
			passages: [GOLD_TEXT.toUpperCase()],
			sent: [complete(1, ["q::s1::turn_9"])],
			retrievedSessions: [["q::s1", 1]],
		})
		expect(result.gold).toMatchObject({
			turns: [{ sentStatus: "absent", candidateDefect: true }],
		})
	})

	it("proves a turn absent only when every sent passage has complete provenance, none maps to it and none holds its text", async () => {
		const result = await run({
			passages: ["other talk one", "other talk two"],
			sent: [
				complete(1, ["q::s1::turn_1"]),
				complete(2, ["q::s1::turn_4", "q::s1::turn_5"]),
			],
			retrievedSessions: [["q::s1", 1]],
			retrievedTurns: [],
		})
		expect(result.gold).toMatchObject({
			status: "applicable",
			sessions: [
				{ sessionId: "q::s1", retrieved: true, sentStatus: "present" },
			],
			turns: [
				{
					turnId: "q::s1::turn_3",
					retrieved: false,
					retrievedRank: null,
					sentRank: null,
					sentStatus: "absent",
					sessionRetrieved: true,
					candidateDefect: true,
				},
			],
			counts: {
				candidate: 1,
				present: 0,
				unknown: 0,
				absentSessionNotRetrieved: 0,
			},
		})
		expect(result.goldTurnInContext).toEqual({ any: false, all: false })
		expect(result.goldSessionInContext).toEqual({ any: true, all: true })
	})

	it.each([
		[
			"a paraphrase in a passage without ids",
			["You told me about adopting Miso the cat"],
			[lineage(1)],
			null,
		],
		[
			"an unresolved source event id",
			["other talk"],
			[lineage(1, { provenance: "partial", turnIds: [] })],
			null,
		],
		[
			"lineage that maps to the turn but holds only part of its text",
			["I adopted a cat named Miso"],
			[complete(1, ["q::s1::turn_3"])],
			1,
		],
		[
			"one passage without ids beside fully resolved ones",
			["other talk", "more talk"],
			[complete(1, ["q::s1::turn_1"]), lineage(2)],
			null,
		],
	] as const)("leaves the status unknown for %s, never absent", async (_name, passages, sent, sentRank) => {
		const result = await run({
			passages: [...passages],
			sent: [...sent],
			retrievedSessions: [["q::s1", 1]],
		})
		expect(result.gold).toMatchObject({
			turns: [{ sentStatus: "unknown", sentRank, candidateDefect: false }],
			counts: { candidate: 0, present: 0, unknown: 1 },
		})
		expect(result.goldTurnInContext).toEqual({
			any: "unknown",
			all: "unknown",
		})
	})

	it("reports a gold turn retrieved beyond the 20 passage cap as absent from what was sent", async () => {
		const passages = Array.from({ length: 25 }, (_, i) => `filler ${i + 1}`)
		const result = await run({
			passages,
			sent: passages.map((_, i) =>
				complete(i + 1, i === 21 ? ["q::s1::turn_3"] : ["q::s1::turn_1"]),
			),
			retrievedSessions: [["q::s1", 1]],
			retrievedTurns: [["q::s1::turn_3", 22]],
		})
		expect(result.passagesSentCount).toBe(20)
		expect(result.gold).toMatchObject({
			turns: [
				{
					retrieved: true,
					retrievedRank: 22,
					sentRank: null,
					sentStatus: "absent",
					candidateDefect: true,
				},
			],
		})
	})

	it("keeps every target's status when gold session A is retrieved with its turn present and gold session B is not retrieved", async () => {
		const result = await run({
			passages: [`note: ${GOLD_TEXT}`, "unrelated"],
			sent: [
				complete(1, ["q::a::turn_3"], ["q::a"]),
				complete(2, ["q::a::turn_9"], ["q::a"]),
			],
			sessions: [session("q::a", 0), session("q::b", 1)],
			turns: [
				turn({ sessionId: "q::a", turnId: "q::a::turn_3" }),
				turn(
					{
						admittedSessionIndex: 1,
						sessionId: "q::b",
						turnIndex: 0,
						turnId: "q::b::turn_1",
					},
					"My sister lives in Lisbon.",
				),
			],
			retrievedSessions: [["q::a", 1]],
			retrievedTurns: [["q::a::turn_3", 1]],
		})
		expect(result.gold).toMatchObject({
			sessions: [
				{ sessionId: "q::a", retrieved: true, sentStatus: "present" },
				{ sessionId: "q::b", retrieved: false, sentStatus: "absent" },
			],
			turns: [
				{
					turnId: "q::a::turn_3",
					sentStatus: "present",
					candidateDefect: false,
				},
				{
					turnId: "q::b::turn_1",
					sentStatus: "absent",
					sessionRetrieved: false,
					candidateDefect: false,
				},
			],
			counts: {
				candidate: 0,
				present: 1,
				unknown: 0,
				absentSessionNotRetrieved: 1,
			},
		})
		expect(result.goldSessionInContext).toEqual({ any: true, all: false })
		expect(result.goldTurnInContext).toEqual({ any: true, all: false })
	})

	it("treats a case with nothing sent as proven absent, since no passage could hold the turn", async () => {
		const result = await run({
			passages: [],
			sent: [],
			retrievedSessions: [["q::s1", 1]],
		})
		expect(result.passagesSentCount).toBe(0)
		expect(result.gold).toMatchObject({
			turns: [{ sentStatus: "absent", candidateDefect: true }],
		})
	})

	it("reports unknown, not a vacuous truth, for a quantifier over no targets", async () => {
		const result = await run({
			passages: ["x"],
			sent: [complete(1, ["q::s1::turn_1"])],
			sessions: [],
			turns: [],
		})
		expect(result.goldSessionInContext).toEqual({
			any: "unknown",
			all: "unknown",
		})
		expect(result.goldTurnInContext).toEqual({
			any: "unknown",
			all: "unknown",
		})
	})
})
