import type {
	MemongoScope,
	MemongoStructuredStableHandle,
} from "@memongo/client"
import { BudgetRefusal } from "./budget.ts"
import {
	API_READ,
	API_WRITE,
	asRecord,
	countedObserve,
	type ProbeContext,
} from "./context.ts"
import { evaluateRouteHealth, type RouteId } from "./health.ts"
import {
	evaluateProbeA,
	isConfirmedErase,
	PROBE_A_RULE,
	PROBE_A_VERSION,
	type EraseVerdict,
	type ReadRecord,
} from "./probe-a-model.ts"
import type { ProbeApi } from "./probe-api.ts"
import {
	ERASED_ROLES,
	isTargeted,
	pairApplies,
	type Phase,
	READ_ROWS,
	type RouteRow,
	TENANT_ROLES,
	type TenantRole,
} from "./route-matrix.ts"
import type { Observation, ProbeRunResult } from "./types.ts"

const QUERY = "What is the project Alpha codeword?"
const BARRIER = { timeoutMs: 10_000 }

export type Tenant = {
	role: TenantRole
	agentId: string
	scope: MemongoScope
	scopeRef: string
	marker: string
	key: string
	eventId?: string
	structuredId?: string
}

type Call = (api: ProbeApi, reader: Tenant, subject: Tenant) => Promise<unknown>

function handleOf(tenant: Tenant): MemongoStructuredStableHandle {
	return {
		family: "structured",
		id: tenant.structuredId ?? "",
		agentId: tenant.agentId,
		scope: tenant.scope,
		scopeRef: tenant.scopeRef,
		revision: 1,
		state: "active",
		structured: { type: "fact", key: tenant.key },
	}
}

function coords(reader: Tenant) {
	return {
		agentId: reader.agentId,
		scope: reader.scope,
		scopeRef: reader.scopeRef,
	}
}

const CALLS: Record<string, Call> = {
	search: (api, reader) =>
		api.search({ query: QUERY, limit: 20, ...coords(reader) }),
	searchDetailed: (api, reader) =>
		api.searchDetailed({ query: QUERY, limit: 20, ...coords(reader) }),
	"recall:filter": (api, reader) =>
		api.recallConversation({ limit: 50, ...coords(reader) }),
	"recall:query": (api, reader) =>
		api.recallConversation({ query: QUERY, limit: 50, ...coords(reader) }),
	"readFile:structured-locator": (api, reader, subject) =>
		api.readFile({
			relPath: `structured:fact:${subject.key}?scope=${reader.scope}&scopeRef=${reader.scopeRef}`,
			agentId: reader.agentId,
		}),
	"lifecycle:get": (api, reader, subject) =>
		api.lifecycleGetAs({ handle: handleOf(subject), ...coords(reader) }),
	"lifecycle:history": (api, reader, subject) =>
		api.lifecycleHistoryAs({ handle: handleOf(subject), ...coords(reader) }),
	profile: (api, reader) => api.profile(coords(reader)),
	activeSlate: (api, reader) => api.hydrateActiveSlate(coords(reader)),
	state: (api, reader) => api.state(coords(reader)),
	"discovery:topic-brief": (api, reader) =>
		api.buildDiscoveryProjection({
			kind: "topic-brief",
			query: QUERY,
			...coords(reader),
		}),
	contextBundle: (api, reader) =>
		api.buildContextBundle({ query: QUERY, ...coords(reader) }),
	relevanceExplain: (api, reader) =>
		api.relevanceExplain({ query: QUERY, agentId: reader.agentId }),
	traceChain: (api, reader, subject) =>
		api.traceChain({
			factId: subject.structuredId ?? "",
			collection: "structured_mem",
			...coords(reader),
		}),
	scanNovelty: (api, reader) =>
		api.scanNovelty({ limit: 50, ...coords(reader) }),
}

export function planProbeA(): { "api-read": number; "api-write": number } {
	let reads = 0
	for (const row of READ_ROWS) {
		if (row.coverage !== "covered") continue
		for (const reader of TENANT_ROLES) {
			reads += 1
			if (!isTargeted(row.id)) continue
			for (const foreign of TENANT_ROLES) {
				if (pairApplies(row, reader, foreign)) reads += 1
			}
		}
		reads += ERASED_ROLES.length + 1
	}
	return { "api-read": reads, "api-write": TENANT_ROLES.length * 2 + 1 }
}

export function buildTenants(ctx: ProbeContext): Record<TenantRole, Tenant> {
	const agentA = ctx.agentId()
	const agentB = ctx.agentId()
	const w1 = ctx.token("probe-w1-")
	const w2 = ctx.token("probe-w2-")
	const make = (
		role: TenantRole,
		agentId: string,
		scope: MemongoScope,
		scopeRef: string,
	): Tenant => ({
		role,
		agentId,
		scope,
		scopeRef,
		marker: ctx.token(`zq${role}`),
		key: ctx.token(`codeword-${role}-`),
	})
	return {
		self: make("self", agentA, "workspace", w1),
		scope: make("scope", agentA, "tenant", w1),
		ref: make("ref", agentA, "workspace", w2),
		agent: make("agent", agentB, "workspace", w1),
	}
}

