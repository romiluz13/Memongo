import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
	createHttpProvider,
	EnrichmentHttpError,
} from "../packages/memory-engine/src/mongodb-llm-enrichment.js"
import { runE2eQa } from "./mongodb-e2e-qa.js"

// Synthetic, fictional envelopes through the real OpenAI-compatible provider.
// Every body carries the canary so a leak into the record or the logs fails.
const CANARY = "OKAPI-CANARY-73"
const TRANSPORT = { verifyPublicHostname: async () => {} }

type FetchStep = (signal: AbortSignal) => Promise<Response>

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	})
}

function completion(message: Record<string, unknown>, extra = {}) {
	return {
		choices: [{ index: 0, finish_reason: "stop", message }],
		...extra,
	}
}

const verdict = () =>
	json(
		completion({
			role: "assistant",
			content: JSON.stringify({ correct: true, rationale: "fixture" }),
		}),
	)

/** Answer requests take `answer`; judge requests get a fixed verdict. */
function fixtureFetch(answer: FetchStep) {
	const answerCalls: string[] = []
	const fetchFn = vi.fn(async (_url: unknown, init?: RequestInit) => {
		const body = String(init?.body)
		if (body.includes("GOLD ANSWER:")) return verdict()
		answerCalls.push(body)
		return answer(init?.signal as AbortSignal)
	})
	return { fetchFn: fetchFn as unknown as typeof fetch, answerCalls }
}

async function runOne(answer: FetchStep, transport = TRANSPORT) {
	const { fetchFn, answerCalls } = fixtureFetch(answer)
	const provider = createHttpProvider(
		{
			baseUrl: "https://answer.example.invalid/v1",
			apiKey: "fixture-key",
			model: "fixture-answer-model",
		},
		fetchFn,
		transport,
	)
	const envelope = await runE2eQa({
		provider,
		model: "fixture-answer-model",
		judgeModel: "fixture-judge-model",
		cases: [
			{
				caseId: "fixture-case",
				question: "Where did the fictional bakery move?",
				goldAnswer: "Lisbon",
				contextPassages: ["The fictional bakery moved to Lisbon."],
			},
		],
	})
	return { result: envelope.caseResults[0], answerCalls }
}

let logged: string[] = []
beforeEach(() => {
	vi.useFakeTimers()
	logged = []
	for (const method of ["log", "warn", "error", "debug", "info"] as const) {
		vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
			logged.push(args.map(String).join(" "))
		})
	}
})
afterEach(() => {
	vi.useRealTimers()
	vi.unstubAllEnvs()
	vi.restoreAllMocks()
})

function expectNoLeak(result: unknown) {
	expect(JSON.stringify(result)).not.toContain(CANARY)
	expect(logged.join("\n")).not.toContain(CANARY)
}

