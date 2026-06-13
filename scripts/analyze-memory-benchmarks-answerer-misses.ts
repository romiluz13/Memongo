import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

type JsonRecord = Record<string, unknown>

type CutoffMiss = {
	questionId: string
	questionType: string
	cutoff: string
	score: number
	category: MissCategory
	question: string
	groundTruth: string
	generatedAnswer: string
	answerSessionIds: string[]
	retrievedCount: number
	topEvidence: EvidenceSummary[]
	evidenceSignals: EvidenceSignals
}

type EvidenceSummary = {
	rank: number
	id: string | null
	score: number | null
	createdAt: string | null
	memory: string
}

type EvidenceSignals = {
	groundTruthTokenHitRanks: number[]
	generatedAnswerTokenHitRanks: number[]
	queryTokenCoverageTop10: number
	queryTokenCoverageTop50: number
	distinctSessionLikeIdsTop10: number
	distinctSessionLikeIdsTop50: number
	newestEvidenceRank: number | null
}

type MissCategory =
	| "answerer-ignored-present-evidence"
	| "context-distracted-by-extra-evidence"
	| "stale-or-conflicting-evidence"
	| "count-aggregation-failure"
	| "preference-evidence-missing-or-buried"
	| "retrieval-missing-evidence"
	| "judge-or-answer-format-ambiguity"
	| "unknown"

type AnalyzerReport = {
	artifactPath: string
	metadata: JsonRecord
	summary: {
		totalEvaluations: number
		cutoffs: string[]
		misses: number
		byCategory: Record<MissCategory, number>
		byQuestionType: Record<string, { misses: number; totalCutoffMisses: number }>
	}
	misses: CutoffMiss[]
	recommendations: string[]
}

function asRecord(value: unknown): JsonRecord {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as JsonRecord)
		: {}
}

function asString(value: unknown): string {
	return typeof value === "string" ? value : ""
}

function asStringArray(value: unknown): string[] {
	return Array.isArray(value)
		? value.filter((entry): entry is string => typeof entry === "string")
		: []
}

function asNumber(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null
}

const stopwords = new Set([
	"about",
	"after",
	"again",
	"been",
	"could",
	"from",
	"have",
	"many",
	"much",
	"need",
	"past",
	"that",
	"their",
	"there",
	"this",
	"times",
	"what",
	"when",
	"where",
	"which",
	"with",
	"would",
	"your",
])

function tokens(text: string): string[] {
	return [
		...new Set(
			text
				.toLowerCase()
				.split(/[^a-z0-9$%]+/)
				.filter((token) => token.length >= 3 && !stopwords.has(token)),
		),
	]
}

function salientAnswerTokens(text: string): string[] {
	const raw = tokens(text)
	const numeric = text.match(/\$?\b\d+(?:\.\d+)?%?\b|\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b/gi) ?? []
	return [...new Set([...numeric.map((token) => token.toLowerCase()), ...raw])]
		.filter((token) => token.length >= 2)
		.slice(0, 16)
}

function normalizeText(value: string): string {
	return value.toLowerCase()
}

function tokenHitRanks(searchResults: EvidenceSummary[], answer: string): number[] {
	const answerTokens = salientAnswerTokens(answer)
	if (answerTokens.length === 0) return []
	const ranks: number[] = []
	for (const result of searchResults) {
		const memory = normalizeText(result.memory)
		if (answerTokens.some((token) => memory.includes(token))) {
			ranks.push(result.rank)
		}
	}
	return ranks
}

function queryCoverage(searchResults: EvidenceSummary[], query: string, limit: number): number {
	const queryTokens = tokens(query)
	if (queryTokens.length === 0) return 0
	const seen = new Set<string>()
	for (const result of searchResults.slice(0, limit)) {
		const memory = normalizeText(result.memory)
		for (const token of queryTokens) {
			if (memory.includes(token)) seen.add(token)
		}
	}
	return Number((seen.size / queryTokens.length).toFixed(4))
}

