import type { Db, Document } from "mongodb"
import { type MemoryScope, createSubsystemLogger } from "@memongo/lib"
import { recordProjectionRun } from "./mongodb-ops.js"
import {
	ErasureGateConflictError,
	withFencedWrite,
	type AdmissionToken,
} from "./mongodb-write-fence.js"
import {
	searchDiscoveryCandidates,
	windowRange,
	type DiscoveryTenant,
} from "./mongodb-discovery-search.js"
import { resolveTimeRangePreset } from "./mongodb-retrieval-planner.js"
import {
	buildEventLifecycleClause,
	buildUnexpiredClause,
} from "./mongodb-temporal.js"
import {
	entitiesCollection,
	episodesCollection,
	eventsCollection,
	proceduresCollection,
	relationsCollection,
	structuredMemCollection,
	structuredMemRevisionsCollection,
} from "./mongodb-schema.js"
import {
	SectionFailureCollector,
	noteBestEffortFailure,
	type SectionFailure,
} from "./section-failures.js"
import type {
	MemoryDiscoveryProjection,
	MemoryDiscoveryProjectionEvidence,
	MemoryDiscoveryProjectionMetadata,
	MemoryDiscoveryProjectionKind,
	MemoryDiscoveryProjectionRequest,
	MemoryDiscoveryProjectionSection,
	MemorySearchTimeRange,
} from "./types.js"

const log = createSubsystemLogger("memory:mongodb:discovery-projections")
function recordReadProjectionRun(
	params: Parameters<typeof recordProjectionRun>[0] & {
		admission?: AdmissionToken
	},
): Promise<string> {
	if (params.admission) {
		return withFencedWrite({
			db: params.db,
			prefix: params.prefix,
			token: params.admission,
			fn: (session) => recordProjectionRun({ ...params, session }),
		})
	}
	return recordProjectionRun(params)
}

const DEFAULT_MAX_ITEMS = 5
const MAX_ITEMS = 8

type ProjectionTimeRange = {
	label: string
	start: Date
	end: Date
}

type ProjectionBuilderResult = {
	title: string
	summary: string
	sections: MemoryDiscoveryProjectionSection[]
	failures: SectionFailure[]
	timeRange?: ProjectionTimeRange
}

function clampMaxItems(maxItems?: number): number {
	if (!Number.isFinite(maxItems)) {
		return DEFAULT_MAX_ITEMS
	}
	return Math.max(1, Math.min(MAX_ITEMS, Math.floor(maxItems ?? 0)))
}

function buildScopeSuffix(scope: MemoryScope, scopeRef: string): string {
	const params = new URLSearchParams()
	params.set("scope", scope)
	params.set("scopeRef", scopeRef)
	return `?${params.toString()}`
}

function buildStructuredPath(doc: Document): string {
	return `structured:${String(doc.type ?? "unknown")}:${String(doc.key ?? "")}${buildScopeSuffix(
		doc.scope as MemoryScope,
		String(doc.scopeRef ?? ""),
	)}`
}

function buildProcedurePath(doc: Document): string {
	return `procedure:${String(doc.procedureId ?? "")}${buildScopeSuffix(
		doc.scope as MemoryScope,
		String(doc.scopeRef ?? ""),
	)}`
}

function buildRelationPath(doc: Document): string {
	// C-025: typed locator ("from-to-type") so a path round-trips to one
	// relation even when several relations share the same entity pair.
	return `relation:${String(doc.fromEntityId ?? "")}-${String(doc.toEntityId ?? "")}-${String(doc.type ?? "")}${buildScopeSuffix(
		doc.scope as MemoryScope,
		String(doc.scopeRef ?? ""),
	)}`
}

function buildEntityPath(doc: Document): string {
	return `entity:${String(doc.entityId ?? "")}${buildScopeSuffix(
		doc.scope as MemoryScope,
		String(doc.scopeRef ?? ""),
	)}`
}

function getSourceEventIds(doc: Document): string[] | undefined {
	if (!Array.isArray(doc.sourceEventIds)) {
		return undefined
	}
	const ids = doc.sourceEventIds.filter(
		(value): value is string => typeof value === "string" && value.length > 0,
	)
	return ids.length > 0 ? ids : undefined
}

function mergeSourceEventIds(
	...docs: Array<Document | null | undefined>
): string[] | undefined {
	const merged = new Set<string>()
	for (const doc of docs) {
		for (const id of getSourceEventIds(doc ?? {}) ?? []) {
			merged.add(id)
		}
	}
	return merged.size > 0 ? Array.from(merged) : undefined
}

function formatCount(count: number, singular: string, plural: string): string {
	return `${count} ${count === 1 ? singular : plural}`
}

function buildEvidence(evidence: MemoryDiscoveryProjectionEvidence[]): {
	evidenceCount: number
	sourceCounts: Record<string, number>
} {
	const sourceCounts = new Map<string, number>()
	for (const entry of evidence) {
		sourceCounts.set(entry.source, (sourceCounts.get(entry.source) ?? 0) + 1)
	}
	return {
		evidenceCount: evidence.length,
		sourceCounts: Object.fromEntries(sourceCounts),
	}
}

