import type { RouteId } from "./health.ts"

export const TENANT_ROLES = ["self", "scope", "ref", "agent"] as const
export type TenantRole = (typeof TENANT_ROLES)[number]
export const ERASED_ROLES = ["self", "scope", "ref"] as const
export type Partition = "agent" | "scope" | "ref"
export type Phase = "pre-erase" | "post-erase"

export type RouteRow = {
	id: string
	route: RouteId
	clientMethod: string
	partitions: Partition[]
	setup: string
	control: string
	extraction: string
	postErase: string
	coverage: "covered" | "gap"
	gapReason?: string
}

const ALL: Partition[] = ["agent", "scope", "ref"]
const DEEP =
	"every string leaf of the response body is scanned for the tenant markers"
const OWN_FOUND =
	"the same response must contain the reader's own marker, healthy and evaluable"
const ERASED_ABSENT =
	"after a confirmed-complete erase of the reader's agent no marker of that agent remains; the untouched agent's marker is still found on the same route"

export const READ_ROWS: RouteRow[] = [
	{
		id: "search",
		route: "search",
		clientMethod: "search",
		partitions: ALL,
		setup:
			"one conversation event per tenant carrying the tenant marker, searchable before any read",
		control: OWN_FOUND,
		extraction: DEEP,
		postErase: ERASED_ABSENT,
		coverage: "covered",
	},
	{
		id: "searchDetailed",
		route: "searchDetailed",
		clientMethod: "searchDetailed",
		partitions: ALL,
		setup:
			"conversation event and structured memory per tenant, searchable before any read",
		control: OWN_FOUND,
		extraction: DEEP,
		postErase: ERASED_ABSENT,
		coverage: "covered",
	},
	{
		id: "recall:filter",
		route: "recallConversation",
		clientMethod: "recallConversation",
		partitions: ALL,
		setup:
			"conversation event per tenant; the query-less recall reads the events collection directly",
		control: OWN_FOUND,
		extraction: DEEP,
		postErase: ERASED_ABSENT,
		coverage: "covered",
	},
	{
		id: "recall:query",
		route: "recallConversation",
		clientMethod: "recallConversation",
		partitions: ALL,
		setup:
			"conversation event per tenant, searchable; recall with a query uses the hybrid lane",
		control: OWN_FOUND,
		extraction: DEEP,
		postErase: ERASED_ABSENT,
		coverage: "covered",
	},
	{
		id: "readFile:structured-locator",
		route: "readFile",
		clientMethod: "readFile",
		partitions: ["agent"],
		setup:
			"structured memory per tenant with a tenant-unique key; the locator carries scope and scopeRef",
		control: "the owner reads its own locator and the text contains its marker",
		extraction: DEEP,
		postErase:
			"the erased agent's locator reads as empty text; the untouched agent's locator still returns its marker",
		coverage: "covered",
	},
	{
		id: "lifecycle:get",
		route: "lifecycleGet",
		clientMethod: "getLifecycleItem",
		partitions: ALL,
		setup:
			"structured memory per tenant; the live handle is fetched with lifecycle get",
		control:
			"the owner's handle returns its item and the value contains the marker",
		extraction: DEEP,
		postErase:
			"the erased agent's handle is not found; the untouched agent's handle still returns its marker",
		coverage: "covered",
	},
	{
		id: "lifecycle:history",
		route: "lifecycleHistory",
		clientMethod: "getLifecycleHistory",
		partitions: ALL,
		setup: "structured memory per tenant, handle as for lifecycle get",
		control:
			"the owner's handle returns a history whose current entry contains the marker",
		extraction: DEEP,
		postErase:
			"the erased agent's handle is not found; the untouched agent's history still returns its marker",
		coverage: "covered",
	},
	{
		id: "profile",
		route: "profile",
		clientMethod: "profile",
		partitions: ALL,
		setup: "structured fact per tenant",
		control: OWN_FOUND,
		extraction: DEEP,
		postErase: ERASED_ABSENT,
		coverage: "covered",
	},
	{
		id: "activeSlate",
		route: "hydrateActiveSlate",
		clientMethod: "hydrateActiveSlate",
		partitions: ALL,
		setup:
			"structured memory per tenant with critical salience so it enters the slate",
		control: OWN_FOUND,
		extraction: DEEP,
		postErase: ERASED_ABSENT,
		coverage: "covered",
	},
	{
		id: "state",
		route: "state",
		clientMethod: "state",
		partitions: ALL,
		setup: "structured memory and events per tenant",
		control: OWN_FOUND,
		extraction: DEEP,
		postErase: ERASED_ABSENT,
		coverage: "covered",
	},
	{
		id: "discovery:topic-brief",
		route: "buildDiscoveryProjection",
		clientMethod: "buildDiscoveryProjection",
		partitions: ALL,
		setup: "events and structured memory per tenant, searchable",
		control: OWN_FOUND,
		extraction: DEEP,
		postErase: ERASED_ABSENT,
		coverage: "covered",
	},
	{
		id: "contextBundle",
		route: "buildContextBundle",
		clientMethod: "buildContextBundle",
		partitions: ALL,
		setup:
			"events and structured memory per tenant, searchable; the query section is expected",
		control: OWN_FOUND,
		extraction: DEEP,
		postErase: ERASED_ABSENT,
		coverage: "covered",
	},
	{
		id: "relevanceExplain",
		route: "relevanceExplain",
		clientMethod: "relevanceExplain",
		partitions: ["agent"],
		setup: "events per tenant; the admin explain route addresses an agent only",
		control: OWN_FOUND,
		extraction: DEEP,
		postErase: ERASED_ABSENT,
		coverage: "covered",
	},
	{
		id: "traceChain",
		route: "traceChain",
		clientMethod: "traceChain",
		partitions: ALL,
		setup:
			"structured memory per tenant citing its source event, so the chain reaches an event body",
		control: "the owner's trace returns nodes whose bodies contain the marker",
		extraction: DEEP,
		postErase: ERASED_ABSENT,
		coverage: "covered",
	},
	{
		id: "scanNovelty",
		route: "scanNovelty",
		clientMethod: "scanNovelty",
		partitions: ALL,
		setup: "events per tenant; the novelty scan returns event bodies",
		control: OWN_FOUND,
		extraction: DEEP,
		postErase: ERASED_ABSENT,
		coverage: "covered",
	},
	{
		id: "searchKB",
		route: "searchKB",
		clientMethod: "searchKB",
		partitions: ALL,
		setup:
			"none possible: the HTTP API has no route that writes a knowledge-base document",
		control: "none possible without a seeded document",
		extraction: DEEP,
		postErase: "not assessed",
		coverage: "gap",
		gapReason:
			"the client and API expose no knowledge-base write, so no positive control can exist on this route",
	},
]

