import { describe, expect, it } from "vitest"
import type { EnrichmentProvider } from "../packages/memory-engine/src/mongodb-llm-enrichment.js"
import { type AnswerContent, generateAnswer } from "./mongodb-e2e-qa-calls.js"

// The answer request carries exactly one kind of content: custom-v1
// passages, custom-v2 dated passages or custom-v3 reader content.
// Fictional strings only.

type Call = Parameters<EnrichmentProvider["chatCompletion"]>[0]

async function sentUser(content: AnswerContent): Promise<string | undefined> {
	const calls: Call[] = []
	const provider: EnrichmentProvider = {
		name: "recording",
		chatCompletion: async (call: Call) => {
			calls.push(call)
			return {
				content: JSON.stringify({ answer: "Quillmarsh" }),
				responseMeta: { shape: "ok", finishReason: "stop" },
			}
		},
	}
	await generateAnswer({
		provider,
		model: "fixture-answer-model",
		question: "Where did the heron nest?",
		content,
	})
	return calls[0]?.messages[1]?.content
}

describe("generateAnswer content", () => {
	it("renders custom-v1 passages", async () => {
		expect(
			await sentUser({ kind: "passages", contextPassages: ["By the pond."] }),
		).toBe(
			[
				"QUESTION: Where did the heron nest?",
				"<context>",
				"[1] By the pond.",
				"</context>",
				'Return only {"answer":"..."}.',
			].join("\n"),
		)
	})

	it("renders custom-v2 dated passages", async () => {
		expect(
			await sentUser({
				kind: "dated-passages",
				questionDate: "2031/02/14 (Fri) 09:30",
				contextPassages: ["By the pond."],
				passageDates: [["2031/01/20 (Mon) 10:00"]],
				passageRoles: ["assistant"],
			}),
		).toBe(
			[
				"QUESTION (asked on 2031/02/14 (Fri) 09:30): Where did the heron nest?",
				"<context>",
				"[1] [2031/01/20 (Mon) 10:00] Assistant: By the pond.",
				"</context>",
				'Return only {"answer":"..."}.',
			].join("\n"),
		)
	})

	it("sends custom-v3 reader content as is", async () => {
		expect(
			await sentUser({ kind: "reader", userContent: "History Chats:\n\nX" }),
		).toBe("History Chats:\n\nX")
	})

	it("accepts one kind of content only", () => {
		const rejected: AnswerContent[] = [
			// @ts-expect-error reader content carries no passages
			{ kind: "reader", userContent: "x", contextPassages: ["p"] },
			// @ts-expect-error dated passages carry no reader content
			{ kind: "dated-passages", contextPassages: [], userContent: "x" },
			// @ts-expect-error custom-v1 passages carry no dates
			{ kind: "passages", contextPassages: [], passageDates: [] },
		]
		const legacy: Parameters<typeof generateAnswer>[0] = {
			provider: {
				name: "unused",
				chatCompletion: async () => {
					throw new Error("never called")
				},
			},
			model: "m",
			question: "q",
			content: { kind: "passages", contextPassages: [] },
			// @ts-expect-error the separate readerContent parameter is gone
			readerContent: "x",
		}
		expect(rejected).toHaveLength(3)
		expect(legacy.content.kind).toBe("passages")
	})
})
