import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { describe, expect, it } from "vitest"
import {
	countBenchmarkRejections,
	loadBenchmarkDataset,
} from "./mongodb-benchmark-dataset.js"

// Ticket #95 acceptance on the official LoCoMo file (snap-research/LoCoMo
// cbfbc1d). Expected values come from Sol's measurements (1202
// locomo-measurements.json, locomo-multiref-coordinates.json) and an
// independent raw-file scan, not from this implementation.
const PINNED =
	"/Users/rom.iluz/.local/state/memongo-team/tasks/1202/locomo10.json"
const PINNED_SHA256 =
	"79fa87e90f04081343b8c8debecb80a9a6842b76a7aa537dc9fdf651ea698ff4"
const present = existsSync(PINNED)

/** [sampleIndex, qaIndex] of the literal evidence references that resolve to no dia_id. */
const UNRESOLVED: Array<[number, number]> = [
	[3, 58],
	[3, 88],
	[4, 18],
	[6, 38],
	[9, 69],
]
/** OPEN-25 rescues: [sampleIndex, qaIndex, distinct tokens]. */
const RESCUED: Array<[number, number, number]> = [
	[0, 37, 2],
	[8, 31, 3],
	[8, 38, 4],
	[8, 46, 4],
]
/** Category-3 items with an empty evidence list (OPEN-8). */
const NO_EVIDENCE: Array<[number, number]> = [
	[0, 30],
	[0, 46],
	[9, 39],
	[9, 42],
]

describe.skipIf(!present)(
	present
		? "pinned official LoCoMo file admission (#95)"
		: `pinned official LoCoMo file admission (#95): SKIPPED, file absent at ${PINNED}`,
	() => {
		it("admits 1981 of 1986 QA items with 5 unresolved-evidence rejections and no other diagnostic", async () => {
			const bytes = await readFile(PINNED)
			expect(createHash("sha256").update(bytes).digest("hex")).toBe(
				PINNED_SHA256,
			)
			const raw = JSON.parse(bytes.toString("utf8")) as Array<{
				sample_id: string
			}>
			const caseId = (sampleIndex: number, qaIndex: number) =>
				`${raw[sampleIndex]?.sample_id}::qa_${qaIndex + 1}`
			const dataset = await loadBenchmarkDataset(PINNED)
			const evaluations = dataset.evaluations ?? []
			const byCase = new Map(evaluations.map((e) => [e.caseId, e]))

			expect(dataset.datasetKind).toBe("locomo")
			expect(dataset.scenarios).toHaveLength(10)
			expect(dataset.adapterDiagnostics?.totals).toEqual({
				rejectedTurns: 0,
				rejectedSessions: 0,
				emptiedSessions: 0,
				rejectedQuestions: 0,
				rejectedQaItems: 5,
				informationalSkips: 0,
			})
			expect(dataset.adapterDiagnostics?.entries).toEqual(
				UNRESOLVED.map(([sampleIndex, qaIndex]) => ({
					format: "locomo",
					sampleIndex,
					qaIndex,
					reason: "qa-evidence-unresolved",
				})),
			)
			expect(
				countBenchmarkRejections(
					dataset.rejections,
					dataset.adapterDiagnostics,
				),
			).toEqual({ rejectedTurns: 0, rejectedConversations: 5 })

			expect(dataset.conversations).toHaveLength(272)
			expect(
				dataset.conversations.reduce((sum, c) => sum + c.turns.length, 0),
			).toBe(5882)
			expect(evaluations).toHaveLength(1981)
			const perCategory = new Map<string, number>()
			for (const e of evaluations)
				perCategory.set(
					e.questionType ?? "",
					(perCategory.get(e.questionType ?? "") ?? 0) + 1,
				)
			expect(Object.fromEntries(perCategory)).toEqual({
				"category-1": 279,
				"category-2": 320,
				"category-3": 96,
				"category-4": 840,
				"category-5": 446,
			})

			const abstentions = evaluations.filter((e) => e.abstention === true)
			expect(abstentions).toHaveLength(446)
			for (const e of abstentions) {
				expect(e.questionType).toBe("category-5")
				expect(Object.hasOwn(e, "answer")).toBe(false)
				expect(e.expectedSessionIds).toEqual([])
				expect(e.expectedDialogIds).toEqual([])
				expect(e.officialRetrieval?.ineligibleReason).toBe("abstention")
				expect(typeof e.metadata?.locomoAdversarialAnswer).toBe("string")
			}
			expect(
				abstentions.filter((e) =>
					Object.hasOwn(e.metadata ?? {}, "locomoReferenceAnswer"),
				),
			).toHaveLength(2)

			const answered = evaluations.filter((e) => e.abstention !== true)
			expect(answered.every((e) => typeof e.answer === "string")).toBe(true)
			expect(
				answered.filter(
					(e) =>
						(e as { goldAnswerSourceType?: string }).goldAnswerSourceType ===
						"number",
				),
			).toHaveLength(6)

			const noEvidence = answered.filter(
				(e) => e.officialRetrieval?.ineligibleReason === "no-evidence",
			)
			expect(noEvidence.map((e) => e.caseId)).toEqual(
				NO_EVIDENCE.map(([s, q]) => caseId(s, q)),
			)
			for (const e of noEvidence) expect(e.answer).toBeTruthy()

			for (const [sampleIndex, qaIndex, tokens] of RESCUED) {
				const rescued = byCase.get(caseId(sampleIndex, qaIndex))
				expect(rescued?.expectedDialogIds).toHaveLength(tokens)
				expect(rescued?.expectedSessionIds.length).toBeGreaterThan(0)
			}
			for (const [sampleIndex, qaIndex] of UNRESOLVED)
				expect(byCase.has(caseId(sampleIndex, qaIndex))).toBe(false)
		})
	},
)