const TARGETED_ROW_IDS: ReadonlySet<string> = new Set([
	"readFile:structured-locator",
	"lifecycle:get",
	"lifecycle:history",
	"traceChain",
])

/** A targeted row presents one tenant's handle or locator under another tenant's coordinates. */
export function isTargeted(rowId: string): boolean {
	return TARGETED_ROW_IDS.has(rowId)
}

export type MethodDecision = {
	decision: "write" | "counts-only" | "maintenance" | "coverage-gap"
	reason: string
}

const write = (reason: string): MethodDecision => ({
	decision: "write",
	reason,
})
const counts = (reason: string): MethodDecision => ({
	decision: "counts-only",
	reason,
})
const maintenance = (reason: string): MethodDecision => ({
	decision: "maintenance",
	reason,
})
const gap = (reason: string): MethodDecision => ({
	decision: "coverage-gap",
	reason,
})

export const CLIENT_METHOD_DECISIONS: Record<string, MethodDecision> = {
	add: write("write route, used for seeding only"),
	writeEvent: write("write route, used for seeding only"),
	writeEvents: write("write route, used for seeding only"),
	writeStructured: write("write route, used for seeding only"),
	writeProcedure: write("write route, not used by the probes"),
	updateLifecycleItem: write("lifecycle mutation, used by probes C and G"),
	deleteLifecycleItem: write("lifecycle mutation, used by probes C and G"),
	reportProcedureOutcome: write("procedure mutation, not used by the probes"),
	applyMemoryFeedback: write("feedback mutation, not used by the probes"),
	extract: write("schedules LLM extraction, which the probe API disables"),
	selfEdit: write("memory-block mutation, not used by the probes"),
	sync: maintenance("workspace file sync mutates the knowledge base"),
	consolidate: maintenance(
		"consolidation mutates tenant memory and would alter fixtures",
	),
	importConversations: maintenance(
		"reads a server-side dataset path, not tenant memory",
	),
	eraseAgent: write("erase is the A post-erase action"),
	promoteQuarantined: write("review mutation, not used by the probes"),
	rejectQuarantined: write("review mutation, not used by the probes"),
	listQuarantined: gap(
		"content-returning admin list; seeding it needs an injection-classifier hit, which A does not stage",
	),
	listRecallTraces: gap(
		"admin trace list holds query text and hit ids, not memory content; agent filter not asserted by A",
	),
	getRecallTrace: gap(
		"admin trace read holds query text and hit ids, not memory content; agent filter not asserted by A",
	),
	listJobs: gap(
		"admin job list holds job metadata and error text; no tenant memory content is staged to check",
	),
	getJob: gap(
		"admin job read holds job metadata and error text; no tenant memory content is staged to check",
	),
	status: counts("deployment facts and counts, no memory content"),
	getDetailedStatus: counts(
		"per-agent counts and lane health, no memory content",
	),
	stats: counts("storage counts, no memory content"),
	probeEmbedding: counts("provider probe, no memory content"),
	probeVector: counts("index probe, no memory content"),
	relevanceReport: counts("aggregate relevance health, no memory content"),
	relevanceSampleRate: counts("sampling configuration, no memory content"),
	accessTrends: counts("access counters keyed by memory id, no memory content"),
	accessSummaries: counts(
		"access counters keyed by memory id, no memory content",
	),
}

