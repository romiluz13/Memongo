import { createHash } from "node:crypto"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type {
	EnrichmentChatResponse,
	EnrichmentProvider,
} from "../packages/memory-engine/src/mongodb-llm-enrichment.js"
import { runE2eQa } from "./mongodb-e2e-qa.js"

// Synthetic, fictional envelopes. Every body carries the canary so any leak
// of response text into the case result or the logs is caught.
const CANARY = "ZEBRA-CANARY-41"

type Fixture = {
	name: string
	reply: EnrichmentChatResponse | Error
	layer: "transport" | "envelope" | "content"
	status: string
	shape?: string
	finishReason?: string
	contentMissing?: true
	candidateAnswer: string
	failed: boolean
}

const FIXTURES: Fixture[] = [
	{
		name: "normal JSON",
		reply: {
			content: JSON.stringify({ answer: " Lisbon ", note: CANARY }),
			responseMeta: { shape: "ok", finishReason: "stop" },
		},
		layer: "content",
		status: "answer",
		shape: "ok",
		finishReason: "stop",
		candidateAnswer: "Lisbon",
		failed: false,
	},
	{
		name: "empty answer string",
		reply: {
			content: JSON.stringify({ answer: "", note: CANARY }),
			responseMeta: { shape: "ok", finishReason: "stop" },
		},
		layer: "content",
		status: "empty-answer",
		shape: "ok",
		finishReason: "stop",
		candidateAnswer: "",
		failed: false,
	},
	{
		name: "missing answer",
		reply: {
			content: JSON.stringify({ reply: CANARY }),
			responseMeta: { shape: "ok", finishReason: "stop" },
		},
		layer: "content",
		status: "missing-answer",
		shape: "ok",
		finishReason: "stop",
		candidateAnswer: "",
		failed: true,
	},
	{
		name: "answer of the wrong type",
		reply: {
			content: JSON.stringify({ answer: [CANARY] }),
			responseMeta: { shape: "ok", finishReason: "stop" },
		},
		layer: "content",
		status: "wrong-answer-type",
		shape: "ok",
		finishReason: "stop",
		candidateAnswer: "",
		failed: true,
	},
	{
		name: "invalid JSON",
		reply: {
			content: `{"answer":"${CANARY} never closed`,
			responseMeta: { shape: "ok", finishReason: "stop" },
		},
		layer: "content",
		status: "invalid-json",
		shape: "ok",
		finishReason: "stop",
		candidateAnswer: "",
		failed: true,
	},
	{
		name: "refusal",
		reply: {
			content: CANARY,
			responseMeta: { shape: "refusal", finishReason: "stop", refusal: true },
		},
		layer: "envelope",
		status: "refusal",
		shape: "refusal",
		finishReason: "stop",
		candidateAnswer: "",
		failed: true,
	},
	{
		name: "content filter",
		reply: {
			content: CANARY,
			responseMeta: {
				shape: "content-filter",
				finishReason: "content_filter",
				refusal: true,
			},
		},
		layer: "envelope",
		status: "content-filter",
		shape: "content-filter",
		finishReason: "content_filter",
		candidateAnswer: "",
		failed: true,
	},
	{
		name: "missing choices",
		reply: { content: "", responseMeta: { shape: "missing-choices" } },
		layer: "envelope",
		status: "missing-choices",
		shape: "missing-choices",
		candidateAnswer: "",
		failed: true,
	},
	{
		name: "malformed message",
		reply: { content: "", responseMeta: { shape: "malformed-message" } },
		layer: "envelope",
		status: "malformed-message",
		shape: "malformed-message",
		candidateAnswer: "",
		failed: true,
	},
	{
		name: "null body",
		reply: {
			content: "",
			responseMeta: { shape: "null-content", finishReason: "stop" },
		},
		layer: "envelope",
		status: "empty-body",
		shape: "null-content",
		finishReason: "stop",
		candidateAnswer: "",
		failed: true,
	},
	{
		name: "whitespace-only content at a normal stop",
		reply: {
			content: "",
			responseMeta: { shape: "empty-content", finishReason: "stop" },
		},
		layer: "envelope",
		status: "empty-body",
		shape: "empty-content",
		finishReason: "stop",
		candidateAnswer: "",
		failed: true,
	},
	{
		name: "length with no content",
		reply: {
			content: "",
			responseMeta: {
				shape: "length",
				finishReason: "length",
				contentMissing: true,
			},
		},
		layer: "envelope",
		status: "truncated",
		shape: "length",
		finishReason: "length",
		contentMissing: true,
		candidateAnswer: "",
		failed: true,
	},
	{
		name: "empty body from an unvalidated provider",
		reply: { content: "  " },
		layer: "envelope",
		status: "empty-body",
		shape: "unvalidated",
		candidateAnswer: "",
		failed: true,
	},
	{
		name: "length with valid JSON",
		reply: {
			content: JSON.stringify({ answer: "Lisbon", note: CANARY }),
			responseMeta: { shape: "length", finishReason: "length" },
		},
		layer: "content",
		status: "answer",
		shape: "length",
		finishReason: "length",
		candidateAnswer: "Lisbon",
		failed: false,
	},
	{
		name: "length with invalid JSON",
		reply: {
			content: `{"answer":"${CANARY}`,
			responseMeta: { shape: "length", finishReason: "length" },
		},
		layer: "envelope",
		status: "truncated",
		shape: "length",
		finishReason: "length",
		candidateAnswer: "",
		failed: true,
	},
	{
		name: "unlisted finish reason",
		reply: {
			content: JSON.stringify({ answer: "Lisbon" }),
			responseMeta: { shape: "ok", finishReason: CANARY },
		},
		layer: "content",
		status: "answer",
		shape: "ok",
		finishReason: "unlisted",
		candidateAnswer: "Lisbon",
		failed: false,
	},
	{
		name: "transport failure",
		reply: new Error(`gateway said ${CANARY}`),
		layer: "transport",
		status: "transport-failure",
		candidateAnswer: "",
		failed: true,
	},
]