function flattenEvidence(
	sections: MemoryDiscoveryProjectionSection[],
): MemoryDiscoveryProjectionEvidence[] {
	return sections.flatMap((section) => section.evidence)
}

function capSections(
	sections: MemoryDiscoveryProjectionSection[],
	maxItems: number,
): MemoryDiscoveryProjectionSection[] {
	let remaining = maxItems
	const capped: MemoryDiscoveryProjectionSection[] = []
	for (const section of sections) {
		if (remaining <= 0) {
			break
		}
		const evidence = section.evidence.slice(0, remaining)
		if (evidence.length === 0) {
			continue
		}
		capped.push({
			...section,
			evidence,
		})
		remaining -= evidence.length
	}
	return capped
}

function pickLatestDocuments<T extends Document>(
	docs: T[],
	options: {
		identity: (doc: T) => string | undefined
		timestamp: (doc: T) => Date | undefined
	},
): T[] {
	const latest = new Map<string, T>()
	for (const doc of docs) {
		const identity = options.identity(doc)
		if (!identity) {
			continue
		}
		const existing = latest.get(identity)
		if (!existing) {
			latest.set(identity, doc)
			continue
		}
		const nextTs = options.timestamp(doc)?.getTime() ?? 0
		const currentTs = options.timestamp(existing)?.getTime() ?? 0
		if (nextTs >= currentTs) {
			latest.set(identity, doc)
		}
	}
	return Array.from(latest.values()).toSorted((left, right) => {
		const leftTs = options.timestamp(left)?.getTime() ?? 0
		const rightTs = options.timestamp(right)?.getTime() ?? 0
		return rightTs - leftTs
	})
}

function resolveProjectionTimeRange(
	timeRange: MemorySearchTimeRange | undefined,
	fallbackPreset: "last-7d" | "last-30d" = "last-7d",
): ProjectionTimeRange {
	if (timeRange?.start || timeRange?.end) {
		const end = timeRange?.end ? new Date(timeRange.end) : new Date()
		const start = timeRange?.start
			? new Date(timeRange.start)
			: resolveTimeRangePreset(fallbackPreset, end).start
		return { label: "custom", start, end }
	}
	const label = timeRange?.preset ?? fallbackPreset
	const resolved = resolveTimeRangePreset(label, new Date())
	return { label, ...resolved }
}

function toEntityEvidence(doc: Document): MemoryDiscoveryProjectionEvidence {
	return {
		title: `${String(doc.name ?? "")} (${String(doc.type ?? "entity")})`,
		summary:
			Array.isArray(doc.aliases) && doc.aliases.length > 0
				? `Aliases: ${doc.aliases.join(", ")}`
				: `Entity type: ${String(doc.type ?? "entity")}`,
		path: buildEntityPath(doc),
		source: "graph",
		canonicalId: `entity:${String(doc.entityId ?? "")}`,
		...(doc.updatedAt instanceof Date ? { timestamp: doc.updatedAt } : {}),
		...(typeof doc.scope === "string"
			? { scope: doc.scope as MemoryScope }
			: {}),
		...(typeof doc.scopeRef === "string" ? { scopeRef: doc.scopeRef } : {}),
		...(getSourceEventIds(doc)
			? { sourceEventIds: getSourceEventIds(doc) }
			: {}),
	}
}

function toRelationEvidence(
	doc: Document,
	entityNames: Map<string, string>,
): MemoryDiscoveryProjectionEvidence {
	const fromName =
		entityNames.get(String(doc.fromEntityId ?? "")) ??
		String(doc.fromEntityId ?? "")
	const toName =
		entityNames.get(String(doc.toEntityId ?? "")) ??
		String(doc.toEntityId ?? "")
	return {
		title: `${fromName} ${String(doc.type ?? "related_to")} ${toName}`,
		summary:
			typeof doc.state === "string"
				? `Relation state: ${doc.state}`
				: `Relation type: ${String(doc.type ?? "related_to")}`,
		path: buildRelationPath(doc),
		source: "graph",
		canonicalId: `relation:${String(doc.fromEntityId ?? "")}:${String(doc.type ?? "")}:${String(doc.toEntityId ?? "")}`,
		...(doc.updatedAt instanceof Date ? { timestamp: doc.updatedAt } : {}),
		...(typeof doc.scope === "string"
			? { scope: doc.scope as MemoryScope }
			: {}),
		...(typeof doc.scopeRef === "string" ? { scopeRef: doc.scopeRef } : {}),
		...(getSourceEventIds(doc)
			? { sourceEventIds: getSourceEventIds(doc) }
			: {}),
	}
}

function toStructuredEvidence(
	doc: Document,
): MemoryDiscoveryProjectionEvidence {
	return {
		title: String(doc.key ?? doc.type ?? "memory"),
		summary: String(doc.value ?? "").slice(0, 700),
		path: buildStructuredPath(doc),
		source: "structured",
		canonicalId: `structured:${String(doc.type ?? "unknown")}:${String(doc.key ?? "")}`,
		...(doc.updatedAt instanceof Date ? { timestamp: doc.updatedAt } : {}),
		...(doc.supersededAt instanceof Date
			? { timestamp: doc.supersededAt }
			: {}),
		...(typeof doc.scope === "string"
			? { scope: doc.scope as MemoryScope }
			: {}),
		...(typeof doc.scopeRef === "string" ? { scopeRef: doc.scopeRef } : {}),
		...(getSourceEventIds(doc)
			? { sourceEventIds: getSourceEventIds(doc) }
			: {}),
	}
}

