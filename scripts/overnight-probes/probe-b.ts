import type { EnrichmentChatUsage } from "../../packages/memory-engine/src/mongodb-llm-enrichment.js"
import { generateAnswer } from "../mongodb-e2e-qa.ts"
import { BudgetRefusal } from "./budget.ts"
import {
	ANSWER_LLM,
	abortReason,
	API_READ,
	API_WRITE,
	type AnswerPort,
	asRecord,
	countedObserve,
	type ProbeContext,
} from "./context.ts"
import { evaluateRouteHealth } from "./health.ts"
import type { Scope } from "./kit.ts"
import {
	B_MAX_ATTEMPTS_PER_CASE,
	B_MAX_CALLS,
	B_MAX_EXTRA_POLLS,
	type BFixture,
	buildBFixture,
	fixtureViolations,
} from "./probe-b-fixtures.ts"
import {
	B_GAPS,
	type BCall,
	type BCaseFacts,
	classifyAnswerShape,
	evaluateProbeB,
	PROBE_B_RULE,
	PROBE_B_VERSION,
} from "./probe-b-model.ts"
import type { ProbeRunResult } from "./types.ts"

const PASSAGE_LIMIT = 10
const ANSWER_MAX_OUTPUT_TOKENS = 512
const PROMPT_OVERHEAD_BYTES = 1024
const BARRIER = { timeoutMs: 10_000 }
const POLL_STEP_MS = 1_000

export function planProbeB(): {
	"api-read": number
	"api-write": number
	"answer-llm": number
} {
	const fixture = buildBFixture((position) => `m${position}`)
	return {
		"api-read":
			fixture.controls.length + fixture.never.length + B_MAX_EXTRA_POLLS,
		"api-write": fixture.seeds.length,
		"answer-llm": B_MAX_CALLS,
	}
}

type State = { dispatched: number; extraPolls: number; stopped: boolean }

type Retrieval = {
	passages: string[]
	facts: BCaseFacts["retrieval"]
	request: unknown
}

function snippets(body: unknown): string[] {
	const results = asRecord(body)?.results
	if (!Array.isArray(results)) return []
	return results
		.map((row) => asRecord(row)?.snippet)
		.filter((snippet): snippet is string => typeof snippet === "string")
}

async function retrieve(
	ctx: ProbeContext,
	scope: Scope,
	state: State,
	question: string,
	marker: string | undefined,
): Promise<Retrieval> {
	for (;;) {
		const observation = await countedObserve(ctx, API_READ, "search", () =>
			ctx.api.search({ query: question, limit: PASSAGE_LIMIT, ...scope }),
		)
		const health = evaluateRouteHealth("search", observation)
		const passages =
			observation.kind === "response" ? snippets(observation.body) : []
		const markerSeen =
			marker !== undefined &&
			health.evaluable &&
			passages.some((passage) => passage.includes(marker))
		const settled = marker === undefined || markerSeen
		if (settled || state.extraPolls >= B_MAX_EXTRA_POLLS) {
			return {
				passages,
				facts: { health, markerSeen },
				request: { route: "search", question },
			}
		}
		state.extraPolls += 1
		await ctx.clock.sleep(POLL_STEP_MS)
	}
}

async function dispatch(
	ctx: ProbeContext,
	port: AnswerPort,
	question: string,
	passages: string[],
): Promise<BCall & { usage?: EnrichmentChatUsage }> {
	let content: string | undefined
	let failed = false
	let usage: EnrichmentChatUsage | undefined
	const reservation = ctx.budget.reserveLlm({
		path: ANSWER_LLM,
		model: port.model,
		inputBytes:
			Buffer.byteLength(question) +
			Buffer.byteLength(passages.join("\n")) +
			PROMPT_OVERHEAD_BYTES,
		maxOutputTokens: ANSWER_MAX_OUTPUT_TOKENS,
		attempts: 1,
	})
	try {
		const answer = await generateAnswer({
			provider: {
				name: port.provider.name,
				chatCompletion: async (params) => {
					const response = await port.provider.chatCompletion(params)
					content = response.content
					return response
				},
			},
			model: port.model,
			question,
			contextPassages: passages,
			onFailure: () => {
				failed = true
			},
			onProviderCall: (outcome, reported) => {
				if (outcome === "succeeded" && reported) usage = reported
			},
		})
		const outcome: BCall["outcome"] = failed
			? content === undefined
				? "provider-failure"
				: "malformed"
			: content !== undefined && classifyAnswerShape(content) === "malformed"
				? "malformed"
				: "answered"
		return {
			outcome,
			answer: outcome === "answered" ? answer : "",
			...(usage ? { usage } : {}),
		}
	} finally {
		ctx.budget.settle(
			reservation,
			usage
				? { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens }
				: undefined,
		)
	}
}

