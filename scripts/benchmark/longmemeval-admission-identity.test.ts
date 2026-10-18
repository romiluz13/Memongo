import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
	type BenchmarkAdapterFailureReason,
	BenchmarkAdapterRejectedError,
} from "./benchmark-adapter-diagnostics.js"
import { ingestBenchmarkDataset } from "./mongodb-benchmark-harness.js"

// Fail-closed admission (decision 6, OPEN-1 A, OPEN-2 B, OPEN-26 (1)): each
// guard throws a typed, value-free error before the first write.
let dir = ""
beforeEach(async () => {
	dir = await mkdtemp(path.join(os.tmpdir(), "longmemeval-identity-"))
})
afterEach(async () => {
	await rm(dir, { recursive: true, force: true })
})

const SECRET = "zq9-canary"

function question(id: string, overrides: Record<string, unknown> = {}) {
	return {
		question_id: id,
		question: `${SECRET} question ${id}`,
		answer: `${SECRET} gold`,
		haystack_session_ids: [`${id}-s1`],
		haystack_sessions: [
			[{ role: "user", content: `${SECRET} fact`, has_answer: true }],
		],
		answer_session_ids: [`${id}-s1`],
		...overrides,
	}
}

const turns = (...contents: string[]) =>
	contents.map((content) => ({ role: "user", content }))

/** Loads through the real ingest path and proves the guard fired before any write. */
async function expectZeroWriteFailure(
	document: unknown,
	reason: BenchmarkAdapterFailureReason,
) {
	const datasetPath = path.join(dir, "longmemeval.json")
	await writeFile(datasetPath, JSON.stringify(document))
	const writeTurn = vi.fn(async () => {})
	const error = await ingestBenchmarkDataset({ datasetPath, writeTurn }).then(
		() => undefined,
		(caught: unknown) => caught,
	)
	expect(error).toBeInstanceOf(BenchmarkAdapterRejectedError)
	expect(error).toMatchObject({ reason })
	expect((error as Error).message).not.toContain(SECRET)
	expect(writeTurn).not.toHaveBeenCalled()
	return error as BenchmarkAdapterRejectedError
}

describe("LongMemEval identity preflight is zero-write", () => {
	it("fails on a duplicate question id, compared trimmed", async () => {
		await expectZeroWriteFailure(
			[question("q"), question("other"), question(" q ")],
			"duplicate-question-id",
		)
	})

	it("fails on a repeated session whose normalized turns differ", async () => {
		await expectZeroWriteFailure(
			[
				question("q", {
					haystack_session_ids: ["s", "q-s1", "s"],
					haystack_sessions: [
						turns("same", "words"),
						[{ role: "user", content: "fact", has_answer: true }],
						turns("same", "changed"),
					],
					answer_session_ids: ["q-s1"],
				}),
			],
			"duplicate-session-mismatch",
		)
	})

	it.each([
		[
			"answer-target annotation",
			[{ role: "user", content: "same", has_answer: true }],
		],
		["role", [{ role: "assistant", content: "same" }]],
		[
			"a skipped empty turn (OPEN-11 A)",
			[
				{ role: "user", content: "same" },
				{ role: "user", content: " " },
			],
		],
	])("treats a difference in %s as a mismatch", async (_label, second) => {
		await expectZeroWriteFailure(
			[
				question("q", {
					haystack_session_ids: ["s", "s"],
					haystack_sessions: [turns("same"), second],
					answer_session_ids: [],
				}),
			],
			"duplicate-session-mismatch",
		)
	})

	it("fails on the canonical generated-id collision [s, s, s::occ2]", async () => {
		await expectZeroWriteFailure(
			[
				question("q", {
					haystack_session_ids: ["s", "s", "s::occ2"],
					haystack_sessions: [turns("same"), turns("same"), turns("other")],
					answer_session_ids: [],
				}),
			],
			"generated-id-collision",
		)
	})

	it("fails on a generated session id shared across questions", async () => {
		await expectZeroWriteFailure(
			[
				question("a", {
					haystack_session_ids: ["b::c"],
					answer_session_ids: [],
				}),
				question("a::b", {
					haystack_session_ids: ["c"],
					answer_session_ids: [],
				}),
			],
			"generated-id-collision",
		)
	})

	it("runs before ordinary rejection: a malformed parent cannot hide a session mismatch (OPEN-26)", async () => {
		await expectZeroWriteFailure(
			[
				question("q0", {
					answer: null,
					haystack_session_ids: ["s", "s"],
					haystack_sessions: [turns("same"), turns("different")],
					answer_session_ids: [],
				}),
				question("q1"),
			],
			"duplicate-session-mismatch",
		)
	})

	it("runs before ordinary rejection: a malformed duplicate still fails the load (OPEN-26)", async () => {
		await expectZeroWriteFailure(
			[question("q"), question("q", { question: "" })],
			"duplicate-question-id",
		)
	})

	it("fails closed on a mixed-format document", async () => {
		await expectZeroWriteFailure(
			[question("q"), { sample_id: "s", conversation: {}, qa: [] }],
			"format-ambiguous",
		)
	})

	it("fails closed when every question is rejected, carrying the diagnostics", async () => {
		const error = await expectZeroWriteFailure(
			[question("q", { answer: false })],
			"all-rejected",
		)
		expect(error.adapterDiagnostics?.totals.rejectedQuestions).toBe(1)
	})

	it("admits projection-equal occurrences that differ only in date or structurally invalid turns", async () => {
		const datasetPath = path.join(dir, "ok.json")
		await writeFile(
			datasetPath,
			JSON.stringify([
				question("q", {
					haystack_session_ids: ["s", "s"],
					haystack_dates: ["2023/05/20 (Sat) 02:21", "2023/05/22 (Mon) 04:00"],
					haystack_sessions: [turns("same"), [...turns("same"), null]],
					answer_session_ids: [],
				}),
			]),
		)
		const writeTurn = vi.fn(async () => {})
		const receipt = await ingestBenchmarkDataset({ datasetPath, writeTurn })
		expect(writeTurn).toHaveBeenCalledTimes(2)
		expect(receipt).toMatchObject({
			rejectedTurns: 1,
			rejectedConversations: 0,
		})
	})
})
