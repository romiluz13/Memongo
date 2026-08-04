import type { Hono } from "hono"
import {
	memongoBridgeAdd,
	memongoBridgeExtractEvent,
	memongoBridgeWriteConversationEvent,
	memongoBridgeWriteConversationEventsBatch,
	memongoBridgeWriteProcedure,
	memongoBridgeWriteStructuredMemory,
	type ProcedureEntry,
	type StructuredMemoryEntry,
} from "@memongo/memory-bridge"
import { internalError, jsonError } from "../lib/errors.js"
import {
	procedureEntrySchema,
	structuredEntrySchema,
	validateMetadata,
	validateWithSchema,
} from "../lib/validation.js"
import { type ApiScope, VALID_SCOPE_VALUES } from "../scope-identity.js"

import {
	MAX_WRITE_EVENTS_BATCH,
	readAgentId,
	readJsonBody,
	readSessionId,
	readScope,
	readScopeRef,
	readScopeInputError,
	readIdempotencyKey,
	isIdempotencyConflictError,
	isRecord,
	readDateValue,
	type V1RouterEnv,
} from "./v1-helpers.js"

export function registerWriteRoutes(v1: Hono<V1RouterEnv>): void {
	v1.post("/add", async (c) => {
		const body = (await readJsonBody(c)) as Record<string, unknown>
		const content = typeof body.content === "string" ? body.content : ""
		if (!content.trim()) {
			return jsonError(c, 400, "VALIDATION_ERROR", "content is required")
		}
		const scopeError = await readScopeInputError(c)
		if (scopeError) {
			return jsonError(c, 400, "VALIDATION_ERROR", scopeError)
		}
		// P2.8: metadata is stored verbatim — reject operator-shaped keys.
		const metadata = validateMetadata(body.metadata)
		if (!metadata.ok) {
			return jsonError(c, 400, "VALIDATION_ERROR", metadata.message)
		}
		// B1: optional absolute expiry. Deterministic policy: unparseable or
		// already-past expiry is a 400 — writing an instantly-invisible
		// document is always a caller bug (validity history uses validAt/
		// invalidAt, never expiresAt).
		const expiresAt = readDateValue(body.expiresAt)
		if (expiresAt === null) {
			return jsonError(
				c,
				400,
				"VALIDATION_ERROR",
				"expiresAt must be a valid date string when provided",
			)
		}
		if (expiresAt && expiresAt.getTime() <= Date.now()) {
			return jsonError(
				c,
				400,
				"VALIDATION_ERROR",
				"expiresAt must be in the future",
			)
		}
		try {
			const out = await memongoBridgeAdd({
				content,
				agentId: await readAgentId(c),
				sessionId: await readSessionId(c),
				metadata: metadata.value,
				scope: await readScope(c),
				scopeRef: await readScopeRef(c),
				idempotencyKey: readIdempotencyKey(c, body),
				expiresAt: expiresAt?.toISOString(),
			})
			return c.json({
				ok: true,
				eventId: out.eventId,
				chunkCreated: out.chunkCreated,
			})
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err)
			if (isIdempotencyConflictError(err)) {
				return jsonError(c, 422, "IDEMPOTENCY_CONFLICT", message)
			}
			return internalError(c, err, "ADD_FAILED")
		}
	})

	v1.post("/write-event", async (c) => {
		const body = (await readJsonBody(c)) as Record<string, unknown>
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
		const timestamp = readDateValue(body.timestamp)
		const validAt = readDateValue(body.validAt)
		const invalidAt = readDateValue(body.invalidAt)
		if (timestamp === null || validAt === null || invalidAt === null) {
			return jsonError(
				c,
				400,
				"VALIDATION_ERROR",
				"timestamp, validAt, and invalidAt must be valid date strings when provided",
			)
		}
		if (
			invalidAt &&
			invalidAt.getTime() <= (validAt ?? timestamp ?? new Date()).getTime()
		) {
			return jsonError(
				c,
				400,
				"VALIDATION_ERROR",
				"invalidAt must be later than validAt or timestamp",
			)
		}
		const scopeError = await readScopeInputError(c)
		if (scopeError) {
			return jsonError(c, 400, "VALIDATION_ERROR", scopeError)
		}
		// P2.8: metadata is stored verbatim — reject operator-shaped keys.
		const metadata = validateMetadata(body.metadata)
		if (!metadata.ok) {
			return jsonError(c, 400, "VALIDATION_ERROR", metadata.message)
		}
		// B1: same deterministic expiresAt policy as /v1/add.
		const expiresAt = readDateValue(body.expiresAt)
		if (expiresAt === null) {
			return jsonError(
				c,
				400,
				"VALIDATION_ERROR",
				"expiresAt must be a valid date string when provided",
			)
		}
		if (expiresAt && expiresAt.getTime() <= Date.now()) {
			return jsonError(
				c,
				400,
				"VALIDATION_ERROR",
				"expiresAt must be in the future",
			)
		}
		const scope = await readScope(c)
		try {
			const out = await memongoBridgeWriteConversationEvent({
				agentId: await readAgentId(c),
				role,
				body: bodyText,
				sessionId: await readSessionId(c),
				timestamp: timestamp?.toISOString(),
				validAt: validAt?.toISOString(),
				invalidAt: invalidAt?.toISOString(),
				metadata: metadata.value,
				scope,
				scopeRef: await readScopeRef(c),
				idempotencyKey: readIdempotencyKey(c, body),
				expiresAt: expiresAt?.toISOString(),
			})
			return c.json({
				ok: true,
				eventId: out.eventId,
				chunkCreated: out.chunkCreated,
			})
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err)
			if (isIdempotencyConflictError(err)) {
				return jsonError(c, 422, "IDEMPOTENCY_CONFLICT", message)
			}
			return internalError(c, err, "WRITE_EVENT_FAILED")
		}
	})

	// P3.9: bulk variant of /write-event. Per-item validation/idempotency
	// failures become per-item receipts (never a batch-level 4xx), mirroring
	// the single-write receipt shape; only a malformed envelope is a 400.
	v1.post("/write-events", async (c) => {
		const body = (await readJsonBody(c)) as Record<string, unknown>
		const rawEvents = body.events
		if (!Array.isArray(rawEvents) || rawEvents.length === 0) {
			return jsonError(
				c,
				400,
				"VALIDATION_ERROR",
				"events must be a non-empty array",
			)
		}
		if (rawEvents.length > MAX_WRITE_EVENTS_BATCH) {
			return jsonError(
				c,
				400,
				"VALIDATION_ERROR",
				`events must contain at most ${MAX_WRITE_EVENTS_BATCH} items`,
			)
		}
		const scopeError = await readScopeInputError(c)
		if (scopeError) {
			return jsonError(c, 400, "VALIDATION_ERROR", scopeError)
		}
		// The authorized tenant identity (the SAME values the auth layer
		// validated). Per-item scope/scopeRef/sessionId refine these for an
		// unscoped caller but can never contradict them — a mismatch fails
		// closed with a per-item receipt instead of crossing a tenant boundary.
		const authorizedScope = await readScope(c)
		const authorizedScopeRef = await readScopeRef(c)
		const authorizedSessionId = await readSessionId(c)

		type BatchReceipt =
			| { ok: true; eventId: string; chunkCreated: boolean; replayed?: boolean }
			| { ok: false; code: string; message: string }
		const receipts: Array<BatchReceipt | undefined> = rawEvents.map(
			() => undefined,
		)
		type ValidItem = {
			index: number
			event: {
				role: "user" | "assistant" | "system" | "tool"
				body: string
				sessionId?: string
				timestamp?: string
				validAt?: string
				invalidAt?: string
				metadata?: Record<string, unknown>
				scope?: ApiScope
				scopeRef?: string
				idempotencyKey?: string
				expiresAt?: string
			}
		}
		const validItems: ValidItem[] = []
		for (const [index, raw] of rawEvents.entries()) {
			const fail = (message: string) => {
				receipts[index] = { ok: false, code: "VALIDATION_ERROR", message }
			}
			if (!isRecord(raw)) {
				fail("each event must be an object")
				continue
			}
			const role = raw.role
			if (
				role !== "user" &&
				role !== "assistant" &&
				role !== "system" &&
				role !== "tool"
			) {
				fail("role must be user|assistant|system|tool")
				continue
			}
			const bodyText = typeof raw.body === "string" ? raw.body : ""
			if (!bodyText.trim()) {
				fail("body is required")
				continue
			}
			const timestamp = readDateValue(raw.timestamp)
			const validAt = readDateValue(raw.validAt)
			const invalidAt = readDateValue(raw.invalidAt)
			if (timestamp === null || validAt === null || invalidAt === null) {
				fail(
					"timestamp, validAt, and invalidAt must be valid date strings when provided",
				)
				continue
			}
			if (
				invalidAt &&
				invalidAt.getTime() <= (validAt ?? timestamp ?? new Date()).getTime()
			) {
				fail("invalidAt must be later than validAt or timestamp")
				continue
			}
			// P2.8: metadata is stored verbatim — reject operator-shaped keys.
			const metadata = validateMetadata(raw.metadata)
			if (!metadata.ok) {
				fail(metadata.message)
				continue
			}
			// B1: per-item expiry, same policy as the single-write routes.
			const expiresAt = readDateValue(raw.expiresAt)
			if (expiresAt === null) {
				fail("expiresAt must be a valid date string when provided")
				continue
			}
			if (expiresAt && expiresAt.getTime() <= Date.now()) {
				fail("expiresAt must be in the future")
				continue
			}
			const itemScope =
				typeof raw.scope === "string" && raw.scope.trim()
					? raw.scope.trim()
					: undefined
			if (
				itemScope !== undefined &&
				!VALID_SCOPE_VALUES.includes(itemScope as ApiScope)
			) {
				fail("scope must be session|user|agent|workspace|tenant|global")
				continue
			}
			if (
				authorizedScope !== undefined &&
				itemScope !== undefined &&
				itemScope !== authorizedScope
			) {
				fail("scope does not match the authorized scope")
				continue
			}
			const itemScopeRef =
				typeof raw.scopeRef === "string" && raw.scopeRef.trim()
					? raw.scopeRef.trim()
					: undefined
			if (
				authorizedScopeRef !== undefined &&
				itemScopeRef !== undefined &&
				itemScopeRef !== authorizedScopeRef
			) {
				fail("scopeRef does not match the authorized scopeRef")
				continue
			}
			const itemSessionId =
				typeof raw.sessionId === "string" && raw.sessionId.trim()
					? raw.sessionId.trim()
					: undefined
			if (
				authorizedSessionId !== undefined &&
				itemSessionId !== undefined &&
				itemSessionId !== authorizedSessionId
			) {
				fail("sessionId does not match the authorized sessionId")
				continue
			}
			validItems.push({
				index,
				event: {
					role,
					body: bodyText,
					sessionId: itemSessionId ?? authorizedSessionId,
					timestamp: timestamp?.toISOString(),
					validAt: validAt?.toISOString(),
					invalidAt: invalidAt?.toISOString(),
					metadata: metadata.value,
					scope: (itemScope ?? authorizedScope) as ApiScope | undefined,
					scopeRef: itemScopeRef ?? authorizedScopeRef,
					idempotencyKey:
						typeof raw.customId === "string" && raw.customId.trim()
							? raw.customId.trim()
							: undefined,
					expiresAt: expiresAt?.toISOString(),
				},
			})
		}
		try {
			const engineReceipts =
				validItems.length > 0
					? await memongoBridgeWriteConversationEventsBatch({
							agentId: await readAgentId(c),
							events: validItems.map(({ event }) => event),
						})
					: []
			for (const [position, { index }] of validItems.entries()) {
				receipts[index] = engineReceipts[position] as BatchReceipt
			}
			return c.json({ ok: true, receipts })
		} catch (err) {
			return internalError(c, err, "WRITE_EVENTS_FAILED")
		}
	})

	v1.post("/extract", async (c) => {
		const body = (await readJsonBody(c)) as Record<string, unknown>
		const eventId = typeof body.eventId === "string" ? body.eventId : ""
		if (!eventId.trim()) {
			return jsonError(c, 400, "VALIDATION_ERROR", "eventId is required")
		}
		try {
			const out = await memongoBridgeExtractEvent({
				agentId: await readAgentId(c),
				scope: await readScope(c),
				scopeRef: await readScopeRef(c),
				eventId,
			})
			return c.json({ ok: true, ...out }, 202)
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err)
			// Tenant isolation: the event is not in the caller's authorized scope.
			if (err instanceof Error && err.name === "EventNotInScopeError") {
				return jsonError(c, 404, "EVENT_NOT_FOUND", message)
			}
			return internalError(c, err, "EXTRACT_FAILED")
		}
	})

	v1.post("/write-structured", async (c) => {
		const body = (await readJsonBody(c)) as Record<string, unknown>
		// P2.8: validate the entry instead of casting — a missing key used to
		// land `undefined` in the MongoDB identity filter.
		const entry = validateWithSchema(structuredEntrySchema, body.entry, "entry")
		if (!entry.ok) {
			return jsonError(c, 400, "VALIDATION_ERROR", entry.message)
		}
		// B1: convert the validated ISO string to a Date (the engine ignores a
		// string expiresAt via its instanceof check) and apply the same
		// deterministic past-expiry policy as the event write routes.
		const entryExpiresAt = entry.value.expiresAt
			? new Date(entry.value.expiresAt)
			: undefined
		if (entryExpiresAt && entryExpiresAt.getTime() <= Date.now()) {
			return jsonError(
				c,
				400,
				"VALIDATION_ERROR",
				"entry.expiresAt must be in the future",
			)
		}
		try {
			const out = await memongoBridgeWriteStructuredMemory({
				agentId: await readAgentId(c),
				scope: await readScope(c),
				scopeRef: await readScopeRef(c),
				entry: {
					...entry.value,
					...(entryExpiresAt ? { expiresAt: entryExpiresAt } : {}),
				} as StructuredMemoryEntry,
			})
			return c.json(out)
		} catch (err) {
			return internalError(c, err, "WRITE_STRUCTURED_FAILED")
		}
	})

	v1.post("/write-procedure", async (c) => {
		const body = (await readJsonBody(c)) as Record<string, unknown>
		// P2.8: validate the entry instead of casting — procedureId feeds the
		// MongoDB identity filter the same way `key` does for structured memory.
		const entry = validateWithSchema(procedureEntrySchema, body.entry, "entry")
		if (!entry.ok) {
			return jsonError(c, 400, "VALIDATION_ERROR", entry.message)
		}
		try {
			const out = await memongoBridgeWriteProcedure({
				agentId: await readAgentId(c),
				scope: await readScope(c),
				scopeRef: await readScopeRef(c),
				entry: entry.value as ProcedureEntry,
			})
			return c.json(out)
		} catch (err) {
			return internalError(c, err, "WRITE_PROCEDURE_FAILED")
		}
	})
}