function differs(
	reader: TenantRole,
	foreign: TenantRole,
): { agent: boolean; scope: boolean; ref: boolean } {
	const agentOf = (r: TenantRole) => (r === "agent" ? "B" : "A")
	const scopeOf = (r: TenantRole) => (r === "scope" ? "tenant" : "workspace")
	const refOf = (r: TenantRole) => (r === "ref" ? "W2" : "W1")
	return {
		agent: agentOf(reader) !== agentOf(foreign),
		scope: scopeOf(reader) !== scopeOf(foreign),
		ref: refOf(reader) !== refOf(foreign),
	}
}

export function pairApplies(
	row: RouteRow,
	reader: TenantRole,
	foreign: TenantRole,
): boolean {
	if (reader === foreign) return false
	const d = differs(reader, foreign)
	const addressable = new Set(row.partitions)
	const differing = (["agent", "scope", "ref"] as const).filter((p) => d[p])
	if (differing.every((p) => addressable.has(p))) return true
	return d.agent && addressable.has("agent")
}

export function preEraseCaseId(
	rowId: string,
	reader: TenantRole,
	foreign: TenantRole,
): string {
	return `A/${rowId}/reader=${reader}/foreign=${foreign}/pre-erase`
}

export function preEraseControlId(rowId: string, reader: TenantRole): string {
	return `A/${rowId}/reader=${reader}/control/pre-erase`
}

export function postEraseCaseId(rowId: string, erased: TenantRole): string {
	return `A/${rowId}/erased=${erased}/post-erase`
}

export function postEraseControlId(rowId: string): string {
	return `A/${rowId}/untouched=agent/control/post-erase`
}

export function requiredCaseIds(): string[] {
	const ids: string[] = []
	for (const row of READ_ROWS) {
		if (row.coverage !== "covered") continue
		for (const reader of TENANT_ROLES) {
			ids.push(preEraseControlId(row.id, reader))
			for (const foreign of TENANT_ROLES) {
				if (pairApplies(row, reader, foreign)) {
					ids.push(preEraseCaseId(row.id, reader, foreign))
				}
			}
		}
		for (const erased of ERASED_ROLES) ids.push(postEraseCaseId(row.id, erased))
		ids.push(postEraseControlId(row.id))
	}
	return ids
}
