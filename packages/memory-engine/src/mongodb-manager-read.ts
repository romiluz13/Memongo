import { findRelationByLocatorId } from "./mongodb-graph.js"
import type { MongoDBManagerHost } from "./mongodb-manager-host.js"
import {
	chunksCollection,
	entitiesCollection,
	episodesCollection,
	eventsCollection,
	kbCollection,
	proceduresCollection,
	structuredMemCollection,
} from "./mongodb-schema.js"
import type { MemoryScope } from "@memongo/lib"
import type { Document } from "mongodb"
import { buildUnexpiredClause } from "./mongodb-temporal.js"

/**
 * Read seam extracted from `mongodb-manager.ts` (P4.3): locator-based reads
 * (structured/entity/procedure/event/episode/relation/kb/conversation/bridge)
 * behind the `MongoDBManagerReadOps` collaborator the facade delegates to.
 */

/** Result shape shared by every locator read path. */
export type ManagerReadResult = {
	text: string
	path: string
	locator: string
	source: "structured" | "conversation" | "reference"
	sourceType: "structured" | "conversation" | "reference"
	type?: string
	key?: string
	title?: string | undefined
}

export class MongoDBManagerReadOps {
	constructor(private readonly host: MongoDBManagerHost) {}

	async readFile(params: {
		relPath: string
		from?: number
		lines?: number
	}): Promise<ManagerReadResult> {
		const rawPath = params.relPath.trim()
		if (!rawPath) {
			throw new Error("path required")
		}

		if (rawPath.startsWith("structured:")) {
			const [basePath, queryString] = rawPath.split("?", 2)
			const [, type, ...keyParts] = basePath.split(":")
			const key = keyParts.join(":").trim()
			if (!type || !key) {
				throw new Error("path required")
			}
			const query = new URLSearchParams(queryString ?? "")
			const scope = query.get("scope")
			const scopeRef = query.get("scopeRef")
			const record = await structuredMemCollection(
				this.host.db,
				this.host.prefix,
			).findOne({
				agentId: this.host.agentId,
				type,
				key,
				...(scope ? { scope } : {}),
				...(scopeRef ? { scopeRef } : {}),
				// P4.4.1 (B1): an expired record reads as gone even before the
				// TTL sweep removes it.
				...buildUnexpiredClause(),
			})
			if (!record) {
				return {
					text: "",
					path: rawPath,
					locator: rawPath,
					source: "structured" as const,
					sourceType: "structured" as const,
				}
			}
			await structuredMemCollection(this.host.db, this.host.prefix).updateOne(
				{ _id: record._id },
				{
					$set: { openedAt: new Date() },
					$inc: { openedCount: 1 },
				},
			)
			const text = [
				`type: ${String(record.type ?? type)}`,
				`key: ${String(record.key ?? key)}`,
				`value: ${String(record.value ?? "")}`,
				typeof record.revision === "number"
					? `revision: ${record.revision}`
					: null,
				typeof record.state === "string" ? `state: ${record.state}` : null,
				typeof record.salience === "string"
					? `salience: ${record.salience}`
					: null,
				typeof record.temporalScope === "string"
					? `temporalScope: ${record.temporalScope}`
					: null,
				record.validFrom instanceof Date
					? `validFrom: ${record.validFrom.toISOString()}`
					: null,
				record.validTo instanceof Date
					? `validTo: ${record.validTo.toISOString()}`
					: null,
				record.reviewAt instanceof Date
					? `reviewAt: ${record.reviewAt.toISOString()}`
					: null,
				record.lastConfirmedAt instanceof Date
					? `lastConfirmedAt: ${record.lastConfirmedAt.toISOString()}`
					: null,
				typeof record.reinforcementCount === "number"
					? `reinforcementCount: ${record.reinforcementCount}`
					: null,
				typeof record.sourceReliability === "number"
					? `sourceReliability: ${record.sourceReliability}`
					: null,
				typeof record.context === "string"
					? `context: ${record.context}`
					: null,
				Array.isArray(record.tags) && record.tags.length > 0
					? `tags: ${record.tags.join(", ")}`
					: null,
				Array.isArray(record.sourceEventIds) && record.sourceEventIds.length > 0
					? `sourceEventIds: ${record.sourceEventIds.join(", ")}`
					: null,
				record.provenance && typeof record.provenance === "object"
					? `provenance: ${JSON.stringify(record.provenance)}`
					: null,
				record.supersedes && typeof record.supersedes === "object"
					? `supersedes: ${JSON.stringify(record.supersedes)}`
					: null,
				record.invalidatedBy && typeof record.invalidatedBy === "object"
					? `invalidatedBy: ${JSON.stringify(record.invalidatedBy)}`
					: null,
				Array.isArray(record.conflictsWith) && record.conflictsWith.length > 0
					? `conflictsWith: ${JSON.stringify(record.conflictsWith)}`
					: null,
			]
				.filter(Boolean)
				.join("\n")
			return {
				text,
				path: rawPath,
				locator: rawPath,
				source: "structured" as const,
				sourceType: "structured" as const,
				type,
				key,
			}
		}

		if (rawPath.startsWith("entity:")) {
			const [basePath, queryString] = rawPath.split("?", 2)
			const entityId = basePath.slice("entity:".length).trim()
			if (!entityId) {
				throw new Error("path required")
			}
			const query = new URLSearchParams(queryString ?? "")
			const scope = query.get("scope")
			const scopeRef = query.get("scopeRef")
			const record = await entitiesCollection(
				this.host.db,
				this.host.prefix,
			).findOne({
				agentId: this.host.agentId,
				entityId,
				...(scope ? { scope } : {}),
				...(scopeRef ? { scopeRef } : {}),
			})
			if (!record) {
				return {
					text: "",
					path: rawPath,
					locator: rawPath,
					source: "conversation" as const,
					sourceType: "conversation" as const,
				}
			}
			const text = [
				`entityId: ${String(record.entityId ?? entityId)}`,
				`name: ${String(record.name ?? "")}`,
				typeof record.type === "string" ? `type: ${record.type}` : null,
				Array.isArray(record.aliases) && record.aliases.length > 0
					? `aliases: ${record.aliases.join(", ")}`
					: null,
				Array.isArray(record.sourceEventIds) && record.sourceEventIds.length > 0
					? `sourceEventIds: ${record.sourceEventIds.join(", ")}`
					: null,
				record.metadata && typeof record.metadata === "object"
					? `metadata: ${JSON.stringify(record.metadata)}`
					: null,
				record.updatedAt instanceof Date
					? `updatedAt: ${record.updatedAt.toISOString()}`
					: null,
			]
				.filter(Boolean)
				.join("\n")
			return {
				text,
				path: rawPath,
				locator: rawPath,
				source: "conversation" as const,
				sourceType: "conversation" as const,
			}
		}

		if (rawPath.startsWith("procedure:")) {
			const [basePath, queryString] = rawPath.split("?", 2)
			const procedureId = basePath.slice("procedure:".length).trim()
			if (!procedureId) {
				throw new Error("path required")
			}
			const query = new URLSearchParams(queryString ?? "")
			const scope = query.get("scope")
			const scopeRef = query.get("scopeRef")
			const record = await proceduresCollection(
				this.host.db,
				this.host.prefix,
			).findOne({
				agentId: this.host.agentId,
				procedureId,
				...(scope ? { scope } : {}),
				...(scopeRef ? { scopeRef } : {}),
			})
			if (!record) {
				return {
					text: "",
					path: rawPath,
					locator: rawPath,
					source: "structured" as const,
					sourceType: "structured" as const,
				}
			}
			await proceduresCollection(this.host.db, this.host.prefix).updateOne(
				{ _id: record._id },
				{
					$set: { openedAt: new Date() },
					$inc: { openedCount: 1 },
				},
			)
			const text = [
				`procedureId: ${String(record.procedureId ?? procedureId)}`,
				`name: ${String(record.name ?? "")}`,
				Array.isArray(record.intentTags) && record.intentTags.length > 0
					? `intentTags: ${record.intentTags.join(", ")}`
					: null,
				Array.isArray(record.triggerQueries) && record.triggerQueries.length > 0
					? `triggerQueries: ${record.triggerQueries.join(" | ")}`
					: null,
				Array.isArray(record.steps) && record.steps.length > 0
					? `steps:\n${record.steps.map((step: unknown, index: number) => `${index + 1}. ${String(step)}`).join("\n")}`
					: null,
				Array.isArray(record.successSignals) && record.successSignals.length > 0
					? `successSignals: ${record.successSignals.join(", ")}`
					: null,
				typeof record.state === "string" ? `state: ${record.state}` : null,
				typeof record.confidence === "number"
					? `confidence: ${record.confidence}`
					: null,
				typeof record.revision === "number"
					? `revision: ${record.revision}`
					: null,
				Array.isArray(record.sourceEventIds) && record.sourceEventIds.length > 0
					? `sourceEventIds: ${record.sourceEventIds.join(", ")}`
					: null,
				record.provenance && typeof record.provenance === "object"
					? `provenance: ${JSON.stringify(record.provenance)}`
					: null,
			]
				.filter(Boolean)
				.join("\n")
			return {
				text,
				path: rawPath,
				locator: rawPath,
				source: "structured" as const,
				sourceType: "structured" as const,
			}
		}

		if (rawPath.startsWith("event:")) {
			const eventId = rawPath.slice("event:".length).trim()
			if (!eventId) {
				throw new Error("path required")
			}
			return await this.host.readCanonicalEvent(eventId, rawPath)
		}

		if (rawPath.startsWith("episode:")) {
			const [basePath, queryString] = rawPath.split("?", 2)
			const episodeId = basePath.slice("episode:".length).trim()
			if (!episodeId) {
				throw new Error("path required")
			}
			const query = new URLSearchParams(queryString ?? "")
			const expand = query.get("expand")?.trim().toLowerCase()
			return await this.host.readEpisodeLocator({
				rawPath,
				episodeId,
				expandEvents: expand === "events" || expand === "full",
			})
		}

		if (rawPath.startsWith("relation:")) {
			const [basePath, queryString] = rawPath.split("?", 2)
			const relationId = basePath.slice("relation:".length).trim()
			if (!relationId) {
				throw new Error("path required")
			}
			const query = new URLSearchParams(queryString ?? "")
			const scope = (query.get("scope") ?? "agent") as MemoryScope
			const scopeRef = query.get("scopeRef") ?? this.host.agentScopeRef
			// P3.8: one findOne on the relationId index — the old path fetched up
			// to 50 relations per read and JS-matched the pair.
			const relation = await findRelationByLocatorId({
				db: this.host.db,
				prefix: this.host.prefix,
				agentId: this.host.agentId,
				scope,
				scopeRef,
				relationId,
			})
			if (!relation) {
				return {
					text: "",
					path: rawPath,
					locator: rawPath,
					source: "conversation" as const,
					sourceType: "conversation" as const,
				}
			}
			const text = [
				`type: ${String(relation.type ?? "")}`,
				`fromEntityId: ${String(relation.fromEntityId ?? "")}`,
				`toEntityId: ${String(relation.toEntityId ?? "")}`,
				typeof relation.state === "string" ? `state: ${relation.state}` : null,
				typeof relation.weight === "number"
					? `weight: ${relation.weight}`
					: null,
				typeof relation.confidence === "number"
					? `confidence: ${relation.confidence}`
					: null,
				relation.validFrom instanceof Date
					? `validFrom: ${relation.validFrom.toISOString()}`
					: null,
				relation.validTo instanceof Date
					? `validTo: ${relation.validTo.toISOString()}`
					: null,
				relation.reviewAt instanceof Date
					? `reviewAt: ${relation.reviewAt.toISOString()}`
					: null,
				relation.lastConfirmedAt instanceof Date
					? `lastConfirmedAt: ${relation.lastConfirmedAt.toISOString()}`
					: null,
				typeof relation.reinforcementCount === "number"
					? `reinforcementCount: ${relation.reinforcementCount}`
					: null,
				typeof relation.sourceReliability === "number"
					? `sourceReliability: ${relation.sourceReliability}`
					: null,
				Array.isArray(relation.sourceEventIds) &&
				relation.sourceEventIds.length > 0
					? `sourceEventIds: ${relation.sourceEventIds.join(", ")}`
					: null,
				relation.provenance && typeof relation.provenance === "object"
					? `provenance: ${JSON.stringify(relation.provenance)}`
					: null,
				relation.supersedes && typeof relation.supersedes === "object"
					? `supersedes: ${JSON.stringify(relation.supersedes)}`
					: null,
				relation.invalidatedBy && typeof relation.invalidatedBy === "object"
					? `invalidatedBy: ${JSON.stringify(relation.invalidatedBy)}`
					: null,
				relation.updatedAt instanceof Date
					? `updatedAt: ${relation.updatedAt.toISOString()}`
					: null,
			]
				.filter(Boolean)
				.join("\n")
			return {
				text,
				path: rawPath,
				locator: rawPath,
				source: "conversation" as const,
				sourceType: "conversation" as const,
			}
		}

		if (rawPath.startsWith("kb:") || rawPath.startsWith("reference:")) {
			const kbPath = rawPath.replace(/^kb:|^reference:/, "").trim()
			if (!kbPath) {
				throw new Error("path required")
			}
			const record = await kbCollection(this.host.db, this.host.prefix).findOne(
				{
					$or: [{ "source.path": kbPath }, { title: kbPath }],
				},
				{ sort: { updatedAt: -1, _id: 1 } },
			)
			if (!record) {
				return {
					text: "",
					path: rawPath,
					locator: rawPath,
					source: "reference" as const,
					sourceType: "reference" as const,
				}
			}
			return {
				text: typeof record.content === "string" ? record.content : "",
				path: rawPath,
				locator: rawPath,
				source: "reference" as const,
				sourceType: "reference" as const,
				title: typeof record.title === "string" ? record.title : undefined,
			}
		}

		if (
			rawPath.startsWith("conversation:") ||
			rawPath.startsWith("events/") ||
			rawPath.startsWith("sessions/")
		) {
			return await this.host.readConversationChunk(
				rawPath,
				params.from,
				params.lines,
			)
		}

		return await this.host.readBridgeChunk(rawPath, params.from, params.lines)
	}

