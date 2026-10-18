import { describe, expect, it } from "vitest"
import {
	type Question,
	question,
	useLongMemEvalLoader,
	ZERO_TOTALS,
} from "./longmemeval-admission.fixture.js"

const { load } = useLongMemEvalLoader()

/** Question "b" with a non-evidence session b-s0 holding `turn`, plus evidence session b-s1. */
function withNonEvidenceTurn(turn: unknown): Question {
	return question("b", {
		haystack_session_ids: ["b-s0", "b-s1"],
		haystack_sessions: [
			[{ role: "user", content: "kept" }, turn],
			[{ role: "user", content: "fact", has_answer: true }],
		],
		answer_session_ids: ["b-s1"],
	})
}

describe("LongMemEval turn admission (decision 3, OPEN-7 B, OPEN-10 B, OPEN-13 A)", () => {
	it.each([
		["a string", "text", "turn-not-object"],
		["null", null, "turn-not-object"],
		["an array", [{ role: "user", content: "x" }], "turn-not-object"],
		["a missing role", { content: "x" }, "turn-invalid-role"],
		["a non-string role", { role: 1, content: "x" }, "turn-invalid-role"],
		["a system role", { role: "system", content: "x" }, "turn-invalid-role"],
		[
			"numeric content",
			{ role: "user", content: 5 },
			"turn-content-not-string",
		],
		["missing content", { role: "user" }, "turn-content-not-string"],
		[
			'has_answer "true"',
			{ role: "user", content: "x", has_answer: "true" },
			"turn-invalid-has-answer",
		],
		[
			"has_answer null",
			{ role: "user", content: "x", has_answer: null },
			"turn-invalid-has-answer",
		],
	])("rejects a turn with %s and keeps its question and siblings", async (_label, turn, reason) => {
		const dataset = await load([question("a"), withNonEvidenceTurn(turn)])
		expect(dataset.scenarios?.map((scenario) => scenario.scenarioId)).toEqual([
			"a",
			"b",
		])
		expect(
			dataset.scenarios?.[1]?.conversations[0]?.turns.map(
				(entry) => entry.body,
			),
		).toEqual(["kept"])
		expect(dataset.adapterDiagnostics).toEqual({
			entries: [
				{
					format: "longmemeval",
					questionIndex: 1,
					sessionIndex: 0,
					turnIndex: 1,
					reason,
				},
			],
			totals: { ...ZERO_TOTALS, rejectedTurns: 1 },
		})
	})

	it.each([
		["empty", ""],
		["whitespace", " \n\t"],
	])("records an %s non-answer, non-evidence turn as an informational skip", async (_label, content) => {
		const dataset = await load([
			question("a"),
			withNonEvidenceTurn({ role: "assistant", content, has_answer: false }),
		])
		expect(dataset.scenarios).toHaveLength(2)
		expect(dataset.adapterDiagnostics).toEqual({
			entries: [
				{
					format: "longmemeval",
					questionIndex: 1,
					sessionIndex: 0,
					turnIndex: 1,
					reason: "skipped-empty-turn",
				},
			],
			totals: { ...ZERO_TOTALS, informationalSkips: 1 },
		})
	})

	it("rejects an empty answer-target turn and the question it was evidence for", async () => {
		const dataset = await load([
			question("a"),
			withNonEvidenceTurn({ role: "user", content: " ", has_answer: true }),
		])
		expect(dataset.scenarios?.map((scenario) => scenario.scenarioId)).toEqual([
			"a",
		])
		expect(dataset.adapterDiagnostics).toEqual({
			entries: [
				{
					format: "longmemeval",
					questionIndex: 1,
					reason: "question-evidence-unresolved",
				},
				{
					format: "longmemeval",
					questionIndex: 1,
					sessionIndex: 0,
					turnIndex: 1,
					reason: "turn-empty-answer-target",
				},
			],
			totals: { ...ZERO_TOTALS, rejectedTurns: 1, rejectedQuestions: 1 },
		})
	})

	it("rejects an empty turn inside an evidence session and the question it was evidence for", async () => {
		const dataset = await load([
			question("a"),
			question("b", {
				haystack_sessions: [
					[
						{ role: "user", content: "fact", has_answer: true },
						{ role: "assistant", content: "" },
					],
				],
			}),
		])
		expect(dataset.scenarios?.map((scenario) => scenario.scenarioId)).toEqual([
			"a",
		])
		expect(dataset.adapterDiagnostics?.entries).toEqual([
			{
				format: "longmemeval",
				questionIndex: 1,
				reason: "question-evidence-unresolved",
			},
			{
				format: "longmemeval",
				questionIndex: 1,
				sessionIndex: 0,
				turnIndex: 1,
				reason: "turn-empty-evidence",
			},
		])
	})

	it("records a session left with no ingestible turn as emptied, informational only (OPEN-10 B)", async () => {
		const dataset = await load([
			question("a"),
			question("b", {
				haystack_session_ids: ["b-s0", "b-s1", "b-s2"],
				haystack_sessions: [
					[
						{ role: "user", content: "" },
						{ role: "assistant", content: " " },
					],
					[{ role: "user", content: "fact", has_answer: true }],
					[],
				],
				answer_session_ids: ["b-s1"],
			}),
		])
		expect(
			dataset.scenarios?.[1]?.conversations.map((c) => c.sessionId),
		).toEqual(["b::b-s1"])
		expect(dataset.adapterDiagnostics).toEqual({
			entries: [
				{
					format: "longmemeval",
					questionIndex: 1,
					sessionIndex: 0,
					reason: "session-emptied",
				},
				{
					format: "longmemeval",
					questionIndex: 1,
					sessionIndex: 0,
					turnIndex: 0,
					reason: "skipped-empty-turn",
				},
				{
					format: "longmemeval",
					questionIndex: 1,
					sessionIndex: 0,
					turnIndex: 1,
					reason: "skipped-empty-turn",
				},
				{
					format: "longmemeval",
					questionIndex: 1,
					sessionIndex: 2,
					reason: "session-emptied",
				},
			],
			totals: { ...ZERO_TOTALS, emptiedSessions: 2, informationalSkips: 2 },
		})
	})

	it("rejects the question when its evidence session is emptied by rejected turns", async () => {
		const dataset = await load([
			question("a"),
			question("b", {
				haystack_sessions: [[{ role: "robot", content: "x" }]],
			}),
		])
		expect(dataset.adapterDiagnostics).toEqual({
			entries: [
				{
					format: "longmemeval",
					questionIndex: 1,
					reason: "question-evidence-unresolved",
				},
				{
					format: "longmemeval",
					questionIndex: 1,
					sessionIndex: 0,
					reason: "session-emptied",
				},
				{
					format: "longmemeval",
					questionIndex: 1,
					sessionIndex: 0,
					turnIndex: 0,
					reason: "turn-invalid-role",
				},
			],
			totals: {
				...ZERO_TOTALS,
				rejectedTurns: 1,
				emptiedSessions: 1,
				rejectedQuestions: 1,
			},
		})
	})

	it("stores admitted content trimmed and never ingests a skipped turn", async () => {
		const dataset = await load([
			question("b", {
				haystack_sessions: [
					[
						{ role: "user", content: "  fact  ", has_answer: true },
						{ role: "assistant", content: "" },
						{ role: "assistant", content: "reply" },
					],
				],
				answer_session_ids: undefined,
			}),
		])
		const turns = dataset.scenarios?.[0]?.conversations[0]?.turns
		expect(turns?.map((turn) => turn.body)).toEqual(["fact", "reply"])
		expect(turns?.map((turn) => turn.metadata?.benchmarkTurnId)).toEqual([
			"b::b-s1::turn_1",
			"b::b-s1::turn_3",
		])
	})
})

