import { Hono } from "hono"
import {
	memongoBridgeAdd,
	memongoBridgeAccessSummaries,
	memongoBridgeBuildContextBundle,
	memongoBridgeBuildDiscoveryProjection,
	memongoBridgeBenchmarkIngest,
	memongoBridgeImportConversations,
	memongoBridgeAccessTrends,
	memongoBridgeGetDetailedStatus,
	memongoBridgeGetMemoryJob,
	memongoBridgeGetRecallTrace,
	memongoBridgeHydrateActiveSlate,
	memongoBridgeListMemoryJobs,
	memongoBridgeListRecallTraces,
	memongoBridgeProbeEmbedding,
	memongoBridgeProbeVector,
	memongoBridgeProfile,
	memongoBridgeRecallConversation,
	memongoBridgeReadFile,
	memongoBridgeRelevanceBenchmark,
	memongoBridgeRelevanceExplain,
	memongoBridgeRelevanceReport,
	memongoBridgeRelevanceSampleRate,
	memongoBridgeTraceChain,
	memongoBridgeScanNovelty,
	memongoBridgeConsolidate,
	memongoBridgeApplyMemoryFeedback,
	memongoBridgeDeleteLifecycleItem,
	memongoBridgeExtractEvent,
	memongoBridgeGetLifecycleHistory,
	memongoBridgeGetLifecycleItem,
	memongoBridgeSelfEdit,
	memongoBridgeGetState,
	memongoBridgeSearch,
	memongoBridgeSearchDetailed,
	memongoBridgeSearchKB,
	memongoBridgeStats,
	memongoBridgeStatus,
	memongoBridgeSync,
	memongoBridgeUpdateLifecycleItem,
	memongoBridgeReportProcedureOutcome,
	memongoBridgeWriteConversationEvent,
	memongoBridgeWriteProcedure,
	memongoBridgeWriteStructuredMemory,
	type MemoryStableHandle,
	type ProcedureEntry,
	type StructuredMemoryEntry,
} from "@memongo/memory-bridge"
import { jsonError } from "../lib/errors.js"

const MAX_LIST_LIMIT = 100
const MAX_HISTORY_LIMIT = 200
const VALID_SCOPE_VALUES = [
	"session",
	"user",
	"agent",
	"workspace",
	"tenant",
	"global",
] as const
type ApiScope = (typeof VALID_SCOPE_VALUES)[number]

function readAgentId(body: Record<string, unknown>): string | undefined {
	return typeof body.agentId === "string" ? body.agentId : undefined
}

function parseListLimit(raw?: string): number | undefined {
	if (raw === undefined) {
		return undefined
	}
	const parsed = Number(raw)
	if (!Number.isFinite(parsed)) {
		return undefined
	}
	return Math.max(1, Math.min(MAX_LIST_LIMIT, Math.floor(parsed)))
}

function readContainerTag(body: Record<string, unknown>): string | undefined {
	return typeof body.containerTag === "string" && body.containerTag.trim()
		? body.containerTag
		: undefined
}

function readQuery(body: Record<string, unknown>): string {
	if (typeof body.query === "string") {
		return body.query
	}
	if (typeof body.q === "string") {
		return body.q
	}
	return ""
}

function readLimit(body: Record<string, unknown>): number | undefined {
	if (typeof body.limit === "number") {
		return body.limit
	}
	return typeof body.maxResults === "number" ? body.maxResults : undefined
}

function readSessionId(body: Record<string, unknown>): string | undefined {
	if (typeof body.sessionId === "string" && body.sessionId.trim()) {
		return body.sessionId
	}
	return readContainerTag(body)
}

function readSessionKey(body: Record<string, unknown>): string | undefined {
	if (typeof body.sessionKey === "string" && body.sessionKey.trim()) {
		return body.sessionKey
	}
	return readContainerTag(body)
}

function readScopeRef(body: Record<string, unknown>): string | undefined {
	if (typeof body.scopeRef === "string" && body.scopeRef.trim()) {
		return body.scopeRef
	}
	return readContainerTag(body)
}

function readScope(body: Record<string, unknown>): ApiScope | undefined {
	const scope = typeof body.scope === "string" ? body.scope : undefined
	if (VALID_SCOPE_VALUES.includes(scope as ApiScope)) {
		return scope as ApiScope
	}
	return undefined
}

function readScopeInputError(body: Record<string, unknown>): string | null {
	if (
		body.scope !== undefined &&
		(typeof body.scope !== "string" || !readScope(body))
	) {
		return "scope must be session|user|agent|workspace|tenant|global"
	}
	if (
		body.scopeRef !== undefined &&
		(typeof body.scopeRef !== "string" || !body.scopeRef.trim())
	) {
		return "scopeRef must be a non-empty string"
	}
	const scope = readScope(body)
	if (
		scope === "session" &&
		!readScopeRef(body) &&
		!readSessionId(body) &&
		!readSessionKey(body)
	) {
		return "session scope requires sessionId, sessionKey, scopeRef, or containerTag"
	}
	if ((scope === "user" || scope === "tenant") && !readScopeRef(body)) {
		return `${scope} scope requires scopeRef`
	}
	return null
}

function readAccessCollection(
	raw: string | undefined,
):
	| "events"
	| "structured_mem"
	| "procedures"
	| "episodes"
	| "entities"
	| "relations"
	| undefined {
	if (
		raw === "events" ||
		raw === "structured_mem" ||
		raw === "procedures" ||
		raw === "episodes" ||
		raw === "entities" ||
		raw === "relations"
	) {
		return raw
	}
	return undefined
}

/**
 * Task 1.A — parse optional embeddingConfig from benchmark request body.
 * Returns the validated config or undefined if absent/malformed. All fields
 * must be present to accept it.
 */
function parseEmbeddingConfig(raw: unknown):
	| {
			model: string
			dimensions: number
			quantization: "float32" | "int8" | "binary"
	  }
	| undefined {
	if (!raw || typeof raw !== "object") return undefined
	const r = raw as Record<string, unknown>
	const model = typeof r.model === "string" ? r.model : undefined
	const dimensions =
		typeof r.dimensions === "number" && r.dimensions > 0
			? Math.floor(r.dimensions)
			: undefined
	const quantization =
		r.quantization === "float32" ||
		r.quantization === "int8" ||
		r.quantization === "binary"
			? r.quantization
			: undefined
	if (!model || !dimensions || !quantization) return undefined
	return { model, dimensions, quantization }
}

/**
 * Task 1.A — parse optional rerankerConfig from benchmark request body.
 * `version` is null-able (Voyage SDK does not always expose version).
 */
function parseRerankerConfig(raw: unknown):
	| {
			model: string
			version: string | null
			stage: "post-fusion" | "pre-fusion" | "none"
	  }
	| undefined {
	if (!raw || typeof raw !== "object") return undefined
	const r = raw as Record<string, unknown>
	const model = typeof r.model === "string" ? r.model : undefined
	const version =
		typeof r.version === "string"
			? r.version
			: r.version === null
				? null
				: undefined
	const stage =
		r.stage === "post-fusion" || r.stage === "pre-fusion" || r.stage === "none"
			? r.stage
			: undefined
	if (!model || version === undefined || !stage) return undefined
	return { model, version, stage }
}

function parseBenchmarkRetrievalLane(
	raw: unknown,
): "native" | "raw-session" | undefined {
	if (typeof raw !== "string") return undefined
	const normalized = raw.trim().toLowerCase().replace(/_/g, "-")
	if (normalized === "native") return "native"
	if (normalized === "raw-session" || normalized === "session") {
		return "raw-session"
	}
	return undefined
}