describe("answer call record", () => {
	it("records one call's latency and its reported usage", async () => {
		const { result, answerCalls } = await runOne(async () => {
			vi.advanceTimersByTime(1234)
			return json(
				completion(
					{
						role: "assistant",
						content: JSON.stringify({ answer: "Lisbon", note: CANARY }),
					},
					{
						usage: {
							prompt_tokens: 7000,
							completion_tokens: 5,
							completion_tokens_details: { reasoning_tokens: 90 },
							total_tokens: 7105,
						},
					},
				),
			)
		})
		expect(answerCalls).toHaveLength(1)
		expect(result?.answerAttempt).toMatchObject({
			layer: "content",
			status: "answer",
			latencyMs: 1234,
			usage: {
				inputTokens: 7000,
				outputTokens: 5,
				reasoningTokens: 90,
				totalTokens: 7105,
				hiddenOutputTokens: 100,
			},
		})
		expectNoLeak(result)
	})

	it("records usage the provider did not report as null, never zero", async () => {
		const { result } = await runOne(async () =>
			json(completion({ role: "assistant", content: '{"answer":"Lisbon"}' })),
		)
		expect(result?.answerAttempt?.usage).toBeNull()
	})

	it("keeps reported counts and nulls the ones the provider left out", async () => {
		const { result } = await runOne(async () =>
			json(
				completion(
					{ role: "assistant", content: '{"answer":"Lisbon"}' },
					{ usage: { prompt_tokens: 40, completion_tokens: 3 } },
				),
			),
		)
		expect(result?.answerAttempt?.usage).toEqual({
			inputTokens: 40,
			outputTokens: 3,
			reasoningTokens: null,
			totalTokens: null,
			hiddenOutputTokens: null,
			hiddenOutputTokensUnavailable: "total-tokens-not-reported",
		})
	})

	it("records a provider timeout as timeout with no status", async () => {
		vi.stubEnv("MEMONGO_LLM_ENRICHMENT_TIMEOUT_MS", "5000")
		const pending = runOne(
			(signal) =>
				new Promise<Response>((_, reject) => {
					signal.addEventListener("abort", () =>
						reject(new DOMException(CANARY, "AbortError")),
					)
				}),
		)
		await vi.advanceTimersByTimeAsync(5000)
		const { result, answerCalls } = await pending
		expect(answerCalls).toHaveLength(1)
		expect(result?.answerAttempt).toEqual({
			layer: "transport",
			status: "transport-failure",
			transportFailure: "timeout",
			latencyMs: 5000,
		})
		expect(logged.join("\n")).toMatch(/answer generation failed.*timeout/)
		expectNoLeak(result)
	})

	it("does not let a fetch forge a timeout through the engine's error class", async () => {
		const { result } = await runOne(async () => {
			throw new EnrichmentHttpError(CANARY, 408, "timeout")
		})
		expect(result?.answerAttempt).toMatchObject({
			transportFailure: "http-status",
			httpStatus: 408,
		})
		expectNoLeak(result)
	})

	it("records a rejected fetch as network with no status", async () => {
		const { result } = await runOne(async () => {
			throw new TypeError(CANARY)
		})
		expect(result?.answerAttempt).toEqual({
			layer: "transport",
			status: "transport-failure",
			transportFailure: "network",
			latencyMs: 0,
		})
		expectNoLeak(result)
	})

	it("records a server's own 408 as http-status 408, apart from a timeout", async () => {
		const { result } = await runOne(async () =>
			json({ error: { message: CANARY } }, 408),
		)
		expect(result?.answerAttempt).toEqual({
			layer: "transport",
			status: "transport-failure",
			transportFailure: "http-status",
			httpStatus: 408,
			latencyMs: 0,
		})
		expectNoLeak(result)
	})

	it("records a refused host as other with no status", async () => {
		const { result, answerCalls } = await runOne(
			async () => json(completion({ role: "assistant", content: "{}" })),
			{
				verifyPublicHostname: async () => {
					throw new Error(CANARY)
				},
			},
		)
		expect(answerCalls).toHaveLength(0)
		expect(result?.answerAttempt).toEqual({
			layer: "transport",
			status: "transport-failure",
			transportFailure: "other",
			latencyMs: 0,
		})
		expectNoLeak(result)
	})

	it("marks a length stop with no content string as content missing", async () => {
		const { result } = await runOne(async () =>
			json({
				choices: [
					{ index: 0, finish_reason: "length", message: { role: "assistant" } },
				],
				usage: { prompt_tokens: 6, completion_tokens: 0, total_tokens: 18 },
			}),
		)
		expect(result?.answerAttempt).toMatchObject({
			layer: "envelope",
			status: "truncated",
			shape: "length",
			finishReason: "length",
			contentMissing: true,
			contentBytes: 0,
			usage: { hiddenOutputTokens: 12 },
		})
	})

	it("keeps an empty content string at a length stop apart from missing content", async () => {
		const { result } = await runOne(async () =>
			json({
				choices: [
					{
						index: 0,
						finish_reason: "length",
						message: { role: "assistant", content: "" },
					},
				],
			}),
		)
		expect(result?.answerAttempt).toMatchObject({
			status: "truncated",
			contentBytes: 0,
		})
		expect(result?.answerAttempt).not.toHaveProperty("contentMissing")
	})

	it("classifies whitespace-only content at a normal stop as an empty body", async () => {
		const { result } = await runOne(async () =>
			json(completion({ role: "assistant", content: " \n\t " })),
		)
		expect(result?.answerAttempt).toMatchObject({
			layer: "envelope",
			status: "empty-body",
			shape: "empty-content",
			finishReason: "stop",
			contentBytes: 0,
		})
	})
})