async function seed(
	ctx: ProbeContext,
	tenants: Record<TenantRole, Tenant>,
): Promise<{
	ok: boolean
	reasons: string[]
	barriers: Record<string, unknown>
}> {
	const reasons: string[] = []
	const barriers: Record<string, unknown> = {}
	for (const role of TENANT_ROLES) {
		const tenant = tenants[role]
		const sentence = `The project Alpha codeword is ${tenant.marker}`
		const event = await countedObserve(ctx, API_WRITE, "writeEvent", () =>
			ctx.api.writeEvent({
				role: "user",
				body: sentence,
				agentId: tenant.agentId,
				scope: tenant.scope,
				scopeRef: tenant.scopeRef,
				sessionId: `session-${role}`,
				customId: ctx.token(`seed-event-${role}-`),
				searchBarrier: BARRIER,
			}),
		)
		const eventBody =
			event.kind === "response" ? asRecord(event.body) : undefined
		if (!eventBody || typeof eventBody.eventId !== "string") {
			reasons.push(`seed-event-failed:${role}:${event.kind}`)
			continue
		}
		tenant.eventId = eventBody.eventId
		barriers[`event:${role}`] = asRecord(eventBody.searchBarrier)?.status
		const structured = await countedObserve(
			ctx,
			API_WRITE,
			"writeStructured",
			() =>
				ctx.api.writeStructured({
					agentId: tenant.agentId,
					searchBarrier: BARRIER,
					entry: {
						type: "fact",
						key: tenant.key,
						value: sentence,
						salience: "critical",
						source: "user",
						scope: tenant.scope,
						scopeRef: tenant.scopeRef,
						sourceEventIds: [tenant.eventId],
					},
				}),
		)
		const body =
			structured.kind === "response" ? asRecord(structured.body) : undefined
		if (!body || typeof body.id !== "string" || body.quarantined === true) {
			reasons.push(`seed-structured-failed:${role}:${structured.kind}`)
			continue
		}
		tenant.structuredId = body.id
		barriers[`structured:${role}`] = asRecord(body.searchBarrier)?.status
	}
	return { ok: reasons.length === 0, reasons, barriers }
}

async function read(
	ctx: ProbeContext,
	row: RouteRow,
	phase: Phase,
	reader: Tenant,
	subject: Tenant,
	foreign: TenantRole | undefined,
): Promise<ReadRecord> {
	const call = CALLS[row.id]
	if (!call) throw new Error(`no read call for row ${row.id}`)
	const observation: Observation = await countedObserve(
		ctx,
		API_READ,
		row.route,
		() => call(ctx.api, reader, subject),
	)
	return {
		rowId: row.id,
		phase,
		reader: reader.role,
		...(foreign ? { foreign } : {}),
		observation,
		health: evaluateRouteHealth(
			row.route as RouteId,
			observation,
			row.route === "buildContextBundle"
				? { sections: ["query-evidence"] }
				: {},
		),
		request: {
			rowId: row.id,
			phase,
			reader: coords(reader),
			subject: {
				role: subject.role,
				key: subject.key,
				id: subject.structuredId,
			},
		},
	}
}

async function readPhase(
	ctx: ProbeContext,
	tenants: Record<TenantRole, Tenant>,
	phase: Phase,
	records: ReadRecord[],
): Promise<void> {
	for (const row of READ_ROWS) {
		if (row.coverage !== "covered") continue
		if (phase === "pre-erase") {
			for (const reader of TENANT_ROLES) {
				records.push(
					await read(
						ctx,
						row,
						phase,
						tenants[reader],
						tenants[reader],
						undefined,
					),
				)
				if (!isTargeted(row.id)) continue
				for (const foreign of TENANT_ROLES) {
					if (!pairApplies(row, reader, foreign)) continue
					records.push(
						await read(
							ctx,
							row,
							phase,
							tenants[reader],
							tenants[foreign],
							foreign,
						),
					)
				}
			}
			continue
		}
		for (const reader of [...ERASED_ROLES, "agent" as const]) {
			records.push(
				await read(
					ctx,
					row,
					phase,
					tenants[reader],
					tenants[reader],
					undefined,
				),
			)
		}
	}
}

function abortReason(error: unknown): string {
	if (error instanceof BudgetRefusal) return `budget-refusal:${error.reason}`
	return `aborted:${error instanceof Error ? error.name : "error"}`
}

export async function runProbeA(ctx: ProbeContext): Promise<ProbeRunResult> {
	const tenants = buildTenants(ctx)
	const records: ReadRecord[] = []
	const notes: string[] = []
	let erase: EraseVerdict = { confirmed: false, reason: "not-attempted" }
	let barriers: Record<string, unknown> = {}
	try {
		const seeded = await seed(ctx, tenants)
		barriers = seeded.barriers
		notes.push(...seeded.reasons)
		if (seeded.ok) {
			await readPhase(ctx, tenants, "pre-erase", records)
			const erased = await countedObserve(ctx, API_WRITE, "eraseAgent", () =>
				ctx.api.eraseAgent({ confirm: "erase", agentId: tenants.self.agentId }),
			)
			erase =
				erased.kind === "response"
					? isConfirmedErase(erased.body, tenants.self.agentId)
					: { confirmed: false, reason: `erase-${erased.kind}` }
			await readPhase(ctx, tenants, "post-erase", records)
		}
	} catch (error) {
		notes.push(abortReason(error))
	}
	const markers = {
		self: tenants.self.marker,
		scope: tenants.scope.marker,
		ref: tenants.ref.marker,
		agent: tenants.agent.marker,
	}
	const evaluation = evaluateProbeA({ records, markers, erase })
	const failed = evaluation.cases.some((item) => item.outcome === "fail")
	const outcome =
		evaluation.outcome === "not-run" && records.length === 0 && !failed
			? "inconclusive"
			: evaluation.outcome
	return {
		probe: "A",
		run: ctx.run,
		rule: PROBE_A_RULE,
		version: PROBE_A_VERSION,
		outcome,
		reasons: [...notes, ...evaluation.reasons],
		cases: evaluation.cases,
		counts: evaluation.counts,
		extra: {
			gaps: evaluation.gaps,
			erase,
			barriers,
			agents: { A: tenants.self.agentId, B: tenants.agent.agentId },
		},
	}
}
