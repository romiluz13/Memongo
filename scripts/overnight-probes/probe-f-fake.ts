import { AdminDenied, type Clock } from "./context.ts"
import {
	createFakeContext,
	createTimerClock,
	generousBudget,
	httpError,
	type Json,
} from "./fake-api.ts"

const DATABASE = "memongo_probe_ab12cd34"
const APP = "memongo-probe-api-ab12cd34"

export type Options = {
	opMs?: number
	dropAcked?: boolean
	duplicate?: boolean
	loseControlAfter?: number
	throttleAfter?: number
	neverFindControl?: boolean
	statusDegraded?: "failed-check" | "partial"
	rejectAfterKill?: boolean
	nonIdempotent?: boolean
	doubleStoreOnReplay?: boolean
	dropAfterKill?: boolean
	ignoreKill?: boolean
	hideOps?: boolean
	foreignOps?: boolean
	vanish?: boolean
	denyList?: boolean
	denyKill?: boolean
	echoQueries?: boolean
	badOpid?: boolean
	failControlWrites?: boolean
	maxListings?: number
}

type Stored = {
	agentId: string
	customId: string
	eventId: string
	body: string
}

export function createFake(clock: Pick<Clock, "sleep">, options: Options = {}) {
	const events: Stored[] = []
	const acks = new Map<string, string>()
	const inflight = new Map<
		number,
		{ opid: number; body: string; killed: boolean }
	>()
	const killCalls: Array<number | string> = []
	let opCounter = 0
	let writes = 0
	let listings = 0
	let killedOnce = false
	const tokensOf = (query: string) =>
		query.split(" ").filter((word) => word.startsWith("zq"))

	const api = {
		writeEvent: async (input: Json) => {
			writes += 1
			opCounter += 1
			const op = {
				opid: 1000 + opCounter,
				body: input.body as string,
				killed: false,
			}
			inflight.set(op.opid, op)
			await clock.sleep(options.opMs ?? 3)
			inflight.delete(op.opid)
			if (options.failControlWrites && String(input.body).includes("zqkctl")) {
				throw httpError(500, "BROKEN")
			}
			if (op.killed) {
				killedOnce = true
				throw httpError(500, "INTERRUPTED")
			}
			if (options.rejectAfterKill && killedOnce) throw httpError(500, "BROKEN")
			if (
				options.throttleAfter !== undefined &&
				writes > options.throttleAfter
			) {
				throw httpError(429, "RATE_LIMITED")
			}
			const customId = input.customId as string
			const known = options.nonIdempotent ? undefined : acks.get(customId)
			if (known) {
				const stored = events.find((item) => item.customId === customId)
				if (options.doubleStoreOnReplay && stored) events.push({ ...stored })
				return { ok: true, eventId: known, chunkCreated: false }
			}
			const eventId = `ev-${events.length + 1}-${writes}`
			acks.set(customId, eventId)
			const body = input.body as string
			const record = {
				agentId: input.agentId as string,
				customId,
				eventId,
				body,
			}
			const dropped =
				(options.dropAcked && body.startsWith("Concurrency log entry")) ||
				(options.dropAfterKill && killedOnce)
			if (!dropped) {
				events.push(record)
				if (options.duplicate) events.push({ ...record })
			}
			return { ok: true, eventId, chunkCreated: true }
		},
		search: async (input: Json) => {
			await clock.sleep(2)
			const tokens = tokensOf(input.query as string)
			const control = tokens.some(
				(token) => token.startsWith("zqfctl") || token.startsWith("zqkctl"),
			)
			const hide =
				(control && options.neverFindControl) ||
				(control &&
					options.loseControlAfter !== undefined &&
					events.length > options.loseControlAfter)
			const results = hide
				? []
				: events
						.filter((item) => tokens.some((token) => item.body.includes(token)))
						.map((item) => ({ snippet: item.body }))
			return {
				results,
				outcomes: { status: "complete", lanes: [] },
				...(options.echoQueries
					? {
							query: input.query,
							metadata: { queriesTried: [input.query] },
						}
					: {}),
			}
		},
		getDetailedStatus: async (agentId: string) =>
			options.statusDegraded
				? {
						events: { count: 0 },
						health: {
							dataCompleteness:
								options.statusDegraded === "partial" ? "partial" : "complete",
							failedChecks:
								options.statusDegraded === "failed-check"
									? ["events.count"]
									: [],
						},
					}
				: {
						events: {
							count: events.filter((item) => item.agentId === agentId).length,
						},
						health: { dataCompleteness: "complete", failedChecks: [] },
					},
	}

	const admin = {
		database: DATABASE,
		appName: APP,
		currentOps: async () => {
			listings += 1
			if (options.maxListings !== undefined && listings > options.maxListings) {
				throw new Error("runaway operation watch")
			}
			if (options.denyList)
				throw new AdminDenied(
					"not authorized on admin to execute command currentOp",
				)
			if (options.hideOps) return []
			if (options.vanish && listings % 2 === 0) return []
			const foreign = options.foreignOps === true
			return [...inflight.values()].map((op) => ({
				opid: options.badOpid ? undefined : op.opid,
				active: true,
				op: "update",
				ns: foreign ? "other_db.events" : `${DATABASE}.events`,
				appName: foreign ? "someone-else" : APP,
				command: {
					update: "events",
					updates: [{ u: { $setOnInsert: { body: op.body } } }],
				},
			}))
		},
		killOp: async (opid: number | string) => {
			killCalls.push(opid)
			if (options.denyKill)
				throw new AdminDenied(
					"not authorized on admin to execute command killOp",
				)
			const op = inflight.get(Number(opid))
			if (op && !options.ignoreKill) op.killed = true
		},
	}
	return { api, admin, events, killCalls, listCalls: () => listings }
}

export function setup(
	options: Options = {},
	withAdmin = true,
	caps: Record<string, number> = {},
) {
	const clock = createTimerClock()
	const fake = createFake(clock, options)
	const ctx = createFakeContext(fake.api, {
		clock,
		...(withAdmin ? { admin: fake.admin } : {}),
		budget: generousBudget(caps),
	})
	return { clock, ctx, ...fake }
}

export function killSetup(
	options: Options = {},
	withAdmin = true,
	caps: Record<string, number> = {},
) {
	return setup({ opMs: 40, ...options }, withAdmin, caps)
}