	async readConversationChunk(
		rawPath: string,
		from?: number,
		lines?: number,
	): Promise<ManagerReadResult> {
		const normalizedPath = rawPath.startsWith("conversation:")
			? rawPath.slice("conversation:".length).trim()
			: rawPath
		if (!normalizedPath) {
			throw new Error("path required")
		}
		const start = Math.max(1, from ?? 1)
		const count = Math.max(1, lines ?? Number.MAX_SAFE_INTEGER)
		const end = start + count - 1
		const docs = await chunksCollection(this.host.db, this.host.prefix)
			.find({
				path: normalizedPath,
				source: { $in: ["sessions", "conversation"] },
				agentId: this.host.agentId,
				...(from || lines
					? {
							$or: [
								{ startLine: { $gte: start, $lte: end } },
								{ endLine: { $gte: start, $lte: end } },
								{ startLine: { $lte: start }, endLine: { $gte: end } },
							],
						}
					: {}),
			})
			// oxlint-disable-next-line unicorn/no-array-sort -- MongoDB cursor .sort(), not Array
			.sort({ startLine: 1 })
			.toArray()
		if (docs.length === 0) {
			if (normalizedPath.startsWith("events/")) {
				const eventId = normalizedPath.slice("events/".length).trim()
				if (eventId) {
					return await this.host.readCanonicalEvent(
						eventId,
						`conversation:${normalizedPath}`,
					)
				}
			}
			return {
				text: "",
				path: `conversation:${normalizedPath}`,
				locator: `conversation:${normalizedPath}`,
				source: "conversation" as const,
				sourceType: "conversation" as const,
			}
		}
		return {
			text: docs
				.map((doc: Document) => (typeof doc.text === "string" ? doc.text : ""))
				.filter(Boolean)
				.join("\n"),
			path: `conversation:${normalizedPath}`,
			locator: `conversation:${normalizedPath}`,
			source: "conversation" as const,
			sourceType: "conversation" as const,
		}
	}