function fixtureProvider(reply: EnrichmentChatResponse | Error) {
	const provider: EnrichmentProvider = {
		name: "fixture",
		chatCompletion: vi.fn<EnrichmentProvider["chatCompletion"]>(
			async ({ messages }) => {
				const user = messages.find((m) => m.role === "user")?.content ?? ""
				if (user.includes("GOLD ANSWER:")) {
					return {
						content: JSON.stringify({ correct: false, rationale: "fixture" }),
					}
				}
				if (reply instanceof Error) throw reply
				return reply
			},
		),
	}
	return provider
}

let logged: string[] = []
beforeEach(() => {
	logged = []
	for (const method of ["log", "warn", "error", "debug", "info"] as const) {
		vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
			logged.push(args.map(String).join(" "))
		})
	}
})
afterEach(() => {
	vi.restoreAllMocks()
})

async function runOne(
	reply: EnrichmentChatResponse | Error,
	abstention = false,
) {
	return runE2eQa({
		provider: fixtureProvider(reply),
		model: "fixture-answer-model",
		judgeModel: "fixture-judge-model",
		cases: [
			{
				caseId: "fixture-case",
				question: "Where did the fictional bakery move?",
				goldAnswer: abstention ? "" : "Lisbon",
				contextPassages: ["The fictional bakery moved to Lisbon."],
				abstention,
			},
		],
	})
}

describe("answer attempt status", () => {
	for (const fixture of FIXTURES) {
		it(`classifies ${fixture.name}`, async () => {
			const envelope = await runOne(fixture.reply)
			const result = envelope.caseResults[0]
			const content =
				fixture.reply instanceof Error ? undefined : fixture.reply.content
			expect(result?.answerAttempt).toEqual({
				layer: fixture.layer,
				status: fixture.status,
				...(fixture.shape ? { shape: fixture.shape } : {}),
				...(fixture.finishReason ? { finishReason: fixture.finishReason } : {}),
				...(content === undefined
					? { transportFailure: "other" }
					: {
							contentBytes: Buffer.byteLength(content, "utf8"),
							contentSha256: createHash("sha256")
								.update(content, "utf8")
								.digest("hex"),
							usage: null,
						}),
				...(fixture.contentMissing ? { contentMissing: true } : {}),
				latencyMs: expect.any(Number),
			})
			const latencyMs = result?.answerAttempt?.latencyMs
			expect(Number.isInteger(latencyMs)).toBe(true)
			expect(latencyMs).toBeGreaterThanOrEqual(0)
			expect(result?.candidateAnswer).toBe(fixture.candidateAnswer)
			expect(result?.error).toBe(
				fixture.failed ? `answer-generation: ${fixture.status}` : undefined,
			)
			expect(envelope.cases.failed).toBe(fixture.failed ? 1 : 0)
			expect(JSON.stringify(result)).not.toContain(CANARY)
			const logText = logged.join("\n")
			expect(logText).not.toContain(CANARY)
			expect(logText).not.toMatch(
				/JSON Parse|Unexpected|Unterminated|position/i,
			)
		})
	}

	it("keeps a schema error out of the abstention credit while a valid empty answer earns it", async () => {
		const missing = await runOne(
			{
				content: JSON.stringify({ reply: "nothing" }),
				responseMeta: { shape: "ok", finishReason: "stop" },
			},
			true,
		)
		expect(missing.caseResults[0]?.correct).toBe(false)
		expect(missing.cases).toMatchObject({ attempted: 1, failed: 1 })
		expect(missing.accuracy).toBe(0)

		const empty = await runOne(
			{
				content: JSON.stringify({ answer: "" }),
				responseMeta: { shape: "ok", finishReason: "stop" },
			},
			true,
		)
		expect(empty.caseResults[0]?.correct).toBe(true)
		expect(empty.caseResults[0]?.answerAttempt?.status).toBe("empty-answer")
		expect(empty.cases).toMatchObject({ attempted: 1, completed: 1 })
		expect(empty.accuracy).toBe(1)
	})
})
