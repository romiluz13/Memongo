import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdir, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { performance } from "node:perf_hooks"

type JsonPrimitive = string | number | boolean | null
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }

type PublicDataset = {
	name: string
	description: string
	data: JsonValue
	metadata: {
		supportsCSV: boolean
		structureClass: string
		tabularEligibility: number
	}
}

type AutoSelectedFormat = "json-compact" | "toon"

type BenchmarkRow = {
	datasetName: string
	description: string
	structureClass: string
	tabularEligibility: number
	formatName: "json-compact" | "toon" | "auto"
	selectedFormat?: AutoSelectedFormat
	tokenCount: number
	tokenDeltaVsCompactJson: number
	tokenSavingsPctVsCompactJson: number
	renderMs: number
	sourceSha256: string
}

const PUBLIC_REPO_URL = "https://github.com/toon-format/toon.git"
const DEFAULT_PUBLIC_REPO_DIR = "/tmp/memongo-public-toon-benchmark"
const DEFAULT_JSON_OUT = "artifacts/benchmarks/toon-public-token-benchmark.json"
const FIXED_NOW = "2026-07-04T00:00:00.000Z"
const AUTO_SAMPLE_LIMIT = 12
const AUTO_MIN_ITEMS = 5
const AUTO_UNIFORM_RATIO = 0.75

function parseArg(name: string): string | undefined {
	const arg = process.argv.find((entry) => entry.startsWith(`--${name}=`))
	return arg?.slice(name.length + 3)
}

function publicRepoDir(): string {
	return resolve(
		parseArg("public-repo") ??
			process.env.TOON_PUBLIC_BENCHMARK_REPO ??
			DEFAULT_PUBLIC_REPO_DIR,
	)
}

function jsonOut(): string {
	return parseArg("json-out") ?? DEFAULT_JSON_OUT
}

function sampleOut(): string | undefined {
	return parseArg("sample-out")
}

function stableValue(value: unknown): JsonValue {
	if (value === undefined) {
		return null
	}
	if (value === null || typeof value !== "object") {
		return value as JsonPrimitive
	}
	if (Array.isArray(value)) {
		return value.map(stableValue)
	}
	return Object.fromEntries(
		Object.entries(value as Record<string, unknown>)
			.filter(([, entry]) => entry !== undefined)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, entry]) => [key, stableValue(entry)]),
	) as JsonValue
}

function stableJson(value: unknown): string {
	return JSON.stringify(stableValue(value))
}

function sha256(text: string): string {
	return createHash("sha256").update(text).digest("hex")
}

function isPlainObject(
	value: JsonValue,
): value is { [key: string]: JsonValue } {
	return value !== null && typeof value === "object" && !Array.isArray(value)
}

function primaryRows(value: JsonValue): Array<{ [key: string]: JsonValue }> {
	if (Array.isArray(value)) {
		return value.filter(isPlainObject)
	}
	if (!isPlainObject(value)) {
		return []
	}
	const arrays = Object.values(value).filter(
		(entry): entry is Array<{ [key: string]: JsonValue }> =>
			Array.isArray(entry) && entry.every(isPlainObject),
	)
	return arrays.sort((left, right) => right.length - left.length)[0] ?? []
}

function hasObjectCell(row: { [key: string]: JsonValue }): boolean {
	return Object.values(row).some((value) => isPlainObject(value))
}

function selectAutoFormat(payload: JsonValue): AutoSelectedFormat {
	const sample = primaryRows(payload).slice(0, AUTO_SAMPLE_LIMIT)
	if (sample.length < AUTO_MIN_ITEMS) {
		return "json-compact"
	}
	if (sample.some(hasObjectCell)) {
		return "json-compact"
	}

	const counts = new Map<string, number>()
	for (const row of sample) {
		const keySet = Object.keys(row).sort().join("|")
		counts.set(keySet, (counts.get(keySet) ?? 0) + 1)
	}
	const mostCommon = Math.max(...counts.values())
	return mostCommon / sample.length >= AUTO_UNIFORM_RATIO
		? "toon"
		: "json-compact"
}