function readDiscoveryProjectionKind(
	body: Record<string, unknown>,
):
	| "entity-brief"
	| "topic-brief"
	| "what-changed"
	| "contradiction-report"
	| undefined {
	const kind = typeof body.kind === "string" ? body.kind : undefined
	if (
		kind === "entity-brief" ||
		kind === "topic-brief" ||
		kind === "what-changed" ||
		kind === "contradiction-report"
	) {
		return kind
	}
	return undefined
}

function readConversationRoles(
	body: Record<string, unknown>,
): Array<"user" | "assistant" | "system" | "tool"> | undefined | null {
	if (!Array.isArray(body.roles)) {
		return undefined
	}
	const roles = body.roles.filter(
		(role): role is "user" | "assistant" | "system" | "tool" =>
			role === "user" ||
			role === "assistant" ||
			role === "system" ||
			role === "tool",
	)
	return roles.length === body.roles.length ? roles : null
}

function isRecallConversationValidationError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error)
	return (
		message.includes("invalid timestamp") ||
		message.includes("invalid date boundary") ||
		message.includes("Invalid time zone specified") ||
		message.includes("roles must contain only")
	)
}

type LifecycleSourceAgent = {
	id: string
	name: string
	runId?: string
}

type StructuredLifecyclePatchBody = {
	value?: string
	context?: string
	confidence?: number
	source?: StructuredMemoryEntry["source"]
	sessionId?: string
	tags?: string[]
	salience?: StructuredMemoryEntry["salience"]
	temporalScope?: StructuredMemoryEntry["temporalScope"]
	provenance?: Record<string, unknown>
	sourceEventIds?: string[]
	validTo?: Date
	reviewAt?: Date
	lastConfirmedAt?: Date
	sourceReliability?: number
	sourceAgent?: LifecycleSourceAgent
	artifact?: StructuredMemoryEntry["artifact"]
}

