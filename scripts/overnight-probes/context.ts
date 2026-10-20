import type { Budget } from "./budget.ts"
import { observeCall } from "./observe.ts"
import type { EvidenceWriter } from "./output.ts"
import type { ProbeApi } from "./probe-api.ts"
import type { Observation } from "./types.ts"

export const API_READ = "api-read"
export const API_WRITE = "api-write"

export type Clock = {
	now(): number
	sleep(ms: number): Promise<void>
}

export type ProbeContext = {
	api: ProbeApi
	run: number
	budget: Budget
	evidence: EvidenceWriter
	clock: Clock
	token(prefix: string): string
	agentId(): string
}

export async function countedObserve(
	ctx: ProbeContext,
	path: typeof API_READ | typeof API_WRITE,
	route: string,
	call: () => Promise<unknown>,
): Promise<Observation> {
	const reservation = ctx.budget.reserveCount(path)
	try {
		return await observeCall(route, call)
	} finally {
		ctx.budget.settle(reservation)
	}
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined
}
