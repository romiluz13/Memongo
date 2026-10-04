import { settledFailureMeta } from "./query-diagnostics.js"
import type { Db, Document } from "mongodb"
import { type MemoryScope, createSubsystemLogger } from "@memongo/lib"
import {
	eventsCollection,
	proceduresCollection,
	structuredMemCollection,
} from "./mongodb-schema.js"
import {
	buildCurrentValidityClause,
	buildEventLifecycleClause,
	buildUnexpiredClause,
	mergeQueryClauses,
} from "./mongodb-temporal.js"
import { emitTelemetry, type TelemetryDocument } from "./mongodb-telemetry.js"
import {
	ErasureGateConflictError,
	type AdmissionToken,
} from "./mongodb-write-fence.js"
import type {
	MemoryActiveSlate,
	MemoryActiveSlateItem,
	MemoryActiveSlateKind,
	MemoryBlock,
	MemoryBlockLabel,
	MemoryBlocks,
} from "./types.js"

const log = createSubsystemLogger("memory:mongodb:active-slate")
function emitReadTelemetry(
	db: Db,
	prefix: string,
	doc: Omit<TelemetryDocument, "ts">,
	admission?: AdmissionToken,
): void {
	if (admission) {
		void emitTelemetry(db, prefix, doc, { admission }).catch(() =>
			log.warn("active-slate telemetry emit failed"),
		)
	} else {
		emitTelemetry(db, prefix, doc)
	}
}

const ACTIVE_SLATE_MAX_ITEMS = 6
const ACTIVE_SLATE_DEFAULT_ITEMS = 5

function clampMaxItems(maxItems?: number): number {
	if (!Number.isFinite(maxItems)) {
		return ACTIVE_SLATE_DEFAULT_ITEMS
	}
	return Math.max(
		1,
		Math.min(ACTIVE_SLATE_MAX_ITEMS, Math.floor(maxItems ?? 0)),
	)
}

