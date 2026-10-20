import { MemongoClientError } from "@memongo/client"
import { createBudget, type Budget } from "./budget.ts"
import type { Clock, ProbeContext } from "./context.ts"
import type { EvidenceWriter } from "./output.ts"
import type { ProbeApi } from "./probe-api.ts"

export type Json = Record<string, unknown>

export function httpError(
	status: number,
	code?: string,
	message = "failure",
): MemongoClientError {
	return new MemongoClientError(
		status,
		JSON.stringify({ error: { code, message } }),
	)
}

export type FakeClock = Clock & { advance(ms: number): void; sleeps: number[] }

export function createFakeClock(start = 1_700_000_000_000): FakeClock {
	let current = start
	const sleeps: number[] = []
	return {
		now: () => current,
		mono: () => current - start,
		sleep: async (ms) => {
			sleeps.push(ms)
			current += ms
		},
		advance: (ms) => {
			current += ms
		},
		sleeps,
	}
}

export type TimerClock = Clock & {
	drive<T>(work: Promise<T>): Promise<T>
}

export function createTimerClock(start = 1_700_000_000_000): TimerClock {
	let current = start
	const timers: { at: number; resolve: () => void }[] = []
	return {
		now: () => current,
		mono: () => current - start,
		sleep: (ms) =>
			new Promise<void>((resolve) => {
				timers.push({ at: current + ms, resolve })
			}),
		async drive<T>(work: Promise<T>): Promise<T> {
			let state: { value: T } | { error: unknown } | undefined
			work.then(
				(value) => {
					state = { value }
				},
				(error) => {
					state = { error }
				},
			)
			let idle = 0
			while (!state) {
				await new Promise<void>((resolve) => setImmediate(resolve))
				if (state) break
				const next = timers.reduce(
					(min, timer) => Math.min(min, timer.at),
					Number.POSITIVE_INFINITY,
				)
				if (next === Number.POSITIVE_INFINITY) {
					idle += 1
					if (idle > 1_000) throw new Error("fake timer clock deadlocked")
					continue
				}
				idle = 0
				current = Math.max(current, next)
				const due = timers.filter((timer) => timer.at <= current)
				for (const timer of due) timers.splice(timers.indexOf(timer), 1)
				for (const timer of due) timer.resolve()
			}
			if ("error" in state) throw state.error
			return state.value
		},
	}
}

export type SentInput = { method: string; input: unknown }

export function recordInputs(ctx: { api: ProbeApi }): SentInput[] {
	const sent: SentInput[] = []
	const methods = ctx.api as unknown as Record<
		string,
		(...args: unknown[]) => unknown
	>
	const wrapped = Object.fromEntries(
		Object.entries(methods).map(([method, call]) => [
			method,
			(...args: unknown[]) => {
				sent.push({ method, input: structuredClone(args[0]) })
				return call(...args)
			},
		]),
	)
	Object.assign(ctx, { api: wrapped })
	return sent
}

export function sentTo(sent: readonly SentInput[], method: string): unknown[] {
	return sent.filter((item) => item.method === method).map((item) => item.input)
}

export function silentWriter(): EvidenceWriter & { records: unknown[] } {
	const records: unknown[] = []
	return {
		records,
		record: (kind, payload) => {
			records.push({ kind, payload })
		},
		note: () => {},
	}
}

export function generousBudget(
	caps: Record<string, number> = {},
	prices: Parameters<typeof createBudget>[0]["prices"] = {},
): Budget {
	return createBudget({
		ceilingUsd: 5,
		prices,
		caps: {
			"api-read": 100_000,
			"api-write": 100_000,
			"kill-op": 10,
			"current-op": 100_000,
			...caps,
		},
	})
}

export function createFakeContext(
	api: unknown,
	overrides: Partial<ProbeContext> = {},
): ProbeContext & {
	clock: FakeClock
	evidence: ReturnType<typeof silentWriter>
} {
	let counter = 0
	const clock = createFakeClock()
	const evidence = silentWriter()
	return {
		api: api as ProbeApi,
		run: 1,
		budget: generousBudget(),
		evidence,
		clock,
		token: (prefix) => {
			counter += 1
			return `${prefix}${counter.toString(16).padStart(6, "0")}`
		},
		agentId: () => {
			counter += 1
			return `probe-agent-${counter}`
		},
		...overrides,
	} as ProbeContext & {
		clock: FakeClock
		evidence: ReturnType<typeof silentWriter>
	}
}
