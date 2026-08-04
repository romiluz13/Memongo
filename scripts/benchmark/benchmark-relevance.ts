import { randomUUID } from "node:crypto"
import { readFile } from "node:fs/promises"
import { createSubsystemLogger } from "@memongo/lib"
import type { Db } from "mongodb"
import { relevanceRegressionsCollection } from "../../packages/memory-engine/src/mongodb-schema.js"
import type {
	MemoryBenchmarkCaseOutcome,
	MemoryBenchmarkDatasetKind,
	MemoryBenchmarkExecutionSummary,
	MemoryBenchmarkLaneLatencySummary,
	MemoryBenchmarkMeasurementPasses,
	MemoryBenchmarkOfficialMetrics,
	MemoryBenchmarkQuestionTypeMetrics,
	MemoryBenchmarkRunReport,
	MemorySearchResult,
	QueryGovernanceReport,
} from "../../packages/memory-engine/src/types.js"
import type {
	BenchmarkCaseDiagnosticEntry,
	BenchmarkMissLedgerEntry,
} from "./mongodb-benchmark-runner.js"

const log = createSubsystemLogger("memory:mongodb:benchmark-relevance")

export type RelevanceSourceScope = "all" | "memory" | "kb" | "structured"

export type RelevanceBenchmarkCase = {
	query: string
	sourceScope?: RelevanceSourceScope
	minTopScore?: number
	expectedSources?: string[]
}

export type RelevanceBenchmarkResult = {
	datasetVersion: string
	datasetName?: string
	datasetKind?: MemoryBenchmarkDatasetKind | "legacy-query"
	scenarios?: number
	cases: number
	scoredCases?: number
	skippedCases?: number
	execution?: MemoryBenchmarkExecutionSummary
	caseOutcomes?: MemoryBenchmarkCaseOutcome[]
	hitRate: number
	emptyRate: number
	avgTopScore: number
	p95LatencyMs: number
	laneLatencyP95?: MemoryBenchmarkLaneLatencySummary
	measurementPasses?: MemoryBenchmarkMeasurementPasses
	rAt5?: number
	rAt10?: number
	ndcgAt10?: number
	questionTypeBreakdown?: MemoryBenchmarkQuestionTypeMetrics[]
	officialMetrics?: MemoryBenchmarkOfficialMetrics
	ingest?: {
		conversationsIngested: number
		turnsIngested: number
		skippedConversations: number
		failedLines: number
		failedTurns: number
	}
	regressions: BenchmarkRegression[]
	queryGovernance?: QueryGovernanceReport
	benchmarkReport?: MemoryBenchmarkRunReport
	missLedger?: BenchmarkMissLedgerEntry[]
	caseDiagnostics?: BenchmarkCaseDiagnosticEntry[]
}

export type BenchmarkRegression = {
	metricName: string
	baseline: number
	current: number
	delta: number
	severity: "low" | "medium" | "high"
}

export async function loadLegacyRelevanceDataset(
	pathname: string,
): Promise<RelevanceBenchmarkCase[]> {
	const raw = await readFile(pathname, "utf-8")
	const rows = raw
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0 && !line.startsWith("#"))
	const cases: RelevanceBenchmarkCase[] = []
	let skippedRows = 0
	for (const row of rows) {
		try {
			const parsed = JSON.parse(row) as RelevanceBenchmarkCase
			if (
				typeof parsed.query !== "string" ||
				parsed.query.trim().length === 0
			) {
				skippedRows++
				continue
			}
			cases.push(parsed)
		} catch {
			skippedRows++
		}
	}
	if (skippedRows > 0) {
		log.warn(`legacy benchmark dataset skipped ${skippedRows} invalid rows`)
	}
	return cases
}

export async function persistBenchmarkRegression(params: {
	db: Db
	prefix: string
	agentId: string
	datasetVersion: string
	currentMetrics: Record<
		| "hitRate"
		| "emptyRate"
		| "avgTopScore"
		| "p95LatencyMs"
		| "rAt5"
		| "rAt10"
		| "ndcgAt10",
		number
	>
}): Promise<BenchmarkRegression[]> {
	const collection = relevanceRegressionsCollection(params.db, params.prefix)
	const metricNames = [
		"hitRate",
		"emptyRate",
		"avgTopScore",
		"p95LatencyMs",
		"rAt5",
		"rAt10",
		"ndcgAt10",
	] as const
	const now = new Date()
	const regressions: BenchmarkRegression[] = []
	for (const metricName of metricNames) {
		const previous = await collection
			.find(
				{
					agentId: params.agentId,
					datasetVersion: params.datasetVersion,
					metricName,
				},
				{ sort: { ts: -1 }, limit: 1, projection: { current: 1 } },
			)
			.toArray()
		const current = params.currentMetrics[metricName]
		const baseline =
			typeof previous[0]?.current === "number" &&
			Number.isFinite(previous[0].current)
				? previous[0].current
				: current
		const delta = current - baseline
		const ratio = Math.abs(delta)
		const severity = ratio >= 0.2 ? "high" : ratio >= 0.1 ? "medium" : "low"
		regressions.push({ metricName, baseline, current, delta, severity })
		try {
			await collection.insertOne({
				regressionId: randomUUID(),
				agentId: params.agentId,
				ts: now,
				datasetVersion: params.datasetVersion,
				metricName,
				baseline,
				current,
				delta,
				severity,
				failingCases: [],
			})
		} catch (error) {
			log.warn("failed to persist benchmark regression metric", {
				datasetVersion: params.datasetVersion,
				metricName,
				error: error instanceof Error ? error.message : String(error),
			})
		}
	}
	return regressions
}

export function buildBenchmarkCaseSummary(
	results: MemorySearchResult[],
	latencyMs: number,
) {
	return {
		empty: results.length === 0,
		hitSources: Array.from(new Set(results.map((result) => result.source))),
		topScore: results[0]?.score ?? 0,
		latencyMs,
	}
}

export function summarizeBenchmarkCases(
	cases: Array<{
		empty: boolean
		topScore: number
		latencyMs: number
		pass: boolean
	}>,
) {
	if (cases.length === 0) {
		return { hitRate: 0, emptyRate: 0, avgTopScore: 0, p95LatencyMs: 0 }
	}
	const sortedLatencies = cases
		.map((entry) => entry.latencyMs)
		.sort((a, b) => a - b)
	const p95Index = Math.min(
		sortedLatencies.length - 1,
		Math.ceil(0.95 * sortedLatencies.length) - 1,
	)
	return {
		hitRate: cases.filter((entry) => entry.pass).length / cases.length,
		emptyRate: cases.filter((entry) => entry.empty).length / cases.length,
		avgTopScore:
			cases.reduce((sum, entry) => sum + entry.topScore, 0) / cases.length,
		p95LatencyMs: sortedLatencies[p95Index] ?? 0,
	}
}
