import { describe, expect, it } from "vitest"
import { BenchmarkAdapterRejectedError } from "./benchmark-adapter-diagnostics.js"
import {
	type Question,
	question,
	useLongMemEvalLoader,
	ZERO_TOTALS,
} from "./longmemeval-admission.fixture.js"

const { load, loadText, failure } = useLongMemEvalLoader()

describe("LongMemEval gold (decision 1)", () => {
	it("keeps a finite numeric gold as its string form and records the source type", async () => {
		const dataset = await load([
			question("q-int", { answer: 1300 }),
			question("q-zero", { answer: 0 }),
			question("q-float", { answer: 2.5 }),
		])
		const evaluations = dataset.scenarios?.map(
			(scenario) => scenario.evaluations[0],
		)
		expect(evaluations?.map((evaluation) => evaluation?.answer)).toEqual([
			"1300",
			"0",
			"2.5",
		])
		for (const evaluation of evaluations ?? [])
			expect(evaluation).toHaveProperty("goldAnswerSourceType", "number")
		expect(dataset.adapterDiagnostics).toEqual({
			entries: [],
			totals: ZERO_TOTALS,
		})
	})

	it("keeps string gold exactly and leaves the source-type key absent", async () => {
		const dataset = await load([question("q", { answer: "  Friday \n" })])
		const evaluation = dataset.scenarios?.[0]?.evaluations[0]
		expect(evaluation?.answer).toBe("  Friday \n")
		expect(Object.hasOwn(evaluation ?? {}, "goldAnswerSourceType")).toBe(false)
	})

	it.each([
		["null", null],
		["boolean", true],
		["array", ["x"]],
		["object", { value: "x" }],
		["blank string", "  "],
		["absent", undefined],
	])("rejects %s gold as question-invalid-gold while siblings survive", async (_label, answer) => {
		const dataset = await load([
			question("q0"),
			question("q1", { answer }),
			question("q2"),
		])
		expect(dataset.scenarios?.map((scenario) => scenario.scenarioId)).toEqual([
			"q0",
			"q2",
		])
		expect(dataset.adapterDiagnostics).toEqual({
			entries: [
				{
					format: "longmemeval",
					questionIndex: 1,
					reason: "question-invalid-gold",
				},
			],
			totals: { ...ZERO_TOTALS, rejectedQuestions: 1 },
		})
	})

	it("rejects a non-finite numeric gold (1e400 parses to Infinity)", async () => {
		const dataset = await loadText(
			JSON.stringify([question("q0"), question("q1")]).replace(
				'"answer q1"',
				"1e400",
			),
		)
		expect(dataset.adapterDiagnostics?.entries).toEqual([
			{
				format: "longmemeval",
				questionIndex: 1,
				reason: "question-invalid-gold",
			},
		])
	})

	it("rejects missing gold on an abstention question too (OPEN-4 A)", async () => {
		const dataset = await load([
			question("q0"),
			question("q1_abs", { answer: undefined }),
		])
		expect(dataset.adapterDiagnostics?.entries).toEqual([
			{
				format: "longmemeval",
				questionIndex: 1,
				reason: "question-invalid-gold",
			},
		])
	})
})

describe("LongMemEval recognition and malformed siblings (decision 2, OPEN-1 A)", () => {
	const malformed: Array<[string, unknown, string]> = [
		["null element", null, "question-not-object"],
		["array element", [1], "question-not-object"],
		[
			"numeric question_id",
			{ ...question("x"), question_id: 7 },
			"question-invalid-id",
		],
		[
			"blank question_id",
			{ ...question("x"), question_id: "  " },
			"question-invalid-id",
		],
		[
			"blank question",
			{ ...question("x"), question: " " },
			"question-invalid-text",
		],
		[
			"non-string question",
			{ ...question("x"), question: 5 },
			"question-invalid-text",
		],
		[
			"missing haystack_sessions",
			{ ...question("x"), haystack_sessions: undefined },
			"question-invalid-sessions",
		],
	]

	it.each(
		malformed.flatMap(([label, value, reason]) =>
			[0, 1, 2].map((position) => [label, position, value, reason] as const),
		),
	)("rejects a malformed %s at position %i as LongMemEval and keeps sibling coordinates", async (_label, position, value, reason) => {
		const document: unknown[] = [question("a"), question("b")]
		document.splice(position, 0, value)
		const dataset = await load(document)
		expect(dataset.datasetKind).toBe("longmemeval")
		expect(dataset.scenarios?.map((scenario) => scenario.scenarioId)).toEqual([
			"a",
			"b",
		])
		expect(dataset.adapterDiagnostics?.entries).toEqual([
			{ format: "longmemeval", questionIndex: position, reason },
		])
		expect(dataset.adapterDiagnostics?.totals).toEqual({
			...ZERO_TOTALS,
			rejectedQuestions: 1,
		})
		expect(Object.hasOwn(dataset, "rejections")).toBe(false)
	})

	it("fails typed with all-rejected and carries the diagnostics when nothing is evaluable", async () => {
		const error = await failure([
			question("a", { question: "" }),
			question("b", { answer: null }),
		])
		expect(error).toBeInstanceOf(BenchmarkAdapterRejectedError)
		expect(error).toMatchObject({
			reason: "all-rejected",
			adapterDiagnostics: {
				entries: [
					{
						format: "longmemeval",
						questionIndex: 0,
						reason: "question-invalid-text",
					},
					{
						format: "longmemeval",
						questionIndex: 1,
						reason: "question-invalid-gold",
					},
				],
				totals: { ...ZERO_TOTALS, rejectedQuestions: 2 },
			},
		})
		expect((error as Error).message).not.toContain("answer a")
	})

	it("fails closed with format-ambiguous when LongMemEval and LoCoMo signatures are mixed", async () => {
		const error = await failure([
			question("a"),
			{ sample_id: "s", conversation: {}, qa: [] },
		])
		expect(error).toBeInstanceOf(BenchmarkAdapterRejectedError)
		expect(error).toMatchObject({ reason: "format-ambiguous" })
		expect(Object.hasOwn(error as object, "adapterDiagnostics")).toBe(false)
	})

	it.each([
		["[null, 5]", [null, 5]],
		["[]", []],
	])("leaves a document with no official signature %s on the unchanged generic path", async (_label, document) => {
		const error = await failure(document)
		expect(error).not.toBeInstanceOf(BenchmarkAdapterRejectedError)
		expect((error as Error).name).toBe("BenchmarkInputRejectedError")
	})

	it("keeps generic conversation documents free of adapterDiagnostics", async () => {
		const dataset = await load([{ turns: [{ role: "user", body: "kept" }] }])
		expect(dataset.datasetKind).toBe("generic")
		expect(Object.hasOwn(dataset, "adapterDiagnostics")).toBe(false)
		expect(dataset.rejections).toEqual([])
	})
})

