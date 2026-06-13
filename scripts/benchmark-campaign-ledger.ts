import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

type CampaignStatus =
	| "blocked"
	| "reproduced-competitor"
	| "adapter-ready"
	| "memongo-rehearsal"
	| "memongo-win"
	| "scoped-out"
	| "watchlist"

type CampaignRow = {
	priority: "P0" | "P1" | "P2" | "Watchlist"
	order: number
	competitor: string
	benchmark: string
	homeField: string
	metricType: string
	competitorTarget: string
	memongoStatus: CampaignStatus
	currentResult: string
	nextGate: string
	requiredArtifacts: string[]
	stopConditions: string[]
}

export const benchmarkCampaignLedger: CampaignRow[] = [
	{
		priority: "P1",
		order: 1,
		competitor: "Mem0",
		benchmark: "LongMemEval top-50/top-200",
		homeField: "memory-benchmarks official LongMemEval judged answer accuracy",
		metricType: "judged answer accuracy",
		competitorTarget:
			"Committed platform rows: top-50 90.4%, top-200 93.4%; README rows: top-50 94.8%, top-200 94.4%",
		memongoStatus: "blocked",
		currentResult:
			"Full 500 saved-artifact GPT-5 judge scored top-50 88.4% and top-200 88.2%; capability report is blocked.",
		nextGate:
			"Pass memory capability fixtures for multi-session current-state, retrieval coverage, temporal reasoning, assistant recall, count/current-state, and context packing; then rerun predict-only and judge saved artifacts.",
		requiredArtifacts: [
			"prediction files and ingestion ledgers",
			"answerer status output",
			"miss analysis",
			"memory capability report",
			"exact-prefix cleanup proof",
		],
		stopConditions: [
			"any empty retrieval",
			"critical capability blocker",
			"question-id or gold-answer logic",
			"judge/model metadata missing",
		],
	},
	{
		priority: "P1",
		order: 2,
		competitor: "Mem0",
		benchmark: "LoCoMo top-50/top-200",
		homeField: "memory-benchmarks official LoCoMo judged answer accuracy",
		metricType: "judged answer accuracy",
		competitorTarget:
			"README top-50 91.8%, top-200 92.5%; committed artifacts report top-50 82.66%, top-200 91.56%",
		memongoStatus: "blocked",
		currentResult:
			"Memongo adapter path has not run the official LoCoMo row set.",
		nextGate:
			"Run competitor command and row filter first; adapt Memongo only after the scorer and model posture are reproduced.",
		requiredArtifacts: [
			"competitor command log",
			"competitor result artifact",
			"Memongo prediction artifact",
			"saved-artifact judge output",
			"cleanup proof",
		],
		stopConditions: [
			"row filter mismatch",
			"judge model mismatch without disclosure",
			"competitor command not reproducible",
		],
	},
	{
		priority: "P1",
		order: 3,
		competitor: "Mem0",
		benchmark: "BEAM 1M/10M",
		homeField: "memory-benchmarks official BEAM judged answer quality",
		metricType: "judged answer quality",
		competitorTarget:
			"BEAM 1M committed 70.1% pass rate; BEAM 10M committed 50.5% pass rate",
		memongoStatus: "blocked",
		currentResult: "No Memongo BEAM adapter yet.",
		nextGate:
			"Reproduce the official BEAM command, then implement a Memongo adapter that preserves the same judge/model and context budget.",
		requiredArtifacts: [
			"competitor BEAM artifact",
			"Memongo BEAM artifact",
			"cost/token report",
			"cleanup proof",
		],
		stopConditions: [
			"dataset scale changed",
			"context budget changed without disclosure",
			"judge prompt/scorer edited",
		],
	},
	{
		priority: "P1",
		order: 4,
		competitor: "Supermemory / MemoryBench",
		benchmark: "MemoryBench provider comparison",
		homeField:
			"MemoryBench compare lanes for LoCoMo, LongMemEval, and ConvoMem",
		metricType: "MemScore and judged answer accuracy",
		competitorTarget:
			"Framework comparison through MemoryBench provider interface",
		memongoStatus: "blocked",
		currentResult: "Memongo provider is not implemented.",
		nextGate:
			"Add a Memongo provider only after locking provider I/O and judge/model settings; run locomo, longmemeval, and convomem lanes.",
		requiredArtifacts: [
			"provider implementation diff",
			"MemoryBench compare output",
			"judge/model metadata",
			"cleanup proof",
		],
		stopConditions: [
			"provider API differs from competitors",
			"judge/model setting missing",
			"MemScore components unavailable",
		],
	},
	{
		priority: "P1",
		order: 5,
		competitor: "Zep",
		benchmark: "LoCoMo and LongMemEval",
		homeField: "Zep benchmark harnesses and notebooks",
		metricType: "judged answer accuracy, latency, context analysis",
		competitorTarget:
			"LoCoMo committed experiment reports mean accuracy 0.80318 and max accuracy 0.81234; command replay still required",
		memongoStatus: "blocked",
		currentResult: "Competitor command not yet reproduced in this branch.",
		nextGate:
			"Convert Zep LoCoMo into a reproducible command artifact, then run Memongo through the same row set and judge posture.",
		requiredArtifacts: [
			"Zep command replay",
			"Zep result artifact",
			"Memongo adapter artifact",
			"latency/context report",
		],
		stopConditions: [
			"notebook-only result cannot be replayed",
			"Zep context budget cannot be matched",
			"judge/scorer changed",
		],
	},
	{
		priority: "P2",
		order: 6,
		competitor: "Mastra",
		benchmark: "LongMemEval",
		homeField: "Mastra explorations/longmemeval package",
		metricType: "judged answer accuracy",
		competitorTarget:
			"README references full and quick commands; no committed result found",
		memongoStatus: "blocked",
		currentResult: "Official package needs command reproduction.",
		nextGate:
			"Run Mastra official command first, capture scorer output, then build Memongo adapter only if the row is reproducible.",
		requiredArtifacts: [
			"Mastra command log",
			"Mastra result",
			"Memongo result",
		],
		stopConditions: ["no committed/replayable score", "scorer prompt edited"],
	},
	{
		priority: "P2",
		order: 7,
		competitor: "Hindsight",
		benchmark: "LoCoMo / LongMemEval / BEAM",
		homeField: "Hindsight benchmark scripts",
		metricType: "judged answer accuracy and latency",
		competitorTarget:
			"README claims state of the art; score artifacts still need reproduction",
		memongoStatus: "blocked",
		currentResult:
			"Competitor scripts exist but score artifact is not reproduced.",
		nextGate:
			"Reproduce Hindsight benchmark scripts and classify each row as runnable, blocked, or non-comparable before Memongo adapter work.",
		requiredArtifacts: [
			"Hindsight command log",
			"score artifact",
			"Memongo parity artifact",
		],
		stopConditions: [
			"API-only black box cannot expose comparable context",
			"score artifact missing",
		],
	},
	{
		priority: "P2",
		order: 8,
		competitor: "OpenViking / OpenClaw Eval",
		benchmark: "LoCoMo/task completion",
		homeField: "OpenViking benchmark and OpenClaw Eval scripts",
		metricType: "task completion and judged answer accuracy",
		competitorTarget:
			"README says 1,540-case LoCoMo test; no committed score artifact found",
		memongoStatus: "blocked",
		currentResult: "Benchmark commands require artifact-backed reproduction.",
		nextGate:
			"Reproduce official OpenViking/OpenClaw command, then decide whether Memongo compares on QA, task completion, or both.",
		requiredArtifacts: [
			"official command replay",
			"score artifact",
			"Memongo adapter artifact",
		],
		stopConditions: [
			"metric is task-completion-only",
			"row cannot be mapped to memory framework behavior",
		],
	},
	{
		priority: "P0",
		order: 9,
		competitor: "MemPalace",
		benchmark: "LLM/rerank lane",
		homeField: "MemPalace LongMemEval hybrid v4 Haiku rerank",
		metricType: "retrieval RecallAny@5 with rerank disclosure",
		competitorTarget: "Committed full-500 rerank file reports 99.20%",
		memongoStatus: "adapter-ready",
		currentResult:
			"Memongo hybrid no-LLM ties 99.20% but is not the same rerank lane.",
		nextGate:
			"Run a separately labeled Memongo rerank lane with fixed reranker model, prompt hash, and no hidden fallback.",
		requiredArtifacts: [
			"MemPalace rerank artifact",
			"Memongo rerank artifact",
			"reranker model/prompt hash",
			"cleanup proof",
		],
		stopConditions: [
			"rerank model undisclosed",
			"rerank prompt missing",
			"mixed with no-LLM rows",
		],
	},
	{
		priority: "Watchlist",
		order: 10,
		competitor: "Letta",
		benchmark: "Unknown",
		homeField: "No repo-backed benchmark claim found",
		metricType: "unknown",
		competitorTarget: "None",
		memongoStatus: "watchlist",
		currentResult: "No reproducible row found.",
		nextGate:
			"Keep watchlist only until a repo-backed benchmark artifact or command appears.",
		requiredArtifacts: ["future repo-backed claim, if found"],
		stopConditions: ["marketing-only claim", "no scorer or dataset"],
	},
]

