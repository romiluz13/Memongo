import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach } from "vitest"
import { loadBenchmarkDataset } from "./mongodb-benchmark-dataset.js"

// Loader seam for ticket #94: a fixture document goes in, normalized
// scenarios and adapterDiagnostics come out (shape table 1197, resolutions r3).
type LoadedDataset = ReturnType<typeof loadBenchmarkDataset>

export function useLongMemEvalLoader(): {
	load: (document: unknown) => LoadedDataset
	loadText: (text: string) => LoadedDataset
	failure: (document: unknown) => Promise<unknown>
} {
	let dir = ""
	beforeEach(async () => {
		dir = await mkdtemp(path.join(os.tmpdir(), "longmemeval-admission-"))
	})
	afterEach(async () => {
		await rm(dir, { recursive: true, force: true })
	})
	const loadText = async (text: string) => {
		const target = path.join(dir, "longmemeval.json")
		await writeFile(target, text)
		return loadBenchmarkDataset(target)
	}
	const load = (document: unknown) => loadText(JSON.stringify(document))
	const failure = (document: unknown) =>
		load(document).then(
			() => {
				throw new Error("expected admission to fail")
			},
			(caught: unknown) => caught,
		)
	return { load, loadText, failure }
}

export type Question = Record<string, unknown>

export function question(id: string, overrides: Question = {}): Question {
	return {
		question_id: id,
		question_type: "single-session-user",
		question: `What about ${id}?`,
		answer: `answer ${id}`,
		haystack_session_ids: [`${id}-s1`],
		haystack_sessions: [
			[
				{ role: "user", content: `fact for ${id}`, has_answer: true },
				{ role: "assistant", content: "noted" },
			],
		],
		answer_session_ids: [`${id}-s1`],
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
