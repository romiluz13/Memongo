import { describe, expect, it, vi } from "vitest"
import {
	type BenchmarkAdapterFailureReason,
	BenchmarkAdapterRejectedError,
} from "./benchmark-adapter-diagnostics.js"
import {
	qa,
	sample,
	turn,
	useLoCoMoLoader,
} from "./locomo-admission.fixture.js"
import { ingestBenchmarkDataset } from "./mongodb-benchmark-harness.js"

// Fail-closed LoCoMo admission (decisions 2 and 6, OPEN-2 B, OPEN-26 (1),
// 1206 Q5): each guard throws a typed, value-free error before the first write.
const { datasetPath } = useLoCoMoLoader()

const SECRET = "zq9-locomo-canary"

/** Loads through the real ingest path and proves the guard fired before any write. */
async function expectZeroWriteFailure(
	document: unknown,
	reason: BenchmarkAdapterFailureReason,
) {
	const writeTurn = vi.fn(async () => {})
	const error = await ingestBenchmarkDataset({
		datasetPath: await datasetPath(document),
		writeTurn,
	}).then(
		() => undefined,
		(caught: unknown) => caught,
	)
	expect(error).toBeInstanceOf(BenchmarkAdapterRejectedError)
	expect(error).toMatchObject({ reason })
	expect((error as Error).message).not.toContain(SECRET)
	expect(writeTurn).not.toHaveBeenCalled()
	return error as BenchmarkAdapterRejectedError
}

const secretSample = (id: string, overrides: Record<string, unknown> = {}) =>
	sample(id, {
		qa: [qa({ question: `${SECRET} question`, answer: `${SECRET} gold` })],
		...overrides,
	})

const secretTurn = (speaker: string, diaId: string) =>
	turn(speaker, diaId, `${SECRET} text`)

describe("LoCoMo identity preflight is zero-write (decision 6, 1206 Q5)", () => {
	it("fails on a duplicate sample id, compared trimmed", async () => {
		const error = await expectZeroWriteFailure(
			[secretSample("a"), secretSample("b"), secretSample(" a ")],
			"duplicate-sample-id",
		)
		expect(Object.hasOwn(error, "adapterDiagnostics")).toBe(false)
	})

	it("fails on a duplicate dia_id within one sample, across sessions and trimmed", async () => {
		await expectZeroWriteFailure(
			[
				secretSample("a", {
					conversation: {
						session_2: [secretTurn("Bob", " D1:1 ")],
						session_2_date_time: "9:00 am on 9 May, 2023",
					},
				}),
			],
			"duplicate-dialog-id",
		)
	})

	it("allows the same dia_id in different samples", async () => {
		const writeTurn = vi.fn(async () => {})
		const result = await ingestBenchmarkDataset({
			datasetPath: await datasetPath([secretSample("a"), secretSample("b")]),
			writeTurn,
		})
		expect(result.rejectedConversations).toBe(0)
		expect(writeTurn).toHaveBeenCalledTimes(4)
	})

	describe("runs before ordinary rejection and cannot hide under it (OPEN-26 (1))", () => {
		it("finds a duplicate sample id on a sample rejected for its shape", async () => {
			await expectZeroWriteFailure(
				[
					secretSample("a"),
					{ ...secretSample("a"), conversation: SECRET },
					secretSample("b"),
				],
				"duplicate-sample-id",
			)
		})

		it("finds a duplicate dia_id inside a malformed sample", async () => {
			await expectZeroWriteFailure(
				[
					secretSample("ok"),
					secretSample("bad", {
						qa: SECRET,
						conversation: {
							speaker_b: "Alice",
							session_1: [
								secretTurn("Alice", "D1:1"),
								secretTurn("Alice", "D1:1"),
							],
						},
					}),
				],
				"duplicate-dialog-id",
			)
		})

		it("finds a duplicate dia_id under a sample with a blank id", async () => {
			await expectZeroWriteFailure(
				[
					secretSample("ok"),
					{
						...secretSample("x", {
							conversation: {
								session_1: [
									secretTurn("Alice", "D1:1"),
									secretTurn("Bob", "D1:1"),
								],
							},
						}),
						sample_id: " ",
					},
				],
				"duplicate-dialog-id",
			)
		})

		it("finds a duplicate dia_id across rejected sessions and turns", async () => {
			await expectZeroWriteFailure(
				[
					secretSample("a", {
						conversation: {
							session_01: [secretTurn("Mallory", "D1:1")],
						},
					}),
				],
				"duplicate-dialog-id",
			)
			await expectZeroWriteFailure(
				[
					secretSample("a", {
						conversation: {
							session_1: [
								secretTurn("Alice", "D1:1"),
								{ speaker: 7, dia_id: "D1:1", text: SECRET },
							],
						},
					}),
				],
				"duplicate-dialog-id",
			)
		})

		it("wins over an all-rejected document", async () => {
			await expectZeroWriteFailure(
				[
					secretSample("a", { conversation: { speaker_b: "Alice" } }),
					secretSample("a", { conversation: { speaker_b: "Alice" } }),
				],
				"duplicate-sample-id",
			)
		})
	})

	it("fails closed on a document holding both official signatures (OPEN-1 A)", async () => {
		await expectZeroWriteFailure(
			[
				secretSample("a"),
				{ question_id: "q", haystack_sessions: [], question: SECRET },
			],
			"format-ambiguous",
		)
	})
})

describe("LoCoMo all-rejected is a typed zero-write failure (decision 2, OPEN-2 B)", () => {
	it("fails when every sample is rejected, carrying the diagnostics", async () => {
		const error = await expectZeroWriteFailure(
			[
				{ ...secretSample("a"), sample_id: " " },
				{ ...secretSample("b"), qa: SECRET },
			],
			"all-rejected",
		)
		expect(error.adapterDiagnostics?.entries).toEqual([
			{ format: "locomo", sampleIndex: 0, reason: "sample-invalid-id" },
			{ format: "locomo", sampleIndex: 1, reason: "sample-invalid-qa" },
		])
		expect(error.adapterDiagnostics?.totals.rejectedQuestions).toBe(2)
	})

	it("fails when samples survive but no evaluation case is admitted", async () => {
		const error = await expectZeroWriteFailure(
			[
				secretSample("a", { qa: [] }),
				secretSample("b", { qa: [qa({ question: " " })] }),
			],
			"all-rejected",
		)
		expect(error.adapterDiagnostics?.entries).toEqual([
			{
				format: "locomo",
				sampleIndex: 1,
				qaIndex: 0,
				reason: "qa-invalid-question",
			},
		])
	})
})
