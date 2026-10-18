import { describe, expect, it } from "vitest"
import { BenchmarkTimestampRejectedError } from "./benchmark-timestamp.js"
import { countBenchmarkRejections } from "./mongodb-benchmark-dataset.js"
import {
	SESSION_DATE,
	ZERO_TOTALS,
	qa,
	sample,
	turn,
	useLoCoMoLoader,
} from "./locomo-admission.fixture.js"

const { load } = useLoCoMoLoader()

describe("LoCoMo admission of a valid document", () => {
	it("keeps the release shape and reports zero adapter totals", async () => {
		const dataset = await load([sample("s1")])
		expect(dataset.datasetKind).toBe("locomo")
		expect(dataset.adapterDiagnostics).toEqual({
			entries: [],
			totals: ZERO_TOTALS,
		})
		expect(Object.hasOwn(dataset, "rejections")).toBe(false)
		expect(dataset.scenarios).toEqual([
			{
				scenarioId: "s1",
				conversations: [
					{
						conversationId: "s1",
						sessionId: "s1::session_1",
						turns: [
							{
								role: "user",
								body: "fact for s1",
								timestamp: SESSION_DATE,
								metadata: {
									benchmarkDatasetKind: "locomo",
									locomoDialogId: "D1:1",
									locomoSpeaker: "Alice",
								},
							},
							{
								role: "assistant",
								body: "noted",
								timestamp: SESSION_DATE,
								metadata: {
									benchmarkDatasetKind: "locomo",
									locomoDialogId: "D1:2",
									locomoSpeaker: "Bob",
								},
							},
						],
					},
				],
				evaluations: [
					{
						caseId: "s1::qa_1",
						query: "What about s1?",
						expectedSessionIds: ["s1::session_1"],
						expectedDialogIds: ["D1:1"],
						answer: "answer s1",
						questionType: "category-1",
						abstention: false,
						metadata: {
							benchmarkDatasetKind: "locomo",
							locomoCategory: 1,
							evidence: ["D1:1"],
						},
					},
				],
			},
		])
		expect(dataset.evaluations).toEqual(dataset.scenarios?.[0]?.evaluations)
		expect(dataset.conversations).toEqual(dataset.scenarios?.[0]?.conversations)
	})

	it("keeps a numeric gold as its string form with its source type (decision 1)", async () => {
		const dataset = await load([
			sample("s1", { qa: [qa({ answer: 2022, category: 2 })] }),
		])
		expect(dataset.evaluations?.[0]).toMatchObject({
			answer: "2022",
			goldAnswerSourceType: "number",
		})
	})

	it("keeps a string gold exactly, without trimming, and no source type", async () => {
		const dataset = await load([
			sample("s1", { qa: [qa({ answer: "  spaced  " })] }),
		])
		const evaluation = dataset.evaluations?.[0]
		expect(evaluation?.answer).toBe("  spaced  ")
		expect(Object.hasOwn(evaluation ?? {}, "goldAnswerSourceType")).toBe(false)
	})

	it("stores text trimmed and never ingests summaries, observations or other keys", async () => {
		const dataset = await load([
			{
				...sample("s1", {
					conversation: {
						session_1: [turn("Alice", "D1:1", "  padded fact \n")],
						session_1_summary: "zq9 summary",
					},
				}),
				observation: { session_1_observation: ["zq9 observation"] },
				session_summary: { session_1_summary: "zq9 session summary" },
				event_summary: { events_session_1: "zq9 event" },
			},
		])
		expect(dataset.conversations[0]?.turns[0]?.body).toBe("padded fact")
		expect(JSON.stringify(dataset.conversations)).not.toContain("zq9")
	})

	it("keeps the timestamp policy: an absent date is allowed, an invalid one fails closed", async () => {
		const undated = await load([
			sample("s1", { conversation: { session_1_date_time: undefined } }),
		])
		expect(undated.conversations[0]?.turns[0]?.timestamp).toBeUndefined()
		await expect(
			load([sample("s1", { conversation: { session_1_date_time: "soon" } })]),
		).rejects.toBeInstanceOf(BenchmarkTimestampRejectedError)
	})

	it("walks every session and resolves evidence across sessions", async () => {
		const dataset = await load([
			sample("s1", {
				conversation: {
					session_2: [turn("Bob", "D2:1", "second session fact")],
					session_2_date_time: "9:00 am on 9 May, 2023",
				},
				qa: [qa({ evidence: ["D2:1", "D1:1", "D2:1"] })],
			}),
		])
		expect(dataset.conversations.map((c) => c.sessionId)).toEqual([
			"s1::session_1",
			"s1::session_2",
		])
		expect(dataset.evaluations?.[0]).toMatchObject({
			expectedSessionIds: ["s1::session_2", "s1::session_1"],
			expectedDialogIds: ["D2:1", "D1:1"],
		})
	})
})

