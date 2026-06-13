import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { basename, extname, join } from "node:path"

export type RawLongMemEvalShardEntry = {
	question_id: string
	question?: string
	question_type?: string
	[key: string]: unknown
}

export type LongMemEvalShard = {
	shardId: string
	index: number
	startInclusive: number
	endExclusive: number
	count: number
	path: string
	questionIds: string[]
	questionTypes: Record<string, number>
}

export type LongMemEvalShardManifest = {
	label: string
	datasetPath: string
	datasetSha256: string
	totalQuestions: number
	shardSize: number
	totalShards: number
	disclosure: string
	shards: LongMemEvalShard[]
}

type CreateShardOptions = {
	entries: RawLongMemEvalShardEntry[]
	shardSize: number
	outDir: string
	filePrefix: string
}

type WriteShardOptions = {
	datasetPath: string
	outDir: string
	shardSize: number
	label: string
}

export function assertLongMemEvalEntries(
	value: unknown,
): asserts value is RawLongMemEvalShardEntry[] {
	if (!Array.isArray(value) || value.length === 0) {
		throw new Error("dataset must be a non-empty LongMemEval JSON array")
	}
	const seen = new Set<string>()
	for (const [index, entry] of value.entries()) {
		if (
			typeof entry !== "object" ||
			entry === null ||
			typeof (entry as { question_id?: unknown }).question_id !== "string" ||
			(entry as { question_id: string }).question_id.length === 0
		) {
			throw new Error(`dataset entry ${index} is missing question_id`)
		}
		const questionId = (entry as { question_id: string }).question_id
		if (seen.has(questionId)) {
			throw new Error(`duplicate question_id: ${questionId}`)
		}
		seen.add(questionId)
	}
}

export function createLongMemEvalShards({
	entries,
	shardSize,
	outDir,
	filePrefix,
}: CreateShardOptions): LongMemEvalShard[] {
	if (!Number.isInteger(shardSize) || shardSize < 1) {
		throw new Error("shardSize must be a positive integer")
	}
	assertLongMemEvalEntries(entries)
	const totalShards = Math.ceil(entries.length / shardSize)
	const width = Math.max(2, String(totalShards - 1).length)
	return Array.from({ length: totalShards }, (_, index) => {
		const startInclusive = index * shardSize
		const endExclusive = Math.min(startInclusive + shardSize, entries.length)
		const shardEntries = entries.slice(startInclusive, endExclusive)
		const shardId = `shard-${String(index).padStart(width, "0")}`
		const questionTypes: Record<string, number> = {}
		for (const entry of shardEntries) {
			const questionType =
				typeof entry.question_type === "string"
					? entry.question_type
					: "unknown"
			questionTypes[questionType] = (questionTypes[questionType] ?? 0) + 1
		}
		return {
			shardId,
			index,
			startInclusive,
			endExclusive,
			count: shardEntries.length,
			path: join(outDir, `${filePrefix}-${shardId}.json`),
			questionIds: shardEntries.map((entry) => entry.question_id),
			questionTypes,
		}
	})
}

export function writeLongMemEvalShards({
	datasetPath,
	outDir,
	shardSize,
	label,
}: WriteShardOptions): LongMemEvalShardManifest {
	const raw = readFileSync(datasetPath, "utf8")
	const parsed = JSON.parse(raw) as unknown
	assertLongMemEvalEntries(parsed)
	const datasetSha256 = createHash("sha256").update(raw).digest("hex")
	const ext = extname(datasetPath)
	const filePrefix = basename(datasetPath, ext || undefined)
	const shards = createLongMemEvalShards({
		entries: parsed,
		shardSize,
		outDir,
		filePrefix,
	})

	mkdirSync(outDir, { recursive: true })
	for (const shard of shards) {
		const entries = parsed.slice(shard.startInclusive, shard.endExclusive)
		writeFileSync(shard.path, `${JSON.stringify(entries, null, 2)}\n`)
	}

	const manifest: LongMemEvalShardManifest = {
		label,
		datasetPath,
		datasetSha256,
		totalQuestions: parsed.length,
		shardSize,
		totalShards: shards.length,
		disclosure:
			"Sharded local rehearsal only. Do not publish as a single-run result; use to keep Local Preview memory bounded and merge saved predictions only for evaluate-only experiments with explicit infrastructure disclosure.",
		shards,
	}
	writeFileSync(
		join(outDir, "longmemeval-shard-manifest.json"),
		`${JSON.stringify(manifest, null, 2)}\n`,
	)
	writeFileSync(
		join(outDir, "longmemeval-shard-manifest.md"),
		renderLongMemEvalShardManifestMarkdown(manifest),
	)
	return manifest
}

export function renderLongMemEvalShardManifestMarkdown(
	manifest: LongMemEvalShardManifest,
): string {
	const lines = [
		"# LongMemEval Shard Manifest",
		"",
		`Label: \`${manifest.label}\``,
		"",
		`Dataset SHA-256: \`${manifest.datasetSha256}\``,
		"",
		`Total questions: ${manifest.totalQuestions}`,
		`Shard size: ${manifest.shardSize}`,
		`Total shards: ${manifest.totalShards}`,
		"",
		`Disclosure: ${manifest.disclosure}`,
		"",
		"| Shard | Rows | Range | Dataset path | Question types |",
		"| --- | ---: | --- | --- | --- |",
	]
	for (const shard of manifest.shards) {
		const types = Object.entries(shard.questionTypes)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([type, count]) => `${type}: ${count}`)
			.join("<br>")
		lines.push(
			`| ${shard.shardId} | ${shard.count} | ${shard.startInclusive}-${shard.endExclusive - 1} | \`${shard.path}\` | ${types} |`,
		)
	}
	return `${lines.join("\n")}\n`
}

function parseArgs(argv: string[]): WriteShardOptions {
	let datasetPath: string | undefined
	let outDir: string | undefined
	let shardSize = 50
	let label = "longmemeval-sharded-local-rehearsal"
	for (const arg of argv) {
		if (arg.startsWith("--dataset=")) {
			datasetPath = arg.slice("--dataset=".length)
		} else if (arg.startsWith("--out-dir=")) {
			outDir = arg.slice("--out-dir=".length)
		} else if (arg.startsWith("--shard-size=")) {
			shardSize = Number(arg.slice("--shard-size=".length))
		} else if (arg.startsWith("--label=")) {
			label = arg.slice("--label=".length)
		} else {
			throw new Error(`unknown argument: ${arg}`)
		}
	}
	if (!datasetPath) {
		throw new Error(
			"usage: bun scripts/longmemeval-shards.ts --dataset=PATH --out-dir=DIR [--shard-size=50] [--label=LABEL]",
		)
	}
	if (!outDir) {
		throw new Error(
			"usage: bun scripts/longmemeval-shards.ts --dataset=PATH --out-dir=DIR [--shard-size=50] [--label=LABEL]",
		)
	}
	return { datasetPath, outDir, shardSize, label }
}

if (import.meta.main) {
	try {
		const manifest = writeLongMemEvalShards(parseArgs(process.argv.slice(2)))
		console.log(renderLongMemEvalShardManifestMarkdown(manifest))
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error))
		process.exit(1)
	}
}
