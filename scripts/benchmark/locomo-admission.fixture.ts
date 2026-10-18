import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach } from "vitest"
import { loadBenchmarkDataset } from "./mongodb-benchmark-dataset.js"

// Loader seam for ticket #95: a LoCoMo fixture document goes in, normalized
// scenarios and adapterDiagnostics come out (shape table 1197, resolutions r3).
type LoadedDataset = ReturnType<typeof loadBenchmarkDataset>

export function useLoCoMoLoader(): {
	load: (document: unknown) => LoadedDataset
	loadText: (text: string) => LoadedDataset
	failure: (document: unknown) => Promise<unknown>
	datasetPath: (document: unknown) => Promise<string>
} {
	let dir = ""
	beforeEach(async () => {
		dir = await mkdtemp(path.join(os.tmpdir(), "locomo-admission-"))
	})
	afterEach(async () => {
		await rm(dir, { recursive: true, force: true })
	})
	const textPath = async (text: string) => {
		const target = path.join(dir, "locomo.json")
		await writeFile(target, text)
		return target
	}
	const datasetPath = (document: unknown) => textPath(JSON.stringify(document))
	const loadText = async (text: string) =>
		loadBenchmarkDataset(await textPath(text))
	const load = async (document: unknown) =>
		loadBenchmarkDataset(await datasetPath(document))
	const failure = (document: unknown) =>
		load(document).then(
			() => {
				throw new Error("expected admission to fail")
			},
			(caught: unknown) => caught,
		)
	return { load, loadText, failure, datasetPath }
}

export type Sample = Record<string, unknown>

export const SESSION_DATE = "1:56 pm on 8 May, 2023"

export function turn(speaker: string, diaId: string, text: string): Sample {
	return { speaker, dia_id: diaId, text }
}

/** One valid sample: two speakers, one session of two turns, one category-1 QA item. */
export function sample(
	id: string,
	overrides: {
		conversation?: Record<string, unknown>
		qa?: unknown
		[key: string]: unknown
	} = {},
): Sample {
	const { conversation, ...rest } = overrides
	return {
		sample_id: id,
		qa: [qa({ question: `What about ${id}?`, answer: `answer ${id}` })],
		...rest,
		conversation: {
			speaker_a: "Alice",
			speaker_b: "Bob",
			session_1_date_time: SESSION_DATE,
			session_1: [
				turn("Alice", "D1:1", `fact for ${id}`),
				turn("Bob", "D1:2", "noted"),
			],
			...conversation,
		},
	}
}

export function qa(overrides: Record<string, unknown> = {}): Sample {
	return {
		question: "What happened?",
		answer: "it happened",
		category: 1,
		evidence: ["D1:1"],
		...overrides,
	}
}

export const ZERO_TOTALS = {
	rejectedTurns: 0,
	rejectedSessions: 0,
	emptiedSessions: 0,
	rejectedQuestions: 0,
	rejectedQaItems: 0,
	informationalSkips: 0,
}
