import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"

type JsonRecord = Record<string, unknown>

export type CountKind =
	| "repeated-action"
	| "pending-action"
	| "inventory"
	| "duration"
	| "money-or-percent"
	| "unknown-count"

export type CountQuestionAudit = {
	questionId: string
	questionType: string
	question: string
	answer: string
	countKind: CountKind
	goldNumber: number | null
	answerSessionCount: number | null
	sessionCountEqualsGold: boolean | null
	timeWindowed: boolean
	flags: string[]
}

export type ArtifactCountAudit = CountQuestionAudit & {
	generatedAnswer: string
	generatedNumber: number | null
	derivedEvidenceCount: number | null
	derivedEvidenceNumber: number | null
	cutoff: string
	artifactFlags: string[]
}

export type CountPolicyAuditReport = {
	datasetPath: string
	artifactPath?: string
	cutoff: string
	summary: {
		countQuestions: number
		byKind: Record<string, number>
		numericGold: number
		sessionCountEqualsGold: number
		sessionCountDiffersFromGold: number
		timeWindowed: number
		artifactEvaluations: number
		artifactFlagged: number
	}
	questions: CountQuestionAudit[]
	artifactEvaluations: ArtifactCountAudit[]
}

type LongMemEvalQuestion = {
	question_id?: unknown
	question_type?: unknown
	question?: unknown
	answer?: unknown
	ground_truth_answer?: unknown
	answer_session_ids?: unknown
}

const numberWords = new Map<string, number>([
	["zero", 0],
	["one", 1],
	["two", 2],
	["three", 3],
	["four", 4],
	["five", 5],
	["six", 6],
	["seven", 7],
	["eight", 8],
	["nine", 9],
	["ten", 10],
	["eleven", 11],
	["twelve", 12],
	["thirteen", 13],
	["fourteen", 14],
	["fifteen", 15],
	["sixteen", 16],
	["seventeen", 17],
	["eighteen", 18],
	["nineteen", 19],
	["twenty", 20],
])

function asRecord(value: unknown): JsonRecord {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as JsonRecord)
		: {}
}

function asString(value: unknown): string {
	if (typeof value === "string") return value
	if (typeof value === "number" && Number.isFinite(value)) return String(value)
	return ""
}

function asStringArrayLength(value: unknown): number | null {
	return Array.isArray(value) ? value.length : null
}

export function hasCountStyleQuestion(question: string): boolean {
	return /\bhow many\b|\bhow much\b|\bnumber of\b|\bcount(?:ed|ing)?\b|\btotal\b/i.test(
		question,
	)
}

export function extractFirstNumber(text: string): number | null {
	const digitMatch = text.match(/(?:^|[^\w])(\d+(?:\.\d+)?)(?:[^\w]|$)/)
	if (digitMatch?.[1]) {
		const parsed = Number(digitMatch[1])
		return Number.isFinite(parsed) ? parsed : null
	}
	const lower = text.toLowerCase()
	for (const [word, value] of numberWords) {
		if (new RegExp(`\\b${word}\\b`).test(lower)) {
			return value
		}
	}
	return null
}

export function classifyCountKind(question: string, answer: string): CountKind {
	const q = question.toLowerCase()
	const a = answer.toLowerCase()
	if (
		/\b(need|needs|needed|still need|have to)\b.*\b(pick up|return|collect|drop off|send|mail|buy|purchase|order|wash|clean|schedule|book|call)\b/.test(
			q,
		) ||
		/\b(pick up|return|collect|drop off)\b/.test(q)
	) {
		return "pending-action"
	}
	if (
		/\bhow many\s+(?:days?|hours?|minutes?|weeks?|months?|years?)\b/.test(q)
	) {
		return "duration"
	}
	if (
		/\bhow many times\b|\btimes did i\b/.test(q) ||
		/\bhow many\b.*\b(?:did i|have i)\b.*\b(?:go|went|visit|visited|attend|attended|bake|baked|watch|watched)\b/.test(
			q,
		)
	) {
		return "repeated-action"
	}
	if (
		/\b(how much|cashback|cash back|refund|receipt|coupon|discount|spent|paid|cost|price|dollars?|usd)\b|[$%]/.test(
			`${q} ${a}`,
		)
	) {
		return "money-or-percent"
	}
	if (/\bhow many\b|\bnumber of\b|\btotal\b|\bcount\b/.test(q)) {
		return "inventory"
	}
	return "unknown-count"
}

export function isTimeWindowedQuestion(question: string): boolean {
	return /\b(past|last|this|today|yesterday|tomorrow|week|month|year|in january|in february|in march|in april|in may|in june|in july|in august|in september|in october|in november|in december)\b/i.test(
		question,
	)
}