const at = (
	sessionIndex: number,
	reason: string,
	turnIndex?: number,
): Record<string, unknown> => ({
	format: "locomo",
	sampleIndex: 0,
	sessionIndex,
	...(turnIndex === undefined ? {} : { turnIndex }),
	reason,
})

const atQa = (qaIndex: number, reason: string) => ({
	format: "locomo",
	sampleIndex: 0,
	qaIndex,
	reason,
})

describe("LoCoMo session walk (table 3.2, decision 2, OPEN-15)", () => {
	it("rejects a non-array session and still admits the sessions after it", async () => {
		const dataset = await load([
			sample("s", {
				conversation: {
					session_2: { not: "an array" },
					session_3: [turn("Bob", "D3:1", "later fact")],
				},
			}),
		])
		expect(dataset.adapterDiagnostics?.entries).toEqual([
			at(1, "session-not-array"),
		])
		expect(dataset.adapterDiagnostics?.totals).toEqual({
			...ZERO_TOTALS,
			rejectedSessions: 1,
		})
		expect(dataset.conversations.map((c) => c.sessionId)).toEqual([
			"s::session_1",
			"s::session_3",
		])
	})

	it("rejects a gap instead of stopping at it", async () => {
		const dataset = await load([
			sample("s", {
				conversation: {
					session_4: [turn("Bob", "D4:1", "after the gap")],
				},
			}),
		])
		expect(dataset.adapterDiagnostics?.entries).toEqual([
			at(1, "session-gap"),
			at(2, "session-gap"),
		])
		expect(dataset.conversations.map((c) => c.sessionId)).toEqual([
			"s::session_1",
			"s::session_4",
		])
	})

	it("rejects non-canonical session keys and ignores a date with no session", async () => {
		const dataset = await load([
			sample("s", {
				conversation: {
					session_0: [turn("Bob", "D0:1", "zero")],
					session_01: [turn("Bob", "D01:1", "leading zero")],
					session_9_date_time: "9:00 am on 9 May, 2023",
				},
			}),
		])
		expect(dataset.adapterDiagnostics?.entries).toEqual([
			at(-1, "session-invalid-key"),
			at(0, "session-invalid-key"),
		])
		expect(dataset.adapterDiagnostics?.totals).toEqual({
			...ZERO_TOTALS,
			rejectedSessions: 2,
		})
		expect(dataset.conversations.map((c) => c.sessionId)).toEqual([
			"s::session_1",
		])
	})

	it("records an emptied session as informational only (OPEN-10 B)", async () => {
		const dataset = await load([
			sample("s", {
				conversation: {
					session_2: [],
					session_3: [turn("Bob", "D3:1", "  ")],
				},
			}),
		])
		expect(dataset.adapterDiagnostics?.entries).toEqual([
			at(1, "session-emptied"),
			at(2, "session-emptied"),
			at(2, "skipped-empty-turn", 0),
		])
		expect(dataset.adapterDiagnostics?.totals).toEqual({
			...ZERO_TOTALS,
			emptiedSessions: 2,
			informationalSkips: 1,
		})
		expect(
			countBenchmarkRejections(undefined, dataset.adapterDiagnostics),
		).toEqual({ rejectedTurns: 0, rejectedConversations: 0 })
		expect(dataset.conversations.map((c) => c.sessionId)).toEqual([
			"s::session_1",
		])
	})
})

