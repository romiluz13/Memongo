import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { describe, expect, it } from "vitest"
import {
	B2_ABSTENTION_MINIMUM,
	B2_ALL_AFTER_MINIMUM,
	B2_DATASET_RELATIVE,
	B2_FROZEN50_SEED,
	B2_FROZEN50_SIZE,
	B2_IDENTITY_PIN_RELATIVE,
	B2_MATERIALIZED_OUTPUT_RELATIVE,
	B2_OUTPUT_RELATIVE,
	type B2FrozenArtifact,
	type ClassifiedQuestion,
	buildB2FrozenArtifact,
	classifyLongMemEvalQuestion,
	materializeFrozenDataset,
	repoRootFromHere,
	selectB2FrozenSet,
	typeTargets,
} from "./longmemeval-b2-frozen50.js"

type B2IdentityPin = {
	version: number
	seed: number
	parentSha256: string
	subsetSha256: string
	ids: string[]
}

function question(
	caseId: string,
	questionType: string,
	flags?: { abstention?: boolean; allAfter?: boolean },
): ClassifiedQuestion {
	return {
		caseId,
		questionType,
		abstention: flags?.abstention ?? false,
		allSessionsAfterQuestionDate: flags?.allAfter ?? false,
	}
}

function corpus(): ClassifiedQuestion[] {
	const types = [
		"knowledge-update",
		"multi-session",
		"single-session-assistant",
		"single-session-preference",
		"single-session-user",
		"temporal-reasoning",
	]
	const rows: ClassifiedQuestion[] = []
	for (const type of types) {
		for (let index = 0; index < 12; index++) {
			rows.push(
				question(`${type}-${String(index).padStart(2, "0")}`, type, {
					abstention: index < 2 && type !== "single-session-assistant",
					allAfter: type === "temporal-reasoning" && index < 6,
				}),
			)
		}
	}
	return rows
}

describe("B2 frozen 50 selection", () => {
	it("gives the alphabetically first types the remainder seats", () => {
		const targets = typeTargets(
			[
				"temporal-reasoning",
				"knowledge-update",
				"multi-session",
				"single-session-user",
				"single-session-assistant",
				"single-session-preference",
			],
			50,
		)
		expect(targets.get("knowledge-update")).toBe(9)
		expect(targets.get("multi-session")).toBe(9)
		expect(targets.get("temporal-reasoning")).toBe(8)
		expect([...targets.values()].reduce((sum, count) => sum + count, 0)).toBe(
			50,
		)
	})

	it("is deterministic for one seed and meets the quotas", () => {
		const first = selectB2FrozenSet(corpus(), { seed: B2_FROZEN50_SEED })
		const second = selectB2FrozenSet(corpus(), { seed: B2_FROZEN50_SEED })
		expect(second.map((row) => row.caseId)).toEqual(
			first.map((row) => row.caseId),
		)
		expect(first).toHaveLength(B2_FROZEN50_SIZE)
		expect(first.filter((row) => row.abstention).length).toBeGreaterThanOrEqual(
			B2_ABSTENTION_MINIMUM,
		)
		expect(
			first.filter((row) => row.allSessionsAfterQuestionDate).length,
		).toBeGreaterThanOrEqual(B2_ALL_AFTER_MINIMUM)
		const counts = new Map<string, number>()
		for (const row of first) {
			counts.set(row.questionType, (counts.get(row.questionType) ?? 0) + 1)
		}
		expect(counts.get("knowledge-update")).toBe(9)
		expect(counts.get("temporal-reasoning")).toBe(8)
		expect([...first.map((row) => row.caseId)].sort()).toEqual(
			first.map((row) => row.caseId),
		)
	})

	it("changes membership when the seed changes", () => {
		const left = selectB2FrozenSet(corpus(), { seed: 1 }).map(
			(row) => row.caseId,
		)
		const right = selectB2FrozenSet(corpus(), { seed: 2 }).map(
			(row) => row.caseId,
		)
		expect(left).not.toEqual(right)
	})
})

