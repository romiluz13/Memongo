import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { describe, expect, it, vi } from "vitest"
import {
	ingestBenchmarkDataset,
	importConversationDataset,
	loadBenchmarkDataset,
} from "./mongodb-benchmark-harness.js"

describe("benchmark harness", () => {
	it("loads a benchmark conversation dataset from JSON", async () => {
		const dir = await mkdtemp(path.join(os.tmpdir(), "memongo-bench-"))
		const datasetPath = path.join(dir, "dataset.json")
		try {
			await writeFile(
				datasetPath,
				JSON.stringify({
					name: "LongMemEval sample",
					conversations: [
						{
							conversationId: "conv-1",
							scope: "workspace",
							turns: [
								{
									role: "user",
									body: "Please remember that Phoenix ships on Friday.",
								},
								{
									role: "assistant",
									body: "Got it, Phoenix ships on Friday.",
								},
							],
						},
					],
				}),
			)

			const dataset = await loadBenchmarkDataset(datasetPath)

			expect(dataset.name).toBe("LongMemEval sample")
			expect(dataset.conversations).toHaveLength(1)
			expect(dataset.conversations[0]?.turns).toHaveLength(2)
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	})

	it("imports conversation datasets through the canonical write callback without benchmark metadata", async () => {
		const dir = await mkdtemp(path.join(os.tmpdir(), "memongo-import-"))
		const datasetPath = path.join(dir, "history.json")
		const writeTurn = vi.fn(async () => undefined)
		try {
			await writeFile(
				datasetPath,
				JSON.stringify({
					conversations: [
						{
							conversationId: "conv-7",
							sessionId: "sess-7",
							turns: [
								{
									role: "user",
									body: "We agreed to deploy Atlas Local benchmarks nightly.",
									timestamp: "2026-04-11T07:00:00.000Z",
								},
							],
						},
					],
				}),
			)

			const result = await importConversationDataset({
				datasetPath,
				scope: "agent",
				writeTurn,
			})

			expect(result.datasetKind).toBe("generic")
			expect(result.conversationsImported).toBe(1)
			expect(result.turnsImported).toBe(1)
			expect(writeTurn).toHaveBeenCalledOnce()
			expect(writeTurn).toHaveBeenCalledWith(
				expect.objectContaining({
					sessionId: "sess-7",
					scope: "agent",
					timestamp: new Date("2026-04-11T07:00:00.000Z"),
					metadata: expect.objectContaining({
						importConversationId: "conv-7",
						importDataset: "history.json",
						importDatasetKind: "generic",
					}),
				}),
			)
			expect(
				(writeTurn.mock.calls[0]?.[0] as { metadata?: Record<string, unknown> })
					.metadata,
			).not.toHaveProperty("benchmarkDataset")
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	})

	it("normalizes LongMemEval sessions and evaluation cases", async () => {
		const dir = await mkdtemp(path.join(os.tmpdir(), "memongo-bench-"))
		const datasetPath = path.join(dir, "longmemeval.json")
		try {
			await writeFile(
				datasetPath,
				JSON.stringify([
					{
						question_id: "q1",
						question_type: "single-session",
						question: "When is the Phoenix launch?",
						answer: "Friday",
						question_date: "2026-04-01",
						haystack_session_ids: ["s1"],
						haystack_dates: ["2026-03-31T12:00:00.000Z"],
						haystack_sessions: [
							[
								{
									role: "user",
									content: "Reminder: Phoenix launches on Friday.",
									has_answer: true,
								},
							],
						],
						answer_session_ids: ["s1"],
					},
				]),
			)

			const dataset = await loadBenchmarkDataset(datasetPath)

			expect(dataset.datasetKind).toBe("longmemeval")
			expect(dataset.scenarios).toHaveLength(1)
			expect(dataset.scenarios?.[0]?.conversations[0]?.sessionId).toBe("q1::s1")
			expect(dataset.scenarios?.[0]?.evaluations[0]).toEqual(
				expect.objectContaining({
					caseId: "q1",
					expectedSessionIds: ["q1::s1"],
					expectedTurnIds: ["q1::s1::turn_1"],
					questionType: "single-session",
					abstention: false,
				}),
			)
			expect(
				dataset.scenarios?.[0]?.conversations[0]?.turns[0]?.metadata,
			).toEqual(
				expect.objectContaining({
					benchmarkTurnId: "q1::s1::turn_1",
					benchmarkHasAnswer: true,
				}),
			)
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	})

	it("normalizes LoCoMo conversations and evidence-backed evaluations", async () => {
		const dir = await mkdtemp(path.join(os.tmpdir(), "memongo-bench-"))
		const datasetPath = path.join(dir, "locomo.json")
		try {
			await writeFile(
				datasetPath,
				JSON.stringify([
					{
						sample_id: "sample-1",
						conversation: {
							speaker_a: "Alice",
							speaker_b: "Bob",
							session_1_date_time: "2026-04-01T10:00:00.000Z",
							session_1: [
								{
									speaker: "Alice",
									dia_id: "D1:1",
									text: "Let’s meet next Tuesday.",
								},
								{
									speaker: "Bob",
									dia_id: "D1:2",
									text: "Tuesday works for me.",
								},
							],
						},
						qa: [
							{
								question: "When are they meeting?",
								answer: "Next Tuesday",
								category: 2,
								evidence: ["D1:1"],
							},
						],
					},
				]),
			)

			const dataset = await loadBenchmarkDataset(datasetPath)

			expect(dataset.datasetKind).toBe("locomo")
			expect(dataset.scenarios).toHaveLength(1)
			expect(dataset.scenarios?.[0]?.conversations[0]?.turns).toHaveLength(2)
			expect(dataset.scenarios?.[0]?.evaluations[0]).toEqual(
				expect.objectContaining({
					caseId: "sample-1::qa_1",
					expectedSessionIds: ["sample-1::session_1"],
					expectedDialogIds: ["D1:1"],
					questionType: "category-2",
					abstention: false,
				}),
			)
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	})

	it("replays benchmark turns through the canonical write callback", async () => {
		const dir = await mkdtemp(path.join(os.tmpdir(), "memongo-bench-"))
		const datasetPath = path.join(dir, "dataset.jsonl")
		const writeTurn = vi.fn(async () => undefined)
		try {
			await writeFile(
				datasetPath,
				`${JSON.stringify({
					conversationId: "conv-1",
					turns: [
						{
							role: "user",
							body: "I decided to deploy on Friday.",
							timestamp: "2026-04-09T09:00:00.000Z",
						},
						{
							role: "assistant",
							body: "Friday deployment noted.",
						},
					],
				})}\n`,
			)

			const result = await ingestBenchmarkDataset({
				datasetPath,
				scope: "agent",
				writeTurn,
			})

			expect(result.conversationsIngested).toBe(1)
			expect(result.turnsIngested).toBe(2)
			expect(result.failedLines).toBe(0)
			expect(result.failedTurns).toBe(0)
			expect(writeTurn).toHaveBeenCalledTimes(2)
			expect(writeTurn).toHaveBeenNthCalledWith(
				1,
				expect.objectContaining({
					role: "user",
					body: "I decided to deploy on Friday.",
					sessionId: "conv-1",
					scope: "agent",
					timestamp: new Date("2026-04-09T09:00:00.000Z"),
					metadata: expect.objectContaining({
						benchmarkConversationId: "conv-1",
						benchmarkDataset: "dataset.jsonl",
					}),
				}),
			)
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	})

	it("skips malformed JSONL lines and tracks failedLines", async () => {
		const dir = await mkdtemp(path.join(os.tmpdir(), "memongo-bench-"))
		const datasetPath = path.join(dir, "dataset.jsonl")
		try {
			await writeFile(
				datasetPath,
				[
					JSON.stringify({
						conversationId: "conv-1",
						turns: [{ role: "user", body: "First line is fine." }],
					}),
					"{ not valid json",
				].join("\n"),
			)

			const dataset = await loadBenchmarkDataset(datasetPath)
			expect(dataset.conversations).toHaveLength(1)
			expect(dataset.failedLines).toBe(1)
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	})

	it("continues after failed writes and tracks failedTurns", async () => {
		const dir = await mkdtemp(path.join(os.tmpdir(), "memongo-bench-"))
		const datasetPath = path.join(dir, "dataset.json")
		try {
			await writeFile(
				datasetPath,
				JSON.stringify({
					conversations: [
						{
							conversationId: "conv-7",
							turns: [{ role: "user", body: "Broken write" }],
						},
					],
				}),
			)

			const result = await ingestBenchmarkDataset({
				datasetPath,
				writeTurn: async () => {
					throw new Error("write failed")
				},
			})
			expect(result.conversationsIngested).toBe(1)
			expect(result.turnsIngested).toBe(0)
			expect(result.failedTurns).toBe(1)
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	})

	it("rejects benchmark datasets outside allowed roots", async () => {
		const allowedDir = await mkdtemp(
			path.join(os.tmpdir(), "memongo-bench-allow-"),
		)
		const outsideDir = await mkdtemp(
			path.join(os.tmpdir(), "memongo-bench-outside-"),
		)
		const datasetPath = path.join(outsideDir, "dataset.jsonl")
		try {
			await writeFile(
				datasetPath,
				JSON.stringify({
					conversationId: "conv-1",
					turns: [{ role: "user", body: "outside root" }],
				}),
			)

			await expect(
				loadBenchmarkDataset(datasetPath, {
					allowedRoots: [allowedDir],
				}),
			).rejects.toThrow(
				"datasetPath must resolve inside the workspace or configured benchmark dataset directory",
			)
		} finally {
			await rm(allowedDir, { recursive: true, force: true })
			await rm(outsideDir, { recursive: true, force: true })
		}
	})
})