function toStructuredChangeEvidence(params: {
	revision: Document
	current?: Document
}): MemoryDiscoveryProjectionEvidence {
	const { revision, current } = params
	const oldValue = String(revision.value ?? "").trim()
	const currentValue = current ? String(current.value ?? "").trim() : ""
	const summary =
		currentValue && currentValue !== oldValue
			? `Previous: ${oldValue.slice(0, 320)} Current: ${currentValue.slice(0, 320)}`
			: oldValue.slice(0, 700)
	const sourceEventIds = mergeSourceEventIds(revision, current)
	const pathDoc = current ?? revision
	return {
		title: String(revision.key ?? revision.type ?? "memory"),
		summary,
		path: buildStructuredPath(pathDoc),
		source: "structured",
		canonicalId: `structured:${String(revision.type ?? "unknown")}:${String(revision.key ?? "")}`,
		...(current?.updatedAt instanceof Date
			? { timestamp: current.updatedAt }
			: revision.supersededAt instanceof Date
				? { timestamp: revision.supersededAt }
				: revision.updatedAt instanceof Date
					? { timestamp: revision.updatedAt }
					: {}),
		...(typeof revision.scope === "string"
			? { scope: revision.scope as MemoryScope }
			: {}),
		...(typeof revision.scopeRef === "string"
			? { scopeRef: revision.scopeRef }
			: {}),
		...(sourceEventIds ? { sourceEventIds } : {}),
	}
}

function toProcedureEvidence(doc: Document): MemoryDiscoveryProjectionEvidence {
	const steps = Array.isArray(doc.steps)
		? doc.steps
				.filter((value): value is string => typeof value === "string")
				.slice(0, 2)
		: []
	return {
		title: String(doc.name ?? doc.procedureId ?? "procedure"),
		summary:
			steps.length > 0
				? steps.join(" -> ").slice(0, 700)
				: String(doc.searchText ?? "").slice(0, 700),
		path: buildProcedurePath(doc),
		source: "procedural",
		canonicalId: `procedure:${String(doc.procedureId ?? "")}`,
		...(doc.updatedAt instanceof Date ? { timestamp: doc.updatedAt } : {}),
		...(typeof doc.scope === "string"
			? { scope: doc.scope as MemoryScope }
			: {}),
		...(typeof doc.scopeRef === "string" ? { scopeRef: doc.scopeRef } : {}),
		...(getSourceEventIds(doc)
			? { sourceEventIds: getSourceEventIds(doc) }
			: {}),
	}
}

function toEpisodeEvidence(doc: Document): MemoryDiscoveryProjectionEvidence {
	return {
		title: String(doc.title ?? doc.episodeId ?? "episode"),
		summary: String(doc.summary ?? "").slice(0, 700),
		path: `episode:${String(doc.episodeId ?? "")}`,
		source: "episodic",
		canonicalId: `episode:${String(doc.episodeId ?? "")}`,
		...(doc.timeRange?.end instanceof Date
			? { timestamp: doc.timeRange.end }
			: {}),
		...(typeof doc.scope === "string"
			? { scope: doc.scope as MemoryScope }
			: {}),
		...(typeof doc.scopeRef === "string" ? { scopeRef: doc.scopeRef } : {}),
		...(getSourceEventIds(doc)
			? { sourceEventIds: getSourceEventIds(doc) }
			: {}),
	}
}

function toEventEvidence(doc: Document): MemoryDiscoveryProjectionEvidence {
	return {
		title:
			typeof doc.role === "string" && doc.role.trim()
				? `${doc.role} event`
				: "event",
		summary: String(doc.body ?? "").slice(0, 700),
		path: `events/${String(doc.eventId ?? "")}`,
		source: "conversation",
		canonicalId: `event:${String(doc.eventId ?? "")}`,
		...(doc.timestamp instanceof Date ? { timestamp: doc.timestamp } : {}),
		...(typeof doc.scope === "string"
			? { scope: doc.scope as MemoryScope }
			: {}),
		...(typeof doc.scopeRef === "string" ? { scopeRef: doc.scopeRef } : {}),
		...(typeof doc.eventId === "string"
			? { sourceEventIds: [doc.eventId] }
			: {}),
	}
}

type BriefParams = {
	db: Db
	prefix: string
	agentId: string
	scope: MemoryScope
	scopeRef: string
	query: string
	maxItems: number
}

const DISCOVERY_OPERATION = "buildDiscoveryProjection"

function createCollector(query?: string): SectionFailureCollector {
	return new SectionFailureCollector({
		log,
		operation: DISCOVERY_OPERATION,
		query,
	})
}

function stateClauses(states: string[]): {
	search: Document
	match: string | Document
} {
	return states.length === 1
		? {
				search: { equals: { path: "state", value: states[0] } },
				match: states[0],
			}
		: {
				search: { in: { path: "state", value: states } },
				match: { $in: states },
			}
}

