import { existsSync, readFileSync } from "node:fs"

type JsonRecord = Record<string, unknown>

export type AnswererArtifactStatus = {
	ok: boolean
	artifactPath: string
	mode: string | null
	evaluations: number
	cutoffsChecked: string[]
	failures: string[]
	warnings: string[]
}

export type AnswererArtifactOptions = {
	cutoff?: string
	requireAnswererMode?: boolean
}

function asRecord(value: unknown): JsonRecord {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as JsonRecord)
		: {}
}

function asString(value: unknown): string {
	return typeof value === "string" ? value : ""
}

function cutoffEntries(
	cutoffResults: JsonRecord,
	requestedCutoff?: string,
): [string, JsonRecord][] {
	if (requestedCutoff) {
		return [[requestedCutoff, asRecord(cutoffResults[requestedCutoff])]]
	}
	return Object.entries(cutoffResults).map(([label, value]) => [
		label,
		asRecord(value),
	])
}

export function evaluateAnswererArtifact(
	payload: JsonRecord,
	artifactPath: string,
	options: AnswererArtifactOptions = {},
): AnswererArtifactStatus {
	const failures: string[] = []
	const warnings: string[] = []
	const metadata = asRecord(payload.metadata)
	const mode = asString(metadata.mode) || null
	const evaluations = Array.isArray(payload.evaluations)
		? payload.evaluations
		: []
	const cutoffsChecked = new Set<string>()

	if (options.requireAnswererMode !== false && mode && mode !== "answerer") {
		failures.push(`metadata.mode=${mode}; expected answerer`)
	}
	if (!Array.isArray(payload.evaluations)) {
		failures.push("evaluations array missing")
	}

	for (const [index, rawEvaluation] of evaluations.entries()) {
		const evaluation = asRecord(rawEvaluation)
		const questionId = asString(evaluation.question_id) || `index-${index}`
		const questionType = asString(evaluation.question_type) || "unknown"
		const isAbstention = evaluation.is_abstention === true
		const cutoffResults = asRecord(evaluation.cutoff_results)
		const entries = cutoffEntries(cutoffResults, options.cutoff)

		if (entries.length === 0) {
			failures.push(`${questionId} (${questionType}): cutoff_results missing`)
			continue
		}

		for (const [label, result] of entries) {
			cutoffsChecked.add(label)
			if (Object.keys(result).length === 0) {
				failures.push(`${questionId} (${questionType}) ${label}: result missing`)
				continue
			}

			const generatedAnswer = asString(result.generated_answer).trim()
			if (!isAbstention && !generatedAnswer) {
				failures.push(
					`${questionId} (${questionType}) ${label}: generated_answer is empty`,
				)
			}

			const judgeRaw = asString(result.judge_raw).trim()
			if (!judgeRaw) {
				warnings.push(`${questionId} (${questionType}) ${label}: judge_raw empty`)
			}
		}

		const retrieval = asRecord(evaluation.retrieval)
		const searchResults = Array.isArray(retrieval.search_results)
			? retrieval.search_results
			: []
		if (!isAbstention && searchResults.length === 0) {
			failures.push(`${questionId} (${questionType}): retrieval.search_results empty`)
		}
	}

	return {
		ok: failures.length === 0,
		artifactPath,
		mode,
		evaluations: evaluations.length,
		cutoffsChecked: [...cutoffsChecked].sort(),
		failures,
		warnings,
	}
}

export function parseArgs(argv: string[]): {
	artifactPath?: string
	options: AnswererArtifactOptions
	json: boolean
} {
	let artifactPath: string | undefined
	let cutoff: string | undefined
	let json = false
	let requireAnswererMode = true

	for (const arg of argv) {
		if (arg === "--json") {
			json = true
		} else if (arg === "--allow-non-answerer-mode") {
			requireAnswererMode = false
		} else if (arg.startsWith("--cutoff=")) {
			cutoff = arg.slice("--cutoff=".length).trim()
		} else if (!arg.startsWith("--") && !artifactPath) {
			artifactPath = arg
		} else {
			throw new Error(`unknown argument: ${arg}`)
		}
	}

	return {
		artifactPath,
		options: { cutoff, requireAnswererMode },
		json,
	}
}

function renderStatus(status: AnswererArtifactStatus): string {
	const lines = [
		`artifact: ${status.artifactPath}`,
		`mode: ${status.mode ?? "unknown"}`,
		`evaluations: ${status.evaluations}`,
		`cutoffs: ${status.cutoffsChecked.join(", ") || "none"}`,
		`status: ${status.ok ? "PASS" : "FAIL"}`,
	]
	if (status.failures.length > 0) {
		lines.push("", "failures:")
		for (const failure of status.failures) lines.push(`- ${failure}`)
	}
	if (status.warnings.length > 0) {
		lines.push("", "warnings:")
		for (const warning of status.warnings) lines.push(`- ${warning}`)
	}
	return lines.join("\n")
}

if (import.meta.main) {
	try {
		const parsed = parseArgs(process.argv.slice(2))
		if (!parsed.artifactPath) {
			throw new Error(
				"usage: bun scripts/check-memory-benchmarks-answerer-artifact.ts <artifact.json> [--cutoff=top_50] [--json]",
			)
		}
		if (!existsSync(parsed.artifactPath)) {
			throw new Error(`artifact not found: ${parsed.artifactPath}`)
		}
		const payload = JSON.parse(readFileSync(parsed.artifactPath, "utf8")) as JsonRecord
		const status = evaluateAnswererArtifact(
			payload,
			parsed.artifactPath,
			parsed.options,
		)
		console.log(
			parsed.json ? JSON.stringify(status, null, 2) : renderStatus(status),
		)
		process.exit(status.ok ? 0 : 1)
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error))
		process.exit(1)
	}
}