// Synthetic classifier coverage: these run everywhere (CI included) because
// they build raw LongMemEval-shaped entries instead of reading the
// gitignored dataset.
describe("B2 classifier (synthetic entries)", () => {
	function rawEntry(options: {
		questionId?: string
		questionDate?: string
		answerSessionIds?: string[]
		haystackSessionIds?: string[]
		haystackDates?: string[]
	}) {
		return {
			question_id: options.questionId ?? "gpt4_synthetic",
			question_type: "knowledge-update",
			question_date: options.questionDate ?? "2024/06/15 (Sat) 14:30",
			answer_session_ids: options.answerSessionIds ?? ["session-1"],
			haystack_session_ids: options.haystackSessionIds ??
				options.answerSessionIds ?? ["session-1"],
			haystack_dates:
				options.haystackDates ??
				(options.answerSessionIds ?? ["session-1"]).map(
					() => "2024/06/16 (Sun) 10:00",
				),
		}
	}

	it("marks all-after only for strictly later answer-session timestamps", () => {
		const anomalies: string[] = []
		// Equal timestamp: not after.
		const equal = classifyLongMemEvalQuestion(
			rawEntry({
				answerSessionIds: ["session-1"],
				haystackDates: ["2024/06/15 (Sat) 14:30"],
			}),
			anomalies,
		)
		expect(equal.allSessionsAfterQuestionDate).toBe(false)
		// Strictly later the same day: after.
		const later = classifyLongMemEvalQuestion(
			rawEntry({
				answerSessionIds: ["session-1"],
				haystackDates: ["2024/06/15 (Sat) 20:00"],
			}),
			anomalies,
		)
		expect(later.allSessionsAfterQuestionDate).toBe(true)
		// One equal timestamp among several sessions: the question is not
		// all-after.
		const mixed = classifyLongMemEvalQuestion(
			rawEntry({
				answerSessionIds: ["session-1", "session-2"],
				haystackSessionIds: ["session-1", "session-2"],
				haystackDates: ["2024/06/16 (Sun) 10:00", "2024/06/15 (Sat) 14:30"],
			}),
			anomalies,
		)
		expect(mixed.allSessionsAfterQuestionDate).toBe(false)
		expect(anomalies).toEqual([])
	})

	it("records a weekday mismatch as an anomaly without throwing", () => {
		const anomalies: string[] = []
		const classified = classifyLongMemEvalQuestion(
			rawEntry({
				questionId: "gpt4_badweekday",
				questionDate: "2024/06/15 (Mon) 14:30", // 2024-06-15 is a Saturday
				haystackDates: ["2024/06/16 (Tue) 10:00"], // 2024-06-16 is a Sunday
			}),
			anomalies,
		)
		expect(classified.allSessionsAfterQuestionDate).toBe(true)
		expect(anomalies).toEqual([
			"gpt4_badweekday question_date weekday does not match the calendar",
			expect.stringContaining("haystack date weekday does not match"),
		])
	})

	it("throws on structural violations, not just anomalies", () => {
		expect(() =>
			classifyLongMemEvalQuestion({ ...rawEntry({}), question_id: "" }, []),
		).toThrow("question is missing question_id")
		expect(() =>
			classifyLongMemEvalQuestion(
				{ ...rawEntry({}), answer_session_ids: [] },
				[],
			),
		).toThrow("has no answer sessions")
		expect(() =>
			classifyLongMemEvalQuestion(
				rawEntry({
					answerSessionIds: ["session-9"],
					haystackSessionIds: ["session-1"],
					haystackDates: ["2024/06/16 (Sun) 10:00"],
				}),
				[],
			),
		).toThrow("answer session session-9 is not in the haystack")
		expect(() =>
			classifyLongMemEvalQuestion(
				rawEntry({
					answerSessionIds: ["session-1", "session-2"],
					haystackSessionIds: ["session-1", "session-2", "session-1"],
					haystackDates: [
						"2024/06/16 (Sun) 10:00",
						"2024/06/17 (Mon) 10:00",
						"2024/06/18 (Tue) 10:00",
					],
				}),
				[],
			),
		).toThrow("has conflicting haystack dates")
	})

	it("throws when a quota pool cannot fill its seats", () => {
		// Only one all-after row for a quota of 4: the shortfall must throw,
		// not pass silently.
		const pool = corpus().map((row) => ({
			...row,
			allSessionsAfterQuestionDate: false,
		}))
		pool[0] = { ...pool[0], allSessionsAfterQuestionDate: true }
		expect(() => selectB2FrozenSet(pool)).toThrow(
			"could not fill quota-all-sessions-after-question-date",
		)
	})
})