function searchStructured(params: {
	db: Db
	prefix: string
	tenant: DiscoveryTenant
	query: string
	states: string[]
	limit: number
}): Promise<Document[]> {
	const state = stateClauses(params.states)
	return searchDiscoveryCandidates({
		collection: structuredMemCollection(params.db, params.prefix),
		indexName: `${params.prefix}structured_mem_text`,
		lane: "structured",
		query: params.query,
		textPaths: ["key", "value", "context", "tags"],
		tenant: params.tenant,
		filter: [state.search],
		// P4.4.1 (B1): hide TTL-expired docs until the sweep removes them.
		recheck: {
			...params.tenant,
			state: state.match,
			$and: [buildUnexpiredClause()],
		},
		sort: { updatedAt: -1 },
		limit: params.limit,
	})
}

function searchProcedures(params: {
	db: Db
	prefix: string
	tenant: DiscoveryTenant
	query: string
	limit: number
	states?: string[]
	updatedWindow?: { start: Date; end: Date }
}): Promise<Document[]> {
	const state = params.states ? stateClauses(params.states) : undefined
	return searchDiscoveryCandidates({
		collection: proceduresCollection(params.db, params.prefix),
		indexName: `${params.prefix}procedures_text`,
		lane: "procedural",
		query: params.query,
		// searchText embeds name, intentTags, triggerQueries and steps.
		textPaths: ["name", "searchText"],
		tenant: params.tenant,
		filter: [
			...(state ? [state.search] : []),
			...(params.updatedWindow
				? [windowRange("updatedAt", params.updatedWindow)]
				: []),
		],
		recheck: {
			...params.tenant,
			...(state ? { state: state.match } : {}),
			...(params.updatedWindow
				? {
						updatedAt: {
							$gte: params.updatedWindow.start,
							$lte: params.updatedWindow.end,
						},
					}
				: {}),
		},
		sort: { updatedAt: -1 },
		limit: params.limit,
	})
}

async function searchAdjacentEntityIds(params: {
	db: Db
	prefix: string
	tenant: DiscoveryTenant
	query: string
	limit: number
}): Promise<string[]> {
	const entities = await searchDiscoveryCandidates({
		collection: entitiesCollection(params.db, params.prefix),
		indexName: "entity_autocomplete",
		lane: "graph",
		query: params.query,
		textPaths: ["name", "aliases", "type"],
		tenant: params.tenant,
		recheck: { ...params.tenant },
		sort: { updatedAt: -1 },
		limit: params.limit,
	})
	return entities
		.map((entity) => String(entity.entityId ?? ""))
		.filter((id) => id.length > 0)
}

// Relation briefs search entities first and read relations by the matched ids
// (adj); no relation field is matched against the query text.
async function readRelationsAdjacentToQuery(params: {
	db: Db
	prefix: string
	tenant: DiscoveryTenant
	query: string
	entityLimit: number
	extra: Document
	limit: number
}): Promise<Document[]> {
	const entityIds = await searchAdjacentEntityIds({
		db: params.db,
		prefix: params.prefix,
		tenant: params.tenant,
		query: params.query,
		limit: params.entityLimit,
	})
	if (entityIds.length === 0) {
		return []
	}
	return relationsCollection(params.db, params.prefix)
		.find({
			...params.tenant,
			...params.extra,
			$or: [
				{ fromEntityId: { $in: entityIds } },
				{ toEntityId: { $in: entityIds } },
			],
		})
		.sort({ updatedAt: -1 })
		.limit(params.limit)
		.toArray()
}

