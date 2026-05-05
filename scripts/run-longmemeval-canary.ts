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

const CASES_PER_TYPE = 8

const repoRoot = process.cwd()
const workspaceDir =
	process.env.MEMONGO_WORKSPACE_DIR?.trim() ||
	path.join(os.homedir(), ".memongo", "workspace")
const datasetPath =
	process.env.MEMONGO_CANARY_DATASET_PATH?.trim() ||
	process.env.MEMONGO_BENCHMARK_DATASET_PATH?.trim() ||
	path.join(workspaceDir, "benchmarks", "longmemeval_s_cleaned.json")
const artifactRoot = path.join(
	repoRoot,
	".claude",
	"cc10x",
	"v10",
	"workflows",
	"memongo-memory-hardening",
	"artifacts",
	"canary-runs",
)
const port = Number(process.env.MEMONGO_API_PORT?.trim() || "3847")
const baseUrl = `http://127.0.0.1:${port}`
const maxResults = Number(
	process.env.MEMONGO_BENCHMARK_MAX_RESULTS?.trim() || "50",
)
const dryRun = process.env.MEMONGO_CANARY_DRY_RUN === "1"

// ---------------------------------------------------------------------------
// Stratified selection (exported for testability)
// ---------------------------------------------------------------------------

export function selectStratifiedSubset(
	entries: RawLongMemEvalEntry[],
	casesPerType: number,
): {
	selected: RawLongMemEvalEntry[]
	selectedQuestionIds: string[]
	breakdown: Record<string, number>
} {
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

	return { selected, selectedQuestionIds, breakdown }
}

// ---------------------------------------------------------------------------
// HTTP helper (no-timeout, reused from the full runner pattern)
// ---------------------------------------------------------------------------

function postJsonNoTimeout(params: {
	url: string
	payload: unknown
}): Promise<{ statusCode: number; body: string }> {
	const body = JSON.stringify(params.payload)
	const parsed = new URL(params.url)
	return new Promise((resolve, reject) => {
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
				timeout: 0,
			},
			(res) => {
				const chunks: Buffer[] = []
				res.on("data", (chunk: Buffer) => chunks.push(chunk))
				res.on("end", () => {
					resolve({
						statusCode: res.statusCode ?? 0,
						body: Buffer.concat(chunks).toString("utf8"),
					})
				})
			},
		)
		req.on("error", reject)
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
	const runDir = path.join(artifactRoot, runId)

	console.log(`[canary] run=${runId} dataset=${datasetPath} dryRun=${dryRun}`)

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

	// Select stratified subset
	const { selected, selectedQuestionIds, breakdown } = selectStratifiedSubset(
		entries,
		CASES_PER_TYPE,
	)

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
	const response = await postJsonNoTimeout({
		url: `${baseUrl}/v1/admin/relevance/benchmark`,
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