// The identity pin is committed, so this runs everywhere — including CI,
// where the gitignored LongMemEval dataset is absent.
describe("B2 frozen 50 identity pin (committed constant)", () => {
	const root = repoRootFromHere(import.meta.url)

	it("pins 50 unique ids with the seed and hex digests", async () => {
		const pin = JSON.parse(
			await readFile(path.join(root, B2_IDENTITY_PIN_RELATIVE), "utf8"),
		) as B2IdentityPin
		expect(pin.version).toBe(1)
		expect(pin.seed).toBe(B2_FROZEN50_SEED)
		expect(pin.ids).toHaveLength(B2_FROZEN50_SIZE)
		expect(new Set(pin.ids).size).toBe(B2_FROZEN50_SIZE)
		expect(pin.parentSha256).toMatch(/^[0-9a-f]{64}$/)
		expect(pin.subsetSha256).toMatch(/^[0-9a-f]{64}$/)
		expect(pin.parentSha256).not.toBe(pin.subsetSha256)
		// Abstention is derivable from the id suffix; the frozen set carries
		// exactly 5 abstention questions (quota 4, plus one type-fill draw).
		const abstentionIds = pin.ids.filter((id) => id.endsWith("_abs"))
		expect(abstentionIds.length).toBeGreaterThanOrEqual(B2_ABSTENTION_MINIMUM)
		expect(abstentionIds.length).toBe(5)
		// Sorted by case id, matching the selector's emission order.
		expect([...pin.ids].sort()).toEqual(pin.ids)
	})
})

// The LongMemEval dataset lives under gitignored benchmarks/data/, so this
// suite only runs where the dataset has been fetched; CI skips it.
describe.skipIf(
	!existsSync(
		path.join(repoRootFromHere(import.meta.url), B2_DATASET_RELATIVE),
	),
)("B2 frozen artifact on the LongMemEval file", () => {
	const root = repoRootFromHere(import.meta.url)
	const datasetPath = path.join(root, B2_DATASET_RELATIVE)
	const outputPath = path.join(root, B2_OUTPUT_RELATIVE)
	const materializedPath = path.join(root, B2_MATERIALIZED_OUTPUT_RELATIVE)

	it("matches the committed identity pin", async () => {
		expect(existsSync(outputPath)).toBe(true)
		expect(existsSync(materializedPath)).toBe(true)
		const datasetBytes = await readFile(datasetPath)
		const materializedBytes = await readFile(materializedPath)
		const entries: unknown = JSON.parse(datasetBytes.toString("utf8"))
		expect(Array.isArray(entries)).toBe(true)
		const parentSha256 = createHash("sha256").update(datasetBytes).digest("hex")
		const subsetSha256 = createHash("sha256")
			.update(materializedBytes)
			.digest("hex")
		const generated = buildB2FrozenArtifact(entries as never[])
		const written = JSON.parse(
			await readFile(outputPath, "utf8"),
		) as B2FrozenArtifact
		const pin = JSON.parse(
			await readFile(path.join(root, B2_IDENTITY_PIN_RELATIVE), "utf8"),
		) as B2IdentityPin

		// The recorded digests are the actual file digests...
		expect(written.parentSha256).toBe(parentSha256)
		expect(written.subsetSha256).toBe(subsetSha256)
		expect(pin.parentSha256).toBe(parentSha256)
		expect(pin.subsetSha256).toBe(subsetSha256)
		// ...the selection is byte-stable against regeneration...
		const { parentSha256: _p, subsetSha256: _s, ...writtenCore } = written
		expect(writtenCore).toEqual(generated)
		expect(written.seed).toBe(B2_FROZEN50_SEED)
		expect(written.questionCount).toBe(50)
		expect(written.abstentionCount).toBeGreaterThanOrEqual(4)
		expect(written.allSessionsAfterQuestionDateCount).toBeGreaterThanOrEqual(4)
		expect(new Set(written.questions.map((row) => row.caseId)).size).toBe(50)
		// ...and the committed pin holds exactly the selected 50 ids.
		expect(written.questions.map((row) => row.caseId)).toEqual(pin.ids)

		const materializedWritten = JSON.parse(
			await readFile(materializedPath, "utf8"),
		)
		expect(Array.isArray(materializedWritten)).toBe(true)
		expect(materializedWritten).toHaveLength(50)
		// Records preserved whole, in selection order, from the parent dataset.
		expect(materializedWritten).toEqual(
			materializeFrozenDataset(entries as never[], written.questions),
		)
		for (const [index, row] of written.questions.entries()) {
			expect(materializedWritten[index].question_id).toBe(row.caseId)
		}
	})
})
