import type {
	MemongoScope,
	MemongoStructuredStableHandle,
} from "@memongo/client"
import { API_READ, countedObserve, type ProbeContext } from "./context.ts"
import { evaluateRouteHealth, type HealthExpectation } from "./health.ts"
import type { GRead, GRouteId } from "./probe-g-model.ts"
import { isRecord } from "./rows.ts"

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

export async function pollUntil<T>(
	ctx: ProbeContext,
	read: () => Promise<T>,
	done: (read: T) => boolean,
): Promise<{
	polls: number
	elapsedMs: number
	satisfied: boolean
	last: T
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

export type LiveHandle =
	| { ok: true; handle: MemongoStructuredStableHandle }
	| { ok: false; reason: string }

const SCOPES: readonly MemongoScope[] = [
	"session",
	"user",
	"agent",
	"workspace",
]
const STATES: readonly MemongoStructuredStableHandle["state"][] = [
	"active",
	"invalidated",
	"conflicted",
]
const OPTIONAL_STAMPS = ["validFrom", "validTo", "updatedAt"] as const

function invalid(reason: string): LiveHandle {
	return { ok: false, reason }
}

export function resolveLiveHandle(
	seed: MemongoStructuredStableHandle,
	read: GRead | undefined,
): LiveHandle {
	if (read?.observation.kind !== "response") {
		return invalid("pre-read-unavailable")
	}
	const body = read.observation.body
	const handle = isRecord(body) ? body.handle : undefined
	if (!isRecord(handle)) return invalid("handle-missing")
	if (handle.family !== "structured") return invalid("family")
	if (handle.id !== seed.id) return invalid("id-mismatch")
	if (handle.agentId !== seed.agentId) return invalid("agent-mismatch")
	if (handle.scopeRef !== seed.scopeRef) return invalid("scope-ref-mismatch")
	const scope = SCOPES.find((candidate) => candidate === handle.scope)
	if (!scope || scope !== seed.scope) return invalid("scope-mismatch")
	const revision = handle.revision
	if (
		typeof revision !== "number" ||
		!Number.isInteger(revision) ||
		revision < 1
	) {
		return invalid("revision")
	}
	const state = STATES.find((candidate) => candidate === handle.state)
	if (!state) return invalid("state")
	const structured = handle.structured
	if (
		!isRecord(structured) ||
		typeof structured.type !== "string" ||
		structured.key !== seed.structured.key
	) {
		return invalid("structured-mismatch")
	}
	const stamps: Partial<Record<(typeof OPTIONAL_STAMPS)[number], string>> = {}
	for (const name of OPTIONAL_STAMPS) {
		const stamp = handle[name]
		if (stamp === undefined) continue
		if (typeof stamp !== "string") return invalid(name)
		stamps[name] = stamp
	}
	return {
		ok: true,
		handle: {
			family: "structured",
			id: seed.id,
			agentId: seed.agentId,
			scope,
			scopeRef: seed.scopeRef,
			revision,
			state,
			structured: { type: structured.type, key: seed.structured.key },
			...stamps,
		},
	}
}

export const MAX_POLLS = SETTLE_MAX_MS / SETTLE_STEP_MS + 1
