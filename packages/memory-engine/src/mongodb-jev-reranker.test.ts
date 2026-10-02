import { describe, expect, it, vi } from "vitest"
import {
	JEV_ENDPOINT,
	JEV_MAX_CANDIDATES,
	JEV_MAX_REQUEST_BYTES,
	JEV_MAX_RESPONSE_BYTES,
	JEV_MODEL_ID,
	JEV_RELEVANCE_LEVELS,
	JevRerankError,
	type JevRerankOutcome,
	scoreCandidatesWithJev,
} from "./mongodb-jev-reranker.js"

// Deterministic fixtures only — no provider calls, no real DNS, no network.
// The DNS guard is always injected as a resolved no-op; fetch is always a
// local fake. Native JSON.parse keeps the last duplicate key; exact key-set
// validation (not duplicate detection) is what these tests pin down.

const QUERY = "when did we migrate the ledger to MongoDB?"
const CANDIDATES = ["we migrated the ledger in March", "unrelated banter"]

function legendMap(): Record<string, string> {
	const out: Record<string, string> = {}
	JEV_RELEVANCE_LEVELS.forEach((text, i) => {
		out[String(i)] = text
	})
	return out
}

/** Build one valid Score answer whose score IS the expectation. */
function scoreAnswer(probabilities: Record<string, number>) {
	const expectation = Object.entries(probabilities).reduce(
		(acc, [level, p]) => acc + Number(level) * p,
		0,
	)
	return {
		type: "score",
		score: expectation,
		legend: legendMap(),
		probabilities,
		confidence: 0.9,
	}
}

function okBody(
	candidates: string[],
	extra: Record<string, unknown> = {},
): string {
	const answers: Record<string, unknown> = {}
	candidates.forEach((_, i) => {
		answers[`candidate_${i}`] = scoreAnswer({
			"0": 0.1,
			"1": 0.2,
			"2": 0.4,
			"3": 0.2,
			"4": 0.1,
		})
	})
	return JSON.stringify({
		model: JEV_MODEL_ID,
		answers,
		usage: { input_tokens: 120, output_tokens: 30 },
		...extra,
	})
}

type FakeFetch = {
	calls: Array<{ url: string; init?: RequestInit }>
	fetch: typeof globalThis.fetch
}

function makeFakeFetch(
	responder: (url: string, init?: RequestInit) => Promise<Response> | Response,
): FakeFetch {
	const calls: Array<{ url: string; init?: RequestInit }> = []
	const fetch = (async (url: unknown, init?: RequestInit) => {
		calls.push({ url: String(url), init })
		return responder(String(url), init)
	}) as typeof globalThis.fetch
	return { calls, fetch }
}

function baseParams(
	fake: FakeFetch,
	overrides: Partial<Parameters<typeof scoreCandidatesWithJev>[0]> = {},
) {
	return {
		query: QUERY,
		candidates: CANDIDATES,
		apiKey: "test-server-key",
		remainingMs: 2000,
		fetchFn: fake.fetch,
		verifyPublicHostname: async () => {},
		...overrides,
	}
}

function lateFetch(ms: number, response: () => Response): FakeFetch {
	return makeFakeFetch(
		() =>
			new Promise<Response>((resolve) =>
				setTimeout(() => resolve(response()), ms),
			),
	)
}