type ProcedureLifecyclePatchBody = {
	name?: string
	intentTags?: string[]
	triggerQueries?: string[]
	steps?: string[]
	successSignals?: string[]
	confidence?: number
	provenance?: Record<string, unknown>
	sourceEventIds?: string[]
	sourceAgent?: LifecycleSourceAgent
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

function readStringArray(raw: unknown): string[] | null | undefined {
	if (raw === undefined) {
		return undefined
	}
	if (!Array.isArray(raw)) {
		return null
	}
	if (!raw.every((value) => typeof value === "string")) {
		return null
	}
	return raw
}

function readDateValue(raw: unknown): Date | null | undefined {
	if (raw === undefined) {
		return undefined
	}
	if (typeof raw !== "string" || !raw.trim()) {
		return null
	}
	const parsed = new Date(raw)
	return Number.isNaN(parsed.getTime()) ? null : parsed
}

function readSourceAgentValue(
	raw: unknown,
): LifecycleSourceAgent | null | undefined {
	if (raw === undefined) {
		return undefined
	}
	if (!isRecord(raw)) {
		return null
	}
	const id = typeof raw.id === "string" ? raw.id.trim() : ""
	const name = typeof raw.name === "string" ? raw.name.trim() : ""
	if (!id || !name) {
		return null
	}
	const runId =
		typeof raw.runId === "string" && raw.runId.trim() ? raw.runId : undefined
	return { id, name, ...(runId ? { runId } : {}) }
}

function readActorRole(
	raw: unknown,
): "user" | "assistant" | "system" | null | undefined {
	if (raw === undefined) {
		return undefined
	}
	return raw === "user" || raw === "assistant" || raw === "system" ? raw : null
}

function readLifecycleState(
	raw: unknown,
): "active" | "invalidated" | "conflicted" | undefined {
	return raw === "active" || raw === "invalidated" || raw === "conflicted"
		? raw
		: undefined
}

function readLifecycleHandle(raw: unknown): MemoryStableHandle | null {
	if (!isRecord(raw)) {
		return null
	}
	const family = raw.family
	if (family !== "structured" && family !== "procedure") {
		return null
	}
	const id = typeof raw.id === "string" ? raw.id.trim() : ""
	const agentId = typeof raw.agentId === "string" ? raw.agentId.trim() : ""
	const scope = readScope(raw)
	const scopeRef = typeof raw.scopeRef === "string" ? raw.scopeRef.trim() : ""
	const revision =
		typeof raw.revision === "number" && Number.isInteger(raw.revision)
			? raw.revision
			: Number.NaN
	const state = readLifecycleState(raw.state)
	if (!id || !agentId || !scope || !scopeRef || revision < 1 || !state) {
		return null
	}
	const validFrom = readDateValue(raw.validFrom)
	const validTo = readDateValue(raw.validTo)
	const updatedAt = readDateValue(raw.updatedAt)
	if (validFrom === null || validTo === null || updatedAt === null) {
		return null
	}
	if (family === "structured") {
		if (!isRecord(raw.structured)) {
			return null
		}
		const type =
			typeof raw.structured.type === "string" ? raw.structured.type.trim() : ""
		const key =
			typeof raw.structured.key === "string" ? raw.structured.key.trim() : ""
		if (!type || !key) {
			return null
		}
		return {
			family,
			id,
			agentId,
			scope,
			scopeRef,
			revision,
			state,
			structured: { type, key },
			...(validFrom ? { validFrom } : {}),
			...(validTo ? { validTo } : {}),
			...(updatedAt ? { updatedAt } : {}),
		}
	}
	if (!isRecord(raw.procedure)) {
		return null
	}
	const procedureId =
		typeof raw.procedure.procedureId === "string"
			? raw.procedure.procedureId.trim()
			: ""
	if (!procedureId) {
		return null
	}
	return {
		family,
		id,
		agentId,
		scope,
		scopeRef,
		revision,
		state,
		procedure: { procedureId },
		...(validFrom ? { validFrom } : {}),
		...(validTo ? { validTo } : {}),
		...(updatedAt ? { updatedAt } : {}),
	}
}

function readStructuredLifecyclePatch(
	raw: unknown,
): StructuredLifecyclePatchBody | null {
	if (!isRecord(raw)) {
		return null
	}
	const patch: StructuredLifecyclePatchBody = {}
	if ("value" in raw) {
		if (typeof raw.value !== "string") return null
		patch.value = raw.value
	}
	if ("context" in raw) {
		if (typeof raw.context !== "string") return null
		patch.context = raw.context
	}
	if ("confidence" in raw) {
		if (
			typeof raw.confidence !== "number" ||
			!Number.isFinite(raw.confidence)
		) {
			return null
		}
		patch.confidence = raw.confidence
	}
	if ("source" in raw) {
		if (
			raw.source !== "agent" &&
			raw.source !== "user" &&
			raw.source !== "session" &&
			raw.source !== "ingestion"
		) {
			return null
		}
		patch.source = raw.source
	}
	if ("sessionId" in raw) {
		if (typeof raw.sessionId !== "string") return null
		patch.sessionId = raw.sessionId
	}
	if ("tags" in raw) {
		const tags = readStringArray(raw.tags)
		if (!tags) return null
		patch.tags = tags
	}
	if ("salience" in raw) {
		if (
			raw.salience !== "critical" &&
			raw.salience !== "high" &&
			raw.salience !== "normal" &&
			raw.salience !== "low"
		) {
			return null
		}
		patch.salience = raw.salience
	}
	if ("temporalScope" in raw) {
		if (
			raw.temporalScope !== "ongoing" &&
			raw.temporalScope !== "bounded" &&
			raw.temporalScope !== "permanent" &&
			raw.temporalScope !== "transient"
		) {
			return null
		}
		patch.temporalScope = raw.temporalScope
	}
	if ("provenance" in raw) {
		if (!isRecord(raw.provenance)) return null
		patch.provenance = raw.provenance
	}
	if ("sourceEventIds" in raw) {
		const sourceEventIds = readStringArray(raw.sourceEventIds)
		if (!sourceEventIds) return null
		patch.sourceEventIds = sourceEventIds
	}
	if ("validTo" in raw) {
		const validTo = readDateValue(raw.validTo)
		if (!validTo) return null
		patch.validTo = validTo
	}
	if ("reviewAt" in raw) {
		const reviewAt = readDateValue(raw.reviewAt)
		if (!reviewAt) return null
		patch.reviewAt = reviewAt
	}
	if ("lastConfirmedAt" in raw) {
		const lastConfirmedAt = readDateValue(raw.lastConfirmedAt)
		if (!lastConfirmedAt) return null
		patch.lastConfirmedAt = lastConfirmedAt
	}
	if ("sourceReliability" in raw) {
		if (
			typeof raw.sourceReliability !== "number" ||
			!Number.isFinite(raw.sourceReliability)
		) {
			return null
		}
		patch.sourceReliability = raw.sourceReliability
	}
	if ("sourceAgent" in raw) {
		const sourceAgent = readSourceAgentValue(raw.sourceAgent)
		if (!sourceAgent) return null
		patch.sourceAgent = sourceAgent
	}
	if ("artifact" in raw) {
		if (
			!isRecord(raw.artifact) ||
			(raw.artifact.type !== "solution" &&
				raw.artifact.type !== "formula" &&
				raw.artifact.type !== "command" &&
				raw.artifact.type !== "config" &&
				raw.artifact.type !== "snippet") ||
			typeof raw.artifact.title !== "string" ||
			typeof raw.artifact.content !== "string"
		) {
			return null
		}
		patch.artifact = {
			type: raw.artifact.type,
			title: raw.artifact.title,
			content: raw.artifact.content,
		}
	}
	return Object.keys(patch).length > 0 ? patch : null
}

function readProcedureLifecyclePatch(
	raw: unknown,
): ProcedureLifecyclePatchBody | null {
	if (!isRecord(raw)) {
		return null
	}
	const patch: ProcedureLifecyclePatchBody = {}
	if ("name" in raw) {
		if (typeof raw.name !== "string") return null
		patch.name = raw.name
	}
	if ("intentTags" in raw) {
		const intentTags = readStringArray(raw.intentTags)
		if (!intentTags) return null
		patch.intentTags = intentTags
	}
	if ("triggerQueries" in raw) {
		const triggerQueries = readStringArray(raw.triggerQueries)
		if (!triggerQueries) return null
		patch.triggerQueries = triggerQueries
	}
	if ("steps" in raw) {
		const steps = readStringArray(raw.steps)
		if (!steps) return null
		patch.steps = steps
	}
	if ("successSignals" in raw) {
		const successSignals = readStringArray(raw.successSignals)
		if (!successSignals) return null
		patch.successSignals = successSignals
	}
	if ("confidence" in raw) {
		if (
			typeof raw.confidence !== "number" ||
			!Number.isFinite(raw.confidence)
		) {
			return null
		}
		patch.confidence = raw.confidence
	}
	if ("provenance" in raw) {
		if (!isRecord(raw.provenance)) return null
		patch.provenance = raw.provenance
	}
	if ("sourceEventIds" in raw) {
		const sourceEventIds = readStringArray(raw.sourceEventIds)
		if (!sourceEventIds) return null
		patch.sourceEventIds = sourceEventIds
	}
	if ("sourceAgent" in raw) {
		const sourceAgent = readSourceAgentValue(raw.sourceAgent)
		if (!sourceAgent) return null
		patch.sourceAgent = sourceAgent
	}
	return Object.keys(patch).length > 0 ? patch : null
}

export function createV1Router(): Hono {
	const v1 = new Hono()

	v1.post("/search", async (c) => {
		const body = (await c.req.json().catch(() => ({}))) as Record<
			string,
			unknown
		>
		const query = readQuery(body)
		if (!query.trim()) {
			return jsonError(c, 400, "VALIDATION_ERROR", "query is required")
		}
		const scopeError = readScopeInputError(body)
		if (scopeError) {
			return jsonError(c, 400, "VALIDATION_ERROR", scopeError)
		}
		try {
			const results = await memongoBridgeSearch({
				query,
				agentId: readAgentId(body),
				maxResults: readLimit(body),
				minScore: typeof body.minScore === "number" ? body.minScore : undefined,
				sessionKey: readSessionKey(body),
				scope: readScope(body),
				scopeRef: readScopeRef(body),
			})
			return c.json({ results })
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err)
			return jsonError(c, 500, "SEARCH_FAILED", message)
		}
	})

	v1.post("/search-kb", async (c) => {
		const body = (await c.req.json().catch(() => ({}))) as Record<
			string,
			unknown
		>
		const query = readQuery(body)
		if (!query.trim()) {
			return jsonError(c, 400, "VALIDATION_ERROR", "query is required")
		}
		try {
			const filter =
				typeof body.filter === "object" &&
				body.filter !== null &&
				!Array.isArray(body.filter)
					? (body.filter as {
							tags?: string[]
							category?: string
							source?: string
						})
					: undefined
			const results = await memongoBridgeSearchKB({
				query,
				agentId: readAgentId(body),
				maxResults: readLimit(body),
				minScore: typeof body.minScore === "number" ? body.minScore : undefined,
				filter,
			})
			return c.json({ results })
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err)
			return jsonError(c, 500, "SEARCH_KB_FAILED", message)
		}
	})

	v1.post("/recall-conversation", async (c) => {
		const body = (await c.req.json().catch(() => ({}))) as Record<
			string,
			unknown
		>
		const roles = readConversationRoles(body)
		if (roles === null) {
			return jsonError(
				c,
				400,
				"VALIDATION_ERROR",
				"roles must contain only user|assistant|system|tool",
			)
		}
		try {
			const result = await memongoBridgeRecallConversation({
				agentId: readAgentId(body),
				query: typeof body.query === "string" ? body.query : undefined,
				sessionId:
					typeof body.sessionId === "string" ? body.sessionId : undefined,
				roles,
				startTime:
					typeof body.startTime === "string" ? body.startTime : undefined,
				endTime: typeof body.endTime === "string" ? body.endTime : undefined,
				timezone: typeof body.timezone === "string" ? body.timezone : undefined,
				includeToolMessages:
					typeof body.includeToolMessages === "boolean"
						? body.includeToolMessages
						: undefined,
				limit: readLimit(body),
			})
			return c.json(result)
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err)
			if (isRecallConversationValidationError(err)) {
				return jsonError(c, 400, "VALIDATION_ERROR", message)
			}
			return jsonError(c, 500, "RECALL_CONVERSATION_FAILED", message)
		}
	})

	v1.post("/import/conversations", async (c) => {
		const body = (await c.req.json().catch(() => ({}))) as Record<
			string,
			unknown
		>
		if (
			typeof body.datasetPath !== "string" ||
			body.datasetPath.trim() === ""
		) {
			return jsonError(c, 400, "VALIDATION_ERROR", "datasetPath is required")
		}
		try {
			const result = await memongoBridgeImportConversations({
				agentId: readAgentId(body),
				datasetPath: body.datasetPath,
				scope: readScope(body),
				limitConversations:
					typeof body.limitConversations === "number"
						? body.limitConversations
						: undefined,
				limitTurnsPerConversation:
					typeof body.limitTurnsPerConversation === "number"
						? body.limitTurnsPerConversation
						: undefined,
			})
			return c.json(result)
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err)
			return jsonError(c, 500, "CONVERSATION_IMPORT_FAILED", message)
		}
	})

	v1.post("/lifecycle/get", async (c) => {
		const body = (await c.req.json().catch(() => ({}))) as Record<
			string,
			unknown
		>
		const handle = readLifecycleHandle(body.handle)
		if (!handle) {
			return jsonError(
				c,
				400,
				"VALIDATION_ERROR",
				"handle must be a valid structured/procedure stable handle",
			)
		}
		try {
			const item = await memongoBridgeGetLifecycleItem({ handle })
			if (!item) {
				return jsonError(c, 404, "NOT_FOUND", "memory not found")
			}
			return c.json(item)
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err)
			return jsonError(c, 500, "LIFECYCLE_GET_FAILED", message)
		}
	})

	v1.post("/lifecycle/update", async (c) => {
		const body = (await c.req.json().catch(() => ({}))) as Record<
			string,
			unknown
		>
		const handle = readLifecycleHandle(body.handle)
		if (!handle) {
			return jsonError(
				c,
				400,
				"VALIDATION_ERROR",
				"handle must be a valid structured/procedure stable handle",
			)
		}
		const patch =
			handle.family === "structured"
				? readStructuredLifecyclePatch(body.patch)
				: readProcedureLifecyclePatch(body.patch)
		if (!patch) {
			return jsonError(
				c,
				400,
				"VALIDATION_ERROR",
				"patch must be a valid lifecycle patch for the handle family",
			)
		}
		try {
			const item = await memongoBridgeUpdateLifecycleItem({ handle, patch })
			if (!item) {
				return jsonError(c, 404, "NOT_FOUND", "memory not found")
			}
			return c.json(item)
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err)
			return jsonError(c, 500, "LIFECYCLE_UPDATE_FAILED", message)
		}
	})

	v1.post("/lifecycle/delete", async (c) => {
		const body = (await c.req.json().catch(() => ({}))) as Record<
			string,
			unknown
		>
		const handle = readLifecycleHandle(body.handle)
		if (!handle) {
			return jsonError(
				c,
				400,
				"VALIDATION_ERROR",
				"handle must be a valid structured/procedure stable handle",
			)
		}
		if (body.invalidatedBy !== undefined && !isRecord(body.invalidatedBy)) {
			return jsonError(
				c,
				400,
				"VALIDATION_ERROR",
				"invalidatedBy must be an object when provided",
			)
		}
		try {
			const item = await memongoBridgeDeleteLifecycleItem({
				handle,
				...(isRecord(body.invalidatedBy)
					? { invalidatedBy: body.invalidatedBy }
					: {}),
			})
			if (!item) {
				return jsonError(c, 404, "NOT_FOUND", "memory not found")
			}
			return c.json(item)
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err)
			return jsonError(c, 500, "LIFECYCLE_DELETE_FAILED", message)
		}
	})

	v1.post("/lifecycle/history", async (c) => {
		const body = (await c.req.json().catch(() => ({}))) as Record<
			string,
			unknown
		>
		const handle = readLifecycleHandle(body.handle)
		if (!handle) {
			return jsonError(
				c,
				400,
				"VALIDATION_ERROR",
				"handle must be a valid structured/procedure stable handle",
			)
		}
		if (
			body.limit !== undefined &&
			(typeof body.limit !== "number" || !Number.isFinite(body.limit))
		) {
			return jsonError(c, 400, "VALIDATION_ERROR", "limit must be a number")
		}
		const limit =
			typeof body.limit === "number"
				? Math.max(1, Math.min(MAX_HISTORY_LIMIT, Math.floor(body.limit)))
				: undefined
		try {
			const history = await memongoBridgeGetLifecycleHistory({
				handle,
				limit,
			})
			if (history.length === 0) {
				return jsonError(c, 404, "NOT_FOUND", "memory not found")
			}
			return c.json(history)
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err)
			return jsonError(c, 500, "LIFECYCLE_HISTORY_FAILED", message)
		}
	})

	v1.post("/procedures/outcome", async (c) => {
		const body = (await c.req.json().catch(() => ({}))) as Record<
			string,
			unknown
		>
		const handle = readLifecycleHandle(body.handle)
		if (!handle || handle.family !== "procedure") {
			return jsonError(
				c,
				400,
				"VALIDATION_ERROR",
				"handle must be a valid procedure stable handle",
			)
		}
		if (typeof body.success !== "boolean") {
			return jsonError(c, 400, "VALIDATION_ERROR", "success must be a boolean")
		}
		if (body.note !== undefined && typeof body.note !== "string") {
			return jsonError(c, 400, "VALIDATION_ERROR", "note must be a string")
		}
		const actorRole = readActorRole(body.actorRole)
		if (actorRole === null) {
			return jsonError(
				c,
				400,
				"VALIDATION_ERROR",
				"actorRole must be user|assistant|system when provided",
			)
		}
		try {
			const item = await memongoBridgeReportProcedureOutcome({
				handle,
				success: body.success,
				...(typeof body.note === "string" ? { note: body.note } : {}),
				...(actorRole ? { actorRole } : {}),
			})
			if (!item) {
				return jsonError(c, 404, "NOT_FOUND", "procedure not found")
			}
			return c.json(item)
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err)
			return jsonError(c, 500, "PROCEDURE_OUTCOME_FAILED", message)
		}
	})

	v1.post("/memory/feedback", async (c) => {
		const body = (await c.req.json().catch(() => ({}))) as Record<
			string,
			unknown
		>
		const handle = readLifecycleHandle(body.handle)
		if (!handle || handle.family !== "structured") {
			return jsonError(
				c,
				400,
				"VALIDATION_ERROR",
				"handle must be a valid structured memory stable handle",
			)
		}
		const signal =
			body.signal === "confirm" ||
			body.signal === "correct" ||
			body.signal === "irrelevant"
				? body.signal
				: null
		if (!signal) {
			return jsonError(
				c,
				400,
				"VALIDATION_ERROR",
				"signal must be confirm|correct|irrelevant",
			)
		}
		if (body.note !== undefined && typeof body.note !== "string") {
			return jsonError(c, 400, "VALIDATION_ERROR", "note must be a string")
		}
		const actorRole = readActorRole(body.actorRole)
		if (actorRole === null) {
			return jsonError(
				c,
				400,
				"VALIDATION_ERROR",
				"actorRole must be user|assistant|system when provided",
			)
		}
		const patch =
			signal === "correct"
				? readStructuredLifecyclePatch(body.patch)
				: undefined
		if (signal === "correct" && (!patch || Object.keys(patch).length === 0)) {
			return jsonError(
				c,
				400,
				"VALIDATION_ERROR",
				"patch must be a valid structured lifecycle patch for correct feedback",
			)
		}
		if (body.invalidatedBy !== undefined && !isRecord(body.invalidatedBy)) {
			return jsonError(
				c,
				400,
				"VALIDATION_ERROR",
				"invalidatedBy must be an object when provided",
			)
		}
		try {
			const item = await memongoBridgeApplyMemoryFeedback({
				handle,
				signal,
				...(patch ? { patch } : {}),
				...(typeof body.note === "string" ? { note: body.note } : {}),
				...(actorRole ? { actorRole } : {}),
				...(isRecord(body.invalidatedBy)
					? { invalidatedBy: body.invalidatedBy }
					: {}),
			})
			if (!item) {
				return jsonError(c, 404, "NOT_FOUND", "memory not found")
			}
			return c.json(item)
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err)
			return jsonError(c, 500, "MEMORY_FEEDBACK_FAILED", message)
		}
	})

	v1.post("/search-detailed", async (c) => {
		const body = (await c.req.json().catch(() => ({}))) as Record<
			string,
			unknown
		>
		const scopeError = readScopeInputError(body)
		if (scopeError) {
			return jsonError(c, 400, "VALIDATION_ERROR", scopeError)
		}
		const query = readQuery(body)
		if (!query.trim()) {
			return jsonError(c, 400, "VALIDATION_ERROR", "query is required")
		}
		try {
			const searchMode =
				body.searchMode === "auto" ||
				body.searchMode === "direct" ||
				body.searchMode === "agentic"
					? body.searchMode
					: undefined
			const sourcePreference = Array.isArray(body.sourcePreference)
				? (body.sourcePreference as string[])
				: undefined
			const timeRange =
				typeof body.timeRange === "object" &&
				body.timeRange !== null &&
				!Array.isArray(body.timeRange)
					? (body.timeRange as Record<string, unknown>)
					: undefined
			const conversationScope =
				typeof body.conversationScope === "object" &&
				body.conversationScope !== null
					? (body.conversationScope as { sessionKey?: string })
					: undefined
			const structuredScope =
				typeof body.structuredScope === "object" &&
				body.structuredScope !== null
					? (body.structuredScope as Record<string, unknown>)
					: undefined
			const referenceScope =
				typeof body.referenceScope === "object" && body.referenceScope !== null
					? (body.referenceScope as Record<string, unknown>)
					: undefined
			const proceduralScope =
				typeof body.proceduralScope === "object" &&
				body.proceduralScope !== null
					? (body.proceduralScope as Record<string, unknown>)
					: undefined
			const searchConfig =
				typeof body.searchConfig === "object" &&
				body.searchConfig !== null &&
				!Array.isArray(body.searchConfig)
					? (body.searchConfig as Record<string, unknown>)
					: undefined
			const result = await memongoBridgeSearchDetailed({
				query,
				agentId: readAgentId(body),
				scope: readScope(body),
				scopeRef: readScopeRef(body),
				maxResults: readLimit(body),
				minScore: typeof body.minScore === "number" ? body.minScore : undefined,
				searchMode,
				sourcePreference,
				timeRange: timeRange as
					| { preset?: string; start?: string; end?: string }
					| undefined,
				needExactEvidence:
					typeof body.needExactEvidence === "boolean"
						? body.needExactEvidence
						: undefined,
				maxPasses:
					typeof body.maxPasses === "number" ? body.maxPasses : undefined,
				returnPlan:
					typeof body.returnPlan === "boolean" ? body.returnPlan : undefined,
				conversationScope,
				structuredScope: structuredScope as
					| {
							type?: string
							state?: string | string[]
							salience?: string[]
					  }
					| undefined,
				referenceScope: referenceScope as
					| {
							source?: string
							category?: string
							tags?: string[]
					  }
					| undefined,
				proceduralScope: proceduralScope as
					| { state?: string; intentTags?: string[] }
					| undefined,
				searchConfig: searchConfig as
					| {
							recipe?:
								| "fast"
								| "hybrid"
								| "deep"
								| "temporal"
								| "chain-of-thought"
							recallProfile?: "latency" | "balanced" | "proof"
							maxResults?: number
							searchMode?: "auto" | "direct" | "agentic"
							maxPasses?: number
							sourcePreference?: string[]
							timeRange?: { preset?: string; start?: string; end?: string }
							needExactEvidence?: boolean
							numCandidates?: number
							fusionMethod?: "scoreFusion" | "rankFusion" | "js-merge"
							hybridMode?: "hybrid" | "vector-only"
							allowHybridBackstop?: boolean
							lexicalPrefilter?: "disabled" | "experimental"
					  }
					| undefined,
			})
			return c.json(result)
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err)
			return jsonError(c, 500, "SEARCH_DETAILED_FAILED", message)
		}
	})

	v1.post("/hydrate-active-slate", async (c) => {
		const body = (await c.req.json().catch(() => ({}))) as Record<
			string,
			unknown
		>
		const scopeError = readScopeInputError(body)
		if (scopeError) {
			return jsonError(c, 400, "VALIDATION_ERROR", scopeError)
		}
		try {
			const slate = await memongoBridgeHydrateActiveSlate({
				agentId: readAgentId(body),
				scope: readScope(body),
				scopeRef: readScopeRef(body),
				maxItems: typeof body.maxItems === "number" ? body.maxItems : undefined,
			})
			return c.json(slate)
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err)
			return jsonError(c, 500, "ACTIVE_SLATE_FAILED", message)
		}
	})

	v1.post("/discovery-projection", async (c) => {
		const body = (await c.req.json().catch(() => ({}))) as Record<
			string,
			unknown
		>
		const kind = readDiscoveryProjectionKind(body)
		if (!kind) {
			return jsonError(c, 400, "VALIDATION_ERROR", "kind is required")
		}
		if (
			(kind === "entity-brief" || kind === "topic-brief") &&
			!readQuery(body).trim()
		) {
			return jsonError(c, 400, "VALIDATION_ERROR", "query is required")
		}
		const scopeError = readScopeInputError(body)
		if (scopeError) {
			return jsonError(c, 400, "VALIDATION_ERROR", scopeError)
		}
		try {
			const timeRange =
				typeof body.timeRange === "object" &&
				body.timeRange !== null &&
				!Array.isArray(body.timeRange)
					? (body.timeRange as Record<string, unknown>)
					: undefined
			const projection = await memongoBridgeBuildDiscoveryProjection({
				agentId: readAgentId(body),
				kind,
				query: readQuery(body) || undefined,
				scope: readScope(body),
				scopeRef: readScopeRef(body),
				maxItems: typeof body.maxItems === "number" ? body.maxItems : undefined,
				timeRange: timeRange as
					| { preset?: string; start?: string; end?: string }
					| undefined,
			})
			return c.json(projection)
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err)
			return jsonError(c, 500, "DISCOVERY_PROJECTION_FAILED", message)
		}
	})

	v1.post("/context-bundle", async (c) => {
		const body = (await c.req.json().catch(() => ({}))) as Record<
			string,
			unknown
		>
		const discoveryKind =
			body.discoveryKind === undefined
				? undefined
				: readDiscoveryProjectionKind({ kind: body.discoveryKind })
		if (body.discoveryKind !== undefined && !discoveryKind) {
			return jsonError(
				c,
				400,
				"VALIDATION_ERROR",
				"discoveryKind must be entity-brief|topic-brief|what-changed|contradiction-report",
			)
		}
		const scopeError = readScopeInputError(body)
		if (scopeError) {
			return jsonError(c, 400, "VALIDATION_ERROR", scopeError)
		}
		try {
			const timeRange =
				typeof body.timeRange === "object" &&
				body.timeRange !== null &&
				!Array.isArray(body.timeRange)
					? (body.timeRange as Record<string, unknown>)
					: undefined
			const bundle = await memongoBridgeBuildContextBundle({
				agentId: readAgentId(body),
				query: readQuery(body) || undefined,
				scope: readScope(body),
				scopeRef: readScopeRef(body),
				sessionId: readSessionId(body),
				tokenBudget:
					typeof body.tokenBudget === "number" ? body.tokenBudget : undefined,
				maxActiveItems:
					typeof body.maxActiveItems === "number"
						? body.maxActiveItems
						: undefined,
				maxEvidenceItems:
					typeof body.maxEvidenceItems === "number"
						? body.maxEvidenceItems
						: undefined,
				maxRecentEvents:
					typeof body.maxRecentEvents === "number"
						? body.maxRecentEvents
						: undefined,
				includeDiscoveryProjection:
					typeof body.includeDiscoveryProjection === "boolean"
						? body.includeDiscoveryProjection
						: undefined,
				discoveryKind,
				includeProfile:
					typeof body.includeProfile === "boolean"
						? body.includeProfile
						: undefined,
				timeRange: timeRange as
					| { preset?: string; start?: string; end?: string }
					| undefined,
				mode: body.mode === "wake-up" ? "wake-up" : undefined,
			})
			return c.json(bundle)
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err)
			return jsonError(c, 500, "CONTEXT_BUNDLE_FAILED", message)
		}
	})

	v1.post("/read-file", async (c) => {
		const body = (await c.req.json().catch(() => ({}))) as Record<
			string,
			unknown
		>
		const relPath = typeof body.relPath === "string" ? body.relPath : ""
		if (!relPath.trim()) {
			return jsonError(c, 400, "VALIDATION_ERROR", "relPath is required")
		}
		try {
			const out = await memongoBridgeReadFile({
				relPath,
				from: typeof body.from === "number" ? body.from : undefined,
				lines: typeof body.lines === "number" ? body.lines : undefined,
				agentId: readAgentId(body),
			})
			return c.json(out)
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err)
			return jsonError(c, 500, "READ_FILE_FAILED", message)
		}
	})

	v1.post("/add", async (c) => {
		const body = (await c.req.json().catch(() => ({}))) as Record<
			string,
			unknown
		>
		const content = typeof body.content === "string" ? body.content : ""
		if (!content.trim()) {
			return jsonError(c, 400, "VALIDATION_ERROR", "content is required")
		}
		const scopeError = readScopeInputError(body)
		if (scopeError) {
			return jsonError(c, 400, "VALIDATION_ERROR", scopeError)
		}
		const metadata =
			typeof body.metadata === "object" &&
			body.metadata !== null &&
			!Array.isArray(body.metadata)
				? (body.metadata as Record<string, unknown>)
				: undefined
		try {
			const out = await memongoBridgeAdd({
				content,
				agentId: readAgentId(body),
				sessionId: readSessionId(body),
				metadata,
				scope: readScope(body),
				scopeRef: readScopeRef(body),
			})
			return c.json({
				ok: true,
				eventId: out.eventId,
				chunkCreated: out.chunkCreated,
			})
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err)
			return jsonError(c, 500, "ADD_FAILED", message)
		}
	})

	v1.post("/write-event", async (c) => {
		const body = (await c.req.json().catch(() => ({}))) as Record<
			string,
			unknown
		>
		const role = body.role
		const bodyText = typeof body.body === "string" ? body.body : ""
		if (
			role !== "user" &&
			role !== "assistant" &&
			role !== "system" &&
			role !== "tool"
		) {
			return jsonError(
				c,
				400,
				"VALIDATION_ERROR",
				"role must be user|assistant|system|tool",
			)
		}
		if (!bodyText.trim()) {
			return jsonError(c, 400, "VALIDATION_ERROR", "body is required")
		}
		const scopeError = readScopeInputError(body)
		if (scopeError) {
			return jsonError(c, 400, "VALIDATION_ERROR", scopeError)
		}
		const metadata =
			typeof body.metadata === "object" &&
			body.metadata !== null &&
			!Array.isArray(body.metadata)
				? (body.metadata as Record<string, unknown>)
				: undefined
		const scope = readScope(body)
		try {
			const out = await memongoBridgeWriteConversationEvent({
				agentId: readAgentId(body),
				role,
				body: bodyText,
				sessionId: readSessionId(body),
				timestamp:
					typeof body.timestamp === "string" ? body.timestamp : undefined,
				metadata,
				scope,
				scopeRef: readScopeRef(body),
			})
			return c.json({
				ok: true,
				eventId: out.eventId,
				chunkCreated: out.chunkCreated,
			})
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err)
			return jsonError(c, 500, "WRITE_EVENT_FAILED", message)
		}
	})

	v1.post("/extract", async (c) => {
		const body = (await c.req.json().catch(() => ({}))) as Record<
			string,
			unknown
		>
		const eventId = typeof body.eventId === "string" ? body.eventId : ""
		if (!eventId.trim()) {
			return jsonError(c, 400, "VALIDATION_ERROR", "eventId is required")
		}
		try {
			const out = await memongoBridgeExtractEvent({
				agentId: readAgentId(body),
				eventId,
			})
			return c.json({ ok: true, ...out }, 202)
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err)
			return jsonError(c, 500, "EXTRACT_FAILED", message)
		}
	})

	v1.post("/write-structured", async (c) => {
		const body = (await c.req.json().catch(() => ({}))) as Record<
			string,
			unknown
		>
		const entry = body.entry
		if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
			return jsonError(c, 400, "VALIDATION_ERROR", "entry object is required")
		}
		try {
			const out = await memongoBridgeWriteStructuredMemory({
				agentId: readAgentId(body),
				entry: entry as StructuredMemoryEntry,
			})
			return c.json(out)
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err)
			return jsonError(c, 500, "WRITE_STRUCTURED_FAILED", message)
		}
	})

	v1.post("/write-procedure", async (c) => {
		const body = (await c.req.json().catch(() => ({}))) as Record<
			string,
			unknown
		>
		const entry = body.entry
		if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
			return jsonError(c, 400, "VALIDATION_ERROR", "entry object is required")
		}
		try {
			const out = await memongoBridgeWriteProcedure({
				agentId: readAgentId(body),
				entry: entry as ProcedureEntry,
			})
			return c.json(out)
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err)
			return jsonError(c, 500, "WRITE_PROCEDURE_FAILED", message)
		}
	})

	v1.post("/profile", async (c) => {
		const body = (await c.req.json().catch(() => ({}))) as Record<
			string,
			unknown
		>
		const scopeError = readScopeInputError(body)
		if (scopeError) {
			return jsonError(c, 400, "VALIDATION_ERROR", scopeError)
		}
		try {
			const profile = await memongoBridgeProfile({
				agentId: readAgentId(body),
				scope: readScope(body),
				scopeRef: readScopeRef(body),
				maxEntities:
					typeof body.maxEntities === "number" ? body.maxEntities : undefined,
				maxEpisodes:
					typeof body.maxEpisodes === "number" ? body.maxEpisodes : undefined,
				maxPerType:
					typeof body.maxPerType === "number" ? body.maxPerType : undefined,
				activityWindowMs:
					typeof body.activityWindowMs === "number"
						? body.activityWindowMs
						: undefined,
			})
			return c.json(profile)
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err)
			return jsonError(c, 500, "PROFILE_FAILED", message)
		}
	})

	v1.get("/state", async (c) => {
		const query = c.req.query() as Record<string, unknown>
		const scopeError = readScopeInputError(query)
		if (scopeError) {
			return jsonError(c, 400, "VALIDATION_ERROR", scopeError)
		}
		const agentId = c.req.query("agentId") ?? undefined
		const scope = readScope(query)
		const scopeRef = readScopeRef(query)
		try {
			const state = await memongoBridgeGetState({ agentId, scope, scopeRef })
			return c.json(state)
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err)
			return jsonError(c, 500, "STATE_FAILED", message)
		}
	})

	v1.get("/status", async (c) => {
		const agentId = c.req.query("agentId") ?? undefined
		try {
			const status = await memongoBridgeStatus({ agentId })
			return c.json(status)
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err)
			return jsonError(c, 500, "STATUS_FAILED", message)
		}
	})

	v1.get("/status/detailed", async (c) => {
		const agentId = c.req.query("agentId") ?? undefined
		try {
			const status = await memongoBridgeGetDetailedStatus({ agentId })
			return c.json(status)
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err)
			return jsonError(c, 500, "DETAILED_STATUS_FAILED", message)
		}
	})

	v1.get("/stats", async (c) => {
		const agentId = c.req.query("agentId") ?? undefined
		try {
			const stats = await memongoBridgeStats({ agentId })
			return c.json(stats)
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err)
			return jsonError(c, 500, "STATS_FAILED", message)
		}
	})

	v1.post("/sync", async (c) => {
		const body = (await c.req.json().catch(() => ({}))) as Record<
			string,
			unknown
		>
		try {
			await memongoBridgeSync({
				agentId: readAgentId(body),
				reason: typeof body.reason === "string" ? body.reason : undefined,
				force: typeof body.force === "boolean" ? body.force : undefined,
			})
			return c.json({ ok: true })
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err)
			return jsonError(c, 500, "SYNC_FAILED", message)
		}
	})

	v1.get("/probes/embedding", async (c) => {
		const agentId = c.req.query("agentId") ?? undefined
		try {
			const result = await memongoBridgeProbeEmbedding({ agentId })
			return c.json(result)
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err)
			return jsonError(c, 500, "PROBE_EMBEDDING_FAILED", message)
		}
	})

	v1.get("/probes/vector", async (c) => {
		const agentId = c.req.query("agentId") ?? undefined
		try {
			const ok = await memongoBridgeProbeVector({ agentId })
			return c.json({ ok })
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err)
			return jsonError(c, 500, "PROBE_VECTOR_FAILED", message)
		}
	})

	v1.post("/admin/relevance/explain", async (c) => {
		const body = (await c.req.json().catch(() => ({}))) as Record<
			string,
			unknown
		>
		const query = typeof body.query === "string" ? body.query : ""
		if (!query.trim()) {
			return jsonError(c, 400, "VALIDATION_ERROR", "query is required")
		}
		const sourceScope =
			body.sourceScope === "all" ||
			body.sourceScope === "memory" ||
			body.sourceScope === "kb" ||
			body.sourceScope === "structured"
				? body.sourceScope
				: undefined
		try {
			const out = await memongoBridgeRelevanceExplain({
				agentId: readAgentId(body),
				query,
				sourceScope,
				sessionKey:
					typeof body.sessionKey === "string" ? body.sessionKey : undefined,
				maxResults:
					typeof body.maxResults === "number" ? body.maxResults : undefined,
				minScore: typeof body.minScore === "number" ? body.minScore : undefined,
				deep: typeof body.deep === "boolean" ? body.deep : undefined,
			})
			return c.json(out)
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err)
			return jsonError(c, 500, "RELEVANCE_EXPLAIN_FAILED", message)
		}
	})

	v1.post("/admin/relevance/benchmark", async (c) => {
		const body = (await c.req.json().catch(() => ({}))) as Record<
			string,
			unknown
		>
		try {
			// Task 1.A parity envelope inputs (all optional at Phase 1).
			const datasetSha256 =
				typeof body.datasetSha256 === "string" &&
				/^[0-9a-f]{64}$/.test(body.datasetSha256)
					? body.datasetSha256
					: undefined
			const embeddingConfig = parseEmbeddingConfig(body.embeddingConfig)
			const rerankerConfig = parseRerankerConfig(body.rerankerConfig)
			const retrievalLane = parseBenchmarkRetrievalLane(body.retrievalLane)

			const out = await memongoBridgeRelevanceBenchmark({
				agentId: readAgentId(body),
				datasetPath:
					typeof body.datasetPath === "string" ? body.datasetPath : undefined,
				maxResults:
					typeof body.maxResults === "number" ? body.maxResults : undefined,
				minScore: typeof body.minScore === "number" ? body.minScore : undefined,
				...(datasetSha256 ? { datasetSha256 } : {}),
				...(embeddingConfig ? { embeddingConfig } : {}),
				...(rerankerConfig ? { rerankerConfig } : {}),
				...(retrievalLane ? { retrievalLane } : {}),
			})
			try {
				return c.json(out)
			} catch (serializeErr) {
				const serializeMsg =
					serializeErr instanceof Error
						? serializeErr.message
						: String(serializeErr)
				if (!serializeMsg.includes("Invalid string length")) {
					throw serializeErr
				}
				// V8 cannot stringify the full result — return only the compact
				// summary without benchmarkReport and queryGovernance to stay
				// under the ~512 MB JSON.stringify limit.
				const {
					benchmarkReport: _br,
					queryGovernance: _qg,
					questionTypeBreakdown: _qtb,
					...compact
				} = out as Record<string, unknown>
				try {
					return c.json({
						...compact,
						_compacted: true,
						_compactReason: "Invalid string length",
					})
				} catch {
					// Even the compact version is too large — return metrics only.
					return c.json({
						datasetVersion: out.datasetVersion,
						cases: out.cases,
						scoredCases: out.scoredCases,
						hitRate: out.hitRate,
						emptyRate: out.emptyRate,
						avgTopScore: out.avgTopScore,
						p95LatencyMs: out.p95LatencyMs,
						rAt5: out.rAt5,
						rAt10: out.rAt10,
						ndcgAt10: out.ndcgAt10,
						officialMetrics: out.officialMetrics,
						_compacted: true,
						_compactReason: "Invalid string length (metrics-only fallback)",
					})
				}
			}
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err)
			return jsonError(c, 500, "RELEVANCE_BENCHMARK_FAILED", message)
		}
	})

	v1.post("/admin/benchmarks/ingest", async (c) => {
		const body = (await c.req.json().catch(() => ({}))) as Record<
			string,
			unknown
		>
		const datasetPath =
			typeof body.datasetPath === "string" ? body.datasetPath.trim() : ""
		if (!datasetPath) {
			return jsonError(c, 400, "VALIDATION_ERROR", "datasetPath is required")
		}
		try {
			const out = await memongoBridgeBenchmarkIngest({
				agentId: readAgentId(body),
				datasetPath,
				scope: readScope(body),
				limitConversations:
					typeof body.limitConversations === "number"
						? body.limitConversations
						: undefined,
				limitTurnsPerConversation:
					typeof body.limitTurnsPerConversation === "number"
						? body.limitTurnsPerConversation
						: undefined,
			})
			return c.json(out)
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err)
			return jsonError(c, 500, "BENCHMARK_INGEST_FAILED", message)
		}
	})

	v1.get("/admin/relevance/report", async (c) => {
		const agentId = c.req.query("agentId") ?? undefined
		const windowMsRaw = c.req.query("windowMs")
		const windowMs = windowMsRaw ? Number(windowMsRaw) : undefined
		try {
			const out = await memongoBridgeRelevanceReport({
				agentId,
				windowMs: Number.isFinite(windowMs) ? windowMs : undefined,
			})
			return c.json(out)
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err)
			return jsonError(c, 500, "RELEVANCE_REPORT_FAILED", message)
		}
	})

	v1.get("/admin/relevance/sample-rate", async (c) => {
		const agentId = c.req.query("agentId") ?? undefined
		try {
			const out = await memongoBridgeRelevanceSampleRate({ agentId })
			return c.json(out)
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err)
			return jsonError(c, 500, "RELEVANCE_SAMPLE_RATE_FAILED", message)
		}
	})

	v1.get("/admin/access-trends", async (c) => {
		const agentId = c.req.query("agentId") ?? undefined
		const collection = readAccessCollection(
			c.req.query("collection") ?? undefined,
		)
		const memoryIdsRaw = c.req.query("memoryIds")
		const memoryIds = memoryIdsRaw
			? memoryIdsRaw
					.split(",")
					.map((memoryId) => memoryId.trim())
					.filter((memoryId) => memoryId.length > 0)
			: undefined
		const windowDaysRaw = c.req.query("windowDays")
		const windowDays = windowDaysRaw ? Number(windowDaysRaw) : undefined
		const limit = parseListLimit(c.req.query("limit"))
		try {
			const out = await memongoBridgeAccessTrends({
				agentId,
				collection,
				memoryIds,
				windowDays: Number.isFinite(windowDays) ? windowDays : undefined,
				limit,
			})
			return c.json(out)
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err)
			return jsonError(c, 500, "ACCESS_TRENDS_FAILED", message)
		}
	})

	v1.get("/admin/access-summaries", async (c) => {
		const agentId = c.req.query("agentId") ?? undefined
		const collection = readAccessCollection(
			c.req.query("collection") ?? undefined,
		)
		const memoryIdsRaw = c.req.query("memoryIds")
		const memoryIds = memoryIdsRaw
			? memoryIdsRaw
					.split(",")
					.map((memoryId) => memoryId.trim())
					.filter((memoryId) => memoryId.length > 0)
			: []
		if (!collection) {
			return jsonError(c, 400, "VALIDATION_ERROR", "collection is required")
		}
		if (memoryIds.length === 0) {
			return jsonError(c, 400, "VALIDATION_ERROR", "memoryIds is required")
		}
		const windowDaysRaw = c.req.query("windowDays")
		const windowDays = windowDaysRaw ? Number(windowDaysRaw) : undefined
		try {
			const out = await memongoBridgeAccessSummaries({
				agentId,
				collection,
				memoryIds,
				windowDays: Number.isFinite(windowDays) ? windowDays : undefined,
			})
			return c.json(out)
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err)
			return jsonError(c, 500, "ACCESS_SUMMARIES_FAILED", message)
		}
	})

	v1.get("/admin/traces", async (c) => {
		const agentId = c.req.query("agentId")
		const limit = parseListLimit(c.req.query("limit"))
		try {
			const traces = await memongoBridgeListRecallTraces({
				agentId: agentId || undefined,
				limit,
			})
			return c.json(traces)
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err)
			return jsonError(c, 500, "TRACE_LIST_FAILED", message)
		}
	})

	v1.get("/admin/traces/:traceId", async (c) => {
		const traceId = c.req.param("traceId")
		if (!traceId.trim()) {
			return jsonError(c, 400, "VALIDATION_ERROR", "traceId is required")
		}
		try {
			const trace = await memongoBridgeGetRecallTrace({
				agentId: c.req.query("agentId") || undefined,
				traceId,
			})
			if (!trace) {
				return jsonError(c, 404, "NOT_FOUND", "trace not found")
			}
			return c.json(trace)
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err)
			return jsonError(c, 500, "TRACE_GET_FAILED", message)
		}
	})

	v1.get("/jobs", async (c) => {
		const agentId = c.req.query("agentId")
		const status = c.req.query("status")
		const jobType = c.req.query("jobType")
		const limit = parseListLimit(c.req.query("limit"))
		try {
			const jobs = await memongoBridgeListMemoryJobs({
				agentId: agentId || undefined,
				status:
					status === "pending" ||
					status === "running" ||
					status === "completed" ||
					status === "failed" ||
					status === "cancelled"
						? status
						: undefined,
				limit,
				jobType:
					jobType === "consolidation" ||
					jobType === "extraction" ||
					jobType === "import" ||
					jobType === "materialization" ||
					jobType === "enrichment"
						? jobType
						: undefined,
			})
			return c.json(jobs)
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err)
			return jsonError(c, 500, "JOB_LIST_FAILED", message)
		}
	})

	v1.get("/jobs/:jobId", async (c) => {
		const jobId = c.req.param("jobId")
		if (!jobId.trim()) {
			return jsonError(c, 400, "VALIDATION_ERROR", "jobId is required")
		}
		try {
			const job = await memongoBridgeGetMemoryJob({
				agentId: c.req.query("agentId") || undefined,
				jobId,
			})
			if (!job) {
				return jsonError(c, 404, "NOT_FOUND", "job not found")
			}
			return c.json(job)
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err)
			return jsonError(c, 500, "JOB_GET_FAILED", message)
		}
	})

	v1.post("/chain-trace", async (c) => {
		const body = (await c.req.json().catch(() => ({}))) as Record<
			string,
			unknown
		>
		const factId = typeof body.factId === "string" ? body.factId : ""
		const collection =
			typeof body.collection === "string" ? body.collection : ""
		if (!factId.trim()) {
			return jsonError(c, 400, "VALIDATION_ERROR", "factId is required")
		}
		if (!collection.trim()) {
			return jsonError(c, 400, "VALIDATION_ERROR", "collection is required")
		}
		try {
			const chain = await memongoBridgeTraceChain({
				agentId: readAgentId(body),
				factId,
				collection,
				maxDepth: typeof body.maxDepth === "number" ? body.maxDepth : undefined,
			})
			return c.json(chain)
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err)
			return jsonError(c, 500, "CHAIN_TRACE_FAILED", message)
		}
	})

	v1.post("/novelty-scan", async (c) => {
		const body = (await c.req.json().catch(() => ({}))) as Record<
			string,
			unknown
		>
		try {
			const report = await memongoBridgeScanNovelty({
				agentId: readAgentId(body),
				limit: typeof body.limit === "number" ? body.limit : undefined,
				scope: typeof body.scope === "string" ? body.scope : undefined,
			})
			return c.json(report)
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err)
			return jsonError(c, 500, "NOVELTY_SCAN_FAILED", message)
		}
	})

	v1.post("/consolidate", async (c) => {
		const body = (await c.req.json().catch(() => ({}))) as Record<
			string,
			unknown
		>
		try {
			const result = await memongoBridgeConsolidate({
				agentId: readAgentId(body),
				maxEvents:
					typeof body.maxEvents === "number" ? body.maxEvents : undefined,
				minCombinedScore:
					typeof body.minCombinedScore === "number"
						? body.minCombinedScore
						: undefined,
				scope: typeof body.scope === "string" ? body.scope : undefined,
			})
			return c.json(result)
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err)
			return jsonError(c, 500, "CONSOLIDATE_FAILED", message)
		}
	})

	v1.post("/self-edit", async (c) => {
		const body = (await c.req.json().catch(() => ({}))) as Record<
			string,
			unknown
		>
		const block = typeof body.block === "string" ? body.block : ""
		const action = typeof body.action === "string" ? body.action : "replace"
		const content = typeof body.content === "string" ? body.content : ""
		const validBlocks = ["user", "persona", "instructions"]
		const validActions = ["append", "replace", "prepend"]
		if (!block.trim() || !validBlocks.includes(block)) {
			return jsonError(
				c,
				400,
				"VALIDATION_ERROR",
				"block must be user|persona|instructions",
			)
		}
		if (!validActions.includes(action)) {
			return jsonError(
				c,
				400,
				"VALIDATION_ERROR",
				"action must be append|replace|prepend",
			)
		}
		if (!content.trim()) {
			return jsonError(c, 400, "VALIDATION_ERROR", "content is required")
		}
		try {
			const result = await memongoBridgeSelfEdit({
				agentId: readAgentId(body),
				block: block as "user" | "persona" | "instructions",
				action: action as "append" | "replace" | "prepend",
				content,
			})
			return c.json(result)
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err)
			return jsonError(c, 500, "SELF_EDIT_FAILED", message)
		}
	})

	return v1
}