function measure(render: () => string): { text: string; renderMs: number } {
	const timings: number[] = []
	let text = render()
	for (let index = 0; index < 35; index += 1) {
		const start = performance.now()
		text = render()
		timings.push(performance.now() - start)
	}
	timings.sort((left, right) => left - right)
	return {
		text,
		renderMs: timings[Math.floor(timings.length / 2)] ?? 0,
	}
}

function ensurePublicRepo(repoDir: string): void {
	if (!existsSync(repoDir)) {
		execFileSync("git", ["clone", "--depth=1", PUBLIC_REPO_URL, repoDir], {
			stdio: "inherit",
		})
	}
	if (!existsSync(resolve(repoDir, "benchmarks/node_modules/gpt-tokenizer"))) {
		execFileSync("bun", ["install"], {
			cwd: resolve(repoDir, "benchmarks"),
			stdio: "inherit",
		})
	}
}

function gitOutput(repoDir: string, args: string[]): string {
	return execFileSync("git", args, {
		cwd: repoDir,
		encoding: "utf8",
	}).trim()
}

async function loadPublicBenchmark(repoDir: string): Promise<{
	datasets: PublicDataset[]
	encodeToon: (data: unknown) => string
	tokenize: (text: string) => number
	repoCommit: string
}> {
	const datasetsModule = (await import(
		`file://${resolve(repoDir, "benchmarks/src/datasets.ts")}`
	)) as { TOKEN_EFFICIENCY_DATASETS: PublicDataset[] }
	const toonModule = (await import(
		`file://${resolve(repoDir, "packages/toon/src/index.ts")}`
	)) as { encode: (data: unknown) => string }
	const utilsModule = (await import(
		`file://${resolve(repoDir, "benchmarks/src/utils.ts")}`
	)) as { tokenize: (text: string) => number }
	return {
		datasets: datasetsModule.TOKEN_EFFICIENCY_DATASETS,
		encodeToon: toonModule.encode,
		tokenize: utilsModule.tokenize,
		repoCommit: gitOutput(repoDir, ["rev-parse", "HEAD"]),
	}
}

function buildRows(
	datasets: PublicDataset[],
	encodeToon: (data: unknown) => string,
	tokenize: (text: string) => number,
): BenchmarkRow[] {
	const rows: BenchmarkRow[] = []
	for (const dataset of datasets) {
		const payload = dataset.data
		const stablePayload = stableValue(payload)
		const sourceJson = stableJson(stablePayload)
		const sourceSha256 = sha256(sourceJson)
		const compact = measure(() => JSON.stringify(payload))
		const toon = measure(() => encodeToon(payload))
		const selectedFormat = selectAutoFormat(stablePayload)
		const auto = selectedFormat === "toon" ? toon : compact
		const compactTokens = tokenize(compact.text)

		for (const format of [
			{ formatName: "json-compact" as const, ...compact },
			{ formatName: "toon" as const, ...toon },
			{
				formatName: "auto" as const,
				selectedFormat,
				text: auto.text,
				renderMs: auto.renderMs,
			},
		]) {
			const tokenCount = tokenize(format.text)
			rows.push({
				datasetName: dataset.name,
				description: dataset.description,
				structureClass: dataset.metadata.structureClass,
				tabularEligibility: dataset.metadata.tabularEligibility,
				formatName: format.formatName,
				selectedFormat:
					format.formatName === "auto" ? format.selectedFormat : undefined,
				tokenCount,
				tokenDeltaVsCompactJson: tokenCount - compactTokens,
				tokenSavingsPctVsCompactJson:
					compactTokens === 0
						? 0
						: ((compactTokens - tokenCount) / compactTokens) * 100,
				renderMs: Number(format.renderMs.toFixed(4)),
				sourceSha256,
			})
		}
	}
	return rows
}

function formatPercent(value: number): string {
	const sign = value > 0 ? "+" : ""
	return `${sign}${value.toFixed(1)}%`
}

