import type { Db, Document } from "mongodb"
import { type MemoryScope, createSubsystemLogger } from "@memongo/lib"
import { recordProjectionRun } from "./mongodb-ops.js"
import { resolveTimeRangePreset } from "./mongodb-retrieval-planner.js"
import {
	entitiesCollection,
	episodesCollection,
	eventsCollection,
	proceduresCollection,
	relationsCollection,
	structuredMemCollection,
	structuredMemRevisionsCollection,
} from "./mongodb-schema.js"
import type {
	MemoryDiscoveryProjection,
	MemoryDiscoveryProjectionEvidence,
	MemoryDiscoveryProjectionKind,
	MemoryDiscoveryProjectionRequest,
	MemoryDiscoveryProjectionSection,
	MemorySearchTimeRange,
} from "./types.js"

const log = createSubsystemLogger("memory:mongodb:discovery-projections")

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
	partial: boolean
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
	return `relation:${String(doc.fromEntityId ?? "")}-${String(doc.toEntityId ?? "")}${buildScopeSuffix(
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

function buildQueryRegex(query?: string): RegExp | undefined {
	const normalized = query?.trim()
	if (!normalized) {
		return undefined
	}
	const parts = Array.from(
		new Set(
			normalized
				.split(/\s+/)
				.map((part) => part.trim())
				.filter(Boolean)
				.map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
		),
	).slice(0, 8)
	if (parts.length === 0) {
		return undefined
	}
	return new RegExp(parts.join("|"), "i")
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

async function settled<T>(
	label: string,
	fn: () => Promise<T>,
): Promise<T | null> {
	try {
		return await fn()
	} catch (error) {
		log.warn(`buildDiscoveryProjection: ${label} query failed`, { error })
		return null
	}
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

async function buildEntityBrief(params: {
	db: Db
	prefix: string
	agentId: string
	scope: MemoryScope
	scopeRef: string
	query: string
	maxItems: number
}): Promise<ProjectionBuilderResult> {
	const { db, prefix, agentId, scope, scopeRef, query, maxItems } = params
	const regex = buildQueryRegex(query)
	const scopeFilter = { agentId, scope, scopeRef }

	const entities = await settled("entity-brief.entities", () =>
		entitiesCollection(db, prefix)
			.find({
				...scopeFilter,
				...(regex
					? {
							$or: [{ name: regex }, { aliases: regex }],
						}
					: {}),
			})
			.sort({ updatedAt: -1 })
			.limit(maxItems)
			.toArray(),
	)

	const matchedEntities = entities ?? []
	const matchedIds = matchedEntities.map((entity) =>
		String(entity.entityId ?? ""),
	)
	const relationDocs =
		matchedIds.length === 0
			? []
			: await settled("entity-brief.relations", () =>
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
				)
	const relations = relationDocs ?? []

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
			? []
			: await settled("entity-brief.related-entities", () =>
					entitiesCollection(db, prefix)
						.find({
							...scopeFilter,
							entityId: { $in: relatedEntityIds },
						})
						.sort({ updatedAt: -1 })
						.limit(maxItems * 2)
						.toArray(),
				)
	const relatedEntities = relatedEntityDocs ?? []
	const structured = await settled("entity-brief.structured", () =>
		structuredMemCollection(db, prefix)
			.find({
				...scopeFilter,
				state: "active",
				...(regex
					? {
							$or: [
								{ key: regex },
								{ value: regex },
								{ context: regex },
								{ tags: regex },
							],
						}
					: {}),
			})
			.sort({ updatedAt: -1 })
			.limit(maxItems)
			.toArray(),
	)

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
	if ((structured ?? []).length > 0) {
		sections.push({
			title: "Durable context",
			summary: `Found ${formatCount((structured ?? []).length, "durable record", "durable records")} tied to ${query}.`,
			evidence: (structured ?? []).map((doc) => toStructuredEvidence(doc)),
		})
	}

	const partial = [entities, relationDocs, relatedEntityDocs, structured].some(
		(result) => result === null,
	)
	const summary = `Found ${formatCount(matchedEntities.length, "matching entity", "matching entities")}, ${formatCount(relations.length, "active relationship", "active relationships")}, and ${formatCount((structured ?? []).length, "durable record", "durable records")} for ${query}.`
	return {
		title: `${query.trim()} entity brief`,
		summary,
		sections: capSections(sections, maxItems),
		partial,
	}
}

async function buildTopicBrief(params: {
	db: Db
	prefix: string
	agentId: string
	scope: MemoryScope
	scopeRef: string
	query: string
	maxItems: number
}): Promise<ProjectionBuilderResult> {
	const { db, prefix, agentId, scope, scopeRef, query, maxItems } = params
	const regex = buildQueryRegex(query)
	const normalized = query.trim().toLowerCase()
	const scopeFilter = { agentId, scope, scopeRef }

	const episodes = await settled("topic-brief.episodes", () =>
		episodesCollection(db, prefix)
			.find({
				...scopeFilter,
				status: { $ne: "deleted" },
				...(regex
					? {
							$or: [
								{ title: regex },
								{ summary: regex },
								{ tags: regex },
								{ topics: normalized },
							],
						}
					: {}),
			})
			.sort({ "timeRange.end": -1 })
			.limit(maxItems)
			.toArray(),
	)
	const structured = await settled("topic-brief.structured", () =>
		structuredMemCollection(db, prefix)
			.find({
				...scopeFilter,
				state: "active",
				...(regex
					? {
							$or: [
								{ key: regex },
								{ value: regex },
								{ context: regex },
								{ tags: regex },
							],
						}
					: {}),
			})
			.sort({ updatedAt: -1 })
			.limit(maxItems)
			.toArray(),
	)
	const procedures = await settled("topic-brief.procedures", () =>
		proceduresCollection(db, prefix)
			.find({
				...scopeFilter,
				state: "active",
				...(regex
					? {
							$or: [
								{ name: regex },
								{ steps: regex },
								{ intentTags: regex },
								{ searchText: regex },
							],
						}
					: {}),
			})
			.sort({ updatedAt: -1 })
			.limit(maxItems)
			.toArray(),
	)

	const sections: MemoryDiscoveryProjectionSection[] = []
	if ((episodes ?? []).length > 0) {
		sections.push({
			title: "Recent episodes",
			summary: `Matched ${formatCount((episodes ?? []).length, "episode", "episodes")} for ${query}.`,
			evidence: (episodes ?? []).map((doc) => toEpisodeEvidence(doc)),
		})
	}
	if ((structured ?? []).length > 0) {
		sections.push({
			title: "Durable memory",
			summary: `Matched ${formatCount((structured ?? []).length, "durable record", "durable records")} for ${query}.`,
			evidence: (structured ?? []).map((doc) => toStructuredEvidence(doc)),
		})
	}
	if ((procedures ?? []).length > 0) {
		sections.push({
			title: "Procedures",
			summary: `Matched ${formatCount((procedures ?? []).length, "procedure", "procedures")} for ${query}.`,
			evidence: (procedures ?? []).map((doc) => toProcedureEvidence(doc)),
		})
	}

	const partial = [episodes, structured, procedures].some(
		(result) => result === null,
	)
	return {
		title: `${query.trim()} topic brief`,
		summary: `Matched ${formatCount((episodes ?? []).length, "episode", "episodes")}, ${formatCount((structured ?? []).length, "durable record", "durable records")}, and ${formatCount((procedures ?? []).length, "procedure", "procedures")} for ${query}.`,
		sections: capSections(sections, maxItems),
		partial,
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
	const regex = buildQueryRegex(query)
	const scopeFilter = { agentId, scope, scopeRef }
	const resolvedTimeRange = resolveProjectionTimeRange(timeRange)
	const laneQueryLimit = Math.max(maxItems * 3, maxItems)
	const dateFilter = {
		$gte: resolvedTimeRange.start,
		$lte: resolvedTimeRange.end,
	}

	const revisions = await settled("what-changed.structured-revisions", () =>
		structuredMemRevisionsCollection(db, prefix)
			.find({
				...scopeFilter,
				supersededAt: dateFilter,
				...(regex
					? {
							$or: [
								{ key: regex },
								{ value: regex },
								{ context: regex },
								{ tags: regex },
							],
						}
					: {}),
			})
			.sort({ supersededAt: -1 })
			.limit(laneQueryLimit)
			.toArray(),
	)
	const revisionDocs = pickLatestDocuments(revisions ?? [], {
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
		? await settled("what-changed.structured-current", () =>
				structuredMemCollection(db, prefix)
					.find({
						...scopeFilter,
						state: "active",
						$or: revisionFilters,
					})
					.toArray(),
			)
		: []
	const currentStructuredByKey = new Map<string, Document>()
	for (const doc of currentStructured ?? []) {
		currentStructuredByKey.set(
			`${String(doc.type ?? "")}::${String(doc.key ?? "")}`,
			doc,
		)
	}
	const procedures = await settled("what-changed.procedures", () =>
		proceduresCollection(db, prefix)
			.find({
				...scopeFilter,
				updatedAt: dateFilter,
				...(regex
					? {
							$or: [
								{ name: regex },
								{ steps: regex },
								{ intentTags: regex },
								{ searchText: regex },
							],
						}
					: {}),
			})
			.sort({ updatedAt: -1 })
			.limit(laneQueryLimit)
			.toArray(),
	)
	const procedureDocs = pickLatestDocuments(procedures ?? [], {
		identity: (doc) =>
			typeof doc.procedureId === "string" ? doc.procedureId : undefined,
		timestamp: (doc) =>
			doc.updatedAt instanceof Date ? doc.updatedAt : undefined,
	})
	const relations = await settled("what-changed.relations", () =>
		relationsCollection(db, prefix)
			.find({
				...scopeFilter,
				updatedAt: dateFilter,
				...(regex
					? {
							$or: [
								{ fromEntityId: regex },
								{ toEntityId: regex },
								{ type: regex },
							],
						}
					: {}),
			})
			.sort({ updatedAt: -1 })
			.limit(laneQueryLimit)
			.toArray(),
	)
	const relationDocs = pickLatestDocuments(relations ?? [], {
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
	const events = await settled("what-changed.events", () =>
		eventsCollection(db, prefix)
			.find({
				...scopeFilter,
				timestamp: dateFilter,
				...(regex ? { body: regex } : {}),
			})
			.sort({ timestamp: -1 })
			.limit(laneQueryLimit)
			.toArray(),
	)

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
	if ((events ?? []).length > 0) {
		sections.push({
			title: "Recent anchors",
			summary: `Found ${formatCount((events ?? []).length, "recent event", "recent events")} in ${resolvedTimeRange.label}.`,
			evidence: (events ?? []).map((doc) => toEventEvidence(doc)),
		})
	}

	const partial = [
		revisions,
		currentStructured,
		procedures,
		relations,
		events,
	].some((result) => result === null)
	const evidenceSections = capSections(sections, maxItems)
	const evidence = flattenEvidence(evidenceSections)
	return {
		title: query?.trim() ? `What changed for ${query.trim()}` : "What changed",
		summary:
			evidence.length > 0
				? `Found ${formatCount(evidence.length, "change", "changes")} in ${resolvedTimeRange.label}.`
				: `No notable changes found in ${resolvedTimeRange.label}.`,
		sections: evidenceSections,
		partial,
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
	const regex = buildQueryRegex(query)
	const scopeFilter = { agentId, scope, scopeRef }
	const stateFilter = { $in: ["conflicted", "invalidated"] }

	const structured = await settled("contradiction.structured", () =>
		structuredMemCollection(db, prefix)
			.find({
				...scopeFilter,
				state: stateFilter,
				...(regex
					? {
							$or: [
								{ key: regex },
								{ value: regex },
								{ context: regex },
								{ tags: regex },
							],
						}
					: {}),
			})
			.sort({ updatedAt: -1 })
			.limit(maxItems)
			.toArray(),
	)
	const procedures = await settled("contradiction.procedures", () =>
		proceduresCollection(db, prefix)
			.find({
				...scopeFilter,
				state: stateFilter,
				...(regex
					? {
							$or: [
								{ name: regex },
								{ steps: regex },
								{ intentTags: regex },
								{ searchText: regex },
							],
						}
					: {}),
			})
			.sort({ updatedAt: -1 })
			.limit(maxItems)
			.toArray(),
	)
	const relations = await settled("contradiction.relations", () =>
		relationsCollection(db, prefix)
			.find({
				...scopeFilter,
				state: stateFilter,
				...(regex
					? {
							$or: [
								{ fromEntityId: regex },
								{ toEntityId: regex },
								{ type: regex },
							],
						}
					: {}),
			})
			.sort({ updatedAt: -1 })
			.limit(maxItems)
			.toArray(),
	)

	const sections: MemoryDiscoveryProjectionSection[] = []
	if ((structured ?? []).length > 0) {
		sections.push({
			title: "Structured contradictions",
			summary: `Found ${formatCount((structured ?? []).length, "structured contradiction", "structured contradictions")}.`,
			evidence: (structured ?? []).map((doc) => toStructuredEvidence(doc)),
		})
	}
	if ((procedures ?? []).length > 0) {
		sections.push({
			title: "Procedure contradictions",
			summary: `Found ${formatCount((procedures ?? []).length, "procedure contradiction", "procedure contradictions")}.`,
			evidence: (procedures ?? []).map((doc) => toProcedureEvidence(doc)),
		})
	}
	if ((relations ?? []).length > 0) {
		sections.push({
			title: "Relation contradictions",
			summary: `Found ${formatCount((relations ?? []).length, "relation contradiction", "relation contradictions")}.`,
			evidence: (relations ?? []).map((doc) =>
				toRelationEvidence(doc, new Map<string, string>()),
			),
		})
	}

	const partial = [structured, procedures, relations].some(
		(result) => result === null,
	)
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
		partial,
	}
}

function projectionKindRequiresQuery(
	kind: MemoryDiscoveryProjectionKind,
): boolean {
	return kind === "entity-brief" || kind === "topic-brief"
}

export async function buildDiscoveryProjection(params: {
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
					query,
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
					query,
					maxItems,
				})
				break
		}

		const evidence = flattenEvidence(built.sections)
		const metadata = {
			partial: built.partial,
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

		await recordProjectionRun({
			db,
			prefix,
			run: {
				agentId,
				projectionType: kind,
				status: built.partial ? "partial" : "ok",
				itemsProjected: metadata.evidenceCount,
				durationMs: Date.now() - startedAt,
			},
		}).catch(() => {})

		return projection
	} catch (error) {
		await recordProjectionRun({
			db,
			prefix,
			run: {
				agentId,
				projectionType: kind,
				status: "failed",
				itemsProjected: 0,
				durationMs: Date.now() - startedAt,
			},
		}).catch(() => {})
		throw error
	}
}