async function answerCase(
	ctx: ProbeContext,
	port: AnswerPort,
	state: State,
	notes: string[],
	input: {
		caseId: string
		kind: BCaseFacts["kind"]
		question: string
		marker?: string
		pairedControl?: string
	},
	scope: Scope,
): Promise<BCaseFacts> {
	const retrieval = await retrieve(
		ctx,
		scope,
		state,
		input.question,
		input.marker,
	)
	const facts: BCaseFacts = {
		caseId: input.caseId,
		kind: input.kind,
		...(input.marker !== undefined ? { marker: input.marker } : {}),
		...(input.pairedControl !== undefined
			? { pairedControl: input.pairedControl }
			: {}),
		retrieval: retrieval.facts,
		calls: [],
		request: retrieval.request,
	}
	const reachable =
		retrieval.facts.health.evaluable &&
		(input.kind === "never" || retrieval.facts.markerSeen)
	if (!reachable) return facts
	while (facts.calls.length < B_MAX_ATTEMPTS_PER_CASE) {
		if (state.stopped) {
			facts.skipped = "budget"
			break
		}
		if (state.dispatched >= B_MAX_CALLS) {
			facts.skipped = "call-cap"
			break
		}
		try {
			state.dispatched += 1
			const call = await dispatch(ctx, port, input.question, retrieval.passages)
			facts.calls.push({ outcome: call.outcome, answer: call.answer })
			if (call.outcome === "answered") break
		} catch (error) {
			if (!(error instanceof BudgetRefusal)) throw error
			state.dispatched -= 1
			state.stopped = true
			facts.skipped = "budget"
			notes.push(abortReason(error))
			break
		}
	}
	return facts
}

async function seed(
	ctx: ProbeContext,
	scope: Scope,
	fixture: BFixture,
	notes: string[],
): Promise<void> {
	const last = fixture.seeds.length - 1
	for (const [position, item] of fixture.seeds.entries()) {
		const written = await countedObserve(ctx, API_WRITE, "writeEvent", () =>
			ctx.api.writeEvent({
				role: "user",
				body: item.text,
				sessionId: "session-b",
				customId: ctx.token("b-"),
				...scope,
				...(position === last ? { searchBarrier: BARRIER } : {}),
			}),
		)
		const body =
			written.kind === "response" ? asRecord(written.body) : undefined
		if (!body || typeof body.eventId !== "string") {
			notes.push(`seed-failed:${item.id}`)
		}
	}
}

export async function runProbeB(ctx: ProbeContext): Promise<ProbeRunResult> {
	const port = ctx.answer
	const fixture = buildBFixture(() => ctx.token("zqb"))
	const violations = fixtureViolations(fixture)
	const notes: string[] = []
	const state: State = { dispatched: 0, extraPolls: 0, stopped: false }
	const facts: BCaseFacts[] = []
	const scope: Scope = {
		agentId: ctx.agentId(),
		scope: "workspace",
		scopeRef: ctx.token("probe-b-"),
	}
	if (!port) {
		return {
			probe: "B",
			run: ctx.run,
			rule: PROBE_B_RULE,
			version: PROBE_B_VERSION,
			outcome: "not-run",
			reasons: ["answer provider is not configured"],
			cases: [],
			counts: {},
		}
	}
	try {
		if (violations.length === 0) await seed(ctx, scope, fixture, notes)
		for (const control of fixture.controls) {
			facts.push(
				await answerCase(
					ctx,
					port,
					state,
					notes,
					{
						caseId: control.caseId,
						kind: "control",
						question: control.question,
						marker: control.marker,
					},
					scope,
				),
			)
		}
		for (const item of fixture.never) {
			facts.push(
				await answerCase(
					ctx,
					port,
					state,
					notes,
					{
						caseId: item.caseId,
						kind: "never",
						question: item.question,
						pairedControl: item.pairedControl,
					},
					scope,
				),
			)
		}
	} catch (error) {
		notes.push(abortReason(error))
	}
	const evaluation = evaluateProbeB(facts, violations)
	const failed = evaluation.cases.some((item) => item.outcome === "fail")
	return {
		probe: "B",
		run: ctx.run,
		rule: PROBE_B_RULE,
		version: PROBE_B_VERSION,
		outcome:
			evaluation.outcome === "not-run" && !failed
				? "inconclusive"
				: evaluation.outcome,
		reasons: [...new Set([...notes, ...evaluation.reasons])],
		cases: evaluation.cases,
		counts: evaluation.counts,
		extra: {
			agentId: scope.agentId,
			model: port.model,
			answerCalls: state.dispatched,
			extraPolls: state.extraPolls,
			coverageGaps: B_GAPS,
		},
	}
}
