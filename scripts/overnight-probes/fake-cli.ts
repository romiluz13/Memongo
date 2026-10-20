import type { Io } from "./cli.ts"
import type { ProbeContext } from "./context.ts"
import { createFakeClock } from "./fake-api.ts"
import {
	fixture,
	type Overrides,
	SENTINELS,
	URI,
	VOYAGE,
} from "./fake-harness.ts"
import { startHarness } from "./harness.ts"
import type { ProbeApi } from "./probe-api.ts"
import type { Registry } from "./runner.ts"
import type {
	CaseResult,
	Outcome,
	ProbeLetter,
	ProbeRunResult,
} from "./types.ts"

export const ANSWER_KEY = "answer-key-SENTINEL-0001"
export const ENV: Record<string, string> = {
	MEMONGO_MONGODB_URI: URI,
	VOYAGE_API_KEY: VOYAGE,
	MEMONGO_BENCHMARK_ANSWER_API_KEY: ANSWER_KEY,
	MEMONGO_BENCHMARK_ANSWER_BASE_URL: "https://answer.sentinel.example/v1",
	MEMONGO_BENCHMARK_ANSWER_MODEL: "answer-model",
	MEMONGO_PROBE_ANSWER_PRICE_INPUT_USD_PER_MTOK: "1",
	MEMONGO_PROBE_ANSWER_PRICE_OUTPUT_USD_PER_MTOK: "2",
	PATH: "/usr/bin",
}
export const ALL_SENTINELS = [...SENTINELS, ANSWER_KEY]

export function caseOf(
	caseId: string,
	outcome: Outcome,
	predicate?: string,
): CaseResult {
	return {
		caseId,
		outcome,
		controlEligible: true,
		...(predicate ? { predicate } : {}),
		...(outcome === "fail"
			? {
					evidence: {
						request: { headers: { Authorization: `Bearer ${ANSWER_KEY}` } },
						response: { note: `reached ${URI} with ${VOYAGE}` },
					},
				}
			: {}),
	}
}

export type Behavior = (
	letter: ProbeLetter,
	ctx: ProbeContext,
) => Promise<ProbeRunResult>

export function resultOf(
	letter: ProbeLetter,
	ctx: ProbeContext,
	outcome: Outcome,
	cases: CaseResult[],
): ProbeRunResult {
	return {
		probe: letter,
		run: ctx.run,
		rule: "rule",
		version: "v1",
		outcome,
		reasons: outcome === "pass" ? [] : [`${letter} ${outcome}`],
		cases,
		counts: {},
	}
}

export function registryOf(behavior: Behavior): Registry {
	const entry = (letter: ProbeLetter, extra: Record<string, number> = {}) => ({
		plan: () => ({ "api-read": 3, "api-write": 2, ...extra }),
		run: (ctx: ProbeContext) => behavior(letter, ctx),
	})
	return {
		A: entry("A"),
		B: entry("B", { "answer-llm": 60 }),
		C: entry("C"),
		D: entry("D"),
		E: entry("E"),
		F: entry("F", { "kill-op": 1, "current-op": 2 }),
		G: entry("G"),
	}
}

export const passes: Behavior = async (letter, ctx) =>
	resultOf(letter, ctx, "pass", [caseOf("c1", "pass")])

export type Setup = {
	io: Io
	out: string[]
	err: string[]
	f: ReturnType<typeof fixture>
	events: string[]
	trigger(): Promise<void> | undefined
	answered: number
}

export function setup(
	behavior: Behavior,
	harness: Overrides = {},
	tweak: (io: Io) => void = () => {},
): Setup {
	const out: string[] = []
	const err: string[] = []
	const events: string[] = []
	const f = fixture(harness)
	let terminate: (() => Promise<void>) | undefined
	let counter = 0
	const state: Setup = {
		out,
		err,
		f,
		events,
		trigger: () => terminate?.(),
		answered: 0,
		io: undefined as unknown as Io,
	}
	state.io = {
		stdout: { write: (chunk) => out.push(chunk) },
		stderr: { write: (chunk) => err.push(chunk) },
		clock: createFakeClock(),
		randomHex: (chars) => {
			counter += 1
			return counter.toString(16).padStart(chars, "0")
		},
		randomUuid: () => {
			counter += 1
			return `00000000-0000-4000-8000-${counter.toString(16).padStart(12, "0")}`
		},
		startHarness: (input) => {
			events.push(`start after ${out.length} records`)
			return startHarness(
				{ ...f.deps, sanitizer: input.sanitizer },
				{
					mongoUri: input.mongoUri,
					voyageKey: input.voyageKey,
					baseEnv: input.baseEnv,
				},
			)
		},
		createApi: () => ({}) as ProbeApi,
		createAnswer: () => {
			state.answered += 1
			return { provider: {} as never, model: "answer-model" }
		},
		onTerminate: (handler) => {
			terminate = handler
			return () => {
				terminate = undefined
			}
		},
		registry: registryOf(behavior),
	}
	tweak(state.io)
	return state
}

export function records(out: readonly string[]): Array<{
	kind: string
	payload: Record<string, unknown>
}> {
	return out.flatMap((chunk) =>
		chunk
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line)),
	)
}

export function everything(state: Setup): string {
	return [...state.out, ...state.err].join("")
}
