import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"

type JsonRecord = Record<string, unknown>

const repoRoot = process.cwd()
const competitorRoot =
	process.env.MEMONGO_COMPETITOR_ROOT?.trim() ||
	"/Users/rom.iluz/Dev/memongo-competitors"
const outDir =
	process.env.MEMONGO_MEMPALACE_FREEZE_DIR?.trim() ||
	path.join(
		repoRoot,
		"artifacts",
		"competitors",
		"mempalace",
		"p0-freeze-20260525",
	)

const mempalaceRoot = path.join(competitorRoot, "mempalace")

function git(repo: string, args: string[]): string {
	return execFileSync("git", ["-C", repo, ...args], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
	}).trim()
}

function asRecord(value: unknown): JsonRecord {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as JsonRecord)
		: {}
}

function sha256(buffer: Buffer): string {
	return createHash("sha256").update(buffer).digest("hex")
}

async function readJson(pathname: string): Promise<unknown> {
	return JSON.parse(await readFile(pathname, "utf8")) as unknown
}

async function readJsonl(pathname: string): Promise<JsonRecord[]> {
	const text = await readFile(pathname, "utf8")
	return text
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean)
		.map((line) => asRecord(JSON.parse(line) as unknown))
}

function average(values: number[]): number {
	return values.length > 0
		? values.reduce((sum, value) => sum + value, 0) / values.length
		: 0
}

function numberAt(record: JsonRecord, pathSegments: string[]): number | null {
	let current: unknown = record
	for (const segment of pathSegments) {
		current = asRecord(current)[segment]
	}
	return typeof current === "number" && Number.isFinite(current)
		? current
		: null
}

function summarizeLongMemEval(rows: JsonRecord[]) {
	const r5 = rows
		.map((row) =>
			numberAt(row, [
				"retrieval_results",
				"metrics",
				"session",
				"recall_any@5",
			]),
		)
		.filter((value): value is number => value !== null)
	const r10 = rows
		.map((row) =>
			numberAt(row, [
				"retrieval_results",
				"metrics",
				"session",
				"recall_any@10",
			]),
		)
		.filter((value): value is number => value !== null)
	return {
		cases: rows.length,
		rAt5: average(r5),
		rAt10: average(r10),
		hitsAt5: r5.filter((value) => value > 0).length,
		hitsAt10: r10.filter((value) => value > 0).length,
	}
}

function summarizeRecallRows(rows: JsonRecord[]) {
	const recalls = rows
		.map((row) => row.recall)
		.filter(
			(value): value is number =>
				typeof value === "number" && Number.isFinite(value),
		)
	return {
		cases: rows.length,
		avgRecall: average(recalls),
		perfect: recalls.filter((value) => value >= 1).length,
		zero: recalls.filter((value) => value === 0).length,
	}
}

function summarizeHitRows(rows: JsonRecord[]) {
	const hits = rows.filter((row) => row.hit_at_k === true).length
	return {
		cases: rows.length,
		hitRate: rows.length > 0 ? hits / rows.length : 0,
		hits,
		misses: rows.length - hits,
	}
}

async function readFileEvidence(params: {
	id: string
	lane: string
	relativePath: string
	metric: "longmemeval" | "recall" | "hit"
}) {
	const absolutePath = path.join(mempalaceRoot, params.relativePath)
	const bytes = await readFile(absolutePath)
	const rows = params.relativePath.endsWith(".jsonl")
		? await readJsonl(absolutePath)
		: (() => {
				const parsed = JSON.parse(bytes.toString("utf8")) as unknown
				return Array.isArray(parsed)
					? parsed.map((entry) => asRecord(entry))
					: []
			})()
	const metrics =
		params.metric === "longmemeval"
			? summarizeLongMemEval(rows)
			: params.metric === "recall"
				? summarizeRecallRows(rows)
				: summarizeHitRows(rows)
	return {
		id: params.id,
		lane: params.lane,
		path: absolutePath,
		relativePath: params.relativePath,
		sha256: sha256(bytes),
		rows: rows.length,
		metrics,
	}
}

async function main() {
	await mkdir(outDir, { recursive: true })
	const evidence = {
		artifactVersion: 1,
		createdAt: new Date().toISOString(),
		competitorRoot,
		repositories: {
			mempalace: {
				branch: git(mempalaceRoot, ["branch", "--show-current"]),
				head: git(mempalaceRoot, ["rev-parse", "HEAD"]),
				statusShort: git(mempalaceRoot, ["status", "--short"]),
				remote: git(mempalaceRoot, ["remote", "get-url", "origin"]),
			},
			membench: {
				branch: git(path.join(competitorRoot, "Membench"), [
					"branch",
					"--show-current",
				]),
				head: git(path.join(competitorRoot, "Membench"), ["rev-parse", "HEAD"]),
			},
			locomo: {
				branch: git(path.join(competitorRoot, "locomo"), [
					"branch",
					"--show-current",
				]),
				head: git(path.join(competitorRoot, "locomo"), ["rev-parse", "HEAD"]),
			},
		},
		sources: {
			readme: {
				path: path.join(mempalaceRoot, "README.md"),
				sha256: sha256(await readFile(path.join(mempalaceRoot, "README.md"))),
			},
			benchmarksMd: {
				path: path.join(mempalaceRoot, "benchmarks", "BENCHMARKS.md"),
				sha256: sha256(
					await readFile(
						path.join(mempalaceRoot, "benchmarks", "BENCHMARKS.md"),
					),
				),
			},
		},
		files: [
			await readFileEvidence({
				id: "longmemeval-raw-full500",
				lane: "LongMemEval raw session top-5, no LLM",
				relativePath:
					"benchmarks/results_mempal_raw_session_20260414_1629.jsonl",
				metric: "longmemeval",
			}),
			await readFileEvidence({
				id: "longmemeval-hybrid-v4-heldout450",
				lane: "LongMemEval hybrid_v4 held-out 450, no LLM",
				relativePath:
					"benchmarks/results_mempal_hybrid_v4_held_out_session_20260414_1634.jsonl",
				metric: "longmemeval",
			}),
			await readFileEvidence({
				id: "locomo-raw-session-top10",
				lane: "LoCoMo raw session top-10, no rerank",
				relativePath:
					"benchmarks/results_locomo_raw_session_top10_20260414_1634.json",
				metric: "recall",
			}),
			await readFileEvidence({
				id: "locomo-hybrid-session-top10",
				lane: "LoCoMo hybrid session top-10, no rerank",
				relativePath:
					"benchmarks/results_locomo_hybrid_session_top10_20260414_1649.json",
				metric: "recall",
			}),
			await readFileEvidence({
				id: "convomem-raw-top10",
				lane: "ConvoMem raw top-10, no rerank",
				relativePath:
					"benchmarks/results_convomem_raw_top10_20260414_1649.json",
				metric: "recall",
			}),
			await readFileEvidence({
				id: "membench-hybrid-all-movie-top5",
				lane: "MemBench hybrid all movie/roles/events top-5",
				relativePath:
					"benchmarks/results_membench_hybrid_all_movie_top5_20260414_1656.json",
				metric: "hit",
			}),
		],
	}
	const outputPath = path.join(outDir, "evidence.json")
	await writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8")
	console.log(JSON.stringify({ ok: true, outputPath }, null, 2))
}

await main()