function summarize(rows: BenchmarkRow[]): string[] {
	const toonRows = rows.filter((row) => row.formatName === "toon")
	const autoRows = rows.filter((row) => row.formatName === "auto")
	const toonWins = toonRows.filter((row) => row.tokenDeltaVsCompactJson < 0)
	const toonLosses = toonRows.filter((row) => row.tokenDeltaVsCompactJson > 0)
	const autoWins = autoRows.filter((row) => row.tokenDeltaVsCompactJson < 0)
	const autoLosses = autoRows.filter((row) => row.tokenDeltaVsCompactJson > 0)
	const autoToon = autoRows.filter((row) => row.selectedFormat === "toon")
	const autoJson = autoRows.filter(
		(row) => row.selectedFormat === "json-compact",
	)
	const totalCompact = rows
		.filter((row) => row.formatName === "json-compact")
		.reduce((total, row) => total + row.tokenCount, 0)
	const totalToon = toonRows.reduce((total, row) => total + row.tokenCount, 0)
	const totalAuto = autoRows.reduce((total, row) => total + row.tokenCount, 0)

	return [
		`Public TOON token-efficiency datasets: raw TOON saved tokens on ${toonWins.length}/${toonRows.length} datasets and lost tokens on ${toonLosses.length}/${toonRows.length} versus compact JSON.`,
		`Auto selected TOON on ${autoToon.length}/${autoRows.length} datasets and compact JSON on ${autoJson.length}/${autoRows.length}; auto saved tokens on ${autoWins.length}/${autoRows.length} datasets and lost tokens on ${autoLosses.length}/${autoRows.length}.`,
		`Totals versus compact JSON: raw TOON ${formatPercent(((totalCompact - totalToon) / totalCompact) * 100)}, auto ${formatPercent(((totalCompact - totalAuto) / totalCompact) * 100)}.`,
	]
}

function printTable(rows: BenchmarkRow[]): void {
	console.log(
		"Dataset                         Format              Tokens   Delta   Savings",
	)
	console.log(
		"------------------------------  ------------------  -------  ------  -------",
	)
	for (const row of rows) {
		const format =
			row.formatName === "auto" ? `auto->${row.selectedFormat}` : row.formatName
		const delta =
			row.tokenDeltaVsCompactJson === 0
				? "0"
				: `${row.tokenDeltaVsCompactJson > 0 ? "+" : ""}${row.tokenDeltaVsCompactJson.toLocaleString("en-US")}`
		console.log(
			`${row.description.padEnd(30)}  ${format.padEnd(18)}  ${row.tokenCount.toLocaleString("en-US").padStart(7)}  ${delta.padStart(6)}  ${formatPercent(row.tokenSavingsPctVsCompactJson).padStart(7)}`,
		)
	}
}

async function main(): Promise<void> {
	const repoDir = publicRepoDir()
	ensurePublicRepo(repoDir)
	const { datasets, encodeToon, tokenize, repoCommit } =
		await loadPublicBenchmark(repoDir)
	const rows = buildRows(datasets, encodeToon, tokenize)
	const report = {
		generatedAt: FIXED_NOW,
		source: {
			repo: PUBLIC_REPO_URL,
			commit: repoCommit,
			datasets: "benchmarks/src/datasets.ts TOKEN_EFFICIENCY_DATASETS",
		},
		tokenizer: {
			package: "gpt-tokenizer",
			model: "gpt-4o",
			encoding: "o200k_base",
		},
		selectionPolicy:
			"Auto samples up to 12 rows from the largest top-level object array. It selects TOON only for at least 5 mostly uniform rows with no nested object cells; otherwise compact JSON.",
		results: rows,
		interpretation: summarize(rows),
	}

	printTable(rows)
	console.log("")
	for (const line of report.interpretation) {
		console.log(line)
	}
	console.log(`Public TOON repo commit: ${repoCommit}`)

	const absoluteJsonOut = resolve(jsonOut())
	await mkdir(dirname(absoluteJsonOut), { recursive: true })
	await writeFile(absoluteJsonOut, `${JSON.stringify(report, null, 2)}\n`)
	const sample = sampleOut()
	if (sample) {
		const absoluteSampleOut = resolve(sample)
		await mkdir(dirname(absoluteSampleOut), { recursive: true })
		await writeFile(absoluteSampleOut, `${JSON.stringify(report, null, 2)}\n`)
		console.log(`Sample report: ${sample}`)
	}
	console.log(`JSON report: ${jsonOut()}`)
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : error)
	process.exitCode = 1
})