const repeated = () => [
	{ role: "user", content: "same words" },
	{ role: "assistant", content: "same reply" },
]

describe("LongMemEval session occurrences (decision 6, OPEN-12 A)", () => {
	it("labels the k-th occurrence, keeps its own date and the original id as provenance", async () => {
		const dataset = await load([
			question("q", {
				haystack_session_ids: ["s", "q-s1", "s", "s"],
				haystack_dates: [
					"2023/05/20 (Sat) 02:21",
					"2023/05/21 (Sun) 03:00",
					"2023/05/22 (Mon) 04:00",
					"2023/05/23 (Tue) 05:00",
				],
				haystack_sessions: [
					repeated(),
					[{ role: "user", content: "fact", has_answer: true }],
					repeated(),
					repeated(),
				],
				answer_session_ids: ["q-s1"],
			}),
		])
		const conversations = dataset.scenarios?.[0]?.conversations ?? []
		expect(conversations.map((entry) => entry.sessionId)).toEqual([
			"q::s",
			"q::q-s1",
			"q::s::occ2",
			"q::s::occ3",
		])
		const second = conversations[2]
		expect(second?.turns.map((turn) => turn.metadata)).toEqual([
			{
				benchmarkDatasetKind: "longmemeval",
				benchmarkQuestionId: "q",
				benchmarkOriginalSessionId: "s",
				benchmarkTurnId: "q::s::occ2::turn_1",
			},
			{
				benchmarkDatasetKind: "longmemeval",
				benchmarkQuestionId: "q",
				benchmarkOriginalSessionId: "s",
				benchmarkTurnId: "q::s::occ2::turn_2",
			},
		])
		expect(
			conversations.map((conversation) => conversation.turns[0]?.timestamp),
		).toEqual([
			"2023/05/20 (Sat) 02:21",
			"2023/05/21 (Sun) 03:00",
			"2023/05/22 (Mon) 04:00",
			"2023/05/23 (Tue) 05:00",
		])
		expect(dataset.adapterDiagnostics?.entries).toEqual([])
	})

	it("makes every occurrence of a repeated evidence session evidence, in place", async () => {
		const evidenceSession = () => [
			{ role: "user", content: "fact", has_answer: true },
			{ role: "assistant", content: "ok" },
		]
		const dataset = await load([
			question("q", {
				haystack_session_ids: ["s", "x", "s"],
				haystack_sessions: [
					evidenceSession(),
					[{ role: "user", content: "other", has_answer: true }],
					evidenceSession(),
				],
				answer_session_ids: ["x", "s"],
			}),
		])
		const evaluation = dataset.scenarios?.[0]?.evaluations[0]
		expect(evaluation?.expectedSessionIds).toEqual([
			"q::x",
			"q::s",
			"q::s::occ2",
		])
		expect(evaluation?.expectedTurnIds).toEqual([
			"q::s::turn_1",
			"q::x::turn_1",
			"q::s::occ2::turn_1",
		])
		expect(evaluation?.officialRetrieval).toEqual({
			evaluator: "longmemeval-main-run",
			eligible: true,
			expectedSessionIds: ["q::s", "q::x", "q::s::occ2"],
			expectedTurnIds: ["q::s::turn_1", "q::x::turn_1", "q::s::occ2::turn_1"],
		})
	})

	it("counts occurrences per question, so another question's copy stays first", async () => {
		const dataset = await load([
			question("a", {
				haystack_session_ids: ["s"],
				haystack_sessions: [repeated()],
				answer_session_ids: [],
			}),
			question("b", {
				haystack_session_ids: ["s"],
				haystack_sessions: [repeated()],
				answer_session_ids: [],
			}),
		])
		expect(
			dataset.scenarios?.map(
				(scenario) => scenario.conversations[0]?.sessionId,
			),
		).toEqual(["a::s", "b::s"])
	})
})
