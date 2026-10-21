import { describe, expect, it } from "vitest"
import type { EnrichmentProvider } from "../packages/memory-engine/src/mongodb-llm-enrichment.js"
import { runE2eQa } from "./mongodb-e2e-qa.js"

type Call = Parameters<EnrichmentProvider["chatCompletion"]>[0]

// The snapshot file was written by this test at de618f98eb, before answer
// diagnostics existed, so it pins the requests the answerer and judge received
// then. Updating it is a protocol change, not a diagnostics change.
const SNAPSHOT = "./__snapshots__/mongodb-e2e-qa-requests.base-de618f98eb.json"

function recordingProvider() {
	const calls: Call[] = []
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
			return {
				content: JSON.stringify({ answer: "Lisbon" }),
				responseMeta: { shape: "ok", finishReason: "stop" },
			}
		},
	}
	return { provider, calls }
}

describe("runE2eQa request invariance", () => {
	it("sends byte-identical answer and judge requests to the base commit", async () => {
		const { provider, calls } = recordingProvider()
		await runE2eQa({
			provider,
			model: "fixture-answer-model",
			answerModel: "fixture-answer-model",
			judgeModel: "fixture-judge-model",
			cases: [
				{
					caseId: "capped",
					question: "Where did Zoë’s café ☕ move?",
					goldAnswer: "Lisbon",
					contextPassages: Array.from(
						{ length: 24 },
						(_, i) => `passage ${i} — שלום 👩‍👩‍👧`,
					),
				},
				{
					caseId: "abstain",
					question: "What is the fictional secret?",
					goldAnswer: "",
					abstention: true,
					contextPassages: ["nothing relevant"],
				},
				{
					caseId: "short",
					question: "Which river?",
					goldAnswer: "Tagus",
					contextPassages: ["  padded\t ", ""],
				},
			],
		})
		expect(calls).toHaveLength(7)
		await expect(`${JSON.stringify(calls, null, "\t")}\n`).toMatchFileSnapshot(
			SNAPSHOT,
		)
	})
})