	async readCanonicalEvent(
		eventId: string,
		rawPath: string,
	): Promise<ManagerReadResult> {
		const event = await eventsCollection(
			this.host.db,
			this.host.prefix,
		).findOne({
			agentId: this.host.agentId,
			eventId,
			...buildUnexpiredClause(),
		})
		if (!event) {
			return {
				text: "",
				path: rawPath,
				locator: rawPath,
				source: "conversation" as const,
				sourceType: "conversation" as const,
			}
		}
		const role = typeof event.role === "string" ? event.role : "unknown-role"
		const body = typeof event.body === "string" ? event.body : ""
		const timestamp =
			event.timestamp instanceof Date
				? `timestamp: ${event.timestamp.toISOString()}\n`
				: ""
		return {
			text: `${timestamp}${role}: ${body}`.trim(),
			path: rawPath,
			locator: rawPath,
			source: "conversation" as const,
			sourceType: "conversation" as const,
			type: "event",
			key: eventId,
		}
	}

	async readBridgeChunk(
		rawPath: string,
		from?: number,
		lines?: number,
	): Promise<ManagerReadResult> {
		const start = Math.max(1, from ?? 1)
		const count = Math.max(1, lines ?? Number.MAX_SAFE_INTEGER)
		const end = start + count - 1
		const docs = await chunksCollection(this.host.db, this.host.prefix)
			.find({
				path: rawPath,
				source: { $in: ["conversation", "memory"] },
				agentId: this.host.agentId,
				scope: "workspace",
				scopeRef: this.host.workspaceScopeRef,
				...(from || lines
					? {
							$or: [
								{ startLine: { $gte: start, $lte: end } },
								{ endLine: { $gte: start, $lte: end } },
								{ startLine: { $lte: start }, endLine: { $gte: end } },
							],
						}
					: {}),
			})
			// oxlint-disable-next-line unicorn/no-array-sort -- MongoDB cursor .sort(), not Array
			.sort({ startLine: 1 })
			.toArray()
		if (docs.length === 0) {
			return {
				text: "",
				path: rawPath,
				locator: rawPath,
				source: "reference" as const,
				sourceType: "reference" as const,
			}
		}
		return {
			text: docs
				.map((doc: Document) => (typeof doc.text === "string" ? doc.text : ""))
				.filter(Boolean)
				.join("\n"),
			path: rawPath,
			locator: rawPath,
			source: "reference" as const,
			sourceType: "reference" as const,
		}
	}