function sessionLikeId(result: EvidenceSummary): string {
	const createdDate = result.createdAt?.slice(0, 10)
	if (createdDate) return createdDate
	const match = result.memory.match(/\b20\d\d-\d\d-\d\d\b/)
	return match?.[0] ?? result.id ?? `rank-${result.rank}`
}

function newestEvidenceRank(searchResults: EvidenceSummary[]): number | null {
	let newest: { rank: number; time: number } | null = null
	for (const result of searchResults) {
		const time = result.createdAt ? Date.parse(result.createdAt) : Number.NaN
		if (!Number.isFinite(time)) continue
		if (!newest || time > newest.time) newest = { rank: result.rank, time }
	}
	return newest?.rank ?? null
}

function summarizeEvidence(rawResults: unknown[]): EvidenceSummary[] {
	return rawResults.map((raw, index) => {
		const result = asRecord(raw)
		return {
			rank: index + 1,
			id: asString(result.id) || null,
			score: asNumber(result.score),
			createdAt: asString(result.created_at) || asString(result.createdAt) || null,
			memory: asString(result.memory) || asString(result.text) || "",
		}
	})
}

function evidenceSignals(
	searchResults: EvidenceSummary[],
	question: string,
	groundTruth: string,
	generatedAnswer: string,
): EvidenceSignals {
	return {
		groundTruthTokenHitRanks: tokenHitRanks(searchResults, groundTruth),
		generatedAnswerTokenHitRanks: tokenHitRanks(searchResults, generatedAnswer),
		queryTokenCoverageTop10: queryCoverage(searchResults, question, 10),
		queryTokenCoverageTop50: queryCoverage(searchResults, question, 50),
		distinctSessionLikeIdsTop10: new Set(searchResults.slice(0, 10).map(sessionLikeId)).size,
		distinctSessionLikeIdsTop50: new Set(searchResults.slice(0, 50).map(sessionLikeId)).size,
		newestEvidenceRank: newestEvidenceRank(searchResults),
	}
}

function hasCountIntent(question: string): boolean {
	return /\b(how many|how much|number of|count|total)\b/i.test(question)
}

function hasPreferenceIntent(question: string, groundTruth: string): boolean {
	return /\b(prefer|preference|should i|do you think|advice|suggest|recommend|tips?)\b/i.test(
		`${question}\n${groundTruth}`,
	)
}

function classifyMiss(
	question: string,
	groundTruth: string,
	generatedAnswer: string,
	cutoff: string,
	peerCutoffScore: number | null,
	signals: EvidenceSignals,
): MissCategory {
	const gtInRetrieved = signals.groundTruthTokenHitRanks.length > 0
	const genInRetrieved = signals.generatedAnswerTokenHitRanks.length > 0
	const gtInTop10 = signals.groundTruthTokenHitRanks.some((rank) => rank <= 10)
	const newestBuried =
		signals.newestEvidenceRank !== null && signals.newestEvidenceRank > 3

	if (peerCutoffScore === 1 && cutoff === "top_50") {
		return "context-distracted-by-extra-evidence"
	}
	if (hasCountIntent(question) && gtInRetrieved && genInRetrieved) {
		return "stale-or-conflicting-evidence"
	}
	if (hasCountIntent(question) && gtInRetrieved) {
		return "count-aggregation-failure"
	}
	if (hasPreferenceIntent(question, groundTruth) && !gtInTop10) {
		return "preference-evidence-missing-or-buried"
	}
	if (gtInRetrieved && newestBuried) {
		return "stale-or-conflicting-evidence"
	}
	if (gtInRetrieved) {
		return "answerer-ignored-present-evidence"
	}
	if (
		/\b\d+\b/.test(groundTruth) &&
		/\b\d+\b/.test(generatedAnswer) &&
		normalizeText(generatedAnswer).includes(normalizeText(groundTruth))
	) {
		return "judge-or-answer-format-ambiguity"
	}
	return "retrieval-missing-evidence"
}

