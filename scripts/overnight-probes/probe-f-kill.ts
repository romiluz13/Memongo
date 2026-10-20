import { BudgetRefusal } from "./budget.ts"
import {
	abortReason,
	AdminDenied,
	API_WRITE,
	type AdminPort,
	countedObserve,
	KILL_OP,
	type ProbeContext,
} from "./context.ts"
import { pollUntil, type Scope, stamped } from "./kit.ts"
import { containsMarker } from "./markers.ts"
import { verifyCount } from "./probe-f-load.ts"
import {
	classifyWrite,
	type FKillFacts,
	isEligibleOp,
	type OpOwnership,
	pickEligibleOp,
} from "./probe-f-model.ts"
import { isRecord } from "./rows.ts"

export const F2_WRITERS = 24
export const F2_WINDOW_MS = 20_000
export const F2_POLL_MS = 15
export const F2_MAX_WRITES = 600
export const F2_MAX_REISSUE_ATTEMPTS = 60
export const F2_ATTEMPTS_PER_ENTRY = 3
export const F2_REISSUE_STEP_MS = 2_000

const BARRIER = { timeoutMs: 10_000 }
const ENTRY_PREFIX = "Recovery log entry"
const DETAIL_LIMIT = 200

type Entry = {
	marker: string
	customId: string
	input: Parameters<ProbeContext["api"]["writeEvent"]>[0]
	state: "pending" | "acked" | "error" | "backpressure"
	eventId?: string
	finishedAt?: number
}

type Killed = { opid: number | string; at: number; command: string }

export function planKill(): {
	"api-read": number
	"api-write": number
	"kill-op": number
} {
	return {
		"api-write": F2_MAX_WRITES + F2_MAX_REISSUE_ATTEMPTS + 2 + 1,
		"api-read": 16 + 31,
		"kill-op": 1,
	}
}

function eventIdOf(observation: {
	kind: string
	body?: unknown
}): string | undefined {
	if (observation.kind !== "response") return undefined
	const body = observation.body
	return isRecord(body) && typeof body.eventId === "string"
		? body.eventId
		: undefined
}

async function issue(ctx: ProbeContext, entry: Entry): Promise<void> {
	const observation = await countedObserve(ctx, API_WRITE, "writeEvent", () =>
		ctx.api.writeEvent(entry.input),
	)
	entry.finishedAt = ctx.clock.mono()
	const kind = classifyWrite(observation)
	entry.state = kind
	if (kind === "acked") entry.eventId = eventIdOf(observation)
}

function newEntry(ctx: ProbeContext, scope: Scope): Entry {
	const marker = ctx.token("zqk")
	const customId = ctx.token("fk-")
	return {
		marker,
		customId,
		state: "pending",
		input: {
			role: "user",
			body: `${ENTRY_PREFIX} ${marker}`,
			sessionId: "session-k",
			customId,
			...scope,
		},
	}
}

async function reissueAll(
	ctx: ProbeContext,
	entries: readonly Entry[],
): Promise<FKillFacts["reissues"]> {
	const results: FKillFacts["reissues"] = []
	let attempts = 0
	for (const entry of entries.filter((item) => item.state !== "acked")) {
		let eventId: string | undefined
		for (let tries = 0; tries < F2_ATTEMPTS_PER_ENTRY; tries++) {
			if (attempts >= F2_MAX_REISSUE_ATTEMPTS) break
			attempts += 1
			const observation = await countedObserve(
				ctx,
				API_WRITE,
				"writeEvent",
				() => ctx.api.writeEvent(entry.input),
			)
			eventId = eventIdOf(observation)
			if (eventId !== undefined) break
			await ctx.clock.sleep(F2_REISSUE_STEP_MS)
		}
		results.push({
			customId: entry.customId,
			ok: eventId !== undefined,
			...(eventId !== undefined ? { eventId } : {}),
		})
	}
	return results
}

async function runControls(
	ctx: ProbeContext,
	scope: Scope,
): Promise<FKillFacts["controls"]> {
	const marker = ctx.token("zqkctl")
	let acked = false
	for (let tries = 0; tries < F2_ATTEMPTS_PER_ENTRY && !acked; tries++) {
		const observation = await countedObserve(ctx, API_WRITE, "writeEvent", () =>
			ctx.api.writeEvent({
				role: "user",
				body: `${ENTRY_PREFIX} ${marker}`,
				sessionId: "session-k-control",
				customId: ctx.token("fk-control-"),
				searchBarrier: BARRIER,
				...scope,
			}),
		)
		acked = classifyWrite(observation) === "acked"
		if (!acked) await ctx.clock.sleep(F2_REISSUE_STEP_MS)
	}
	if (!acked) return { writeAcked: false, search: "not-run" }
	const settle = await pollUntil(
		ctx,
		() =>
			stamped(
				ctx,
				"search",
				"post",
				() =>
					ctx.api.search({
						query: `${ENTRY_PREFIX} ${marker}`,
						limit: 20,
						...scope,
					}),
				{ route: "search", purpose: "recovery-control" },
			),
		(read) => read.health.evaluable && containsMarker(read.observation, marker),
	)
	if (settle.satisfied) return { writeAcked: true, search: "found" }
	return {
		writeAcked: true,
		search: settle.last.health.evaluable ? "missing-healthy" : "unhealthy",
	}
}

