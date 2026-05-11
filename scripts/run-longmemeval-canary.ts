/**
 * Stratified LongMemEval canary runner.
 *
 * Selects a deterministic 48-evaluation subset from the official LongMemEval-S
 * dataset: 8 evaluation cases per question type when available, chosen by
 * stable sort on question_id.
 *
 * The canary preserves the official benchmark path by calling the same
 * /v1/admin/relevance/benchmark API with a subset dataset file. The subset
 * is written in the same raw LongMemEval format so the benchmark normalizer
 * handles it identically to the full dataset.
 */

import { createHash, randomUUID } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import http from "node:http"
import os from "node:os"
import path from "node:path"

// ---------------------------------------------------------------------------
// Types (raw LongMemEval entry shape)
// ---------------------------------------------------------------------------

export type RawLongMemEvalEntry = {
	question_id: string
	question_type: string
	question: string
	question_date?: string
	answer?: string
	answer_session_ids?: string[]
	haystack_session_ids?: string[]
	haystack_dates?: string[]
	haystack_sessions?: Record<string, unknown>[]
}

type CanaryArtifact = {
	runId: string
	startedAt: string
	completedAt?: string
	datasetPath: string
	datasetHash: string
	casesPerType: number
	totalCaseLimit?: number
	selectedQuestionIdFilter?: string[]
	totalEvaluations: number
	selectedQuestionIds: string[]
	questionTypeBreakdown: Record<string, number>
	metrics?: Record<string, unknown>
	benchmarkResponse?: unknown
	error?: string
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const CASES_PER_TYPE = Math.max(
	1,
	Math.floor(Number(process.env.MEMONGO_CANARY_CASES_PER_TYPE?.trim()) || 8),
)

const repoRoot = process.cwd()
const workspaceDir =
	process.env.MEMONGO_WORKSPACE_DIR?.trim() ||
	path.join(os.homedir(), ".memongo", "workspace")
const datasetPath =
	process.env.MEMONGO_CANARY_DATASET_PATH?.trim() ||
	process.env.MEMONGO_BENCHMARK_DATASET_PATH?.trim() ||
	path.join(workspaceDir, "benchmarks", "longmemeval_s_cleaned.json")
const port = Number(process.env.MEMONGO_API_PORT?.trim() || "3847")
const baseUrl = `http://127.0.0.1:${port}`
const maxResults = Number(
	process.env.MEMONGO_BENCHMARK_MAX_RESULTS?.trim() || "50",
)
const dryRun = process.env.MEMONGO_CANARY_DRY_RUN === "1"
const totalCaseLimitRaw = process.env.MEMONGO_CANARY_TOTAL_CASES?.trim()
const totalCaseLimit = totalCaseLimitRaw
	? Math.max(1, Math.floor(Number(totalCaseLimitRaw) || 1))
	: undefined
const selectedQuestionIdFilter =
	process.env.MEMONGO_CANARY_QUESTION_IDS?.split(",")
		.map((id) => id.trim())
		.filter(Boolean) ?? []

// ---------------------------------------------------------------------------
// Env-var contract helpers (Task 1.0 — exported for testability)
// ---------------------------------------------------------------------------

/**
 * Resolve the canary artifact directory. MEMONGO_CANARY_ARTIFACT_DIR, when set
 * and non-blank, is used verbatim — runId is NOT appended. Otherwise the
 * default root + runId is returned so each run gets its own subdirectory.
 */
export function resolveCanaryArtifactDir(params: {
	runId: string
	envDir: string | undefined
	repoRoot?: string
}): string {
	const trimmed = params.envDir?.trim()
	if (trimmed && trimmed.length > 0) {
		return params.envDir as string
	}
	const root = params.repoRoot ?? process.cwd()
	return path.join(
		root,
		".claude",
		"cc10x",
		"v10",
		"workflows",
		"memongo-memory-hardening",
		"artifacts",
		"canary-runs",
		params.runId,
	)
}

/** MEMONGO_CANARY_FULL=1 is truthy; every other value (including "true") is false. */
export function resolveCanaryFullMode(envValue: string | undefined): boolean {
	return envValue === "1"
}

/** MEMONGO_CANARY_RESUME=1 is truthy; every other value is false. */
export function resolveCanaryResumeMode(envValue: string | undefined): boolean {
	return envValue === "1"
}

// ---------------------------------------------------------------------------
// Stratified selection (exported for testability)
// ---------------------------------------------------------------------------

export function selectStratifiedSubset(
	entries: RawLongMemEvalEntry[],
	casesPerType: number,
	options: {
		totalCaseLimit?: number
		questionIds?: string[]
	} = {},
): {
	selected: RawLongMemEvalEntry[]
	selectedQuestionIds: string[]
	breakdown: Record<string, number>
} {
	if (options.questionIds && options.questionIds.length > 0) {
		const requested = new Set(options.questionIds)
		const selected = entries.filter((entry) => requested.has(entry.question_id))
		const found = new Set(selected.map((entry) => entry.question_id))
		const missing = [...requested].filter((id) => !found.has(id))
		if (missing.length > 0) {
			throw new Error(
				`Requested question_id(s) not found: ${missing.join(", ")}`,
			)
		}
		return summarizeSelectedEntries(selected)
	}

	// Group by question_type
	const byType = new Map<string, RawLongMemEvalEntry[]>()
	for (const entry of entries) {
		const qt = entry.question_type?.trim() || "unknown"
		const group = byType.get(qt) || []
		group.push(entry)
		byType.set(qt, group)
	}

	// Stable sort within each group by question_id and select top N
	const selected: RawLongMemEvalEntry[] = []
	const selectedQuestionIds: string[] = []
	const breakdown: Record<string, number> = {}

	for (const [qt, group] of [...byType.entries()].sort((a, b) =>
		a[0].localeCompare(b[0]),
	)) {
		group.sort((a, b) => a.question_id.localeCompare(b.question_id))
		const picked = group.slice(0, casesPerType)
		selected.push(...picked)
		for (const entry of picked) {
			selectedQuestionIds.push(entry.question_id)
		}
		breakdown[qt] = picked.length
	}

	return summarizeSelectedEntries(
		options.totalCaseLimit
			? selected.slice(0, options.totalCaseLimit)
			: selected,
	)
}

function summarizeSelectedEntries(entries: RawLongMemEvalEntry[]): {
	selected: RawLongMemEvalEntry[]
	selectedQuestionIds: string[]
	breakdown: Record<string, number>
} {
	const selectedQuestionIds: string[] = []
	const breakdown: Record<string, number> = {}
	for (const entry of entries) {
		selectedQuestionIds.push(entry.question_id)
		const qt = entry.question_type?.trim() || "unknown"
		breakdown[qt] = (breakdown[qt] ?? 0) + 1
	}
	return { selected: entries, selectedQuestionIds, breakdown }
}

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------

export function resolveCanaryHttpTimeoutMs(
	envValue: string | undefined,
): number {
	if (envValue === undefined || envValue.trim() === "") return 20 * 60 * 1000
	const parsed = Number(envValue)
	if (!Number.isFinite(parsed) || parsed < 0) {
		throw new Error(
			`MEMONGO_CANARY_HTTP_TIMEOUT_MS must be a non-negative number, got ${envValue}`,
		)
	}
	return Math.floor(parsed)
}

function postJson(params: {
	url: string
	payload: unknown
	timeoutMs: number
}): Promise<{ statusCode: number; body: string }> {
	const body = JSON.stringify(params.payload)
	const parsed = new URL(params.url)
	return new Promise((resolve, reject) => {
		let settled = false
		const req = http.request(
			{
				hostname: parsed.hostname,
				port: parsed.port || 80,
				path: parsed.pathname + parsed.search,
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"Content-Length": Buffer.byteLength(body),
				},
				timeout: params.timeoutMs,
			},
			(res) => {
				const chunks: Buffer[] = []
				res.on("data", (chunk: Buffer) => chunks.push(chunk))
				res.on("end", () => {
					settled = true
					resolve({
						statusCode: res.statusCode ?? 0,
						body: Buffer.concat(chunks).toString("utf8"),
					})
				})
			},
		)
		req.on("timeout", () => {
			if (settled) return
			settled = true
			req.destroy(
				new Error(
					`canary benchmark request timed out after ${params.timeoutMs}ms`,
				),
			)
		})
		req.on("error", (err) => {
			if (settled) return
			settled = true
			reject(err)
		})
		req.write(body)
		req.end()
	})
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
	const startedAt = new Date()
	const runId =
		process.env.MEMONGO_CANARY_RUN_ID?.trim() ||
		`canary-${startedAt.toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`
	const runDir = resolveCanaryArtifactDir({
		runId,
		envDir: process.env.MEMONGO_CANARY_ARTIFACT_DIR,
		repoRoot,
	})
	const fullMode = resolveCanaryFullMode(process.env.MEMONGO_CANARY_FULL)

	console.log(
		`[canary] run=${runId} dataset=${datasetPath} dryRun=${dryRun} fullMode=${fullMode} runDir=${runDir}`,
	)

	// Load dataset
	if (!existsSync(datasetPath)) {
		throw new Error(`Dataset not found: ${datasetPath}`)
	}
	const raw = readFileSync(datasetPath, "utf8")
	const dataset = JSON.parse(raw) as unknown
	const datasetHash = createHash("sha256").update(raw).digest("hex")

	// Validate it is a raw LongMemEval array
	if (!Array.isArray(dataset) || dataset.length === 0) {
		throw new Error(
			"Dataset must be a non-empty JSON array of LongMemEval entries",
		)
	}
	const entries = dataset as RawLongMemEvalEntry[]

	// Select stratified subset.
	// MEMONGO_CANARY_FULL=1 overrides the stratified subset: run every scenario
	// in the dataset, ignoring MEMONGO_CANARY_CASES_PER_TYPE and
	// MEMONGO_CANARY_TOTAL_CASES (but still honoring an explicit question-id
	// filter, since that's a narrower intent).
	const { selected, selectedQuestionIds, breakdown } = fullMode
		? selectStratifiedSubset(entries, entries.length, {
				questionIds:
					selectedQuestionIdFilter.length > 0
						? selectedQuestionIdFilter
						: undefined,
			})
		: selectStratifiedSubset(entries, CASES_PER_TYPE, {
				totalCaseLimit,
				questionIds: selectedQuestionIdFilter,
			})

	console.log(
		`[canary] selected ${selectedQuestionIds.length} evaluations across ${Object.keys(breakdown).length} types from ${entries.length} total`,
	)
	for (const [qt, count] of Object.entries(breakdown)) {
		console.log(`  ${qt}: ${count}`)
	}

	// Write subset dataset inside the workspace so the benchmark API accepts it
	mkdirSync(runDir, { recursive: true })
	const subsetDir = path.join(workspaceDir, "benchmarks", "canary")
	mkdirSync(subsetDir, { recursive: true })
	const subsetPath = path.join(subsetDir, `${runId}.json`)
	writeFileSync(subsetPath, JSON.stringify(selected, null, 2))

	const artifact: CanaryArtifact = {
		runId,
		startedAt: startedAt.toISOString(),
		datasetPath,
		datasetHash,
		casesPerType: CASES_PER_TYPE,
		...(totalCaseLimit ? { totalCaseLimit } : {}),
		...(selectedQuestionIdFilter.length > 0
			? { selectedQuestionIdFilter }
			: {}),
		totalEvaluations: selectedQuestionIds.length,
		selectedQuestionIds,
		questionTypeBreakdown: breakdown,
	}

	if (dryRun) {
		artifact.completedAt = new Date().toISOString()
		const artifactPath = path.join(runDir, "canary-artifact.json")
		writeFileSync(artifactPath, JSON.stringify(artifact, null, 2))
		console.log(`[canary] dry-run complete. Artifact: ${artifactPath}`)
		console.log(JSON.stringify({ ok: true, runId, dryRun: true }, null, 2))
		return
	}

	// Call benchmark API with the subset
	const agentId = `canary-${runId}`
	console.log(
		`[canary] posting benchmark to ${baseUrl}/v1/admin/relevance/benchmark`,
	)
	const response = await postJson({
		url: `${baseUrl}/v1/admin/relevance/benchmark`,
		timeoutMs: resolveCanaryHttpTimeoutMs(
			process.env.MEMONGO_CANARY_HTTP_TIMEOUT_MS,
		),
		payload: {
			agentId,
			datasetPath: subsetPath,
			maxResults,
		},
	})

	if (response.statusCode < 200 || response.statusCode >= 300) {
		artifact.error = `HTTP ${response.statusCode}: ${response.body.slice(0, 500)}`
		artifact.completedAt = new Date().toISOString()
		const artifactPath = path.join(runDir, "canary-artifact.json")
		writeFileSync(artifactPath, JSON.stringify(artifact, null, 2))
		throw new Error(artifact.error)
	}

	const benchmarkResponse = JSON.parse(response.body) as Record<string, unknown>
	artifact.benchmarkResponse = benchmarkResponse
	artifact.metrics = benchmarkResponse.benchmarkReport as
		| Record<string, unknown>
		| undefined
	artifact.completedAt = new Date().toISOString()

	// Write artifacts
	const artifactPath = path.join(runDir, "canary-artifact.json")
	const responsePath = path.join(runDir, "benchmark-response.json")
	writeFileSync(artifactPath, JSON.stringify(artifact, null, 2))
	writeFileSync(responsePath, JSON.stringify(benchmarkResponse, null, 2))

	console.log(`[canary] complete. Artifact: ${artifactPath}`)
	console.log(
		JSON.stringify(
			{
				ok: true,
				runId,
				totalEvaluations: selectedQuestionIds.length,
				breakdown,
				artifactPath,
				responsePath,
			},
			null,
			2,
		),
	)
}

main().catch((err) => {
	console.error(err instanceof Error ? err.stack || err.message : err)
	process.exitCode = 1
})