function analyze(payload: JsonRecord, artifactPath: string): AnalyzerReport {
	const evaluations = Array.isArray(payload.evaluations)
		? payload.evaluations.map(asRecord)
		: []
	const metadata = asRecord(payload.metadata)
	const cutoffs = new Set<string>()
	const misses: CutoffMiss[] = []

	for (const evaluation of evaluations) {
		const cutoffResults = asRecord(evaluation.cutoff_results)
		const retrieval = asRecord(evaluation.retrieval)
		const rawSearchResults = Array.isArray(retrieval.search_results)
			? retrieval.search_results
			: []
		const searchResults = summarizeEvidence(rawSearchResults)
		const question = asString(evaluation.question)
		const groundTruth = asString(evaluation.ground_truth_answer)
		const questionId = asString(evaluation.question_id)
		const questionType = asString(evaluation.question_type) || "unknown"
		const answerSessionIds = asStringArray(evaluation.answer_session_ids)

		for (const [cutoff, rawCutoffResult] of Object.entries(cutoffResults)) {
			cutoffs.add(cutoff)
			const cutoffResult = asRecord(rawCutoffResult)
			const score = Number(cutoffResult.score ?? 0)
			if (score >= 1) continue
			const peerCutoffScore =
				cutoff === "top_50"
					? asNumber(asRecord(cutoffResults.top_10).score)
					: cutoff === "top_10"
						? asNumber(asRecord(cutoffResults.top_50).score)
						: null
			const generatedAnswer = asString(cutoffResult.generated_answer)
			const signals = evidenceSignals(
				searchResults,
				question,
				groundTruth,
				generatedAnswer,
			)
			misses.push({
				questionId,
				questionType,
				cutoff,
				score,
				category: classifyMiss(
					question,
					groundTruth,
					generatedAnswer,
					cutoff,
					peerCutoffScore,
					signals,
				),
				question,
				groundTruth,
				generatedAnswer,
				answerSessionIds,
				retrievedCount: searchResults.length,
				topEvidence: searchResults.slice(0, 8),
				evidenceSignals: signals,
			})
		}
	}

	const byCategory = Object.fromEntries(
		[
			"answerer-ignored-present-evidence",
			"context-distracted-by-extra-evidence",
			"stale-or-conflicting-evidence",
			"count-aggregation-failure",
			"preference-evidence-missing-or-buried",
			"retrieval-missing-evidence",
			"judge-or-answer-format-ambiguity",
			"unknown",
		].map((category) => [category, 0]),
	) as Record<MissCategory, number>
	const byQuestionType: Record<string, { misses: number; totalCutoffMisses: number }> =
		{}
	for (const miss of misses) {
		byCategory[miss.category] += 1
		byQuestionType[miss.questionType] ??= { misses: 0, totalCutoffMisses: 0 }
		byQuestionType[miss.questionType].misses += 1
		byQuestionType[miss.questionType].totalCutoffMisses += 1
	}

	return {
		artifactPath,
		metadata,
		summary: {
			totalEvaluations: evaluations.length,
			cutoffs: [...cutoffs].sort(),
			misses: misses.length,
			byCategory,
			byQuestionType,
		},
		misses,
		recommendations: [
			"Do not tune by question id. Fix only generic product behavior.",
			"For count misses, improve count evidence packing and conflict/current-state labeling.",
			"For top_50 regressions, compress or order answer context so additional evidence cannot distract the answerer.",
			"For preference misses, preserve user-specific preference evidence and source timestamps in the answer context.",
			"For retrieval-missing-evidence, inspect MongoDB Search scoreDetails/rankFusion details before changing ranking weights.",
		],
	}
}