function emptyFacts(): FKillFacts {
	return {
		killed: false,
		reissues: [],
		expectedRecords: 0,
		status: { trusted: false },
		controls: { writeAcked: false, search: "not-run" },
	}
}

type Watch = {
	stop: boolean
	denied?: string
	adminError?: string
	aborted?: string
	eligibleSeen: number
	killed?: Killed
}

async function watch(
	ctx: ProbeContext,
	admin: AdminPort,
	entries: readonly Entry[],
	state: Watch,
	start: number,
): Promise<void> {
	const ownership = (): OpOwnership => ({
		database: admin.database,
		appName: admin.appName,
		identities: entries
			.filter((entry) => entry.state === "pending")
			.map((entry) => entry.marker),
	})
	while (!state.stop && ctx.clock.mono() - start < F2_WINDOW_MS) {
		try {
			const ops = await admin.currentOps()
			const pick = pickEligibleOp(ops, ownership())
			if (pick) {
				state.eligibleSeen += 1
				const again = await admin.currentOps()
				const still = again.find(
					(op) =>
						isRecord(op) &&
						op.opid === pick.opid &&
						isEligibleOp(op, ownership()),
				)
				if (still) {
					const reservation = ctx.budget.reserveCount(KILL_OP)
					try {
						await admin.killOp(pick.opid as number | string)
					} finally {
						ctx.budget.settle(reservation)
					}
					state.killed = {
						opid: pick.opid as number | string,
						at: ctx.clock.mono(),
						command: JSON.stringify(pick.command ?? {}),
					}
					state.stop = true
					return
				}
			}
		} catch (error) {
			state.stop = true
			if (error instanceof AdminDenied) {
				state.denied = error.message.slice(0, DETAIL_LIMIT)
			} else if (error instanceof BudgetRefusal) {
				state.aborted = abortReason(error)
			} else {
				state.adminError = error instanceof Error ? error.name : "error"
			}
			return
		}
		await ctx.clock.sleep(F2_POLL_MS)
	}
}

export async function runKill(ctx: ProbeContext): Promise<FKillFacts> {
	const admin = ctx.admin
	if (!admin) {
		return { ...emptyFacts(), notRun: { reason: "admin-unavailable" } }
	}
	const scope: Scope = {
		agentId: ctx.agentId(),
		scope: "workspace",
		scopeRef: ctx.token("probe-k-"),
	}
	const entries: Entry[] = []
	const state: Watch = { stop: false, eligibleSeen: 0 }
	const start = ctx.clock.mono()
	const writer = async (): Promise<void> => {
		while (
			!state.stop &&
			entries.length < F2_MAX_WRITES &&
			ctx.clock.mono() - start < F2_WINDOW_MS
		) {
			const entry = newEntry(ctx, scope)
			entries.push(entry)
			try {
				await issue(ctx, entry)
			} catch (error) {
				entry.state = "error"
				state.stop = true
				state.aborted ??= abortReason(error)
			}
		}
	}
	await Promise.all([
		watch(ctx, admin, entries, state, start),
		...Array.from({ length: F2_WRITERS }, writer),
	])
	state.stop = true
	if (state.aborted) return { ...emptyFacts(), aborted: state.aborted }
	if (state.denied !== undefined) {
		return {
			...emptyFacts(),
			notRun: { reason: "permission", detail: state.denied },
		}
	}
	if (state.adminError) return { ...emptyFacts(), adminError: state.adminError }
	if (!state.killed) {
		return {
			...emptyFacts(),
			notRun: {
				reason:
					state.eligibleSeen > 0 ? "operation-finished" : "no-owned-target",
			},
		}
	}
	const killed = state.killed
	const victim = entries.find((entry) => killed.command.includes(entry.marker))
	const interrupted =
		victim !== undefined &&
		victim.state === "error" &&
		(victim.finishedAt ?? 0) >= killed.at
	if (!interrupted) return { ...emptyFacts(), killed: true, interrupted: false }
	const reissues = await reissueAll(ctx, entries)
	const target = victim ?? entries[0]
	const first = reissues.find((item) => item.customId === target?.customId)
	let dedupe: FKillFacts["dedupe"]
	if (target && first?.eventId !== undefined) {
		const again = await countedObserve(ctx, API_WRITE, "writeEvent", () =>
			ctx.api.writeEvent(target.input),
		)
		const secondEventId = eventIdOf(again)
		dedupe = {
			customId: target.customId,
			ok: secondEventId !== undefined,
			firstEventId: first.eventId,
			...(secondEventId !== undefined ? { secondEventId } : {}),
		}
	}
	const count = await verifyCount(ctx, scope, entries.length)
	const controls = await runControls(ctx, scope)
	return {
		killed: true,
		interrupted: true,
		reissues,
		...(dedupe ? { dedupe } : {}),
		expectedRecords: entries.length,
		status: count,
		controls,
	}
}