export function auditCountQuestion(
	raw: LongMemEvalQuestion,
): CountQuestionAudit | null {
	const question = asString(raw.question).trim()
	if (!question || !hasCountStyleQuestion(question)) {
		return null
	}
	const answer = asString(raw.answer ?? raw.ground_truth_answer).trim()
	const goldNumber = extractFirstNumber(answer)
	const answerSessionCount = asStringArrayLength(raw.answer_session_ids)
	const sessionCountEqualsGold =
		goldNumber === null || answerSessionCount === null
			? null
			: answerSessionCount === goldNumber
	const countKind = classifyCountKind(question, answer)
	const flags: string[] = []
	if (goldNumber === null) flags.push("gold-number-missing")
	if (answerSessionCount === null) flags.push("answer-session-count-missing")
	if (sessionCountEqualsGold === false) {
		flags.push("answer-session-count-differs-from-gold")
	}
	if (countKind === "repeated-action" && isTimeWindowedQuestion(question)) {
		flags.push("requires-source-event-dedup")
	}
	if (countKind === "money-or-percent") {
		flags.push("do-not-use-item-count-policy")
	}

	return {
		questionId: asString(raw.question_id),
		questionType: asString(raw.question_type),
		question,
		answer,
		countKind,
		goldNumber,
		answerSessionCount,
		sessionCountEqualsGold,
		timeWindowed: isTimeWindowedQuestion(question),
		flags,
	}
}

export function countDerivedEvidenceBullets(memory: string): number | null {
	if (!/\bderived (?:countable evidence|action checklist)\b/i.test(memory)) {
		return null
	}
	const matches = memory.match(/\b\d+\./g)
	return matches ? matches.length : 0
}

export function extractDerivedEvidenceNumber(memory: string): number | null {
	const lowerMemory = memory.toLowerCase()
	if (/\bderived current-total evidence\b/.test(lowerMemory)) {
		const statedTotals = [
			...lowerMemory.matchAll(/\bstated total\s+(\d+(?:\.\d+)?)\b/g),
		]
			.map((match) => Number(match[1]))
			.filter(Number.isFinite)
		return statedTotals.length > 0 ? Math.max(...statedTotals) : null
	}
	return countDerivedEvidenceBullets(memory)
}

function buildQuestionMap(
	questions: CountQuestionAudit[],
): Map<string, CountQuestionAudit> {
	return new Map(questions.map((question) => [question.questionId, question]))
}

export function auditArtifactCounts(
	payload: JsonRecord,
	questions: CountQuestionAudit[],
	cutoff: string,
): ArtifactCountAudit[] {
	const questionById = buildQuestionMap(questions)
	const evaluations = Array.isArray(payload.evaluations)
		? payload.evaluations.map(asRecord)
		: []
	const audits: ArtifactCountAudit[] = []
	for (const evaluation of evaluations) {
		const questionId = asString(evaluation.question_id)
		const base = questionById.get(questionId)
		if (!base) continue
		const cutoffResult = asRecord(asRecord(evaluation.cutoff_results)[cutoff])
		const generatedAnswer = asString(cutoffResult.generated_answer).trim()
		const generatedNumber = extractFirstNumber(generatedAnswer)
		const retrieval = asRecord(evaluation.retrieval)
		const searchResults = Array.isArray(retrieval.search_results)
			? retrieval.search_results.map(asRecord)
			: []
		const derivedEvidenceNumber =
			searchResults
				.map((result) => extractDerivedEvidenceNumber(asString(result.memory)))
				.find((count): count is number => count !== null) ?? null
		const derivedEvidenceCount =
			searchResults
				.map((result) => countDerivedEvidenceBullets(asString(result.memory)))
				.find((count): count is number => count !== null) ?? null
		const artifactFlags: string[] = []
		if (!generatedAnswer) artifactFlags.push("generated-answer-empty")
		if (
			base.goldNumber !== null &&
			generatedNumber !== null &&
			generatedNumber !== base.goldNumber
		) {
			artifactFlags.push("generated-number-differs-from-gold")
		}
		if (
			base.goldNumber !== null &&
			derivedEvidenceNumber !== null &&
			derivedEvidenceNumber !== base.goldNumber
		) {
			artifactFlags.push("derived-evidence-count-differs-from-gold")
		}
		if (
			generatedNumber !== null &&
			derivedEvidenceNumber !== null &&
			generatedNumber !== derivedEvidenceNumber
		) {
			artifactFlags.push("generated-number-differs-from-derived-evidence")
		}
		if (
			base.countKind !== "money-or-percent" &&
			base.countKind !== "duration" &&
			derivedEvidenceNumber === null
		) {
			artifactFlags.push("derived-count-evidence-missing")
		}

		audits.push({
			...base,
			generatedAnswer,
			generatedNumber,
			derivedEvidenceCount,
			derivedEvidenceNumber,
			cutoff,
			artifactFlags,
		})
	}
	return audits
}

