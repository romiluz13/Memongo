import type { Context } from "hono"
import type {
	MemoryStableHandle,
	StructuredMemoryEntry,
} from "@memongo/memory-bridge"
import { InvalidJsonError } from "../lib/validation.js"
import {
	type ApiScope,
	resolveRequestAgentId,
	resolveScopeField,
	resolveScopeInput,
	VALID_SCOPE_VALUES,
} from "../scope-identity.js"

export const MAX_LIST_LIMIT = 100
export const MAX_HISTORY_LIMIT = 200
// P3.9: cap the bulk write batch so one request cannot stage an unbounded
// insertMany (the default 1MB body limit binds item size too).
export const MAX_WRITE_EVENTS_BATCH = 500
// VALID_SCOPE_VALUES / ApiScope now live in scope-identity.ts (single source of
// truth shared with scoped-API-key policy validation — issue #57 divergence).

// Issue #57: resolve agentId from the SAME merged input the auth layer
// validates, so manager/partition selection can never diverge from the
// authorized identity (e.g. a nested-only agentId must not fall back to the
// default partition). Shared with the auth layer via ./scope-identity.
export const readAgentId = resolveRequestAgentId

// P2.8: parse the request body once, in the v1 body-validation middleware.
// Read the raw text rather than c.req.json() so an unparseable body is
// distinguishable from an empty one. Hono's body cache keeps a later
// c.req.json() (scope-identity) working off this same read.
export async function parseJsonRequestBody(
	c: Context,
): Promise<Record<string, unknown>> {
	let text: string
	try {
		text = await c.req.text()
	} catch (error) {
		// The body-limit middleware's rejection keeps its own mapping.
		if (error instanceof Error && error.name === "BodyLimitError") {
			throw error
		}
		// A cached json() parse failure from an earlier layer (auth) surfaces
		// here as a rejected bodyCache promise — same client error.
		throw new InvalidJsonError()
	}
	// A genuinely empty body stays `{}` (bodiless POSTs rely on this), but a
	// non-empty body that fails to parse is a client error. Previously it
	// silently became `{}` and the request ran on defaults.
	if (!text.trim()) {
		return {}
	}
	try {
		return JSON.parse(text) as Record<string, unknown>
	} catch {
		throw new InvalidJsonError()
	}
}

export async function readJsonBody(
	c: Context,
): Promise<Record<string, unknown>> {
	// The v1 body-validation middleware pre-parses every non-GET request and
	// stashes the result (malformed JSON never reaches here — it is a 400
	// INVALID_JSON from the middleware), so route handlers share one parse.
	return (c.get("jsonBody") as Record<string, unknown> | undefined) ?? {}
}

export function parseListLimit(raw?: string): number | undefined {
	if (raw === undefined) {
		return undefined
	}
	const parsed = Number(raw)
	if (!Number.isFinite(parsed)) {
		return undefined
	}
	return Math.max(1, Math.min(MAX_LIST_LIMIT, Math.floor(parsed)))
}

export function pickContainerTag(
	input: Record<string, unknown>,
): string | undefined {
	return resolveScopeField(input, "containerTag")
}

export function readQuery(body: Record<string, unknown>): string {
	if (typeof body.query === "string") {
		return body.query
	}
	if (typeof body.q === "string") {
		return body.q
	}
	return ""
}

export function readLimit(body: Record<string, unknown>): number | undefined {
	const raw =
		typeof body.limit === "number"
			? body.limit
			: typeof body.maxResults === "number"
				? body.maxResults
				: undefined
	if (raw === undefined || !Number.isFinite(raw)) {
		return undefined
	}
	// P2.8: search-like routes forwarded `limit` uncapped, letting a caller
	// force unbounded result sets through fusion/rerank. Clamp to the same
	// ceiling as the list routes (defense-in-depth with the engine clamp).
	return Math.max(1, Math.min(MAX_LIST_LIMIT, Math.floor(raw)))
}

export function pickSessionId(
	input: Record<string, unknown>,
): string | undefined {
	return resolveScopeField(input, "sessionId") ?? pickContainerTag(input)
}

export function pickSessionKey(
	input: Record<string, unknown>,
): string | undefined {
	return resolveScopeField(input, "sessionKey") ?? pickContainerTag(input)
}

// Issue #57: session identifiers can also scope a read/write within a tenant,
// so resolve them from the same merged+nested input as scope/scopeRef. Reading
// only the top-level body let validation and execution disagree (validation saw
// a nested sessionId while execution saw none, silently mis-scoping the call).
export async function readSessionId(c: Context): Promise<string | undefined> {
	return pickSessionId(await resolveScopeInput(c))
}

export async function readSessionKey(c: Context): Promise<string | undefined> {
	return pickSessionKey(await resolveScopeInput(c))
}

// Issue #57: scope and scopeRef are tenant-isolation boundaries, so the value
// used for a read/write MUST be the SAME value the auth layer validated. Auth
// resolves them from the merged query+body+nested input (see ./scope-identity),
// so these readers do too — reading only the top-level body would let a request
// pass auth under one scopeRef yet execute under another (e.g. scopeRef supplied
// only as a query param or nested in `params`). pickScope/pickScopeRef are the
// pure resolvers over an already-merged input; readScope/readScopeRef wrap them
// over the request context, mirroring readAgentId.
export function pickScope(
	input: Record<string, unknown>,
): ApiScope | undefined {
	const scope = resolveScopeField(input, "scope")
	return scope && VALID_SCOPE_VALUES.includes(scope as ApiScope)
		? (scope as ApiScope)
		: undefined
}

