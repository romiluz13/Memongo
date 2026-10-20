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