function getStructuredLocator(doc: Document): string {
	const params = new URLSearchParams()
	if (typeof doc.scope === "string") {
		params.set("scope", doc.scope)
	}
	if (typeof doc.scopeRef === "string") {
		params.set("scopeRef", doc.scopeRef)
	}
	const suffix = params.size > 0 ? `?${params.toString()}` : ""
	return `structured:${String(doc.type ?? "unknown")}:${String(doc.key ?? "")}${suffix}`
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

function summarizeProcedure(doc: Document): string {
	if (Array.isArray(doc.steps)) {
		const steps = doc.steps
			.filter((value): value is string => typeof value === "string")
			.slice(0, 3)
		if (steps.length > 0) {
			return steps.join(" -> ").slice(0, 700)
		}
	}
	if (typeof doc.searchText === "string" && doc.searchText.trim()) {
		return doc.searchText.slice(0, 700)
	}
	return ""
}

function salienceRank(value: unknown): number {
	switch (value) {
		case "critical":
			return 0
		case "high":
			return 1
		case "normal":
			return 2
		case "low":
			return 3
		default:
			return 4
	}
}

function timestampValue(value: unknown): number {
	return value instanceof Date ? value.getTime() : 0
}

function isActiveContextProjection(doc: Document): boolean {
	return (
		(typeof doc.key === "string" && doc.key.startsWith("active-context-")) ||
		(Array.isArray(doc.tags) && doc.tags.includes("active-context"))
	)
}

function sortActiveStructuredDocs(docs: Document[]): Document[] {
	return [...docs].toSorted((left, right) => {
		const salienceDelta =
			salienceRank(left.salience) - salienceRank(right.salience)
		if (salienceDelta !== 0) {
			return salienceDelta
		}
		const activeContextDelta =
			Number(isActiveContextProjection(left)) -
			Number(isActiveContextProjection(right))
		if (activeContextDelta !== 0) {
			return activeContextDelta
		}
		return timestampValue(right.updatedAt) - timestampValue(left.updatedAt)
	})
}

function toStructuredItem(
	doc: Document,
	kind: Extract<
		MemoryActiveSlateKind,
		"active-critical" | "decision" | "current-state"
	>,
): MemoryActiveSlateItem {
	return {
		kind,
		source: "structured",
		title: typeof doc.key === "string" ? doc.key : String(doc.type ?? "memory"),
		summary: typeof doc.value === "string" ? doc.value.slice(0, 700) : "",
		path: getStructuredLocator(doc),
		...(doc.updatedAt instanceof Date ? { timestamp: doc.updatedAt } : {}),
		...(typeof doc.scope === "string"
			? { scope: doc.scope as MemoryScope }
			: {}),
		...(typeof doc.scopeRef === "string" ? { scopeRef: doc.scopeRef } : {}),
		...(typeof doc.state === "string" ? { state: doc.state } : {}),
		...(typeof doc.salience === "string" ? { salience: doc.salience } : {}),
		...(doc.provenance && typeof doc.provenance === "object"
			? { provenance: doc.provenance as Record<string, unknown> }
			: {}),
		...(getSourceEventIds(doc)
			? { sourceEventIds: getSourceEventIds(doc) }
			: {}),
	}
}

function toProcedureItem(doc: Document): MemoryActiveSlateItem {
	return {
		kind: "procedure",
		source: "procedural",
		title:
			typeof doc.name === "string" && doc.name.trim()
				? doc.name
				: String(doc.procedureId ?? "procedure"),
		summary: summarizeProcedure(doc),
		path: `procedure:${String(doc.procedureId ?? "")}`,
		canonicalId: `procedure:${String(doc.procedureId ?? "")}`,
		...(doc.updatedAt instanceof Date ? { timestamp: doc.updatedAt } : {}),
		...(typeof doc.scope === "string"
			? { scope: doc.scope as MemoryScope }
			: {}),
		...(typeof doc.scopeRef === "string" ? { scopeRef: doc.scopeRef } : {}),
		...(typeof doc.state === "string" ? { state: doc.state } : {}),
		...(doc.provenance && typeof doc.provenance === "object"
			? { provenance: doc.provenance as Record<string, unknown> }
			: {}),
		...(getSourceEventIds(doc)
			? { sourceEventIds: getSourceEventIds(doc) }
			: {}),
	}
}

function toAnchorItem(doc: Document): MemoryActiveSlateItem {
	return {
		kind: "recent-anchor",
		source: "conversation",
		title:
			typeof doc.role === "string" && doc.role.trim()
				? `${doc.role} anchor`
				: "recent anchor",
		summary: typeof doc.body === "string" ? doc.body.slice(0, 700) : "",
		path: `events/${String(doc.eventId ?? "")}`,
		canonicalId: `event:${String(doc.eventId ?? "")}`,
		...(doc.timestamp instanceof Date ? { timestamp: doc.timestamp } : {}),
		...(typeof doc.scope === "string"
			? { scope: doc.scope as MemoryScope }
			: {}),
		...(typeof doc.scopeRef === "string" ? { scopeRef: doc.scopeRef } : {}),
		...(typeof doc.eventId === "string"
			? { sourceEventIds: [doc.eventId] }
			: {}),
		provenance: {
			lane: "recent-anchor",
			...(typeof doc.eventId === "string" ? { eventId: doc.eventId } : {}),
		},
	}
}

async function settled<T>(
	label: string,
	fn: () => Promise<T>,
): Promise<T | null> {
	try {
		return await fn()
	} catch (error) {
		log.warn(
			`hydrateActiveSlate: ${label} query failed`,
			settledFailureMeta(error),
		)
		return null
	}
}

export async function hydrateActiveSlate(params: {
	admission?: AdmissionToken
	db: Db
	prefix: string
	agentId: string
	scope: MemoryScope
	scopeRef: string
	maxItems?: number
}): Promise<MemoryActiveSlate> {
	const startedAt = Date.now()
	const { db, prefix, agentId, scope, scopeRef } = params
	if (
		params.admission &&
		(params.admission.kind !== "admission" ||
			params.admission.agentId !== agentId)
	)
		throw new ErasureGateConflictError(agentId)
	const maxItems = clampMaxItems(params.maxItems)
	const sourceLimit = ACTIVE_SLATE_MAX_ITEMS
	const now = new Date()
	const scopeFilter = { agentId, scope, scopeRef }
	// RET-10: search-lane-parity current-validity guard for the structured
	// paths — validFrom <= now or absent AND validTo > now or absent, the
	// same arms searchStructuredMemory's currentOnly translation applies.
	// Replaces the B1 validTo-only inline filter: it missed the not-yet-valid
	// (future validFrom) residual. Composed with the B1 TTL guard via
	// mergeQueryClauses so the spread lands as ONE top-level $and instead of
	// two colliding $and/$or keys.
	const structuredLifecycleFilter = mergeQueryClauses(
		buildCurrentValidityClause({ asOf: now }),
		buildUnexpiredClause({ asOf: now }),
	)
	// RET-10: procedures carry validFrom (insert) / validTo (supersede) and
	// no TTL axis — parity with findExactProcedureMatches / searchProcedures
	// currentOnly translation.
	const procedureLifecycleFilter = buildCurrentValidityClause({ asOf: now })
	// RET-10 (events): the anchors are events — full lifecycle guard
	// (bitemporal validAt/invalidAt incl. the explicit-null open-window
	// branch, plus TTL expiresAt) via buildEventLifecycleClause, matching
	// the events-lane guards.
	const anchorLifecycleFilter = buildEventLifecycleClause({ asOf: now })

	try {
		const [activeCriticalDocs, procedureDocs, durableDocs, anchorDocs] =
			await Promise.all([
				settled("active-critical", () =>
					structuredMemCollection(db, prefix)
						.find({
							...scopeFilter,
							state: "active",
							salience: { $in: ["critical", "high"] },
							type: {
								$in: [
									"todo",
									"fact",
									"project",
									"architecture",
									"custom",
									"decision",
									"preference",
									"identity",
									"instruction",
								],
							},
							...structuredLifecycleFilter,
						})
						.sort({ salience: 1, updatedAt: -1 })
						.limit(sourceLimit)
						.project({
							type: 1,
							key: 1,
							value: 1,
							salience: 1,
							state: 1,
							updatedAt: 1,
							scope: 1,
							scopeRef: 1,
							provenance: 1,
							sourceEventIds: 1,
							tags: 1,
						})
						.toArray(),
				),
				settled("procedures", () =>
					proceduresCollection(db, prefix)
						.find({
							...scopeFilter,
							state: "active",
							...procedureLifecycleFilter,
						})
						.sort({ updatedAt: -1 })
						.limit(sourceLimit)
						.project({
							procedureId: 1,
							name: 1,
							steps: 1,
							searchText: 1,
							state: 1,
							updatedAt: 1,
							scope: 1,
							scopeRef: 1,
							provenance: 1,
							sourceEventIds: 1,
							tags: 1,
						})
						.toArray(),
				),
				settled("durable-structured", () =>
					structuredMemCollection(db, prefix)
						.find({
							...scopeFilter,
							state: "active",
							type: {
								$in: [
									"decision",
									"project",
									"fact",
									"architecture",
									"custom",
									"preference",
									"identity",
									"instruction",
								],
							},
							...structuredLifecycleFilter,
						})
						.sort({ updatedAt: -1 })
						.limit(sourceLimit)
						.project({
							type: 1,
							key: 1,
							value: 1,
							salience: 1,
							state: 1,
							updatedAt: 1,
							scope: 1,
							scopeRef: 1,
							provenance: 1,
							sourceEventIds: 1,
						})
						.toArray(),
				),
				settled("recent-anchors", () =>
					eventsCollection(db, prefix)
						.find({
							...scopeFilter,
							...anchorLifecycleFilter,
						})
						.sort({ timestamp: -1 })
						.limit(sourceLimit)
						.project({
							eventId: 1,
							role: 1,
							body: 1,
							timestamp: 1,
							scope: 1,
							scopeRef: 1,
						})
						.toArray(),
				),
			])

		const items: MemoryActiveSlateItem[] = []
		const seenPaths = new Set<string>()
		const candidateArrays = [
			sortActiveStructuredDocs(activeCriticalDocs ?? []).map((doc) =>
				toStructuredItem(doc, "active-critical"),
			),
			(procedureDocs ?? []).map((doc) => toProcedureItem(doc)),
			(durableDocs ?? []).map((doc) =>
				toStructuredItem(
					doc,
					doc.type === "decision" ? "decision" : "current-state",
				),
			),
			(anchorDocs ?? []).map((doc) => toAnchorItem(doc)),
		]

		for (const group of candidateArrays) {
			for (const item of group) {
				if (items.length >= maxItems) {
					break
				}
				if (seenPaths.has(item.path)) {
					continue
				}
				seenPaths.add(item.path)
				items.push(item)
			}
		}

		const countsByKind = Object.fromEntries(
			items.reduce((counts, item) => {
				counts.set(item.kind, (counts.get(item.kind) ?? 0) + 1)
				return counts
			}, new Map<string, number>()),
		)
		const sourceCounts = Object.fromEntries(
			items.reduce((counts, item) => {
				counts.set(item.source, (counts.get(item.source) ?? 0) + 1)
				return counts
			}, new Map<string, number>()),
		)
		const partial = [
			activeCriticalDocs,
			procedureDocs,
			durableDocs,
			anchorDocs,
		].some((result) => result === null)
		const candidateCount = candidateArrays.reduce(
			(total, group) => total + group.length,
			0,
		)
		const slate: MemoryActiveSlate = {
			agentId,
			scope,
			scopeRef,
			items,
			metadata: {
				maxItems,
				truncated: candidateCount > items.length,
				partial,
				countsByKind,
				sourceCounts,
			},
			hydratedAt: new Date(),
		}

		emitReadTelemetry(
			db,
			prefix,
			{
				meta: {
					agentId,
					operation: "active-slate-hydration",
				},
				durationMs: Date.now() - startedAt,
				ok: true,
				itemCount: items.length,
			},
			params.admission,
		)

		return slate
	} catch (error) {
		emitReadTelemetry(
			db,
			prefix,
			{
				meta: {
					agentId,
					operation: "active-slate-hydration",
				},
				durationMs: Date.now() - startedAt,
				ok: false,
				itemCount: 0,
			},
			params.admission,
		)
		throw error
	}
}

// ---------------------------------------------------------------------------
// Memory Blocks — groups active-slate items into labeled blocks with budgets
// ---------------------------------------------------------------------------

const KIND_TO_LABEL: Record<MemoryActiveSlateKind, MemoryBlockLabel> = {
	"active-critical": "active-risks",
	procedure: "procedure-hints",
	decision: "current-work",
	"current-state": "user-profile",
	"recent-anchor": "recent-context",
}

const DEFAULT_BLOCK_BUDGETS: Record<MemoryBlockLabel, number> = {
	persona: 50,
	"user-profile": 80,
	"current-work": 80,
	"active-risks": 60,
	"procedure-hints": 60,
	"recent-context": 60,
	custom: 60,
}

/** Rough token estimate: ~4 chars per token. */
function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4)
}