describe("scoreCandidatesWithJev", () => {
	it("returns normalized scores, raw scores, and usage for an exact valid response", async () => {
		const fake = makeFakeFetch(
			() => new Response(okBody(CANDIDATES), { status: 200 }),
		)
		const outcome = await scoreCandidatesWithJev(baseParams(fake))
		expect(outcome.status).toBe("ok")
		if (outcome.status !== "ok") return
		expect(outcome.rawScores).toEqual([2, 2])
		expect(outcome.scores).toEqual([0.5, 0.5])
		expect(outcome.usage).toEqual({
			status: "known",
			inputTokens: 120,
			outputTokens: 30,
		})
		expect(fake.calls).toHaveLength(1)
		expect(fake.calls[0].url).toBe(JEV_ENDPOINT)
		const init = fake.calls[0].init
		expect(init?.method).toBe("POST")
		expect((init?.headers as Record<string, string>).authorization).toBe(
			"Bearer test-server-key",
		)
		const request = JSON.parse(String(init?.body))
		expect(request.model).toBe(JEV_MODEL_ID)
		expect(Object.keys(request.questions)).toEqual([
			"candidate_0",
			"candidate_1",
		])
		expect(request.questions.candidate_0.criteria).toEqual([
			...JEV_RELEVANCE_LEVELS,
		])
	})

	it("never retries: exactly one fetch for every outcome class", async () => {
		const fake = makeFakeFetch(
			() => new Response("rate limited", { status: 429 }),
		)
		await scoreCandidatesWithJev(baseParams(fake))
		expect(fake.calls).toHaveLength(1)
	})

	it("rejects missing answer keys as a whole", async () => {
		const body = JSON.parse(okBody(CANDIDATES))
		delete body.answers.candidate_1
		const fake = makeFakeFetch(
			() => new Response(JSON.stringify(body), { status: 200 }),
		)
		const outcome = await scoreCandidatesWithJev(baseParams(fake))
		expect(outcome).toMatchObject({
			status: "failed",
			category: "invalid-response",
		})
	})

	it("rejects extra answer keys as a whole", async () => {
		const body = JSON.parse(okBody(CANDIDATES))
		body.answers.candidate_2 = scoreAnswer({ "4": 1 })
		const fake = makeFakeFetch(
			() => new Response(JSON.stringify(body), { status: 200 }),
		)
		const outcome = await scoreCandidatesWithJev(baseParams(fake))
		expect(outcome).toMatchObject({
			status: "failed",
			category: "invalid-response",
		})
	})

	it.each([
		4.2,
		-0.1,
		Number.NaN,
		Number.POSITIVE_INFINITY,
	])("rejects non-finite or out-of-range score %s", async (score) => {
		const body = JSON.parse(okBody(CANDIDATES))
		body.answers.candidate_0 = {
			...body.answers.candidate_0,
			score,
		}
		// JSON.stringify(NaN/Infinity) -> null, still rejected as non-number.
		const fake = makeFakeFetch(
			() => new Response(JSON.stringify(body), { status: 200 }),
		)
		const outcome = await scoreCandidatesWithJev(baseParams(fake))
		expect(outcome).toMatchObject({
			status: "failed",
			category: "invalid-response",
		})
	})

	it("rejects a mismatched legend text", async () => {
		const body = JSON.parse(okBody(CANDIDATES))
		body.answers.candidate_1.legend["4"] = "tampered legend text"
		const fake = makeFakeFetch(
			() => new Response(JSON.stringify(body), { status: 200 }),
		)
		const outcome = await scoreCandidatesWithJev(baseParams(fake))
		expect(outcome).toMatchObject({
			status: "failed",
			category: "invalid-response",
		})
	})

	it("rejects a legend with extra keys or array shape", async () => {
		for (const legend of [
			{ ...legendMap(), "5": "extra level" },
			[...JEV_RELEVANCE_LEVELS],
		]) {
			const body = JSON.parse(okBody(CANDIDATES))
			body.answers.candidate_0.legend = legend
			const fake = makeFakeFetch(
				() => new Response(JSON.stringify(body), { status: 200 }),
			)
			const outcome = await scoreCandidatesWithJev(baseParams(fake))
			expect(outcome).toMatchObject({
				status: "failed",
				category: "invalid-response",
			})
		}
	})

	it("rejects an extra distribution level beyond the frozen legend", async () => {
		const body = JSON.parse(okBody(CANDIDATES))
		body.answers.candidate_0 = {
			...body.answers.candidate_0,
			probabilities: {
				"0": 0.1,
				"1": 0.2,
				"2": 0.35,
				"3": 0.2,
				"4": 0.1,
				"5": 0.05,
			},
			score: 2,
		}
		const fake = makeFakeFetch(
			() => new Response(JSON.stringify(body), { status: 200 }),
		)
		const outcome = await scoreCandidatesWithJev(baseParams(fake))
		expect(outcome).toMatchObject({
			status: "failed",
			category: "invalid-response",
		})
	})

	it("rejects missing or out-of-range confidence instead of inventing one", async () => {
		for (const confidence of [undefined, 999, -0.5, Number.NaN]) {
			const body = JSON.parse(okBody(CANDIDATES))
			if (confidence === undefined) {
				delete body.answers.candidate_0.confidence
			} else {
				body.answers.candidate_0.confidence = confidence
			}
			const fake = makeFakeFetch(
				() => new Response(JSON.stringify(body), { status: 200 }),
			)
			const outcome = await scoreCandidatesWithJev(baseParams(fake))
			expect(outcome).toMatchObject({
				status: "failed",
				category: "invalid-response",
			})
		}
	})

	it("rejects an unpinned reported model (alias or drift)", async () => {
		const body = JSON.parse(okBody(CANDIDATES))
		body.model = "jev-latest"
		const fake = makeFakeFetch(
			() => new Response(JSON.stringify(body), { status: 200 }),
		)
		const outcome = await scoreCandidatesWithJev(baseParams(fake))
		expect(outcome).toMatchObject({
			status: "failed",
			category: "invalid-response",
		})
	})

	it("rejects probabilities that do not sum to 1 within tolerance", async () => {
		const body = JSON.parse(okBody(CANDIDATES))
		body.answers.candidate_0 = scoreAnswer({
			"0": 0.1,
			"1": 0.2,
			"2": 0.3,
			"3": 0.1,
			"4": 0.1, // sum 0.8
		})
		const fake = makeFakeFetch(
			() => new Response(JSON.stringify(body), { status: 200 }),
		)
		const outcome = await scoreCandidatesWithJev(baseParams(fake))
		expect(outcome).toMatchObject({
			status: "failed",
			category: "invalid-response",
		})
	})

	it("accepts probability-sum drift within 1e-3", async () => {
		const body = JSON.parse(okBody(CANDIDATES))
		const probs = { "0": 0.1, "1": 0.2, "2": 0.4005, "3": 0.2, "4": 0.1 }
		const expectation = 0 * 0.1 + 1 * 0.2 + 2 * 0.4005 + 3 * 0.2 + 4 * 0.1
		body.answers.candidate_0 = {
			...scoreAnswer(probs),
			probabilities: probs,
			score: expectation,
		}
		const fake = makeFakeFetch(
			() => new Response(JSON.stringify(body), { status: 200 }),
		)
		const outcome = await scoreCandidatesWithJev(baseParams(fake))
		expect(outcome.status).toBe("ok")
	})

	it("rejects a score that is not the expectation of its probabilities", async () => {
		const body = JSON.parse(okBody(CANDIDATES))
		body.answers.candidate_0 = {
			...body.answers.candidate_0,
			score: 3.5, // probabilities imply 2.0
		}
		const fake = makeFakeFetch(
			() => new Response(JSON.stringify(body), { status: 200 }),
		)
		const outcome = await scoreCandidatesWithJev(baseParams(fake))
		expect(outcome).toMatchObject({
			status: "failed",
			category: "invalid-response",
		})
	})

	it("rejects malformed JSON bodies", async () => {
		const fake = makeFakeFetch(() => new Response("{not json", { status: 200 }))
		const outcome = await scoreCandidatesWithJev(baseParams(fake))
		expect(outcome).toMatchObject({
			status: "failed",
			category: "invalid-json",
		})
	})

	it("skips oversized serialized requests without dispatching", async () => {
		const fake = makeFakeFetch(
			() => new Response(okBody(["x"]), { status: 200 }),
		)
		const bigCandidate = "x".repeat(JEV_MAX_REQUEST_BYTES)
		const outcome = await scoreCandidatesWithJev(
			baseParams(fake, { candidates: [bigCandidate] }),
		)
		expect(outcome).toMatchObject({
			status: "skipped",
			reason: "request-too-large",
		})
		expect(fake.calls).toHaveLength(0)
	})

	it("fails oversized response bodies", async () => {
		const fake = makeFakeFetch(
			() =>
				new Response("x".repeat(JEV_MAX_RESPONSE_BYTES + 1), {
					status: 200,
				}),
		)
		const outcome = await scoreCandidatesWithJev(baseParams(fake))
		expect(outcome).toMatchObject({
			status: "failed",
			category: "response-too-large",
		})
	})

	it(`accepts exactly ${JEV_MAX_CANDIDATES} candidates and skips ${JEV_MAX_CANDIDATES + 1}`, async () => {
		const twenty = Array.from({ length: JEV_MAX_CANDIDATES }, (_, i) => `c${i}`)
		const okFake = makeFakeFetch(
			() => new Response(okBody(twenty), { status: 200 }),
		)
		const okOutcome = await scoreCandidatesWithJev(
			baseParams(okFake, { candidates: twenty }),
		)
		expect(okOutcome.status).toBe("ok")

		const skipFake = makeFakeFetch(() => new Response("{}", { status: 200 }))
		const skipOutcome = await scoreCandidatesWithJev(
			baseParams(skipFake, { candidates: [...twenty, "one-too-many"] }),
		)
		expect(skipOutcome).toMatchObject({
			status: "skipped",
			reason: "too-many-candidates",
		})
		expect(skipFake.calls).toHaveLength(0)
	})

	it("skips empty or whitespace-only candidates instead of dropping them", async () => {
		const fake = makeFakeFetch(
			() => new Response(okBody(CANDIDATES), { status: 200 }),
		)
		const outcome = await scoreCandidatesWithJev(
			baseParams(fake, { candidates: ["valid", "   "] }),
		)
		expect(outcome).toMatchObject({
			status: "skipped",
			reason: "empty-candidate",
		})
		expect(fake.calls).toHaveLength(0)
	})

	it("skips with no credential and never reads the environment", async () => {
		const fake = makeFakeFetch(
			() => new Response(okBody(CANDIDATES), { status: 200 }),
		)
		const outcome = await scoreCandidatesWithJev(
			baseParams(fake, { apiKey: "" }),
		)
		expect(outcome).toMatchObject({ status: "skipped", reason: "no-api-key" })
		expect(fake.calls).toHaveLength(0)
	})

	it("skips when the remaining budget is below the floor", async () => {
		const fake = makeFakeFetch(
			() => new Response(okBody(CANDIDATES), { status: 200 }),
		)
		const outcome = await scoreCandidatesWithJev(
			baseParams(fake, { remainingMs: 249 }),
		)
		expect(outcome).toMatchObject({
			status: "skipped",
			reason: "budget-exhausted",
		})
		expect(fake.calls).toHaveLength(0)
	})

	it("skips a non-finite remaining budget instead of dispatching", async () => {
		const fake = makeFakeFetch(
			() => new Response(okBody(CANDIDATES), { status: 200 }),
		)
		for (const remainingMs of [Number.NaN, Number.POSITIVE_INFINITY]) {
			const outcome = await scoreCandidatesWithJev(
				baseParams(fake, { remainingMs }),
			)
			// Infinity is clamped to the stage cap and may proceed; NaN must not.
			if (Number.isNaN(remainingMs)) {
				expect(outcome).toMatchObject({
					status: "skipped",
					reason: "budget-exhausted",
				})
			}
		}
		expect(fake.calls.length).toBeLessThanOrEqual(1)
	})

	it.each([
		429, 500, 529,
	])("fails http status %i with sanitized category, never body text", async (status) => {
		const fake = makeFakeFetch(
			() => new Response(`provider-secret-body-${QUERY}`, { status }),
		)
		const outcome = await scoreCandidatesWithJev(baseParams(fake))
		expect(outcome).toMatchObject({
			status: "failed",
			category: "http-error",
			httpStatus: status,
		})
		if (outcome.status !== "failed") return
		expect(JSON.stringify(outcome)).not.toContain("provider-secret-body")
	})

	it("refuses redirects (SSRF guard, manual redirect mode)", async () => {
		const fake = makeFakeFetch(
			() =>
				new Response(null, {
					status: 301,
					headers: { location: "https://evil.example/" },
				}),
		)
		const outcome = await scoreCandidatesWithJev(baseParams(fake))
		expect(outcome).toMatchObject({
			status: "failed",
			category: "redirect-refused",
		})
	})

	it("fails closed when the injected DNS guard blocks the host", async () => {
		const fake = makeFakeFetch(
			() => new Response(okBody(CANDIDATES), { status: 200 }),
		)
		const outcome = await scoreCandidatesWithJev(
			baseParams(fake, {
				verifyPublicHostname: async () => {
					throw new Error("SSRF guard blocked private address")
				},
			}),
		)
		expect(outcome).toMatchObject({
			status: "failed",
			category: "ssrf-blocked",
		})
		expect(fake.calls).toHaveLength(0)
	})

	it("fails as transport when fetch rejects (connect failure)", async () => {
		const fake = makeFakeFetch(() => {
			throw new Error("ECONNREFUSED")
		})
		const outcome = await scoreCandidatesWithJev(baseParams(fake))
		expect(outcome).toMatchObject({
			status: "failed",
			category: "transport",
		})
	})

	it("returns by the outer deadline even when the DNS guard stalls", async () => {
		const fake = makeFakeFetch(
			() => new Response(okBody(CANDIDATES), { status: 200 }),
		)
		const started = Date.now()
		const outcome = await scoreCandidatesWithJev(
			baseParams(fake, {
				remainingMs: 300,
				// Guard promise never settles: the race, not the guard, bounds us.
				verifyPublicHostname: () => new Promise<void>(() => {}),
			}),
		)
		expect(outcome).toMatchObject({
			status: "failed",
			category: "deadline-exceeded",
		})
		expect(Date.now() - started).toBeLessThan(2000)
	})

	it("never dispatches fetch when the DNS guard resolves past the deadline", async () => {
		vi.useFakeTimers()
		try {
			const events: JevRerankOutcome[] = []
			const fake = makeFakeFetch(
				() => new Response(okBody(CANDIDATES), { status: 200 }),
			)
			const pending = scoreCandidatesWithJev(
				baseParams(fake, {
					remainingMs: 250,
					verifyPublicHostname: () =>
						new Promise<void>((resolve) => setTimeout(resolve, 350)),
					onEvent: (o) => events.push(o),
				}),
			)
			await vi.advanceTimersByTimeAsync(0)
			expect(fake.calls).toHaveLength(0)
			await vi.advanceTimersByTimeAsync(251)
			const outcome = await pending
			expect(outcome).toMatchObject({
				status: "failed",
				category: "deadline-exceeded",
			})
			expect(fake.calls).toHaveLength(0)
			expect(events).toHaveLength(1)
			await vi.advanceTimersByTimeAsync(200)
			expect(fake.calls).toHaveLength(0)
			expect(events).toHaveLength(1)
			expect(events[0]).toMatchObject({
				status: "failed",
				category: "deadline-exceeded",
			})
		} finally {
			vi.useRealTimers()
		}
	})

	it("discards late completions inert when the transport ignores abort", async () => {
		vi.useFakeTimers()
		try {
			const events: JevRerankOutcome[] = []
			const response = vi.fn(
				() => new Response(okBody(CANDIDATES), { status: 200 }),
			)
			const fake = lateFetch(400, response)
			const pending = scoreCandidatesWithJev(
				baseParams(fake, {
					remainingMs: 250,
					onEvent: (o) => events.push(o),
				}),
			)
			await vi.advanceTimersByTimeAsync(0)
			expect(fake.calls).toHaveLength(1)
			expect(fake.calls[0].init?.signal?.aborted).toBe(false)
			await vi.advanceTimersByTimeAsync(251)
			const outcome = await pending
			expect(outcome).toMatchObject({
				status: "failed",
				category: "deadline-exceeded",
			})
			expect(fake.calls[0].init?.signal?.aborted).toBe(true)
			expect(response).not.toHaveBeenCalled()
			expect(events).toHaveLength(1)
			await vi.advanceTimersByTimeAsync(200)
			expect(response).toHaveBeenCalledExactlyOnceWith()
			expect(fake.calls).toHaveLength(1)
			expect(events).toHaveLength(1)
			expect(events[0]).toMatchObject({
				status: "failed",
				category: "deadline-exceeded",
			})
		} finally {
			vi.useRealTimers()
		}
	})

	it("emits exactly one terminal event when an HTTP error arrives after the deadline", async () => {
		vi.useFakeTimers()
		try {
			const events: JevRerankOutcome[] = []
			const response = vi.fn(() => new Response("too slow", { status: 500 }))
			const fake = lateFetch(400, response)
			const pending = scoreCandidatesWithJev(
				baseParams(fake, {
					remainingMs: 250,
					onEvent: (o) => events.push(o),
				}),
			)
			await vi.advanceTimersByTimeAsync(0)
			expect(fake.calls).toHaveLength(1)
			expect(fake.calls[0].init?.signal?.aborted).toBe(false)
			await vi.advanceTimersByTimeAsync(251)
			const outcome = await pending
			expect(outcome).toMatchObject({
				status: "failed",
				category: "deadline-exceeded",
			})
			expect(fake.calls[0].init?.signal?.aborted).toBe(true)
			expect(response).not.toHaveBeenCalled()
			expect(events).toHaveLength(1)
			await vi.advanceTimersByTimeAsync(200)
			expect(response).toHaveBeenCalledExactlyOnceWith()
			expect(fake.calls).toHaveLength(1)
			expect(events).toHaveLength(1)
			expect(events[0]).toMatchObject({
				status: "failed",
				category: "deadline-exceeded",
			})
		} finally {
			vi.useRealTimers()
		}
	})

	it("normal-mode failures carry no scores and leave order to the caller", async () => {
		const fake = makeFakeFetch(() => new Response("boom", { status: 500 }))
		const outcome = await scoreCandidatesWithJev(baseParams(fake))
		expect(outcome.status).toBe("failed")
		expect("scores" in outcome).toBe(false)
		expect("rawScores" in outcome).toBe(false)
	})

	it("strict mode keeps skips as skipped outcomes and never throws", async () => {
		const fake = makeFakeFetch(
			() => new Response(okBody(CANDIDATES), { status: 200 }),
		)
		for (const overrides of [
			{ apiKey: "" },
			{ remainingMs: 100 },
			{ candidates: [] },
		]) {
			const outcome = await scoreCandidatesWithJev(
				baseParams(fake, { strict: true, ...overrides }),
			)
			expect(outcome.status).toBe("skipped")
		}
		expect(fake.calls).toHaveLength(0)
	})

	it("strict mode emits exactly one sanitized failure event BEFORE throwing", async () => {
		const events: JevRerankOutcome[] = []
		const fake = makeFakeFetch(
			() =>
				new Response(`body-leak-${CANDIDATES[0]}-${QUERY}`, {
					status: 529,
				}),
		)
		const error = await scoreCandidatesWithJev(
			baseParams(fake, { strict: true, onEvent: (o) => events.push(o) }),
		).then(
			() => {
				throw new Error("expected throw")
			},
			(e: unknown) => e,
		)
		expect(error).toBeInstanceOf(JevRerankError)
		const message = (error as Error).message
		expect(message).toContain("http-error")
		expect(message).not.toContain(CANDIDATES[0])
		expect(message).not.toContain(QUERY)
		expect(message).not.toContain("body-leak")
		expect(message).not.toContain("test-server-key")
		// Exactly one terminal failure event, emitted before the throw.
		expect(events).toHaveLength(1)
		expect(events[0]).toMatchObject({
			status: "failed",
			category: "http-error",
		})
		expect(JSON.stringify(events[0])).not.toContain("body-leak")
	})

	it("strict mode emits one event then throws for parse failures too", async () => {
		const events: JevRerankOutcome[] = []
		const fake = makeFakeFetch(() => new Response("{broken", { status: 200 }))
		const error = await scoreCandidatesWithJev(
			baseParams(fake, { strict: true, onEvent: (o) => events.push(o) }),
		).then(
			() => {
				throw new Error("expected throw")
			},
			(e: unknown) => e,
		)
		expect(error).toBeInstanceOf(JevRerankError)
		expect(events).toHaveLength(1)
		expect(events[0]).toMatchObject({
			status: "failed",
			category: "invalid-json",
		})
	})

	it("observer errors never flip a success into failure or trigger retry", async () => {
		const events: JevRerankOutcome[] = []
		const fake = makeFakeFetch(
			() => new Response(okBody(CANDIDATES), { status: 200 }),
		)
		const outcome = await scoreCandidatesWithJev(
			baseParams(fake, {
				onEvent: (o) => {
					events.push(o)
					throw new Error("observer exploded")
				},
			}),
		)
		expect(outcome.status).toBe("ok")
		expect(events).toHaveLength(1)
		expect(fake.calls).toHaveLength(1)
	})

	it("observer failure logging never leaks observer error content", async () => {
		const writes: string[] = []
		const spy = vi
			.spyOn(console, "warn")
			.mockImplementation((...args: unknown[]) => {
				writes.push(args.map((a) => String(a)).join(" "))
			})
		try {
			const marker = `MARKER-leak-${QUERY}-test-server-key`
			const fake = makeFakeFetch(
				() => new Response(okBody(CANDIDATES), { status: 200 }),
			)
			const outcome = await scoreCandidatesWithJev(
				baseParams(fake, {
					onEvent: () => {
						throw new Error(marker)
					},
				}),
			)
			expect(outcome.status).toBe("ok")
			const captured = writes.join("")
			expect(captured).not.toContain(marker)
			expect(captured).not.toContain(QUERY)
			expect(captured).toContain("observer failed")
		} finally {
			spy.mockRestore()
		}
	})

	it("observer runs for failures without changing the outcome", async () => {
		const events: JevRerankOutcome[] = []
		const fake = makeFakeFetch(() => new Response("nope", { status: 500 }))
		const outcome = await scoreCandidatesWithJev(
			baseParams(fake, { onEvent: (o) => events.push(o) }),
		)
		expect(outcome.status).toBe("failed")
		expect(events).toHaveLength(1)
		expect(events[0].status).toBe("failed")
	})

	it("usage absent, zero-input, or invalid is unknown with a reason — never free", async () => {
		const cases: Array<[unknown, string]> = [
			[undefined, "absent"],
			[{ input_tokens: 0, output_tokens: 0 }, "zero-input"],
			[{ input_tokens: 0, output_tokens: 48 }, "zero-input"],
			[{ input_tokens: "x", output_tokens: 1 }, "invalid"],
			[{ input_tokens: 120, output_tokens: -1 }, "invalid"],
			[{ input_tokens: 1.5, output_tokens: 1 }, "invalid"],
		]
		for (const [usage, reason] of cases) {
			const body = JSON.parse(okBody(CANDIDATES))
			if (usage === undefined) {
				delete body.usage
			} else {
				body.usage = usage
			}
			const fake = makeFakeFetch(
				() => new Response(JSON.stringify(body), { status: 200 }),
			)
			const outcome = await scoreCandidatesWithJev(baseParams(fake))
			expect(outcome.status).toBe("ok")
			if (outcome.status === "ok") {
				expect(outcome.usage).toEqual({ status: "unknown", reason })
			}
		}
	})

	it("stage budget is capped at 2000ms even with a larger remaining budget", async () => {
		// A stalling guard with remainingMs 10_000 must still return near the
		// 2000ms stage cap, not the caller's larger budget.
		const fake = makeFakeFetch(
			() => new Response(okBody(CANDIDATES), { status: 200 }),
		)
		const started = Date.now()
		const outcome = await scoreCandidatesWithJev(
			baseParams(fake, {
				remainingMs: 10_000,
				verifyPublicHostname: () => new Promise<void>(() => {}),
			}),
		)
		expect(outcome).toMatchObject({
			status: "failed",
			category: "deadline-exceeded",
		})
		const elapsed = Date.now() - started
		expect(elapsed).toBeGreaterThanOrEqual(1900)
		expect(elapsed).toBeLessThan(2600)
	}, 10_000)
})