export function pickScopeRef(
	input: Record<string, unknown>,
): string | undefined {
	return (
		resolveScopeField(input, "scopeRef") ??
		resolveScopeField(input, "containerTag")
	)
}

export async function readScope(c: Context): Promise<ApiScope | undefined> {
	return pickScope(await resolveScopeInput(c))
}

export async function readScopeRef(c: Context): Promise<string | undefined> {
	return pickScopeRef(await resolveScopeInput(c))
}

export function scopeInputError(input: Record<string, unknown>): string | null {
	// Auth normalizes empty/whitespace scope fields to "absent" via
	// resolveScopeField, so validation must treat them the same way — otherwise
	// the validation and auth layers would disagree about what was provided.
	if (resolveScopeField(input, "scope") !== undefined && !pickScope(input)) {
		return "scope must be session|user|agent|workspace|tenant|global"
	}
	const scope = pickScope(input)
	if (
		scope === "session" &&
		!pickScopeRef(input) &&
		!pickSessionId(input) &&
		!pickSessionKey(input)
	) {
		return "session scope requires sessionId, sessionKey, scopeRef, or containerTag"
	}
	if ((scope === "user" || scope === "tenant") && !pickScopeRef(input)) {
		return `${scope} scope requires scopeRef`
	}
	return null
}

export async function readScopeInputError(c: Context): Promise<string | null> {
	return scopeInputError(await resolveScopeInput(c))
}

// Issue #57: lifecycle routes accept a full, client-supplied stable handle whose
// agentId/scope/scopeRef the bridge uses verbatim to select the manager and
// intra-collection partition. The auth layer only validated the merged-input
// identity, so a scoped key could pass auth under one identity (e.g. a top-level
// decoy agentId) while the handle points at another tenant's data. Require the
// handle's tenant coordinates to equal the authorized identity, failing closed.
export async function lifecycleHandleIdentityError(
	c: Context,
	handle: MemoryStableHandle,
): Promise<string | null> {
	if (handle.agentId !== (await readAgentId(c))) {
		return "handle agentId does not match the authorized identity"
	}
	if (handle.scope !== (await readScope(c))) {
		return "handle scope does not match the authorized identity"
	}
	if (handle.scopeRef !== (await readScopeRef(c))) {
		return "handle scopeRef does not match the authorized identity"
	}
	return null
}

export function readAccessCollection(
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

export function readDiscoveryProjectionKind(
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

export function readConversationRoles(
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

export function isRecallConversationValidationError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error)
	return (
		message.includes("invalid timestamp") ||
		message.includes("invalid date boundary") ||
		message.includes("Invalid time zone specified") ||
		message.includes("roles must contain only")
	)
}

// Mirrors the validation throws in the engine's conversation dataset loader:
// path confinement
// and shape rejections are caller errors (400), never server failures (500).
export function isDatasetPathValidationError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error)
	return (
		message.includes("datasetPath is required") ||
		message.includes(
			"datasetPath must not contain parent-directory traversal",
		) ||
		message.includes(
			"conversation dataset does not exist or is not accessible",
		) ||
		message.includes("conversation dataset must be a .json or .jsonl file") ||
		message.includes("datasetPath must resolve inside the workspace")
	)
}

// IETF draft-ietf-httpapi-idempotency-key-header: the header is the canonical
// channel; the `customId` body field is the SDK-friendly fallback. The header
// wins when both are present so a client and a proxy can never disagree.
export function readIdempotencyKey(
	c: Context,
	body: Record<string, unknown>,
): string | undefined {
	const header = c.req.header("Idempotency-Key")?.trim()
	if (header) {
		return header
	}
	const customId = body.customId
	return typeof customId === "string" && customId.trim()
		? customId.trim()
		: undefined
}

// Engine throws IdempotencyConflictError (mongodb-events.ts); the class does
// not cross the bridge boundary reliably, so match on its stable name.
export function isIdempotencyConflictError(error: unknown): boolean {
	return error instanceof Error && error.name === "IdempotencyConflictError"
}

export type LifecycleSourceAgent = {
	id: string
	name: string
	runId?: string
}

export type StructuredLifecyclePatchBody = {
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

export type ProcedureLifecyclePatchBody = {
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

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function readStringArray(raw: unknown): string[] | null | undefined {
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

export function readDateValue(raw: unknown): Date | null | undefined {
	if (raw === undefined) {
		return undefined
	}
	if (typeof raw !== "string" || !raw.trim()) {
		return null
	}
	const parsed = new Date(raw)
	return Number.isNaN(parsed.getTime()) ? null : parsed
}

export function readSourceAgentValue(
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

export function readActorRole(
	raw: unknown,
): "user" | "assistant" | "system" | null | undefined {
	if (raw === undefined) {
		return undefined
	}
	return raw === "user" || raw === "assistant" || raw === "system" ? raw : null
}

export function readLifecycleState(
	raw: unknown,
): "active" | "invalidated" | "conflicted" | undefined {
	return raw === "active" || raw === "invalidated" || raw === "conflicted"
		? raw
		: undefined
}

export function readLifecycleHandle(raw: unknown): MemoryStableHandle | null {
	if (!isRecord(raw)) {
		return null
	}
	const family = raw.family
	if (family !== "structured" && family !== "procedure") {
		return null
	}
	const id = typeof raw.id === "string" ? raw.id.trim() : ""
	const agentId = typeof raw.agentId === "string" ? raw.agentId.trim() : ""
	const scope = pickScope(raw)
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

export function readStructuredLifecyclePatch(
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

export function readProcedureLifecyclePatch(
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

/** Router env carrying the P2.8 pre-parsed JSON body (see the middleware). */
export type V1RouterEnv = {
	Variables: { jsonBody: Record<string, unknown> }
}
