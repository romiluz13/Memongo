import type { EnrichmentProvider } from "../../packages/memory-engine/src/mongodb-llm-enrichment.js"
import { BudgetRefusal, type Budget } from "./budget.ts"
import { observeCall } from "./observe.ts"
import type { EvidenceWriter } from "./output.ts"
import type { ProbeApi } from "./probe-api.ts"
import { isRecord } from "./rows.ts"
import type { Observation } from "./types.ts"

export const API_READ = "api-read"
export const API_WRITE = "api-write"

export type Clock = {
	now(): number
	mono(): number
	sleep(ms: number): Promise<void>
}

export const ANSWER_LLM = "answer-llm"

export type AnswerPort = { provider: EnrichmentProvider; model: string }

export const KILL_OP = "kill-op"
export const CURRENT_OP = "current-op"

export class AdminDenied extends Error {
	override name = "AdminDenied"
}

export type AdminPort = {
	database: string
	appName: string
	currentOps(): Promise<unknown[]>
	killOp(opid: number | string): Promise<void>
}

export type ProbeContext = {
	api: ProbeApi
	answer?: AnswerPort
	admin?: AdminPort
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
	const startedAt = ctx.clock.mono()
	let errorName: string | undefined
	try {
		const observation = await observeCall(route, async () => {
			try {
				return await call()
			} catch (error) {
				errorName = error instanceof Error ? error.name : typeof error
				throw error
			}
		})
		// Probe outcomes keep only the kind; this record keeps the cause.
		if (observation.kind === "transport-error") {
			ctx.evidence.record("transport-error", {
				run: ctx.run,
				route,
				errorName,
				message: observation.message,
				elapsedMs: ctx.clock.mono() - startedAt,
			})
		}
		return observation
	} finally {
		ctx.budget.settle(reservation)
	}
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
	return isRecord(value) ? value : undefined
}

export function abortReason(error: unknown): string {
	if (error instanceof BudgetRefusal) return `budget-refusal:${error.reason}`
	return `aborted:${error instanceof Error ? error.name : "error"}`
}
