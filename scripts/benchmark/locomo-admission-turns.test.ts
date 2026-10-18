import { describe, expect, it } from "vitest"
import {
	ZERO_TOTALS,
	qa,
	sample,
	turn,
	useLoCoMoLoader,
} from "./locomo-admission.fixture.js"
import { countBenchmarkRejections } from "./mongodb-benchmark-dataset.js"

// Turn rows of table 3.3 with decision 3 and OPEN-13, -16 to -19 (resolutions r3).
const { load } = useLoCoMoLoader()

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
