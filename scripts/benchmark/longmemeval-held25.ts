#!/usr/bin/env bun
/**
 * LongMemEval_S held-out 25 set for the paired-arms measurement.
 *
 * Twenty-five questions that no earlier run or design step has seen. It
 * excludes the five ids new25 excluded, the 25 new25 ids and the B2
 * frozen-50 ids, all read from their committed identity pins. Selection is
 * new25's rule (`selectRoundRobinByType`) over what remains.
 *
 * Emits the materialized dataset `benchmarks/data/lme_s_held25.json`
 * (gitignored; parent records unchanged, selection order) that
 * `bun run benchmark --questions` consumes. The committed identity pin
 * `scripts/benchmark/longmemeval-held25.ids.json` names the 25 ids, the
 * excluded ids and the parent and subset digests.
 *
 * Regenerate from the repo root:
 *   bun scripts/benchmark/longmemeval-held25.ts
 */
import { readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { B2_IDENTITY_PIN_RELATIVE } from "./longmemeval-b2-frozen50.js"
import {
	NEW25_DATASET_RELATIVE,
	NEW25_EXCLUDED_IDS,
	NEW25_IDENTITY_PIN_RELATIVE,
	repoRootFromHere,
	selectRoundRobinByType,
	writePinnedSubset,
} from "./longmemeval-new25.js"

export const HELD25_SIZE = 25
export const HELD25_DATASET_RELATIVE = NEW25_DATASET_RELATIVE
export const HELD25_MATERIALIZED_OUTPUT_RELATIVE =
	"benchmarks/data/lme_s_held25.json"
export const HELD25_IDENTITY_PIN_RELATIVE =
	"scripts/benchmark/longmemeval-held25.ids.json"

export type Held25Exclusions = {
	new25Excluded: readonly string[]
	new25Ids: readonly string[]
	frozen50Ids: readonly string[]
}

type RawQuestion = {
	question_id?: unknown
	question_type?: unknown
}

export function held25ExcludedIds(exclusions: Held25Exclusions): string[] {
	return [
		...new Set([
			...exclusions.new25Excluded,
			...exclusions.new25Ids,
			...exclusions.frozen50Ids,
		]),
	]
}

export function selectHeld25(
	entries: readonly RawQuestion[],
	exclusions: Held25Exclusions,
): string[] {
	return selectRoundRobinByType(entries, {
		size: HELD25_SIZE,
		excluded: held25ExcludedIds(exclusions),
	})
}

async function readPinIds(root: string, relative: string): Promise<string[]> {
	const pin = JSON.parse(await readFile(path.join(root, relative), "utf8")) as {
		ids?: unknown
	}
	if (
		!Array.isArray(pin.ids) ||
		!pin.ids.every((id) => typeof id === "string")
	) {
		throw new Error(`identity pin has no string ids: ${relative}`)
	}
	return pin.ids
}

export async function readCommittedHeld25Exclusions(
	root: string,
): Promise<Held25Exclusions> {
	return {
		new25Excluded: [...NEW25_EXCLUDED_IDS],
		new25Ids: await readPinIds(root, NEW25_IDENTITY_PIN_RELATIVE),
		frozen50Ids: await readPinIds(root, B2_IDENTITY_PIN_RELATIVE),
	}
}

async function main(): Promise<void> {
	const root = repoRootFromHere(import.meta.url)
	const pin = await writePinnedSubset({
		root,
		datasetRelative: HELD25_DATASET_RELATIVE,
		outputRelative: HELD25_MATERIALIZED_OUTPUT_RELATIVE,
		pinRelative: HELD25_IDENTITY_PIN_RELATIVE,
		size: HELD25_SIZE,
		excludedIds: held25ExcludedIds(await readCommittedHeld25Exclusions(root)),
	})
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
