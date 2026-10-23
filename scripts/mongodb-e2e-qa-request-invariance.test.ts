import { describe, expect, it } from "vitest"
import type { EnrichmentProvider } from "../packages/memory-engine/src/mongodb-llm-enrichment.js"
import { type E2eQaCase, runE2eQa } from "./mongodb-e2e-qa.js"
import { heronCase } from "./mongodb-e2e-qa-reader-budget.fixture.js"

type Call = Parameters<EnrichmentProvider["chatCompletion"]>[0]

// The snapshot file was written by this test at de618f98eb, before answer
// diagnostics existed, so it pins the requests the answerer and judge received
// then. Updating it is a protocol change, not a diagnostics change.
const SNAPSHOT = "./__snapshots__/mongodb-e2e-qa-requests.base-de618f98eb.json"
// Written at 7089dbdefc to pin the custom-v2 and custom-v3 requests as well.
const PROTOCOL_SNAPSHOT = (protocol: string) =>
	`./__snapshots__/mongodb-e2e-qa-requests.${protocol}.base-7089dbdefc.json`

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

describe("runE2eQa request invariance per protocol", () => {
	const decoy: E2eQaCase = {
		caseId: "decoy",
		question: "Which river?",
		goldAnswer: "Tagus",
		questionDate: "2031/02/15 (Sat) 09:30",
		contextPassages: ["The river is the Tagus"],
		passageDates: [["2031/01/21 (Tue) 10:00"]],
		passageRoles: ["user"],
		readerUnits: [
			{
				id: "single:event:u1",
				rank: 1,
				sessionId: "sess-river",
				turnOrder: 1,
				passage: "User: The river is the Tagus.",
				sessionDates: ["2031/01/21 (Tue) 10:00"],
			},
		],
	}
	it.each([
		"custom-v2",
		"custom-v3",
	] as const)("sends byte-identical %s answer, judge and decoy-judge requests", async (protocol) => {
		const { provider, calls } = recordingProvider()
		await runE2eQa({
			provider,
			model: "fixture-answer-model",
			answerModel: "fixture-answer-model",
			judgeModel: "fixture-judge-model",
			cases: [
				heronCase({
					contextPassages: ["The heron nested by Quillmarsh pond"],
					passageDates: [["2031/01/20 (Mon) 10:00"]],
					passageRoles: ["user"],
				}),
				decoy,
			],
			protocol,
		})
		expect(calls).toHaveLength(6)
		await expect(`${JSON.stringify(calls, null, "\t")}\n`).toMatchFileSnapshot(
			PROTOCOL_SNAPSHOT(protocol),
		)
	})

	// Written at 2ab6bdc4af from the same fixtures. A missing snapshot file
	// writes itself, so mongodb-e2e-qa-reader-v4.test.ts pins the v4 prompt
	// and return line directly.
	it("sends byte-identical custom-v4 answer, judge and decoy-judge requests", async () => {
		const { provider, calls } = recordingProvider()
		await runE2eQa({
			provider,
			model: "fixture-answer-model",
			answerModel: "fixture-answer-model",
			judgeModel: "fixture-judge-model",
			cases: [
				heronCase({
					contextPassages: ["The heron nested by Quillmarsh pond"],
					passageDates: [["2031/01/20 (Mon) 10:00"]],
					passageRoles: ["user"],
				}),
				decoy,
			],
			protocol: "custom-v4",
		})
		expect(calls).toHaveLength(6)
		await expect(`${JSON.stringify(calls, null, "\t")}\n`).toMatchFileSnapshot(
			"./__snapshots__/mongodb-e2e-qa-requests.custom-v4.base-2ab6bdc4af.json",
		)
	})
})
