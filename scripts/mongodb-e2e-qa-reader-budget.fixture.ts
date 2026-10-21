import type {
	EnrichmentChatUsage,
	EnrichmentProvider,
} from "../packages/memory-engine/src/mongodb-llm-enrichment.js"
import type { ReaderUnit } from "./benchmark/reader-budget.js"
import { type E2eQaCase, runE2eQa } from "./mongodb-e2e-qa.js"

// Shared custom-v3 fixtures: a recording provider and the heron reader
// units. Fictional strings only.

export type Call = Parameters<EnrichmentProvider["chatCompletion"]>[0]

export function recordingProvider(
	answerUsage: Array<EnrichmentChatUsage | undefined>,
) {
	const calls: Call[] = []
	let answers = 0
	const provider: EnrichmentProvider = {
		name: "recording",
		chatCompletion: async (call: Call) => {
			calls.push(structuredClone(call))
			const user = call.messages.find((m) => m.role === "user")?.content ?? ""
			if (user.includes("GOLD ANSWER:")) {
				return {
					content: JSON.stringify({ correct: true, rationale: "fixture" }),
					responseMeta: { shape: "ok", finishReason: "stop" },
				}
			}
			const usage = answerUsage[answers++]
			return {
				content: JSON.stringify({ answer: "Quillmarsh" }),
				responseMeta: { shape: "ok", finishReason: "stop" },
				...(usage ? { usage } : {}),
			}
		},
	}
	return { provider, calls }
}

export function unit(
	id: string,
	rank: number,
	sessionId: string,
	turnOrder: number,
	passage: string,
	sessionDates: string[],
): ReaderUnit {
	return { id, rank, sessionId, turnOrder, passage, sessionDates }
}

export const HERON_UNITS: ReaderUnit[] = [
	unit(
		"round:event:u2|event:a2",
		1,
		"sess-pond",
		2,
		"User: Where did the heron nest?\nAssistant: By Quillmarsh pond.",
		["2031/01/20 (Mon) 10:00"],
	),
	unit(
		"single:event:u7",
		2,
		"sess-reeds",
		1,
		"User: Brindlewick reeds are tall.",
		["2030/11/02 (Sat) 18:45"],
	),
]

export function heronCase(overrides: Partial<E2eQaCase> = {}): E2eQaCase {
	return {
		caseId: "heron",
		question: "Where did the heron nest?",
		goldAnswer: "Quillmarsh",
		questionDate: "2031/02/14 (Fri) 09:30",
		contextPassages: [],
		readerUnits: HERON_UNITS,
		...overrides,
	}
}

export async function run(
	cases: E2eQaCase[],
	answerUsage: Array<EnrichmentChatUsage | undefined> = [],
) {
	const { provider, calls } = recordingProvider(answerUsage)
	const envelope = await runE2eQa({
		provider,
		model: "fixture-answer-model",
		answerModel: "fixture-answer-model",
		judgeModel: "fixture-judge-model",
		cases,
		protocol: "custom-v3",
	})
	const answers = calls.filter(
		(call) =>
			!call.messages
				.find((m) => m.role === "user")
				?.content.includes("GOLD ANSWER:"),
	)
	return { calls, answers, envelope }
}