async function buildEntityBrief(
	params: BriefParams,
): Promise<ProjectionBuilderResult> {
	const { db, prefix, agentId, scope, scopeRef, query, maxItems } = params
	const scopeFilter = { agentId, scope, scopeRef }
	const collector = createCollector(query)

	const entities = await collector.settle(
		"entities",
		"lane",
		() =>
			searchDiscoveryCandidates({
				collection: entitiesCollection(db, prefix),
				indexName: "entity_autocomplete",
				lane: "graph",
				query,
				textPaths: ["name", "aliases"],
				tenant: scopeFilter,
				recheck: { ...scopeFilter },
				sort: { updatedAt: -1 },
				limit: maxItems,
			}),
		{ lane: "graph", label: "entity-brief.entities" },
	)

	const matchedEntities = entities.value ?? []
	const matchedIds = matchedEntities.map((entity) =>
		String(entity.entityId ?? ""),
	)
	const relationDocs =
		matchedIds.length === 0
			? undefined
			: await collector.settle(
					"relations",
					"lane",
					() =>
						relationsCollection(db, prefix)
							.find({
								...scopeFilter,
								state: "active",
								$or: [
									{ fromEntityId: { $in: matchedIds } },
									{ toEntityId: { $in: matchedIds } },
								],
							})
							.sort({ updatedAt: -1 })
							.limit(maxItems)
							.toArray(),
					{ lane: "graph", label: "entity-brief.relations" },
				)
	const relations = relationDocs?.value ?? []

	const relatedEntityIds = Array.from(
		new Set(
			relations.flatMap((relation) => [
				String(relation.fromEntityId ?? ""),
				String(relation.toEntityId ?? ""),
			]),
		),
	).filter((value) => value.length > 0 && !matchedIds.includes(value))
	const relatedEntityDocs =
		relatedEntityIds.length === 0
			? undefined
			: await collector.settle(
					"related-entities",
					"lane",
					() =>
						entitiesCollection(db, prefix)
							.find({
								...scopeFilter,
								entityId: { $in: relatedEntityIds },
							})
							.sort({ updatedAt: -1 })
							.limit(maxItems * 2)
							.toArray(),
					{ lane: "graph", label: "entity-brief.related-entities" },
				)
	const relatedEntities = relatedEntityDocs?.value ?? []
	const structuredResult = await collector.settle(
		"structured",
		"lane",
		() =>
			searchStructured({
				db,
				prefix,
				tenant: scopeFilter,
				query,
				states: ["active"],
				limit: maxItems,
			}),
		{ lane: "structured", label: "entity-brief.structured" },
	)
	const structured = structuredResult.value ?? []
	collector.throwIfAllFailed()

	const entityNames = new Map<string, string>()
	for (const entity of [...matchedEntities, ...relatedEntities]) {
		entityNames.set(String(entity.entityId ?? ""), String(entity.name ?? ""))
	}

	const sections: MemoryDiscoveryProjectionSection[] = []
	if (matchedEntities.length > 0) {
		sections.push({
			title: "Entities",
			summary: `Matched ${formatCount(matchedEntities.length, "entity", "entities")} for ${query}.`,
			evidence: matchedEntities.map((doc) => toEntityEvidence(doc)),
		})
	}
	if (relations.length > 0) {
		sections.push({
			title: "Relationships",
			summary: `Found ${formatCount(relations.length, "active relationship", "active relationships")}.`,
			evidence: relations.map((doc) => toRelationEvidence(doc, entityNames)),
		})
	}
	if (structured.length > 0) {
		sections.push({
			title: "Durable context",
			summary: `Found ${formatCount(structured.length, "durable record", "durable records")} tied to ${query}.`,
			evidence: structured.map((doc) => toStructuredEvidence(doc)),
		})
	}

	const summary = `Found ${formatCount(matchedEntities.length, "matching entity", "matching entities")}, ${formatCount(relations.length, "active relationship", "active relationships")}, and ${formatCount(structured.length, "durable record", "durable records")} for ${query}.`
	return {
		title: `${query.trim()} entity brief`,
		summary,
		sections: capSections(sections, maxItems),
		failures: collector.failures,
	}
}

async function buildTopicBrief(
	params: BriefParams,
): Promise<ProjectionBuilderResult> {
	const { db, prefix, agentId, scope, scopeRef, query, maxItems } = params
	const scopeFilter = { agentId, scope, scopeRef }
	const collector = createCollector(query)

	const episodesResult = await collector.settle(
		"episodes",
		"lane",
		() =>
			searchDiscoveryCandidates({
				collection: episodesCollection(db, prefix),
				indexName: "episode_autocomplete",
				lane: "episodic",
				query,
				textPaths: ["title", "summary", "tags", "topics"],
				tenant: scopeFilter,
				mustNot: [{ equals: { path: "status", value: "deleted" } }],
				recheck: { ...scopeFilter, status: { $ne: "deleted" } },
				sort: { "timeRange.end": -1 },
				limit: maxItems,
			}),
		{ lane: "episodic", label: "topic-brief.episodes" },
	)
	const structuredResult = await collector.settle(
		"structured",
		"lane",
		() =>
			searchStructured({
				db,
				prefix,
				tenant: scopeFilter,
				query,
				states: ["active"],
				limit: maxItems,
			}),
		{ lane: "structured", label: "topic-brief.structured" },
	)
	const proceduresResult = await collector.settle(
		"procedures",
		"lane",
		() =>
			searchProcedures({
				db,
				prefix,
				tenant: scopeFilter,
				query,
				states: ["active"],
				limit: maxItems,
			}),
		{ lane: "procedural", label: "topic-brief.procedures" },
	)
	collector.throwIfAllFailed()
	const episodes = episodesResult.value ?? []
	const structured = structuredResult.value ?? []
	const procedures = proceduresResult.value ?? []

	const sections: MemoryDiscoveryProjectionSection[] = []
	if (episodes.length > 0) {
		sections.push({
			title: "Recent episodes",
			summary: `Matched ${formatCount(episodes.length, "episode", "episodes")} for ${query}.`,
			evidence: episodes.map((doc) => toEpisodeEvidence(doc)),
		})
	}
	if (structured.length > 0) {
		sections.push({
			title: "Durable memory",
			summary: `Matched ${formatCount(structured.length, "durable record", "durable records")} for ${query}.`,
			evidence: structured.map((doc) => toStructuredEvidence(doc)),
		})
	}
	if (procedures.length > 0) {
		sections.push({
			title: "Procedures",
			summary: `Matched ${formatCount(procedures.length, "procedure", "procedures")} for ${query}.`,
			evidence: procedures.map((doc) => toProcedureEvidence(doc)),
		})
	}

	return {
		title: `${query.trim()} topic brief`,
		summary: `Matched ${formatCount(episodes.length, "episode", "episodes")}, ${formatCount(structured.length, "durable record", "durable records")}, and ${formatCount(procedures.length, "procedure", "procedures")} for ${query}.`,
		sections: capSections(sections, maxItems),
		failures: collector.failures,
	}
}