function summarize(
	questions: CountQuestionAudit[],
	artifactEvaluations: ArtifactCountAudit[],
): CountPolicyAuditReport["summary"] {
	const byKind: Record<string, number> = {}
	for (const question of questions) {
		byKind[question.countKind] = (byKind[question.countKind] ?? 0) + 1
	}
	return {
		countQuestions: questions.length,
		byKind,
		numericGold: questions.filter((question) => question.goldNumber !== null)
			.length,
		sessionCountEqualsGold: questions.filter(
			(question) => question.sessionCountEqualsGold === true,
		).length,
		sessionCountDiffersFromGold: questions.filter(
			(question) => question.sessionCountEqualsGold === false,
		).length,
		timeWindowed: questions.filter((question) => question.timeWindowed).length,
		artifactEvaluations: artifactEvaluations.length,
		artifactFlagged: artifactEvaluations.filter(
			(entry) => entry.artifactFlags.length > 0,
		).length,
	}
}

export function buildCountPolicyAuditReport(params: {
	datasetPath: string
	artifactPath?: string
	cutoff?: string
}): CountPolicyAuditReport {
	const cutoff = params.cutoff ?? "top_50"
	const dataset = JSON.parse(
		readFileSync(params.datasetPath, "utf8"),
	) as unknown
	if (!Array.isArray(dataset)) {
		throw new Error("dataset must be a LongMemEval JSON array")
	}
	const questions = dataset
		.map((entry) => auditCountQuestion(entry as LongMemEvalQuestion))
		.filter((entry): entry is CountQuestionAudit => entry !== null)
	const artifactEvaluations = params.artifactPath
		? auditArtifactCounts(
				JSON.parse(readFileSync(params.artifactPath, "utf8")) as JsonRecord,
				questions,
				cutoff,
			)
		: []
	return {
		datasetPath: params.datasetPath,
		artifactPath: params.artifactPath,
		cutoff,
		summary: summarize(questions, artifactEvaluations),
		questions,
		artifactEvaluations,
	}
}

function parseArgs(argv: string[]): {
	datasetPath?: string
	artifactPath?: string
	cutoff?: string
	outputPath?: string
	json: boolean
} {
	let datasetPath: string | undefined
	let artifactPath: string | undefined
	let cutoff: string | undefined
	let outputPath: string | undefined
	let json = false
	for (const arg of argv) {
		if (arg === "--json") json = true
		else if (arg.startsWith("--dataset="))
			datasetPath = arg.slice("--dataset=".length)
		else if (arg.startsWith("--artifact="))
			artifactPath = arg.slice("--artifact=".length)
		else if (arg.startsWith("--cutoff=")) cutoff = arg.slice("--cutoff=".length)
		else if (arg.startsWith("--out=")) outputPath = arg.slice("--out=".length)
		else throw new Error(`unknown argument: ${arg}`)
	}
	return { datasetPath, artifactPath, cutoff, outputPath, json }
}

function renderReport(report: CountPolicyAuditReport): string {
	const lines = [
		`dataset: ${report.datasetPath}`,
		report.artifactPath ? `artifact: ${report.artifactPath}` : undefined,
		`cutoff: ${report.cutoff}`,
		`count questions: ${report.summary.countQuestions}`,
		`by kind: ${Object.entries(report.summary.byKind)
			.map(([kind, count]) => `${kind}=${count}`)
			.join(", ")}`,
		`numeric gold: ${report.summary.numericGold}`,
		`session count equals gold: ${report.summary.sessionCountEqualsGold}`,
		`session count differs from gold: ${report.summary.sessionCountDiffersFromGold}`,
		`time-windowed: ${report.summary.timeWindowed}`,
		`artifact count evaluations: ${report.summary.artifactEvaluations}`,
		`artifact flagged: ${report.summary.artifactFlagged}`,
	].filter((line): line is string => Boolean(line))
	const flagged = report.artifactEvaluations.filter(
		(entry) => entry.artifactFlags.length > 0,
	)
	if (flagged.length > 0) {
		lines.push("", "flagged artifact count cases:")
		for (const entry of flagged) {
			lines.push(
				`- ${entry.questionId} ${entry.countKind}: gold=${entry.goldNumber ?? "?"} generated=${entry.generatedNumber ?? "?"} derived=${entry.derivedEvidenceNumber ?? "?"} flags=${entry.artifactFlags.join(", ")}`,
			)
		}
	}
	return lines.join("\n")
}

if (import.meta.main) {
	try {
		const args = parseArgs(process.argv.slice(2))
		const datasetPath =
			args.datasetPath ?? process.env.MEMONGO_BENCHMARK_DATASET_PATH?.trim()
		if (!datasetPath) {
			throw new Error(
				"pass --dataset=<longmemeval.json> or set MEMONGO_BENCHMARK_DATASET_PATH",
			)
		}
		const report = buildCountPolicyAuditReport({
			datasetPath,
			artifactPath: args.artifactPath,
			cutoff: args.cutoff,
		})
		const rendered = args.json
			? JSON.stringify(report, null, 2)
			: renderReport(report)
		console.log(rendered)
		if (args.outputPath) {
			mkdirSync(path.dirname(args.outputPath), { recursive: true })
			writeFileSync(args.outputPath, `${JSON.stringify(report, null, 2)}\n`)
		}
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error))
		process.exit(1)
	}
}
