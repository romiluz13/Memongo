#!/usr/bin/env bun
/**
 * Frozen stratified 50-question set for backlog B2.
 *
 * The dataset is LongMemEval_S (`benchmarks/data/longmemeval_s_cleaned.json`).
 * Abstention is not a `question_type`. It is the `_abs` suffix on
 * `question_id` (30 of 500). Answer-session time comes from the parallel
 * `haystack_dates` entry for that `haystack_session_ids` value.
 * `allSessionsAfterQuestionDate` is true only when every answer session's
 * timestamp is strictly later than `question_date`. Both timestamps are
 * parsed as `YYYY/MM/DD (Ddd) HH:MM` and compared as UTC calendar fields,
 * so the result does not depend on the machine timezone. The weekday token
 * is checked, not used as the clock.
 *
 * Stratum note (B3 canaries): the "all-sessions-after" quota is NOT
 * "evidence after the question" under the benchmark driver. The driver
 * widens the question cutoff to the end of the question's own local
 * calendar day (backlog B3), so every same-day, later-time-of-day answer
 * session is in scope. The quota's selected rows are exactly those
 * same-day-later-evidence questions: if B3's day-widening regresses to the
 * raw `question_date` timestamp, their evidence falls out of scope and
 * their retrieval scores drop. Read their R/Q as B3 regression canaries,
 * not as out-of-scope evidence cases.
 *
 * Selection (seed B2_FROZEN50_SEED), in this order, and only this order:
 * 1. Sort the corpus by case id.
 * 2. Give every question type floor(50 / typeCount) seats. The remainder
 *    goes to the alphabetically first types, one each.
 * 3. Draw the all-sessions-after quota from a seeded shuffle of that pool,
 *    skipping a type that has no seats left.
 * 4. Draw the abstention quota the same way from the remaining `_abs` rows.
 * 5. Fill each type, alphabetically, from a seeded shuffle of whoever is left.
 * One mulberry32 stream is consumed in that sequence. Fisher-Yates uses it.
 * The emitted list is sorted by case id; `selectionReason` records which
 * step took the row.
 *
 * Emits two artifacts (both under the gitignored benchmarks/data/; this
 * script is the committed source of truth and regeneration is
 * deterministic): the selection sidecar `longmemeval_b2_frozen50.json`
 * (ids + strata) and the materialized dataset
 * `longmemeval_b2_frozen50_dataset.json` (full records, selection order)
 * that the benchmark drivers consume directly.
 *
 * Regenerate from the repo root:
 *   bun scripts/benchmark/longmemeval-b2-frozen50.ts
 */