async function buildWhatChanged(params: {
	db: Db
	prefix: string
	agentId: string
	scope: MemoryScope
	scopeRef: string
	query?: string
	maxItems: number
	timeRange?: MemorySearchTimeRange
}): Promise<ProjectionBuilderResult> {
	const { db, prefix, agentId, scope, scopeRef, query, maxItems, timeRange } =
		params
	const scopeFilter = { agentId, scope, scopeRef }
	const collector = createCollector(query)
	const resolvedTimeRange = resolveProjectionTimeRange(timeRange)
	const laneQueryLimit = Math.max(maxItems * 3, maxItems)
	const window = { start: resolvedTimeRange.start, end: resolvedTimeRange.end }
	const dateFilter = { $gte: window.start, $lte: window.end }

	const revisions = await collector.settle(
		"revisions",
		"lane",
		() =>
			query
				? searchDiscoveryCandidates({
						collection: structuredMemRevisionsCollection(db, prefix),
						indexName: `${prefix}structured_mem_revisions_text`,
						lane: "structured",
						query,
						textPaths: ["key", "value", "context", "tags"],
						tenant: scopeFilter,
						filter: [windowRange("supersededAt", window)],
						recheck: { ...scopeFilter, supersededAt: dateFilter },
						sort: { supersededAt: -1 },
						limit: laneQueryLimit,
					})
				: structuredMemRevisionsCollection(db, prefix)
						.find({ ...scopeFilter, supersededAt: dateFilter })
						.sort({ supersededAt: -1 })
						.limit(laneQueryLimit)
						.toArray(),
		{ lane: "structured", label: "what-changed.structured-revisions" },
	)
	const revisionDocs = pickLatestDocuments(revisions.value ?? [], {
		identity: (doc) => {
			const type = typeof doc.type === "string" ? doc.type : undefined
			const key = typeof doc.key === "string" ? doc.key : undefined
			return type && key ? `${type}::${key}` : undefined
		},
		timestamp: (doc) =>
			doc.supersededAt instanceof Date
				? doc.supersededAt
				: doc.updatedAt instanceof Date
					? doc.updatedAt
					: undefined,
	})
	const revisionFilters = revisionDocs
		.map((doc) => {
			const type = typeof doc.type === "string" ? doc.type : undefined
			const key = typeof doc.key === "string" ? doc.key : undefined
			return type && key ? { type, key } : null
		})
		.filter((value): value is { type: string; key: string } => value !== null)
	const currentStructured = revisionFilters.length
		? await collector.settle(
				"structured-current",
				"lane",
				() =>
					structuredMemCollection(db, prefix)
						.find({
							...scopeFilter,
							state: "active",
							$or: revisionFilters,
							// P4.4.1 (B1): an expired "current" record reads as gone even
							// before the TTL sweep; $and because $or carries the revision
							// identity set.
							$and: [buildUnexpiredClause()],
						})
						.toArray(),
				{ lane: "structured", label: "what-changed.structured-current" },
			)
		: undefined
	const currentStructuredByKey = new Map<string, Document>()
	for (const doc of currentStructured?.value ?? []) {
		currentStructuredByKey.set(
			`${String(doc.type ?? "")}::${String(doc.key ?? "")}`,
			doc,
		)
	}
	const procedures = await collector.settle(
		"procedures",
		"lane",
		() =>
			query
				? searchProcedures({
						db,
						prefix,
						tenant: scopeFilter,
						query,
						updatedWindow: window,
						limit: laneQueryLimit,
					})
				: proceduresCollection(db, prefix)
						.find({ ...scopeFilter, updatedAt: dateFilter })
						.sort({ updatedAt: -1 })
						.limit(laneQueryLimit)
						.toArray(),
		{ lane: "procedural", label: "what-changed.procedures" },
	)
	const procedureDocs = pickLatestDocuments(procedures.value ?? [], {
		identity: (doc) =>
			typeof doc.procedureId === "string" ? doc.procedureId : undefined,
		timestamp: (doc) =>
			doc.updatedAt instanceof Date ? doc.updatedAt : undefined,
	})
	const relations = await collector.settle(
		"relations",
		"lane",
		() =>
			query
				? readRelationsAdjacentToQuery({
						db,
						prefix,
						tenant: scopeFilter,
						query,
						entityLimit: laneQueryLimit,
						extra: { updatedAt: dateFilter },
						limit: laneQueryLimit,
					})
				: relationsCollection(db, prefix)
						.find({ ...scopeFilter, updatedAt: dateFilter })
						.sort({ updatedAt: -1 })
						.limit(laneQueryLimit)
						.toArray(),
		{ lane: "graph", label: "what-changed.relations" },
	)
	const relationDocs = pickLatestDocuments(relations.value ?? [], {
		identity: (doc) => {
			const fromEntityId =
				typeof doc.fromEntityId === "string" ? doc.fromEntityId : undefined
			const type = typeof doc.type === "string" ? doc.type : undefined
			const toEntityId =
				typeof doc.toEntityId === "string" ? doc.toEntityId : undefined
			return fromEntityId && type && toEntityId
				? `${fromEntityId}::${type}::${toEntityId}`
				: undefined
		},
		timestamp: (doc) =>
			doc.updatedAt instanceof Date ? doc.updatedAt : undefined,
	})
	const events = await collector.settle(
		"events",
		"lane",
		() =>
			query
				? searchDiscoveryCandidates({
						collection: eventsCollection(db, prefix),
						indexName: `${prefix}events_text`,
						lane: "raw-window",
						query,
						textPaths: ["body"],
						tenant: scopeFilter,
						filter: [windowRange("timestamp", window)],
						recheck: {
							...scopeFilter,
							timestamp: dateFilter,
							...buildEventLifecycleClause(),
						},
						sort: { timestamp: -1 },
						limit: laneQueryLimit,
					})
				: eventsCollection(db, prefix)
						.find({
							...scopeFilter,
							timestamp: dateFilter,
							// RET-10: the same lifecycle guard the events search lanes apply.
							...buildEventLifecycleClause(),
						})
						.sort({ timestamp: -1 })
						.limit(laneQueryLimit)
						.toArray(),
		{ lane: "raw-window", label: "what-changed.events" },
	)
	collector.throwIfAllFailed()
	const eventDocs = events.value ?? []

	const sections: MemoryDiscoveryProjectionSection[] = []
	if (revisionDocs.length > 0) {
		sections.push({
			title: "Structured changes",
			summary: `Found ${formatCount(revisionDocs.length, "superseded record", "superseded records")} in ${resolvedTimeRange.label}.`,
			evidence: revisionDocs.map((doc) =>
				toStructuredChangeEvidence({
					revision: doc,
					current: currentStructuredByKey.get(
						`${String(doc.type ?? "")}::${String(doc.key ?? "")}`,
					),
				}),
			),
		})
	}
	if (procedureDocs.length > 0) {
		sections.push({
			title: "Procedure changes",
			summary: `Found ${formatCount(procedureDocs.length, "procedure update", "procedure updates")} in ${resolvedTimeRange.label}.`,
			evidence: procedureDocs.map((doc) => toProcedureEvidence(doc)),
		})
	}
	if (relationDocs.length > 0) {
		sections.push({
			title: "Relation changes",
			summary: `Found ${formatCount(relationDocs.length, "relation update", "relation updates")} in ${resolvedTimeRange.label}.`,
			evidence: relationDocs.map((doc) =>
				toRelationEvidence(doc, new Map<string, string>()),
			),
		})
	}
	if (eventDocs.length > 0) {
		sections.push({
			title: "Recent anchors",
			summary: `Found ${formatCount(eventDocs.length, "recent event", "recent events")} in ${resolvedTimeRange.label}.`,
			evidence: eventDocs.map((doc) => toEventEvidence(doc)),
		})
	}

	const evidenceSections = capSections(sections, maxItems)
	const evidence = flattenEvidence(evidenceSections)
	return {
		title: query?.trim() ? `What changed for ${query.trim()}` : "What changed",
		summary:
			evidence.length > 0
				? `Found ${formatCount(evidence.length, "change", "changes")} in ${resolvedTimeRange.label}.`
				: `No notable changes found in ${resolvedTimeRange.label}.`,
		sections: evidenceSections,
		failures: collector.failures,
		timeRange: resolvedTimeRange,
	}
}

