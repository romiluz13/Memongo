#!/usr/bin/env bun
/**
 * Fetches a benchmark dataset and verifies it against the SHA-256 pinned in the
 * release quality contract.
 *
 * The point of this script is auditability, not convenience. A published
 * benchmark number is only meaningful if a reader can obtain the same bytes we
 * measured, and the contract in benchmark-quality-contracts.ts refuses to run
 * unless the dataset hashes to the value it pins. This script makes obtaining
 * those bytes a single command, and fails loudly rather than quietly measuring
 * something else.
 *
 * The datasets are too large to vendor (LongMemEval_S is ~265 MB), so they are
 * downloaded on demand into a gitignored directory.
 *
 *   bun run benchmark:fetch              # default: longmemeval
 *   bun run benchmark:fetch longmemeval
 *
 * LoCoMo is deliberately NOT downloadable here: it is CC BY-NC 4.0
 * (NonCommercial), which is a licensing decision for the project owner rather
 * than something a script should make silently. See the note below.
 */
import { createHash } from "node:crypto"
import { createWriteStream } from "node:fs"
import { mkdir, rename, rm, stat } from "node:fs/promises"
import path from "node:path"
import { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"
import { fileURLToPath } from "node:url"
import { LONGMEMEVAL_RELEASE_V1 } from "../packages/memory-engine/src/benchmark-quality-contracts.js"

const REPO_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
)
const DATA_DIR = path.join(REPO_ROOT, "benchmarks", "data")

type DatasetSpec = {
	key: string
	fileName: string
	url: string
	/** Read from the release contract so this cannot drift from what the gate enforces. */
	sha256: string
	approxBytes: number
	license: string
	source: string
}

const DATASETS: DatasetSpec[] = [
	{
		key: "longmemeval",
		fileName: "longmemeval_s_cleaned.json",
		url: "https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_s_cleaned.json",
		sha256: LONGMEMEVAL_RELEASE_V1.datasetSha256,
		approxBytes: 277_000_000,
		license: "MIT",
		source: "https://github.com/xiaowu0162/LongMemEval (ICLR 2025)",
	},
]

function fail(message: string): never {
	console.error(`\n✗ ${message}\n`)
	process.exit(1)
}

async function sha256OfFile(filePath: string): Promise<string> {
	const hash = createHash("sha256")
	const { createReadStream } = await import("node:fs")
	await pipeline(createReadStream(filePath), hash)
	return hash.digest("hex")
}

async function fileExists(filePath: string): Promise<boolean> {
	try {
		await stat(filePath)
		return true
	} catch {
		return false
	}
}

async function download(spec: DatasetSpec, destination: string): Promise<void> {
	// Download to a temporary name and only promote it after the digest matches,
	// so an interrupted or corrupted transfer can never be mistaken for the
	// verified artifact on a later run.
	const partial = `${destination}.partial`
	await rm(partial, { force: true })

	const response = await fetch(spec.url)
	if (!response.ok || !response.body) {
		fail(`download failed: HTTP ${response.status} for ${spec.url}`)
	}
	const declared = Number(response.headers.get("content-length") ?? 0)
	const totalMb = declared > 0 ? (declared / 1024 / 1024).toFixed(1) : "?"
	console.log(`  downloading ${totalMb} MB …`)

	await pipeline(
		Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),
		createWriteStream(partial),
	)

	const digest = await sha256OfFile(partial)
	if (digest !== spec.sha256) {
		await rm(partial, { force: true })
		fail(
			`digest mismatch for ${spec.fileName}\n` +
				`    expected ${spec.sha256}\n` +
				`    received ${digest}\n` +
				"  The upstream artifact differs from the one this release contract pins.\n" +
				"  Refusing to install it: a benchmark measured on different bytes is not\n" +
				"  comparable to a published number.",
		)
	}
	await rename(partial, destination)
}

async function main(): Promise<void> {
	const requested = (process.argv[2] ?? "longmemeval").trim().toLowerCase()

	if (requested === "locomo") {
		fail(
			"LoCoMo is not fetched by this script.\n" +
				"  snap-research/locomo is CC BY-NC 4.0 (Attribution-NonCommercial), which\n" +
				"  GitHub reports as NOASSERTION and is easy to miss. Whether to benchmark a\n" +
				"  commercial product against a NonCommercial dataset is a licensing decision\n" +
				"  for the project owner, not one a build script should make silently.",
		)
	}

	const spec = DATASETS.find((entry) => entry.key === requested)
	if (!spec) {
		fail(
			`unknown dataset "${requested}". Available: ${DATASETS.map((d) => d.key).join(", ")}`,
		)
	}

	await mkdir(DATA_DIR, { recursive: true })
	const destination = path.join(DATA_DIR, spec.fileName)

	console.log(`\nDataset : ${spec.key}`)
	console.log(`Source  : ${spec.source}`)
	console.log(`License : ${spec.license}`)
	console.log(`Pinned  : ${spec.sha256}`)
	console.log(`Target  : ${path.relative(REPO_ROOT, destination)}`)

	if (await fileExists(destination)) {
		console.log("\n  already present — verifying digest …")
		const digest = await sha256OfFile(destination)
		if (digest === spec.sha256) {
			console.log("\n✓ verified, nothing to do\n")
			return
		}
		console.log(`  digest mismatch (${digest}); re-downloading`)
		await rm(destination, { force: true })
	}

	console.log("")
	await download(spec, destination)
	console.log(`\n✓ verified ${spec.fileName} against the pinned digest\n`)
}

await main()