describe("LoCoMo turn-level admission (table 3.3, decision 3)", () => {
	const withTurn = (bad: unknown, extraQa: unknown[] = []) =>
		sample("s", {
			conversation: {
				session_1: [turn("Alice", "D1:1", "kept fact"), bad],
			},
			qa: [qa(), ...extraQa],
		})

	it.each([
		["not an object", "text", "turn-not-object"],
		["an array", ["Alice", "D1:2", "x"], "turn-not-object"],
		[
			"a non-string speaker",
			{ speaker: 3, dia_id: "D1:2", text: "x" },
			"turn-invalid-speaker",
		],
		["a blank speaker", turn(" ", "D1:2", "x"), "turn-invalid-speaker"],
		[
			"an unknown speaker",
			turn("Mallory", "D1:2", "x"),
			"turn-unknown-speaker",
		],
		[
			"non-string text",
			{ speaker: "Bob", dia_id: "D1:2", text: 5 },
			"turn-content-not-string",
		],
		[
			"missing text",
			{ speaker: "Bob", dia_id: "D1:2" },
			"turn-content-not-string",
		],
		[
			"a blank speaker and non-string text",
			{ speaker: "", text: null },
			"turn-invalid-speaker",
		],
	])("rejects a turn with %s and keeps its siblings", async (_label, bad, reason) => {
		const dataset = await load([withTurn(bad)])
		expect(dataset.adapterDiagnostics?.entries).toEqual([at(0, reason, 1)])
		expect(dataset.adapterDiagnostics?.totals).toEqual({
			...ZERO_TOTALS,
			rejectedTurns: 1,
		})
		expect(
			countBenchmarkRejections(undefined, dataset.adapterDiagnostics),
		).toEqual({ rejectedTurns: 1, rejectedConversations: 0 })
		expect(dataset.conversations[0]?.turns.map((t) => t.body)).toEqual([
			"kept fact",
		])
	})

	it("maps speaker_a to user and speaker_b to assistant, matched trimmed", async () => {
		const dataset = await load([
			sample("s", {
				conversation: {
					speaker_a: " Alice ",
					session_1: [turn(" Alice", "D1:1", "a"), turn("Bob ", "D1:2", "b")],
				},
			}),
		])
		expect(
			dataset.conversations[0]?.turns.map((t) => [
				t.role,
				t.metadata?.locomoSpeaker,
			]),
		).toEqual([
			["user", "Alice"],
			["assistant", "Bob"],
		])
	})

	it("skips an empty turn no QA references, even beside an evidence turn (OPEN-17 A)", async () => {
		const dataset = await load([withTurn(turn("Bob", "D1:2", " \n "))])
		expect(dataset.adapterDiagnostics?.entries).toEqual([
			at(0, "skipped-empty-turn", 1),
		])
		expect(dataset.adapterDiagnostics?.totals).toEqual({
			...ZERO_TOTALS,
			informationalSkips: 1,
		})
		expect(dataset.evaluations).toHaveLength(1)
	})

	it("rejects an empty evidence turn and every QA item naming it (OPEN-13 A, OPEN-26 (3))", async () => {
		const dataset = await load([
			withTurn(turn("Bob", "D1:2", ""), [
				qa({ evidence: ["D1:2"] }),
				qa({ evidence: ["D1:1; D1:2"] }),
			]),
		])
		expect(dataset.adapterDiagnostics?.entries).toEqual([
			at(0, "turn-empty-evidence", 1),
			atQa(1, "qa-evidence-unresolved"),
			atQa(2, "qa-evidence-unresolved"),
		])
		expect(dataset.adapterDiagnostics?.totals).toEqual({
			...ZERO_TOTALS,
			rejectedTurns: 1,
			rejectedQaItems: 2,
		})
		expect(
			countBenchmarkRejections(undefined, dataset.adapterDiagnostics),
		).toEqual({ rejectedTurns: 1, rejectedConversations: 2 })
		expect(dataset.evaluations?.map((e) => e.caseId)).toEqual(["s::qa_1"])
	})

	it("treats a reference from a rejected QA item as evidence, whatever its fate (OPEN-16 A)", async () => {
		const dataset = await load([
			withTurn(turn("Bob", "D1:2", ""), [
				qa({ question: " ", evidence: ["D1:2"] }),
			]),
		])
		expect(dataset.adapterDiagnostics?.entries).toEqual([
			at(0, "turn-empty-evidence", 1),
			atQa(1, "qa-invalid-question"),
		])
	})

	it("rejects every QA item whose evidence names a rejected turn", async () => {
		const dataset = await load([
			withTurn(turn("Mallory", "D1:2", "said by a stranger"), [
				qa({ evidence: ["D1:2"] }),
			]),
		])
		expect(dataset.adapterDiagnostics?.entries).toEqual([
			at(0, "turn-unknown-speaker", 1),
			atQa(1, "qa-evidence-unresolved"),
		])
	})

	it("admits a turn with a missing or blank dia_id that no QA can reference (OPEN-18 A)", async () => {
		const dataset = await load([
			withTurn({ speaker: "Bob", text: "no id", dia_id: " " }),
		])
		expect(dataset.adapterDiagnostics?.totals).toEqual(ZERO_TOTALS)
		expect(dataset.conversations[0]?.turns[1]).toMatchObject({
			body: "no id",
			metadata: { locomoDialogId: undefined },
		})
	})

	it("ignores image and query fields, which are never ingested (OPEN-19 A)", async () => {
		const dataset = await load([
			withTurn({
				...turn("Bob", "D1:2", "photo turn"),
				img_url: ["https://example.invalid/x.png"],
				blip_caption: "zq9 caption",
				query: "zq9 query",
			}),
		])
		expect(dataset.adapterDiagnostics?.totals).toEqual(ZERO_TOTALS)
		expect(JSON.stringify(dataset.conversations)).not.toMatch(
			/zq9|example\.invalid/,
		)
	})
})