async function buildContradictionReport(params: {
	db: Db
	prefix: string
	agentId: string
	scope: MemoryScope
	scopeRef: string
	query?: string
	maxItems: number
}): Promise<ProjectionBuilderResult> {
	const { db, prefix, agentId, scope, scopeRef, query, maxItems } = params
	const scopeFilter = { agentId, scope, scopeRef }
	const collector = createCollector(query)
	const states = ["conflicted", "invalidated"]
	const stateFilter = { $in: states }

	const structured = await collector.settle(
		"structured",
		"lane",
		() =>
			query
				? searchStructured({
						db,
						prefix,
						tenant: scopeFilter,
						query,
						states,
						limit: maxItems,
					})
				: structuredMemCollection(db, prefix)
						.find({
							...scopeFilter,
							state: stateFilter,
							// P4.4.1 (B1): hide TTL-expired docs until the sweep removes them.
							$and: [buildUnexpiredClause()],
						})
						.sort({ updatedAt: -1 })
						.limit(maxItems)
						.toArray(),
		{ lane: "structured", label: "contradiction.structured" },
	)
	const procedures = await collector.settle(
		"procedures",
		"lane",
		() =>
			query
				? searchProcedures({
						db,
						prefix,
						tenant: scopeFilter,
						query,
						states,
						limit: maxItems,
					})
				: proceduresCollection(db, prefix)
						.find({ ...scopeFilter, state: stateFilter })
						.sort({ updatedAt: -1 })
						.limit(maxItems)
						.toArray(),
		{ lane: "procedural", label: "contradiction.procedures" },
	)
	const relations = await collector.settle(
		"relations",
		"lane",
		() =>
			query
				? readRelationsAdjacentToQuery({
						db,
						prefix,
						tenant: scopeFilter,
						query,
						entityLimit: maxItems,
						extra: { state: stateFilter },
						limit: maxItems,
					})
				: relationsCollection(db, prefix)
						.find({ ...scopeFilter, state: stateFilter })
						.sort({ updatedAt: -1 })
						.limit(maxItems)
						.toArray(),
		{ lane: "graph", label: "contradiction.relations" },
	)
	collector.throwIfAllFailed()

	const sections: MemoryDiscoveryProjectionSection[] = []
	const structuredDocs = structured.value ?? []
	const procedureDocs = procedures.value ?? []
	const relationDocs = relations.value ?? []
	if (structuredDocs.length > 0) {
		sections.push({
			title: "Structured contradictions",
			summary: `Found ${formatCount(structuredDocs.length, "structured contradiction", "structured contradictions")}.`,
			evidence: structuredDocs.map((doc) => toStructuredEvidence(doc)),
		})
	}
	if (procedureDocs.length > 0) {
		sections.push({
			title: "Procedure contradictions",
			summary: `Found ${formatCount(procedureDocs.length, "procedure contradiction", "procedure contradictions")}.`,
			evidence: procedureDocs.map((doc) => toProcedureEvidence(doc)),
		})
	}
	if (relationDocs.length > 0) {
		sections.push({
			title: "Relation contradictions",
			summary: `Found ${formatCount(relationDocs.length, "relation contradiction", "relation contradictions")}.`,
			evidence: relationDocs.map((doc) =>
				toRelationEvidence(doc, new Map<string, string>()),
			),
		})
	}

	const evidenceSections = capSections(sections, maxItems)
	const evidence = flattenEvidence(evidenceSections)
	return {
		title: query?.trim()
			? `Contradiction report for ${query.trim()}`
			: "Contradiction report",
		summary:
			evidence.length > 0
				? `Found ${formatCount(evidence.length, "contradiction", "contradictions")} across active memory lanes.`
				: "No contradictions found across the inspected memory lanes.",
		sections: evidenceSections,
		failures: collector.failures,
	}
}

