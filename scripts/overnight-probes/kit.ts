import type {
	MemongoScope,
	MemongoStructuredStableHandle,
} from "@memongo/client"
import { API_READ, countedObserve, type ProbeContext } from "./context.ts"
import { evaluateRouteHealth, type HealthExpectation } from "./health.ts"
import type { GRead, GRouteId } from "./probe-g-model.ts"

export const SETTLE_MAX_MS = 30_000
export const SETTLE_STEP_MS = 1_000

export type Scope = {
	agentId: string
	scope: MemongoScope
	scopeRef: string
}

export async function stamped(
	ctx: ProbeContext,
	route: GRouteId,
	phase: GRead["phase"],
	call: () => Promise<unknown>,
	request: unknown,
	expectation: HealthExpectation = {},
): Promise<GRead> {
	const at = ctx.clock.now()
	const observation = await countedObserve(ctx, API_READ, route, call)
	return {
		route,
		phase,
		at,
		observation,
		health: evaluateRouteHealth(route, observation, expectation),
		request,
	}
}

export async function pollUntil(
	ctx: ProbeContext,
	read: () => Promise<GRead>,
	done: (read: GRead) => boolean,
): Promise<{
	polls: number
	elapsedMs: number
	satisfied: boolean
	last: GRead
}> {
	const start = ctx.clock.mono()
	let polls = 0
	for (;;) {
		const last = await read()
		polls += 1
		if (done(last)) {
			return {
				polls,
				elapsedMs: ctx.clock.mono() - start,
				satisfied: true,
				last,
			}
		}
		if (ctx.clock.mono() - start >= SETTLE_MAX_MS) {
			return {
				polls,
				elapsedMs: ctx.clock.mono() - start,
				satisfied: false,
				last,
			}
		}
		await ctx.clock.sleep(SETTLE_STEP_MS)
	}
}

export function liveHandle(
	fallback: MemongoStructuredStableHandle,
	read: GRead | undefined,
): MemongoStructuredStableHandle {
	if (read?.observation.kind !== "response") return fallback
	const body = read.observation.body
	const handle =
		typeof body === "object" && body !== null
			? (body as { handle?: unknown }).handle
			: undefined
	if (
		typeof handle === "object" &&
		handle !== null &&
		typeof (handle as { revision?: unknown }).revision === "number"
	) {
		return { ...fallback, ...handle } as MemongoStructuredStableHandle
	}
	return fallback
}

export const MAX_POLLS = SETTLE_MAX_MS / SETTLE_STEP_MS + 1
