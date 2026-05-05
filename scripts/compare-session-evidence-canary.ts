/**
 * Session-Evidence ADR Canary Comparison
 *
 * Reads two canary artifacts (one for Option A, one for Option B) and
 * produces a side-by-side comparison of retrieval metrics for the ADR
 * decision documented in docs/plans/2026-04-14-session-evidence-architecture-adr.md.
 *
 * Usage:
 *   MEMONGO_SESSION_EVIDENCE_MODE=A bun scripts/run-longmemeval-canary.ts
 *   MEMONGO_SESSION_EVIDENCE_MODE=B bun scripts/run-longmemeval-canary.ts
 *   bun scripts/compare-session-evidence-canary.ts \
 *     --option-a <path-to-option-a-canary-artifact.json> \
 *     --option-b <path-to-option-b-canary-artifact.json>
 *
 * Alternatively, pass paths via env vars:
 *   OPTION_A_ARTIFACT=<path> OPTION_B_ARTIFACT=<path> bun scripts/compare-session-evidence-canary.ts
 *
 * Also supports a "none" baseline:
 *   --baseline <path-to-no-session-evidence-canary-artifact.json>
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs"
import path from "node:path"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type CanaryArtifact = {
	runId: string
	startedAt: string
	completedAt?: string
	totalEvaluations: number
	questionTypeBreakdown: Record<string, number>
	metrics?: Record<string, unknown>
	benchmarkResponse?: Record<string, unknown>
	error?: string
}

type MetricsSummary = {
	mode: string
	runId: string
	hitRate: number | null
	r5: number | null
	r10: number | null
	ndcg10: number | null
	scoredCases: number | null
	totalEvaluations: number
	perType: Record<
		string,
		{ r5: number | null; r10: number | null; count: number }
	>
	latencyP95Ms: number | null
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function loadArtifact(filePath: string): CanaryArtifact {
	if (!existsSync(filePath)) {
		throw new Error(`Artifact not found: ${filePath}`)
	}
	return JSON.parse(readFileSync(filePath, "utf8")) as CanaryArtifact
}

function extractMetrics(
	artifact: CanaryArtifact,
	mode: string,
): MetricsSummary {
	// Navigate the actual benchmark response schema:
	// benchmarkResponse.benchmarkReport.metrics.internal has the top-line metrics
	// benchmarkResponse.questionTypeBreakdown is an ARRAY of per-type objects
	const benchResp = (artifact.benchmarkResponse ?? {}) as Record<
		string,
		unknown
	>
	const report = (benchResp.benchmarkReport ?? {}) as Record<string, unknown>
	const metrics = (report.metrics ?? {}) as Record<string, unknown>
	const internal = (metrics.internal ?? {}) as Record<string, unknown>
	const perTypeArray = (benchResp.questionTypeBreakdown ?? []) as Array<
		Record<string, unknown>
	>

	const perType: MetricsSummary["perType"] = {}
	for (const entry of perTypeArray) {
		const qt =
			typeof entry.questionType === "string" ? entry.questionType : "unknown"
		perType[qt] = {
			r5: typeof entry.rAt5 === "number" ? entry.rAt5 : null,
			r10: typeof entry.rAt10 === "number" ? entry.rAt10 : null,
			count: typeof entry.cases === "number" ? entry.cases : 0,
		}
	}

	return {
		mode,
		runId: artifact.runId,
		hitRate: typeof internal.hitRate === "number" ? internal.hitRate : null,
		r5: typeof internal.rAt5 === "number" ? internal.rAt5 : null,
		r10: typeof internal.rAt10 === "number" ? internal.rAt10 : null,
		ndcg10: typeof internal.ndcgAt10 === "number" ? internal.ndcgAt10 : null,
		scoredCases: (() => {
			// scoredCases lives under benchmarkReport.corpus, not metrics.internal
			const corpus = (report.corpus ?? {}) as Record<string, unknown>
			if (typeof corpus.scoredCases === "number") return corpus.scoredCases
			// fallback: check internal for older response shapes
			if (typeof internal.scoredCases === "number") return internal.scoredCases
			return null
		})(),
		totalEvaluations: artifact.totalEvaluations,
		perType,
		latencyP95Ms:
			typeof internal.p95LatencyMs === "number" ? internal.p95LatencyMs : null,
	}
}

function formatPercent(value: number | null): string {
	if (value === null) return "N/A"
	return `${(value * 100).toFixed(1)}%`
}

function formatMs(value: number | null): string {
	if (value === null) return "N/A"
	return `${value.toFixed(0)}ms`
}

function buildComparisonTable(summaries: MetricsSummary[]): {
	header: string[]
	rows: string[][]
} {
	const header = [
		"Metric",
		...summaries.map((s) => `${s.mode} (${s.runId.slice(0, 16)})`),
	]
	const rows: string[][] = []

	rows.push(["R@5", ...summaries.map((s) => formatPercent(s.r5))])
	rows.push(["R@10", ...summaries.map((s) => formatPercent(s.r10))])
	rows.push(["NDCG@10", ...summaries.map((s) => formatPercent(s.ndcg10))])
	rows.push(["Hit Rate", ...summaries.map((s) => formatPercent(s.hitRate))])
	rows.push(["P95 Latency", ...summaries.map((s) => formatMs(s.latencyP95Ms))])
	rows.push([
		"Scored Cases",
		...summaries.map((s) => String(s.scoredCases ?? "N/A")),
	])

	// Per-type R@5 breakdown
	const allTypes = new Set<string>()
	for (const s of summaries) {
		for (const qt of Object.keys(s.perType)) {
			allTypes.add(qt)
		}
	}
	for (const qt of [...allTypes].sort()) {
		rows.push([
			`  ${qt} R@5`,
			...summaries.map((s) => {
				const data = s.perType[qt]
				return data ? `${formatPercent(data.r5)} (n=${data.count})` : "N/A"
			}),
		])
		rows.push([
			`  ${qt} R@10`,
			...summaries.map((s) => {
				const data = s.perType[qt]
				return data ? `${formatPercent(data.r10)} (n=${data.count})` : "N/A"
			}),
		])
	}

	return { header, rows }
}

function renderTable(table: { header: string[]; rows: string[][] }): string {
	const allRows = [table.header, ...table.rows]
	const colWidths = table.header.map((_, i) =>
		Math.max(...allRows.map((row) => (row[i] ?? "").length)),
	)
	const pad = (s: string, w: number) => s.padEnd(w)
	const sep = colWidths.map((w) => "-".repeat(w)).join(" | ")
	const lines = [
		colWidths.map((w, i) => pad(table.header[i], w)).join(" | "),
		sep,
		...table.rows.map((row) =>
			colWidths.map((w, i) => pad(row[i] ?? "", w)).join(" | "),
		),
	]
	return lines.join("\n")
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function parseArgs(): {
	optionA?: string
	optionB?: string
	baseline?: string
	outputDir?: string
} {
	const args = process.argv.slice(2)
	const result: Record<string, string> = {}
	for (let i = 0; i < args.length; i++) {
		if (args[i] === "--option-a" && args[i + 1]) {
			result.optionA = args[++i]
		} else if (args[i] === "--option-b" && args[i + 1]) {
			result.optionB = args[++i]
		} else if (args[i] === "--baseline" && args[i + 1]) {
			result.baseline = args[++i]
		} else if (args[i] === "--output-dir" && args[i + 1]) {
			result.outputDir = args[++i]
		}
	}
	return {
		optionA: result.optionA ?? process.env.OPTION_A_ARTIFACT,
		optionB: result.optionB ?? process.env.OPTION_B_ARTIFACT,
		baseline: result.baseline ?? process.env.BASELINE_ARTIFACT,
		outputDir: result.outputDir,
	}
}

async function main() {
	const args = parseArgs()
	const summaries: MetricsSummary[] = []

	if (args.baseline) {
		const artifact = loadArtifact(args.baseline)
		summaries.push(extractMetrics(artifact, "none (baseline)"))
	}
	if (args.optionA) {
		const artifact = loadArtifact(args.optionA)
		summaries.push(extractMetrics(artifact, "Option A (extend chunks)"))
	}
	if (args.optionB) {
		const artifact = loadArtifact(args.optionB)
		summaries.push(extractMetrics(artifact, "Option B (session_chunks)"))
	}

	if (summaries.length === 0) {
		console.error(
			"No artifacts provided. Use --option-a, --option-b, and/or --baseline flags.",
		)
		process.exit(1)
	}

	console.log("\n=== Session-Evidence ADR Canary Comparison ===\n")

	const table = buildComparisonTable(summaries)
	console.log(renderTable(table))

	// Determine winner
	if (summaries.length >= 2) {
		const byR5 = [...summaries].sort((a, b) => (b.r5 ?? 0) - (a.r5 ?? 0))
		console.log(`\n--- Winner by R@5 ---`)
		console.log(
			`  ${byR5[0].mode}: ${formatPercent(byR5[0].r5)} vs ${byR5[1].mode}: ${formatPercent(byR5[1].r5)}`,
		)
		if (byR5[0].r5 === byR5[1].r5) {
			console.log(
				"  Tie on R@5 — apply tie-break rules from the ADR (provenance simplicity, retrieval authority, harmony risk).",
			)
		}
	}

	// Save comparison artifact
	if (args.outputDir) {
		mkdirSync(args.outputDir, { recursive: true })
		const comparisonPath = path.join(
			args.outputDir,
			"session-evidence-comparison.json",
		)
		writeFileSync(
			comparisonPath,
			JSON.stringify(
				{
					generatedAt: new Date().toISOString(),
					summaries,
					table: { header: table.header, rows: table.rows },
				},
				null,
				2,
			),
		)
		console.log(`\nComparison artifact: ${comparisonPath}`)
	}

	console.log("\nDone.")
}

main().catch((err) => {
	console.error("Comparison failed:", err)
	process.exit(1)
})