function renderMarkdown(report: AnalyzerReport): string {
	const lines = [
		"# Mem0 LongMemEval Answerer Miss Analysis",
		"",
		`Artifact: \`${report.artifactPath}\``,
		`Run ID: \`${asString(report.metadata.run_id) || "unknown"}\``,
		`Evaluations: ${report.summary.totalEvaluations}`,
		`Cutoffs: ${report.summary.cutoffs.join(", ")}`,
		`Cutoff misses: ${report.summary.misses}`,
		"",
		"## Category Summary",
		"",
		"| Category | Misses |",
		"| --- | ---: |",
	]
	for (const [category, count] of Object.entries(report.summary.byCategory)) {
		if (count > 0) lines.push(`| ${category} | ${count} |`)
	}
	lines.push("", "## Question-Type Summary", "", "| Type | Misses |", "| --- | ---: |")
	for (const [questionType, item] of Object.entries(report.summary.byQuestionType)) {
		lines.push(`| ${questionType} | ${item.misses} |`)
	}
	lines.push("", "## Miss Ledger", "")
	for (const miss of report.misses) {
		lines.push(
			`### ${miss.questionId} / ${miss.cutoff} / ${miss.category}`,
			"",
			`Type: \`${miss.questionType}\``,
			`Question: ${miss.question}`,
			`Ground truth: ${miss.groundTruth}`,
			`Generated: ${miss.generatedAnswer.replace(/\n/g, " ")}`,
			`Evidence signal: gt ranks ${miss.evidenceSignals.groundTruthTokenHitRanks.join(", ") || "none"}; generated ranks ${miss.evidenceSignals.generatedAnswerTokenHitRanks.join(", ") || "none"}; newest rank ${miss.evidenceSignals.newestEvidenceRank ?? "unknown"}`,
			"",
			"Top evidence:",
		)
		for (const evidence of miss.topEvidence.slice(0, 5)) {
			lines.push(
				`- #${evidence.rank} score=${evidence.score ?? "n/a"} created=${evidence.createdAt ?? "n/a"} id=${evidence.id ?? "n/a"}: ${evidence.memory.replace(/\s+/g, " ").slice(0, 240)}`,
			)
		}
		lines.push("")
	}
	lines.push("## Recommendations", "")
	for (const recommendation of report.recommendations) {
		lines.push(`- ${recommendation}`)
	}
	return `${lines.join("\n")}\n`
}

function parseArgs(argv: string[]): {
	artifactPath?: string
	outDir?: string
	jsonOnly: boolean
} {
	let artifactPath: string | undefined
	let outDir: string | undefined
	let jsonOnly = false
	for (const arg of argv) {
		if (arg === "--json") {
			jsonOnly = true
		} else if (arg.startsWith("--out-dir=")) {
			outDir = arg.slice("--out-dir=".length)
		} else if (!arg.startsWith("--") && !artifactPath) {
			artifactPath = arg
		} else {
			throw new Error(`unknown argument: ${arg}`)
		}
	}
	return { artifactPath, outDir, jsonOnly }
}

if (import.meta.main) {
	try {
		const { artifactPath, outDir, jsonOnly } = parseArgs(process.argv.slice(2))
		if (!artifactPath) {
			throw new Error(
				"usage: bun scripts/analyze-memory-benchmarks-answerer-misses.ts <longmemeval_results.json> [--out-dir=DIR] [--json]",
			)
		}
		if (!existsSync(artifactPath)) {
			throw new Error(`artifact not found: ${artifactPath}`)
		}
		const payload = JSON.parse(readFileSync(artifactPath, "utf8")) as JsonRecord
		const report = analyze(payload, artifactPath)
		if (outDir) {
			mkdirSync(outDir, { recursive: true })
			writeFileSync(join(outDir, "answerer-miss-analysis.json"), JSON.stringify(report, null, 2))
			writeFileSync(join(outDir, "answerer-miss-analysis.md"), renderMarkdown(report))
		} else if (jsonOnly) {
			console.log(JSON.stringify(report, null, 2))
		} else {
			const tempPath = join(dirname(artifactPath), "answerer-miss-analysis.md")
			writeFileSync(tempPath, renderMarkdown(report))
			console.log(renderMarkdown(report))
		}
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error))
		process.exit(1)
	}
}