function projectionKindRequiresQuery(
	kind: MemoryDiscoveryProjectionKind,
): boolean {
	return kind === "entity-brief" || kind === "topic-brief"
}

export async function buildDiscoveryProjection(params: {
	admission?: AdmissionToken
	db: Db
	prefix: string
	agentId: string
	kind: MemoryDiscoveryProjectionKind
	query?: string
	scope: MemoryScope
	scopeRef: string
	maxItems?: number
	timeRange?: MemorySearchTimeRange
}): Promise<MemoryDiscoveryProjection> {
	const startedAt = Date.now()
	const { db, prefix, agentId, kind, query, scope, scopeRef } = params
	if (
		params.admission &&
		(params.admission.kind !== "admission" ||
			params.admission.agentId !== agentId)
	)
		throw new ErasureGateConflictError(agentId)
	const maxItems = clampMaxItems(params.maxItems)

	if (projectionKindRequiresQuery(kind) && !query?.trim()) {
		throw new Error(`query is required for ${kind}`)
	}

	try {
		let built: ProjectionBuilderResult
		switch (kind) {
			case "entity-brief":
				built = await buildEntityBrief({
					db,
					prefix,
					agentId,
					scope,
					scopeRef,
					query: query!.trim(),
					maxItems,
				})
				break
			case "topic-brief":
				built = await buildTopicBrief({
					db,
					prefix,
					agentId,
					scope,
					scopeRef,
					query: query!.trim(),
					maxItems,
				})
				break
			case "what-changed":
				built = await buildWhatChanged({
					db,
					prefix,
					agentId,
					scope,
					scopeRef,
					query: query?.trim() || undefined,
					maxItems,
					timeRange: params.timeRange,
				})
				break
			case "contradiction-report":
				built = await buildContradictionReport({
					db,
					prefix,
					agentId,
					scope,
					scopeRef,
					query: query?.trim() || undefined,
					maxItems,
				})
				break
		}

		const evidence = flattenEvidence(built.sections)
		const metadata: MemoryDiscoveryProjectionMetadata = {
			partial: built.failures.length > 0,
			failures: built.failures,
			...buildEvidence(evidence),
			...(built.timeRange ? { timeRange: built.timeRange } : {}),
		}
		const projection: MemoryDiscoveryProjection = {
			kind,
			...(query?.trim() ? { query: query.trim() } : {}),
			title: built.title,
			summary: built.summary,
			scope,
			scopeRef,
			sections: built.sections,
			metadata,
			builtAt: new Date(),
		}

		await recordReadProjectionRun({
			admission: params.admission,
			db,
			prefix,
			run: {
				agentId,
				projectionType: kind,
				status: built.failures.length > 0 ? "partial" : "ok",
				itemsProjected: metadata.evidenceCount,
				durationMs: Date.now() - startedAt,
			},
		}).catch((runError) =>
			noteBestEffortFailure(log, "discovery-projection-run", runError),
		)

		return projection
	} catch (error) {
		await recordReadProjectionRun({
			admission: params.admission,
			db,
			prefix,
			run: {
				agentId,
				projectionType: kind,
				status: "failed",
				itemsProjected: 0,
				durationMs: Date.now() - startedAt,
			},
		}).catch((runError) =>
			noteBestEffortFailure(log, "discovery-projection-run", runError),
		)
		throw error
	}
}
