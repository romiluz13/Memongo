import { readFileSync } from "node:fs"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import type { EnrichmentProvider } from "../../packages/memory-engine/src/mongodb-llm-enrichment.js"
import {
	createFakeClock,
	createFakeContext,
	generousBudget,
	type Json,
} from "./fake-api.ts"
import { planProbeB, runProbeB } from "./probe-b.ts"

const EXPECTED_ANSWER_SYSTEM_PROMPT = `You answer the QUESTION using ONLY the provided context passages from a user's memory.
Rules:
- Be concise and factual; answer with just the fact asked for.
- If the context does not contain enough information to answer, return an empty answer string.
- Do not use outside knowledge.
Return JSON only: {"answer":"<concise answer, or empty string>"}`

type ProviderMode = {
	confabulate?: boolean
	alwaysAbstain?: boolean
	failFirst?: number
	failAlways?: boolean
	rawContent?: string
}

type Recorded = {
	messages: Array<{ role: string; content: string }>
	responseFormat?: { type: string }
	maxTokens?: number
}

function createFakeProvider(mode: ProviderMode = {}) {
	const recorded: Recorded[] = []
	let failures = 0
	const provider: EnrichmentProvider = {
		name: "fake",
		chatCompletion: async (params) => {
			recorded.push({
				messages: params.messages,
				...(params.responseFormat
					? { responseFormat: params.responseFormat }
					: {}),
				...(params.maxTokens !== undefined
					? { maxTokens: params.maxTokens }
					: {}),
			})
			if (mode.failAlways || failures < (mode.failFirst ?? 0)) {
				failures += 1
				throw new Error("provider down")
			}
			const user = params.messages[1]?.content ?? ""
			const question = user.split("\n")[0] ?? ""
			const entity = /the (\w+) vault/.exec(question)?.[1] ?? ""
			const context = user.split("\n").filter((line) => line.startsWith("["))
			const hit = question.includes("access code")
				? context.find((line) => line.includes(`the ${entity} vault is zqb`))
				: undefined
			const value = hit ? (/is (zqb\w+)\./.exec(hit)?.[1] ?? "") : ""
			let answer = mode.alwaysAbstain ? "" : value
			if (mode.confabulate && answer === "") answer = "The code is 4471."
			const content = mode.rawContent ?? JSON.stringify({ answer })
			return { content, usage: { inputTokens: 120, outputTokens: 12 } }
		},
	}
	return { provider, recorded }
}

type ApiMode = {
	dropMarkers?: boolean
	partial?: boolean
	failSeedAt?: number
}

function createFakeApi(mode: ApiMode = {}) {
	const events: string[] = []
	let writes = 0
	const api = {
		writeEvent: async (input: Json) => {
			writes += 1
			if (writes === mode.failSeedAt) throw new Error("write failed")
			events.push(input.body as string)
			return { ok: true, eventId: `ev-${events.length}`, chunkCreated: true }
		},
		search: async (input: Json) => {
			const words = (input.query as string)
				.toLowerCase()
				.split(/\W+/)
				.filter((word) => word.length > 3)
			const scored = events
				.map((text) => ({
					text,
					score: words.filter((word) => text.toLowerCase().includes(word))
						.length,
				}))
				.filter(
					(item) =>
						item.score > 0 &&
						!(mode.dropMarkers && item.text.includes("access code")),
				)
				.sort((a, b) => b.score - a.score)
				.slice(0, input.limit as number)
			return {
				results: scored.map((item) => ({ snippet: item.text })),
				outcomes: { status: mode.partial ? "partial" : "complete", lanes: [] },
			}
		},
	}
	return { api, events }
}