describe("LoCoMo sample-level rejections (table 3.1, OPEN-14 A)", () => {
	const reject = (sampleIndex: number, reason: string) => ({
		format: "locomo",
		sampleIndex,
		reason,
	})

	it.each([
		["not an object", null, "sample-not-object"],
		["an array", [], "sample-not-object"],
		["a non-string id", { ...sample("x"), sample_id: 7 }, "sample-invalid-id"],
		["a blank id", { ...sample("x"), sample_id: "  " }, "sample-invalid-id"],
		[
			"a non-object conversation",
			{ ...sample("x"), conversation: [] },
			"sample-invalid-conversation",
		],
		["a non-array qa", { ...sample("x"), qa: {} }, "sample-invalid-qa"],
		[
			"a missing speaker",
			sample("x", { conversation: { speaker_b: undefined } }),
			"sample-invalid-speakers",
		],
		[
			"a blank speaker",
			sample("x", { conversation: { speaker_a: " " } }),
			"sample-invalid-speakers",
		],
		[
			"equal speakers after trimming",
			sample("x", { conversation: { speaker_b: " Alice " } }),
			"sample-invalid-speakers",
		],
	])("rejects a sample with %s and keeps its siblings at every position", async (_label, broken, reason) => {
		for (const position of [0, 1, 2]) {
			const document: unknown[] = [sample("a"), sample("b")]
			document.splice(position, 0, broken)
			const dataset = await load(document)
			expect(dataset.datasetKind).toBe("locomo")
			expect(dataset.adapterDiagnostics?.entries).toEqual([
				reject(position, reason),
			])
			expect(dataset.adapterDiagnostics?.totals).toEqual({
				...ZERO_TOTALS,
				rejectedQuestions: 1,
			})
			expect(dataset.scenarios?.map((s) => s.scenarioId)).toEqual(["a", "b"])
		}
	})

	it("records only the first failure in table row order", async () => {
		const dataset = await load([
			sample("a"),
			{ sample_id: " ", conversation: [], qa: {} },
		])
		expect(dataset.adapterDiagnostics?.entries).toEqual([
			reject(1, "sample-invalid-id"),
		])
	})

	it("inspects no descendant of a rejected sample (OPEN-26 (2))", async () => {
		const dataset = await load([
			sample("a"),
			sample("b", {
				conversation: {
					speaker_b: "Alice",
					session_1: [null, turn("Mallory", "D1:1", "")],
					session_3: "not a session",
				},
				qa: [null, qa({ evidence: ["D9:9"] })],
			}),
		])
		expect(dataset.adapterDiagnostics?.entries).toEqual([
			reject(1, "sample-invalid-speakers"),
		])
	})

	it("keeps a sample with a literal empty qa for ingest only, with no diagnostic (OPEN-3 A)", async () => {
		const dataset = await load([sample("a"), sample("b", { qa: [] })])
		expect(dataset.adapterDiagnostics?.totals).toEqual(ZERO_TOTALS)
		expect(dataset.scenarios?.[1]).toMatchObject({
			scenarioId: "b",
			evaluations: [],
		})
		expect(dataset.scenarios?.[1]?.conversations).toHaveLength(1)
	})
})
