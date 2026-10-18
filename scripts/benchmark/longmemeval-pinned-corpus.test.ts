import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { describe, expect, it } from "vitest"
import { loadBenchmarkDataset } from "./mongodb-benchmark-dataset.js"

// Ticket #94 acceptance on the pinned official LongMemEval-S file. Expected
// values come from shape table 1197 section 7 (measured on the raw file and
// cross-checked against the v2.2.5 loader), not from this implementation.
const PINNED =
	"/Users/rom.iluz/Dev/memongo/tmp/team/run/worktree-A/benchmarks/data/longmemeval_s_cleaned.json"
const PINNED_SHA256 =
	"d6f21ea9d60a0d56f34a05b609c79c88a451d2ae03597821ea3d5a9678c3a442"
const present = existsSync(PINNED)

const SKIPS: Array<[number, number, number]> = [
	[79, 12, 8],
	[92, 40, 3],
	[92, 40, 4],
	[92, 40, 7],
	[92, 40, 8],
	[290, 22, 0],
	[327, 26, 16],
	[365, 9, 0],
	[413, 7, 2],
	[413, 7, 4],
	[413, 7, 6],
	[485, 19, 8],
]

const SECOND_OCCURRENCES: Array<[number, number, string]> = [
	[3, 47, "07b7a667_1"],
	[4, 26, "d5d1f9c4"],
	[44, 49, "sharegpt_SYbLHTK_0"],
	[91, 34, "334ab2f1"],
	[140, 12, "sharegpt_YCfhENU_0"],
	[188, 5, "sharegpt_fgnzLtE_0"],
	[218, 32, "sharegpt_z7Ogy29_0"],
	[295, 27, "sharegpt_81riySf_0"],
	[308, 19, "8fcaf3a9_2"],
	[364, 27, "8c64ce26_3"],
	[397, 41, "sharegpt_vyHqfrX_0"],
	[424, 44, "6b8e8bb3_1"],
	[462, 45, "sharegpt_qktLFWS_21"],
]

describe.skipIf(!present)(
	present
		? "pinned LongMemEval-S corpus admission (#94)"
		: `pinned LongMemEval-S corpus admission (#94): SKIPPED, corpus absent at ${PINNED}`,
	() => {
		it("loads 32 numeric gold, 13 second occurrences, 12 informational skips and no rejection", async () => {
			const bytes = await readFile(PINNED)
			expect(createHash("sha256").update(bytes).digest("hex")).toBe(
				PINNED_SHA256,
			)
			const raw = JSON.parse(bytes.toString("utf8")) as Array<{
				answer: unknown
			}>
			const dataset = await loadBenchmarkDataset(PINNED)
			const scenarios = dataset.scenarios ?? []

			expect(scenarios).toHaveLength(500)
			expect(dataset.failedLines).toBe(0)
			expect(Object.hasOwn(dataset, "rejections")).toBe(false)
			expect(dataset.adapterDiagnostics?.totals).toEqual({
				rejectedTurns: 0,
				rejectedSessions: 0,
				emptiedSessions: 0,
				rejectedQuestions: 0,
				rejectedQaItems: 0,
				informationalSkips: 12,
			})
			expect(dataset.adapterDiagnostics?.entries).toEqual(
				SKIPS.map(([questionIndex, sessionIndex, turnIndex]) => ({
					format: "longmemeval",
					questionIndex,
					sessionIndex,
					turnIndex,
					reason: "skipped-empty-turn",
				})),
			)

			const numeric = scenarios.flatMap((scenario, index) => {
				const evaluation = scenario.evaluations[0]
				return evaluation && Object.hasOwn(evaluation, "goldAnswerSourceType")
					? [{ index, evaluation }]
					: []
			})
			expect(numeric).toHaveLength(32)
			for (const { index, evaluation } of numeric) {
				const gold = raw[index]?.answer
				expect(typeof gold).toBe("number")
				expect(evaluation).toMatchObject({
					answer: String(gold),
					goldAnswerSourceType: "number",
				})
			}
			const stringGold = scenarios.filter(
				(scenario) =>
					typeof scenario.evaluations[0]?.answer === "string" &&
					!Object.hasOwn(scenario.evaluations[0], "goldAnswerSourceType"),
			)
			expect(stringGold).toHaveLength(468)

			const occurrenceIds = scenarios.flatMap((scenario) =>
				scenario.conversations
					.map((conversation) => conversation.sessionId ?? "")
					.filter((sessionId) => sessionId.includes("::occ")),
			)
			expect(occurrenceIds).toHaveLength(13)
			for (const [
				questionIndex,
				sessionIndex,
				original,
			] of SECOND_OCCURRENCES) {
				const scenario = scenarios[questionIndex]
				const conversation = scenario?.conversations[sessionIndex]
				expect(conversation?.sessionId).toBe(
					`${scenario?.scenarioId}::${original}::occ2`,
				)
				expect(
					conversation?.turns.every(
						(turn) => turn.metadata?.benchmarkOriginalSessionId === original,
					),
				).toBe(true)
			}
		})
	},
)