function setup(
	apiMode: ApiMode = {},
	providerMode: ProviderMode = {},
	caps: Record<string, number> = {},
) {
	const fakeApi = createFakeApi(apiMode)
	const fakeProvider = createFakeProvider(providerMode)
	const clock = createFakeClock()
	const ctx = createFakeContext(fakeApi.api, {
		clock,
		answer: { provider: fakeProvider.provider, model: "fake-model" },
		budget: generousBudget(
			{ "answer-llm": 60, ...caps },
			{
				"fake-model": {
					inputUsdPerMTok: 1,
					outputUsdPerMTok: 2,
					source: "test",
				},
			},
		),
	})
	return { ctx, clock, ...fakeApi, ...fakeProvider }
}

function caseOf(result: Awaited<ReturnType<typeof runProbeB>>, id: string) {
	const found = result.cases.find((item) => item.caseId === id)
	if (!found) throw new Error(`missing ${id}`)
	return found
}

describe("runProbeB", () => {
	beforeAll(() => {
		vi.stubEnv("MEMONGO_LOG_LEVEL", "silent")
	})
	afterAll(() => {
		vi.unstubAllEnvs()
	})

	it("passes forty paired cases against a faithful answerer with one call each", async () => {
		const { ctx, recorded } = setup()
		const result = await runProbeB(ctx)
		expect(result.cases.filter((item) => item.outcome !== "pass")).toEqual([])
		expect(result.cases).toHaveLength(40)
		expect(result.outcome).toBe("pass")
		expect(recorded).toHaveLength(40)
		expect(ctx.budget.snapshot().calls["answer-llm"]).toBe(40)
	})

	it("sends the unchanged answer prompt and message layout, pinned to the source file", async () => {
		const { ctx, recorded } = setup()
		await runProbeB(ctx)
		const source = readFileSync(
			new URL("../mongodb-e2e-qa.ts", import.meta.url),
			"utf8",
		)
		const start =
			source.indexOf("const ANSWER_SYSTEM_PROMPT = `") +
			"const ANSWER_SYSTEM_PROMPT = `".length
		const fromSource = source.slice(start, source.indexOf("`", start))
		const first = recorded[0] as Recorded
		expect(first.messages[0]).toEqual({ role: "system", content: fromSource })
		expect(fromSource).toBe(EXPECTED_ANSWER_SYSTEM_PROMPT)
		const user = first.messages[1]?.content ?? ""
		expect(
			user.startsWith(
				"QUESTION: What is the access code for the Brindlewick vault?\n<context>\n[1] ",
			),
		).toBe(true)
		expect(user.endsWith('</context>\nReturn only {"answer":"..."}.')).toBe(
			true,
		)
		expect(first.responseFormat).toEqual({ type: "json_object" })
		expect(first.maxTokens).toBe(512)
		expect(first.messages).toHaveLength(2)
	})

	it("stays within the planned call counts", async () => {
		const { ctx } = setup()
		await runProbeB(ctx)
		const plan = planProbeB()
		const counted = ctx.budget.snapshot().calls
		expect(counted["api-write"]).toBe(plan["api-write"])
		expect(counted["api-read"]).toBeLessThanOrEqual(plan["api-read"])
		expect(counted["answer-llm"]).toBeLessThanOrEqual(plan["answer-llm"])
		expect(plan["answer-llm"]).toBe(60)
	})

	it("fails every never-written case an answerer invents a value for", async () => {
		const { ctx } = setup({}, { confabulate: true })
		const result = await runProbeB(ctx)
		const failed = result.cases.filter((item) => item.outcome === "fail")
		expect(failed).toHaveLength(20)
		expect(
			failed.every((item) => item.predicate === "answered-never-written"),
		).toBe(true)
		expect(result.outcome).toBe("fail")
	})

	it("fails the controls and credits no abstention when the answerer abstains on everything", async () => {
		const { ctx } = setup({}, { alwaysAbstain: true })
		const result = await runProbeB(ctx)
		expect(
			result.cases.filter((item) => item.predicate === "control-missed"),
		).toHaveLength(20)
		const never = result.cases.filter((item) =>
			item.caseId.startsWith("B/never/"),
		)
		expect(never.every((item) => item.outcome === "inconclusive")).toBe(true)
		expect(result.outcome).toBe("fail")
	})

	it("retries a transient provider failure once and then passes", async () => {
		const { ctx, recorded } = setup({}, { failFirst: 1 })
		const result = await runProbeB(ctx)
		expect(result.outcome).toBe("pass")
		expect(recorded).toHaveLength(41)
	})

	it("never exceeds sixty answer calls including retries and declares the rest incomplete", async () => {
		const { ctx, recorded } = setup({}, { failAlways: true })
		const result = await runProbeB(ctx)
		expect(recorded).toHaveLength(60)
		expect(ctx.budget.snapshot().calls["answer-llm"]).toBe(60)
		expect(result.extra?.answerCalls).toBe(60)
		const skipped = result.cases.filter((item) => item.reason === "call-cap")
		expect(skipped).toHaveLength(10)
		expect(result.cases.filter((item) => item.outcome === "pass")).toHaveLength(
			0,
		)
		expect(result.outcome).toBe("inconclusive")
	})

	it("keeps provider failure apart from abstention", async () => {
		const { ctx } = setup({}, { failAlways: true })
		const result = await runProbeB(ctx)
		const never = result.cases.filter(
			(item) =>
				item.caseId.startsWith("B/never/") &&
				item.reason?.startsWith("provider:"),
		)
		expect(never.length).toBeGreaterThan(0)
		expect(never.every((item) => item.outcome === "inconclusive")).toBe(true)
	})

	it("treats unparseable and non-string answers as malformed, not as abstentions", async () => {
		for (const rawContent of ["not json", '{"answer":5}', ""]) {
			const { ctx } = setup({}, { rawContent })
			const result = await runProbeB(ctx)
			expect(
				result.cases.filter((item) => item.outcome === "pass"),
			).toHaveLength(0)
			expect(
				result.cases.some((item) => item.reason === "provider:malformed"),
			).toBe(true)
			expect(result.outcome).toBe("inconclusive")
		}
	})

	it("does not call the model for a control whose marker search never returned", async () => {
		const { ctx, recorded, clock } = setup({ dropMarkers: true })
		const result = await runProbeB(ctx)
		const controls = result.cases.filter((item) =>
			item.caseId.startsWith("B/control/"),
		)
		expect(controls.every((item) => item.reason === "retrieval-miss")).toBe(
			true,
		)
		expect(recorded.length).toBeLessThanOrEqual(20)
		expect(clock.sleeps.length).toBe(30)
		expect(result.outcome).toBe("inconclusive")
	})

	it("is inconclusive when search is degraded", async () => {
		const { ctx, recorded } = setup({ partial: true })
		const result = await runProbeB(ctx)
		expect(result.cases.every((item) => item.outcome === "inconclusive")).toBe(
			true,
		)
		expect(recorded).toHaveLength(0)
	})

	it("stops cleanly when the budget refuses further answer calls", async () => {
		const { ctx, recorded } = setup({}, {}, { "answer-llm": 5 })
		const result = await runProbeB(ctx)
		expect(recorded).toHaveLength(5)
		expect(result.cases.some((item) => item.reason === "budget")).toBe(true)
		expect(result.reasons.join(" ")).toContain("budget-refusal:cap")
		expect(result.outcome).toBe("inconclusive")
	})

	it("reports a failed seed and keeps its control out of the verdict", async () => {
		const { ctx } = setup({ failSeedAt: 3 })
		const result = await runProbeB(ctx)
		expect(result.reasons).toContain("seed-failed:B/control/03")
		expect(caseOf(result, "B/control/03").outcome).toBe("inconclusive")
		expect(result.outcome).toBe("inconclusive")
	})

	it("is not-run without an answer provider", async () => {
		const { ctx } = setup()
		const bare = { ...ctx, answer: undefined }
		const result = await runProbeB(bare)
		expect(result.outcome).toBe("not-run")
	})
})