async function rejectedSecond(overrides: Question) {
	const dataset = await load([question("a"), question("b", overrides)])
	expect(dataset.scenarios?.map((scenario) => scenario.scenarioId)).toEqual([
		"a",
	])
	return dataset.adapterDiagnostics
}

describe("LongMemEval question-level admission (OPEN-5, 6, 8, 9; decision 2)", () => {
	it.each([
		["absent", undefined],
		["not an array", "b-s1"],
		["shorter than the sessions", []],
		["longer than the sessions", ["b-s1", "b-s2"]],
		["a non-string entry", [7]],
		["a blank entry", ["  "]],
	])("rejects haystack_session_ids that are %s, with no session_N fallback (OPEN-6 B)", async (_label, ids) => {
		expect(await rejectedSecond({ haystack_session_ids: ids })).toEqual({
			entries: [
				{
					format: "longmemeval",
					questionIndex: 1,
					reason: "question-invalid-session-ids",
				},
			],
			totals: { ...ZERO_TOTALS, rejectedQuestions: 1 },
		})
	})

	it.each([
		["not an array", "b-s1"],
		["null", null],
		["holding a non-string entry", ["b-s1", 3]],
		["holding a blank entry", ["b-s1", " "]],
	])("rejects answer_session_ids %s as question-invalid-evidence (OPEN-9 B)", async (_label, evidence) => {
		expect(
			(await rejectedSecond({ answer_session_ids: evidence }))?.entries,
		).toEqual([
			{
				format: "longmemeval",
				questionIndex: 1,
				reason: "question-invalid-evidence",
			},
		])
	})

	it("rejects an evidence id that names no session of the question", async () => {
		expect(
			(await rejectedSecond({ answer_session_ids: ["b-s1", "elsewhere"] }))
				?.entries,
		).toEqual([
			{
				format: "longmemeval",
				questionIndex: 1,
				reason: "question-evidence-unresolved",
			},
		])
	})

	it("rejects a question with an empty haystack (OPEN-5 B)", async () => {
		expect(
			(
				await rejectedSecond({
					haystack_session_ids: [],
					haystack_sessions: [],
					answer_session_ids: [],
				})
			)?.entries,
		).toEqual([
			{
				format: "longmemeval",
				questionIndex: 1,
				reason: "question-no-sessions",
			},
		])
	})

	it("rejects a question whose every session is rejected, after the session entries (OPEN-5 B)", async () => {
		expect(
			await rejectedSecond({
				haystack_session_ids: ["b-s1", "b-s2"],
				haystack_sessions: ["text", null],
				answer_session_ids: [],
			}),
		).toEqual({
			entries: [
				{
					format: "longmemeval",
					questionIndex: 1,
					reason: "question-no-sessions",
				},
				{
					format: "longmemeval",
					questionIndex: 1,
					sessionIndex: 0,
					reason: "session-not-array",
				},
				{
					format: "longmemeval",
					questionIndex: 1,
					sessionIndex: 1,
					reason: "session-not-array",
				},
			],
			totals: { ...ZERO_TOTALS, rejectedSessions: 2, rejectedQuestions: 1 },
		})
	})

	it("keeps a question with missing evidence and an abstention with an empty list (OPEN-8 keep, decision 2)", async () => {
		const dataset = await load([
			question("a", { answer_session_ids: undefined }),
			question("b_abs", { answer_session_ids: [] }),
		])
		expect(dataset.adapterDiagnostics?.entries).toEqual([])
		const [missing, abstention] =
			dataset.scenarios?.map((scenario) => scenario.evaluations[0]) ?? []
		expect(missing?.expectedSessionIds).toEqual([])
		expect(abstention?.expectedSessionIds).toEqual([])
		expect(abstention?.officialRetrieval).toEqual({
			evaluator: "longmemeval-main-run",
			eligible: false,
			expectedSessionIds: [],
			expectedTurnIds: [],
			ineligibleReason: "abstention",
		})
	})

	it("keeps release question_type handling (OPEN-7 A)", async () => {
		const dataset = await load([
			question("a", { question_type: 5 }),
			question("b_abs", { question_type: undefined }),
		])
		expect(
			dataset.scenarios?.map(
				(scenario) => scenario.evaluations[0]?.questionType,
			),
		).toEqual([undefined, "abstention"])
	})
})