function itemTokens(item: MemoryActiveSlateItem): number {
	return estimateTokens(item.title) + estimateTokens(item.summary)
}

/**
 * Group active-slate items into labeled memory blocks with token budgets.
 * Non-breaking: consumes the existing `MemoryActiveSlate` output.
 */
export function materializeBlocks(
	slate: MemoryActiveSlate,
	budgetOverrides?: Partial<Record<MemoryBlockLabel, number>>,
): MemoryBlocks {
	const grouped = new Map<MemoryBlockLabel, MemoryActiveSlateItem[]>()

	for (const item of slate.items) {
		const label = KIND_TO_LABEL[item.kind] ?? "custom"
		const list = grouped.get(label)
		if (list) {
			list.push(item)
		} else {
			grouped.set(label, [item])
		}
	}

	const blocks: MemoryBlock[] = []
	let totalBudget = 0
	let totalActual = 0

	for (const [label, items] of grouped) {
		const budget =
			budgetOverrides?.[label] ?? DEFAULT_BLOCK_BUDGETS[label] ?? 60
		const actual = items.reduce((sum, it) => sum + itemTokens(it), 0)
		blocks.push({ label, tokenBudget: budget, items, actualTokens: actual })
		totalBudget += budget
		totalActual += actual
	}

	return {
		blocks,
		totalTokenBudget: totalBudget,
		totalActualTokens: totalActual,
	}
}