import { createHash } from "node:crypto"
import { readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

export const B2_FROZEN50_SEED = 20260923
export const B2_FROZEN50_SIZE = 50
export const B2_ABSTENTION_MINIMUM = 4
export const B2_ALL_AFTER_MINIMUM = 4
export const B2_DATASET_RELATIVE = "benchmarks/data/longmemeval_s_cleaned.json"
export const B2_OUTPUT_RELATIVE = "benchmarks/data/longmemeval_b2_frozen50.json"
export const B2_MATERIALIZED_OUTPUT_RELATIVE =
	"benchmarks/data/longmemeval_b2_frozen50_dataset.json"
/**
 * Committed identity pin for the frozen set: the seed, the parent and
 * materialized-subset sha256 digests, and the 50 ids in selection order.
 * Unlike the artifacts under gitignored benchmarks/data/, this file is the
 * reviewed source of truth for "which 50 questions"; any change to the
 * selector that moves membership must update it in its own commit.
 */
export const B2_IDENTITY_PIN_RELATIVE =
	"scripts/benchmark/longmemeval-b2-frozen50.ids.json"

const TIMESTAMP =
	/^(\d{4})\/(\d{2})\/(\d{2}) \((Mon|Tue|Wed|Thu|Fri|Sat|Sun)\) (\d{2}):(\d{2})$/
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const

export type SelectionReason =
	| "quota-all-sessions-after-question-date"
	| "quota-abstention"
	| "type-fill"

export type ClassifiedQuestion = {
	caseId: string
	questionType: string
	abstention: boolean
	allSessionsAfterQuestionDate: boolean
}

export type SelectedQuestion = ClassifiedQuestion & {
	selectionReason: SelectionReason
}

export type B2FrozenArtifact = {
	version: 1
	seed: number
	dataset: string
	parentSha256?: string
	subsetSha256?: string
	questionCount: number
	perTypeCounts: Record<string, number>
	abstentionCount: number
	allSessionsAfterQuestionDateCount: number
	anomalies: string[]
	questions: SelectedQuestion[]
}

type RawQuestion = {
	question_id?: unknown
	question_type?: unknown
	question_date?: unknown
	answer_session_ids?: unknown
	haystack_session_ids?: unknown
	haystack_dates?: unknown
}

export function parseLongMemEvalTimestamp(value: string): {
	utcMs: number
	weekdayMatches: boolean
} {
	const match = TIMESTAMP.exec(value)
	if (!match) {
		throw new Error(`unparseable LongMemEval timestamp: ${value}`)
	}
	const year = Number(match[1])
	const month = Number(match[2])
	const day = Number(match[3])
	const hour = Number(match[5])
	const minute = Number(match[6])
	const utcMs = Date.UTC(year, month - 1, day, hour, minute)
	const weekdayMatches = WEEKDAYS[new Date(utcMs).getUTCDay()] === match[4]
	return { utcMs, weekdayMatches }
}

/** mulberry32. One stream per selection; do not reseed between steps. */
export function mulberry32(seed: number): () => number {
	let state = seed >>> 0
	return () => {
		state = (state + 0x6d2b79f5) >>> 0
		let t = state
		t = Math.imul(t ^ (t >>> 15), t | 1)
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296
	}
}

export function seededShuffle<T>(items: readonly T[], rng: () => number): T[] {
	const copy = [...items]
	for (let index = copy.length - 1; index > 0; index--) {
		const swap = Math.floor(rng() * (index + 1))
		const current = copy[index]
		copy[index] = copy[swap] as T
		copy[swap] = current as T
	}
	return copy
}

export function typeTargets(
	types: readonly string[],
	size: number,
): Map<string, number> {
	if (types.length === 0) {
		throw new Error("no question types to stratify")
	}
	const sorted = [...new Set(types)].sort((left, right) =>
		left < right ? -1 : left > right ? 1 : 0,
	)
	const base = Math.floor(size / sorted.length)
	let remainder = size - base * sorted.length
	const targets = new Map<string, number>()
	for (const type of sorted) {
		const extra = remainder > 0 ? 1 : 0
		remainder -= extra
		targets.set(type, base + extra)
	}
	return targets
}

function takeQuota(params: {
	pool: readonly ClassifiedQuestion[]
	reason: SelectionReason
	needed: number
	selected: Map<string, SelectedQuestion>
	counts: Map<string, number>
	targets: Map<string, number>
	rng: () => number
}): void {
	const shuffled = seededShuffle(
		[...params.pool].sort((left, right) =>
			left.caseId < right.caseId ? -1 : left.caseId > right.caseId ? 1 : 0,
		),
		params.rng,
	)
	let taken = 0
	for (const question of shuffled) {
		if (taken >= params.needed) break
		if (params.selected.has(question.caseId)) continue
		const used = params.counts.get(question.questionType) ?? 0
		const target = params.targets.get(question.questionType) ?? 0
		if (used >= target) continue
		params.selected.set(question.caseId, {
			...question,
			selectionReason: params.reason,
		})
		params.counts.set(question.questionType, used + 1)
		taken += 1
	}
	if (taken < params.needed) {
		throw new Error(
			`could not fill ${params.reason}: took ${taken} of ${params.needed}`,
		)
	}
}

export function selectB2FrozenSet(
	questions: readonly ClassifiedQuestion[],
	options?: {
		seed?: number
		size?: number
		abstentionMinimum?: number
		allAfterMinimum?: number
	},
): SelectedQuestion[] {
	const seed = options?.seed ?? B2_FROZEN50_SEED
	const size = options?.size ?? B2_FROZEN50_SIZE
	const abstentionMinimum = options?.abstentionMinimum ?? B2_ABSTENTION_MINIMUM
	const allAfterMinimum = options?.allAfterMinimum ?? B2_ALL_AFTER_MINIMUM
	const ordered = [...questions].sort((left, right) =>
		left.caseId < right.caseId ? -1 : left.caseId > right.caseId ? 1 : 0,
	)
	const ids = new Set<string>()
	for (const question of ordered) {
		if (ids.has(question.caseId)) {
			throw new Error(`duplicate case id: ${question.caseId}`)
		}
		ids.add(question.caseId)
	}
	const targets = typeTargets(
		ordered.map((question) => question.questionType),
		size,
	)
	const selected = new Map<string, SelectedQuestion>()
	const counts = new Map<string, number>()
	const rng = mulberry32(seed)
	takeQuota({
		pool: ordered.filter((question) => question.allSessionsAfterQuestionDate),
		reason: "quota-all-sessions-after-question-date",
		needed: allAfterMinimum,
		selected,
		counts,
		targets,
		rng,
	})
	takeQuota({
		pool: ordered.filter((question) => question.abstention),
		reason: "quota-abstention",
		needed: abstentionMinimum,
		selected,
		counts,
		targets,
		rng,
	})
	for (const type of [...targets.keys()].sort()) {
		const target = targets.get(type) ?? 0
		const remaining = ordered.filter(
			(question) =>
				question.questionType === type && !selected.has(question.caseId),
		)
		const shuffled = seededShuffle(remaining, rng)
		for (const question of shuffled) {
			const used = counts.get(type) ?? 0
			if (used >= target) break
			selected.set(question.caseId, {
				...question,
				selectionReason: "type-fill",
			})
			counts.set(type, used + 1)
		}
		if ((counts.get(type) ?? 0) !== target) {
			throw new Error(
				`type ${type} filled ${counts.get(type) ?? 0} of ${target}`,
			)
		}
	}
	return [...selected.values()].sort((left, right) =>
		left.caseId < right.caseId ? -1 : left.caseId > right.caseId ? 1 : 0,
	)
}

export function classifyLongMemEvalQuestion(
	entry: RawQuestion,
	anomalies: string[],
): ClassifiedQuestion {
	if (typeof entry.question_id !== "string" || entry.question_id.length === 0) {
		throw new Error("question is missing question_id")
	}
	if (
		typeof entry.question_type !== "string" ||
		entry.question_type.length === 0
	) {
		throw new Error(`${entry.question_id} is missing question_type`)
	}
	if (typeof entry.question_date !== "string") {
		throw new Error(`${entry.question_id} is missing question_date`)
	}
	if (!Array.isArray(entry.answer_session_ids)) {
		throw new Error(`${entry.question_id} is missing answer_session_ids`)
	}
	if (
		!Array.isArray(entry.haystack_session_ids) ||
		!Array.isArray(entry.haystack_dates) ||
		entry.haystack_session_ids.length !== entry.haystack_dates.length
	) {
		throw new Error(
			`${entry.question_id} haystack session ids and dates differ in length`,
		)
	}
	const questionTime = parseLongMemEvalTimestamp(entry.question_date)
	if (!questionTime.weekdayMatches) {
		anomalies.push(
			`${entry.question_id} question_date weekday does not match the calendar`,
		)
	}
	const datesBySession = new Map<string, number[]>()
	for (const [index, sessionId] of entry.haystack_session_ids.entries()) {
		if (typeof sessionId !== "string" || sessionId.length === 0) {
			throw new Error(`${entry.question_id} has an empty haystack session id`)
		}
		const rawDate = entry.haystack_dates[index]
		if (typeof rawDate !== "string") {
			throw new Error(`${entry.question_id} has a non-string haystack date`)
		}
		const parsed = parseLongMemEvalTimestamp(rawDate)
		if (!parsed.weekdayMatches) {
			anomalies.push(
				`${entry.question_id} haystack date weekday does not match: ${rawDate}`,
			)
		}
		const prior = datesBySession.get(sessionId)
		if (prior) prior.push(parsed.utcMs)
		else datesBySession.set(sessionId, [parsed.utcMs])
	}
	if (entry.answer_session_ids.length === 0) {
		throw new Error(`${entry.question_id} has no answer sessions`)
	}
	let allAfter = true
	for (const sessionId of entry.answer_session_ids) {
		if (typeof sessionId !== "string" || sessionId.length === 0) {
			throw new Error(`${entry.question_id} has an empty answer session id`)
		}
		const stamps = datesBySession.get(sessionId)
		if (!stamps) {
			throw new Error(
				`${entry.question_id} answer session ${sessionId} is not in the haystack`,
			)
		}
		if (new Set(stamps).size > 1) {
			throw new Error(
				`${entry.question_id} answer session ${sessionId} has conflicting haystack dates`,
			)
		}
		if ((stamps[0] ?? 0) <= questionTime.utcMs) allAfter = false
	}
	return {
		caseId: entry.question_id,
		questionType: entry.question_type,
		abstention: entry.question_id.endsWith("_abs"),
		allSessionsAfterQuestionDate: allAfter,
	}
}

export function buildB2FrozenArtifact(
	entries: readonly RawQuestion[],
	dataset = B2_DATASET_RELATIVE,
	digests: { parentSha256?: string; subsetSha256?: string } = {},
): B2FrozenArtifact {
	const anomalies: string[] = []
	const questionsWithDuplicateHaystackIds: string[] = []
	let answerSessionHitsDuplicate = 0
	for (const entry of entries) {
		if (!Array.isArray(entry.haystack_session_ids)) continue
		const seen = new Set<string>()
		const duplicated = new Set<string>()
		for (const sessionId of entry.haystack_session_ids) {
			if (typeof sessionId !== "string") continue
			if (seen.has(sessionId)) duplicated.add(sessionId)
			seen.add(sessionId)
		}
		if (duplicated.size === 0 || typeof entry.question_id !== "string") continue
		questionsWithDuplicateHaystackIds.push(entry.question_id)
		if (!Array.isArray(entry.answer_session_ids)) continue
		for (const sessionId of entry.answer_session_ids) {
			if (typeof sessionId === "string" && duplicated.has(sessionId)) {
				answerSessionHitsDuplicate += 1
			}
		}
	}
	if (questionsWithDuplicateHaystackIds.length > 0) {
		anomalies.push(
			`${questionsWithDuplicateHaystackIds.length} questions repeat a haystack session id; ${answerSessionHitsDuplicate} answer sessions use one of those repeated ids`,
		)
	}
	const classified = entries.map((entry) =>
		classifyLongMemEvalQuestion(entry, anomalies),
	)
	const questions = selectB2FrozenSet(classified)
	const perTypeCounts: Record<string, number> = {}
	for (const question of questions) {
		perTypeCounts[question.questionType] =
			(perTypeCounts[question.questionType] ?? 0) + 1
	}
	return {
		version: 1,
		seed: B2_FROZEN50_SEED,
		dataset,
		parentSha256: digests.parentSha256,
		subsetSha256: digests.subsetSha256,
		questionCount: questions.length,
		perTypeCounts,
		abstentionCount: questions.filter((question) => question.abstention).length,
		allSessionsAfterQuestionDateCount: questions.filter(
			(question) => question.allSessionsAfterQuestionDate,
		).length,
		anomalies,
		questions,
	}
}

/**
 * Materialized frozen dataset: the full LongMemEval records (every field
 * preserved as parsed) for exactly the selected questions, in the selection
 * artifact's order. The benchmark drivers key checkpoint/sidecar identity
 * off the dataset file digest, so the B2 loop runs against THIS file, not
 * an in-code id filter. Regeneration is deterministic (fixed seed), so the
 * digest is stable across machines.
 */
export function materializeFrozenDataset(
	entries: readonly RawQuestion[],
	questions: readonly SelectedQuestion[],
): RawQuestion[] {
	const byId = new Map<string, RawQuestion>()
	for (const entry of entries) {
		if (typeof entry.question_id === "string") {
			if (byId.has(entry.question_id)) {
				throw new Error(`duplicate question_id: ${entry.question_id}`)
			}
			byId.set(entry.question_id, entry)
		}
	}
	const records: RawQuestion[] = []
	for (const question of questions) {
		const record = byId.get(question.caseId)
		if (!record) {
			throw new Error(
				`selected question missing from dataset: ${question.caseId}`,
			)
		}
		records.push(record)
	}
	return records
}

export function repoRootFromHere(importMetaUrl: string): string {
	return path.resolve(path.dirname(fileURLToPath(importMetaUrl)), "../..")
}

async function main(): Promise<void> {
	const root = repoRootFromHere(import.meta.url)
	const datasetPath = path.join(root, B2_DATASET_RELATIVE)
	const outputPath = path.join(root, B2_OUTPUT_RELATIVE)
	const materializedPath = path.join(root, B2_MATERIALIZED_OUTPUT_RELATIVE)
	const datasetBytes = await readFile(datasetPath)
	const parentSha256 = createHash("sha256").update(datasetBytes).digest("hex")
	const parsed: unknown = JSON.parse(datasetBytes.toString("utf8"))
	if (!Array.isArray(parsed)) {
		throw new Error("LongMemEval dataset is not a JSON array")
	}
	const staged = buildB2FrozenArtifact(parsed as RawQuestion[])
	if (parsed.length !== 500) {
		throw new Error(`expected 500 questions, found ${parsed.length}`)
	}
	const allAfterInCorpus = (parsed as RawQuestion[])
		.map((entry) => classifyLongMemEvalQuestion(entry, []))
		.filter((question) => question.allSessionsAfterQuestionDate).length
	if (allAfterInCorpus !== 20) {
		throw new Error(
			`expected 20 questions with every answer session after question_date, found ${allAfterInCorpus}`,
		)
	}
	const materialized = materializeFrozenDataset(
		parsed as RawQuestion[],
		staged.questions,
	)
	if (materialized.length !== staged.questionCount) {
		throw new Error(
			`materialized dataset has ${materialized.length} records, expected ${staged.questionCount}`,
		)
	}
	const materializedBytes = `${JSON.stringify(materialized, null, "\t")}\n`
	const subsetSha256 = createHash("sha256")
		.update(materializedBytes)
		.digest("hex")
	const artifact = buildB2FrozenArtifact(parsed as RawQuestion[], undefined, {
		parentSha256,
		subsetSha256,
	})
	// Sanity: the digest pass must not change membership.
	if (JSON.stringify(artifact.questions) !== JSON.stringify(staged.questions)) {
		throw new Error("internal error: selection changed between passes")
	}
	await writeFile(outputPath, `${JSON.stringify(artifact, null, "\t")}\n`)
	await writeFile(materializedPath, materializedBytes)
	console.log(
		JSON.stringify(
			{
				output: B2_OUTPUT_RELATIVE,
				materialized: B2_MATERIALIZED_OUTPUT_RELATIVE,
				seed: artifact.seed,
				parentSha256,
				subsetSha256,
				questionCount: artifact.questionCount,
				perTypeCounts: artifact.perTypeCounts,
				abstentionCount: artifact.abstentionCount,
				allSessionsAfterQuestionDateCount:
					artifact.allSessionsAfterQuestionDateCount,
				anomalies: artifact.anomalies,
			},
			null,
			2,
		),
	)
}

const invokedPath = process.argv[1]
if (
	invokedPath &&
	path.resolve(invokedPath) === fileURLToPath(import.meta.url)
) {
	main().catch((error: unknown) => {
		console.error(error instanceof Error ? error.message : error)
		process.exitCode = 1
	})
}
