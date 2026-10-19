#!/usr/bin/env bun
/**
 * LongMemEval_S new-25 diagnostic set (task 1247).
 *
 * Twenty-five questions the earlier 5-question runs never saw. The five
 * question ids those runs used are excluded. Selection is a round-robin over
 * question_type: types in order of first appearance in the dataset, each
 * type's queue in file order, one question per type per turn, skipping a
 * type whose queue is empty.
 *
 * Emits the materialized dataset `benchmarks/data/lme_s_new25.json`
 * (gitignored; parent records unchanged, selection order) that
 * `bun run benchmark --questions` consumes. The committed identity pin
 * `scripts/benchmark/longmemeval-new25.ids.json` names the 25 ids and the
 * parent and subset digests.
 *
 * Regenerate from the repo root:
 *   bun scripts/benchmark/longmemeval-new25.ts
 */
import { createHash } from "node:crypto"
import { readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

export const NEW25_SIZE = 25
export const NEW25_EXCLUDED_IDS: readonly string[] = [
	"e47becba",
	"118b2229",
	"51a45a95",
	"58bf7951",
	"1e043500",
]
export const NEW25_DATASET_RELATIVE =
	"benchmarks/data/longmemeval_s_cleaned.json"
export const NEW25_MATERIALIZED_OUTPUT_RELATIVE =
	"benchmarks/data/lme_s_new25.json"
export const NEW25_IDENTITY_PIN_RELATIVE =
	"scripts/benchmark/longmemeval-new25.ids.json"

type RawQuestion = {
	question_id?: unknown
	question_type?: unknown
}

export function selectRoundRobinByType(
	entries: readonly RawQuestion[],
	options: { size: number; excluded: readonly string[] },
): string[] {
	const seen = new Set<string>()
	const queues = new Map<string, string[]>()
	const excluded = new Set(options.excluded)
	for (const entry of entries) {
		const id = entry.question_id
		const type = entry.question_type
		if (typeof id !== "string" || typeof type !== "string") {
			throw new Error(
				`question without a string question_id and question_type: ${String(id)}`,
			)
		}
		if (seen.has(id)) {
			throw new Error(`duplicate question_id: ${id}`)
		}
		seen.add(id)
		const queue = queues.get(type) ?? []
		queues.set(type, queue)
		if (!excluded.has(id)) queue.push(id)
	}
	for (const id of excluded) {
		if (!seen.has(id)) {
			throw new Error(`excluded question_id absent from the dataset: ${id}`)
		}
	}
	const eligible = [...queues.values()].reduce((sum, q) => sum + q.length, 0)
	if (eligible < options.size) {
		throw new Error(
			`only ${eligible} eligible questions for a set of ${options.size}`,
		)
	}
	const selected: string[] = []
	const cursors = new Map<string, number>()
	while (selected.length < options.size) {
		for (const [type, queue] of queues) {
			if (selected.length >= options.size) break
			const cursor = cursors.get(type) ?? 0
			const id = queue[cursor]
			if (id === undefined) continue
			selected.push(id)
			cursors.set(type, cursor + 1)
		}
	}
	return selected
}

export function materializeNew25Dataset<T extends RawQuestion>(
	entries: readonly T[],
	ids: readonly string[],
): T[] {
	const byId = new Map<string, T>()
	for (const entry of entries) {
		if (typeof entry.question_id === "string") {
			byId.set(entry.question_id, entry)
		}
	}
	return ids.map((id) => {
		const record = byId.get(id)
		if (!record) {
			throw new Error(`selected question missing from dataset: ${id}`)
		}
		return record
	})
}

export function repoRootFromHere(importMetaUrl: string): string {
	return path.resolve(path.dirname(fileURLToPath(importMetaUrl)), "../..")
}

async function main(): Promise<void> {
	const root = repoRootFromHere(import.meta.url)
	const datasetBytes = await readFile(path.join(root, NEW25_DATASET_RELATIVE))
	const parentSha256 = createHash("sha256").update(datasetBytes).digest("hex")
	const parsed: unknown = JSON.parse(datasetBytes.toString("utf8"))
	if (!Array.isArray(parsed)) {
		throw new Error("LongMemEval dataset is not a JSON array")
	}
	const entries = parsed as RawQuestion[]
	const ids = selectRoundRobinByType(entries, {
		size: NEW25_SIZE,
		excluded: NEW25_EXCLUDED_IDS,
	})
	const materializedBytes = `${JSON.stringify(materializeNew25Dataset(entries, ids), null, "\t")}\n`
	const subsetSha256 = createHash("sha256")
		.update(materializedBytes)
		.digest("hex")
	await writeFile(
		path.join(root, NEW25_MATERIALIZED_OUTPUT_RELATIVE),
		materializedBytes,
	)
	const pin = {
		version: 1,
		parentSha256,
		subsetSha256,
		excludedIds: [...NEW25_EXCLUDED_IDS],
		ids,
	}
	await writeFile(
		path.join(root, NEW25_IDENTITY_PIN_RELATIVE),
		`${JSON.stringify(pin, null, "\t")}\n`,
	)
	console.log(JSON.stringify(pin, null, 2))
}

const invokedPath = process.argv[1]
if (
	invokedPath &&
	path.resolve(invokedPath) === fileURLToPath(import.meta.url)
) {
	main().catch((error: unknown) => {
		console.error(error instanceof Error ? error.message : error)
		process.exitCode = 1
	})
}