	async readEpisodeLocator(params: {
		rawPath: string
		episodeId: string
		expandEvents: boolean
	}): Promise<ManagerReadResult> {
		const { rawPath, episodeId, expandEvents } = params
		const episode = await episodesCollection(
			this.host.db,
			this.host.prefix,
		).findOne({
			agentId: this.host.agentId,
			episodeId,
			status: { $ne: "deleted" },
		})
		if (!episode) {
			return {
				text: "",
				path: rawPath,
				locator: rawPath,
				source: "conversation" as const,
				sourceType: "conversation" as const,
			}
		}

		const sourceEventIds = Array.isArray(episode.sourceEventIds)
			? episode.sourceEventIds.filter(
					(value): value is string => typeof value === "string",
				)
			: Array.isArray(episode.eventIds)
				? episode.eventIds.filter(
						(value): value is string => typeof value === "string",
					)
				: []

		const lines = [
			`type: episode`,
			`episodeId: ${episodeId}`,
			typeof episode.type === "string" ? `episodeType: ${episode.type}` : null,
			typeof episode.title === "string" ? `title: ${episode.title}` : null,
			typeof episode.summary === "string"
				? `summary: ${episode.summary}`
				: null,
			episode.timeRange?.start instanceof Date
				? `timeRangeStart: ${episode.timeRange.start.toISOString()}`
				: null,
			episode.timeRange?.end instanceof Date
				? `timeRangeEnd: ${episode.timeRange.end.toISOString()}`
				: null,
			typeof episode.sourceEventCount === "number"
				? `sourceEventCount: ${episode.sourceEventCount}`
				: `sourceEventCount: ${sourceEventIds.length}`,
			sourceEventIds.length > 0 && !expandEvents
				? `expandLocator: episode:${episodeId}?expand=events`
				: null,
		].filter(Boolean)

		if (expandEvents && sourceEventIds.length > 0) {
			const events = await eventsCollection(this.host.db, this.host.prefix)
				.find({
					agentId: this.host.agentId,
					eventId: { $in: sourceEventIds },
					...buildUnexpiredClause(),
				})
				.toArray()
			const eventOrder = new Map(
				sourceEventIds.map((value, index) => [value, index]),
			)
			events.sort((a, b) => {
				const left =
					eventOrder.get(String(a.eventId)) ?? Number.MAX_SAFE_INTEGER
				const right =
					eventOrder.get(String(b.eventId)) ?? Number.MAX_SAFE_INTEGER
				return left - right
			})

			if (events.length > 0) {
				lines.push("sourceEvents:")
				for (const event of events) {
					const timestamp =
						event.timestamp instanceof Date
							? event.timestamp.toISOString()
							: "unknown-time"
					const role =
						typeof event.role === "string" ? event.role : "unknown-role"
					const body = typeof event.body === "string" ? event.body : ""
					lines.push(`[${timestamp}] ${role}: ${body}`)
				}
			}
		}

		return {
			text: lines.join("\n"),
			path: rawPath,
			locator: rawPath,
			source: "conversation" as const,
			sourceType: "conversation" as const,
			title: typeof episode.title === "string" ? episode.title : undefined,
			type: "episode",
			key: episodeId,
		}
	}
}