export function renderBenchmarkCampaignLedgerMarkdown(): string {
	const lines = [
		"# Benchmark Campaign Ledger",
		"",
		"Every row must move through competitor reproduction, Memongo adapter, artifact-backed run, and claim review. Rows cannot jump from TODO to public win.",
		"",
		"| Order | Competitor | Benchmark | Status | Current result | Next gate | Stop conditions |",
		"| ---: | --- | --- | --- | --- | --- | --- |",
	]
	for (const row of benchmarkCampaignLedger.sort((a, b) => a.order - b.order)) {
		lines.push(
			`| ${row.order} | ${row.competitor} | ${row.benchmark} | ${row.memongoStatus} | ${row.currentResult} | ${row.nextGate} | ${row.stopConditions.join("<br>")} |`,
		)
	}
	return `${lines.join("\n")}\n`
}

function parseArgs(argv: string[]): { outDir?: string; jsonOnly: boolean } {
	let outDir: string | undefined
	let jsonOnly = false
	for (const arg of argv) {
		if (arg === "--json") {
			jsonOnly = true
		} else if (arg.startsWith("--out-dir=")) {
			outDir = arg.slice("--out-dir=".length)
		} else {
			throw new Error(`unknown argument: ${arg}`)
		}
	}
	return { outDir, jsonOnly }
}

if (import.meta.main) {
	try {
		const { outDir, jsonOnly } = parseArgs(process.argv.slice(2))
		if (outDir) {
			mkdirSync(outDir, { recursive: true })
			writeFileSync(
				join(outDir, "benchmark-campaign-ledger.json"),
				JSON.stringify(benchmarkCampaignLedger, null, 2),
			)
			writeFileSync(
				join(outDir, "benchmark-campaign-ledger.md"),
				renderBenchmarkCampaignLedgerMarkdown(),
			)
		} else if (jsonOnly) {
			console.log(JSON.stringify(benchmarkCampaignLedger, null, 2))
		} else {
			console.log(renderBenchmarkCampaignLedgerMarkdown())
		}
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error))
		process.exit(1)
	}
}
