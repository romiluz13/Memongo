import type { Hono } from "hono"
import type { z } from "zod"
import {
	memongoBridgeBuildContextBundle,
	memongoBridgeBuildDiscoveryProjection,
	memongoBridgeGetEvent,
	memongoBridgeHydrateActiveSlate,
	memongoBridgeReadFile,
} from "@memongo/memory-bridge"
import { internalError, jsonError } from "../lib/errors.js"
import {
	contextBundleModeSchema,
	timeRangeSchema,
	validateWithSchema,
} from "../lib/validation.js"

import {
	readAgentId,
	readJsonBody,
	readQuery,
	readSessionId,
	readSessionCoordinate,
	readScope,
	readScopeRef,
	readScopeInputError,
	readDiscoveryProjectionKind,
	type V1RouterEnv,
} from "./v1-helpers.js"

const MAX_EVENT_ID_LENGTH = 256
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this rejects
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/

function readEventId(raw: unknown): string | null {
	if (typeof raw !== "string") return null
	const eventId = raw.trim()
	if (
		!eventId ||
		eventId.length > MAX_EVENT_ID_LENGTH ||
		CONTROL_CHARACTER.test(eventId)
	) {
		return null
	}
	return eventId
}

/**
 * Parse an optional strict-schema field from a route body; `undefined`
 * passes through untouched so omitted fields stay omitted (WS-08).
 */
const optional = <S extends z.ZodTypeAny>(
	schema: S,
	raw: unknown,
	field: string,
) =>
	raw === undefined
		? ({ ok: true as const, value: undefined } as const)
		: validateWithSchema(schema, raw, field)

export function registerContextRoutes(v1: Hono<V1RouterEnv>): void {
	v1.post("/hydrate-active-slate", async (c) => {
		const body = (await readJsonBody(c)) as Record<string, unknown>
		const scopeError = await readScopeInputError(c)
		if (scopeError) {
			return jsonError(c, 400, "VALIDATION_ERROR", scopeError)
		}
		try {
			const slate = await memongoBridgeHydrateActiveSlate({
				agentId: await readAgentId(c),
				sessionId: await readSessionCoordinate(c),
				scope: await readScope(c),
				scopeRef: await readScopeRef(c),
				maxItems: typeof body.maxItems === "number" ? body.maxItems : undefined,
			})
			return c.json(slate)
		} catch (err) {
			return internalError(c, err, "ACTIVE_SLATE_FAILED")
		}
	})

	v1.post("/discovery-projection", async (c) => {
		const body = (await readJsonBody(c)) as Record<string, unknown>
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
		const scopeError = await readScopeInputError(c)
		if (scopeError) {
			return jsonError(c, 400, "VALIDATION_ERROR", scopeError)
		}
		try {
			// WS-08 / C-012: timeRange used to be type-cast through, so a typo'd
			// preset silently dropped the temporal window.
			const timeRange = optional(timeRangeSchema, body.timeRange, "timeRange")
			if (!timeRange.ok) {
				return jsonError(c, 400, "VALIDATION_ERROR", timeRange.message)
			}
			const projection = await memongoBridgeBuildDiscoveryProjection({
				agentId: await readAgentId(c),
				sessionId: await readSessionCoordinate(c),
				kind,
				query: readQuery(body) || undefined,
				scope: await readScope(c),
				scopeRef: await readScopeRef(c),
				maxItems: typeof body.maxItems === "number" ? body.maxItems : undefined,
				timeRange: timeRange.value,
			})
			return c.json(projection)
		} catch (err) {
			return internalError(c, err, "DISCOVERY_PROJECTION_FAILED")
		}
	})

	v1.post("/context-bundle", async (c) => {
		const body = (await readJsonBody(c)) as Record<string, unknown>
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
		const scopeError = await readScopeInputError(c)
		if (scopeError) {
			return jsonError(c, 400, "VALIDATION_ERROR", scopeError)
		}
		try {
			// WS-08 / C-012: timeRange used to be type-cast through, so a typo'd
			// preset silently dropped the temporal window.
			const timeRange = optional(timeRangeSchema, body.timeRange, "timeRange")
			if (!timeRange.ok) {
				return jsonError(c, 400, "VALIDATION_ERROR", timeRange.message)
			}
			// WS-08 / C-013: mode used to silently swallow every value outside
			// "wake-up" into the default "full" bundle — a caller requesting
			// "wakeup" or "FULL" never learned the mode was dropped. Invalid
			// values now return 400 naming the allowed set.
			const mode = optional(contextBundleModeSchema, body.mode, "mode")
			if (!mode.ok) {
				return jsonError(
					c,
					400,
					"VALIDATION_ERROR",
					"mode must be full|wake-up",
				)
			}
			const bundle = await memongoBridgeBuildContextBundle({
				agentId: await readAgentId(c),
				query: readQuery(body) || undefined,
				scope: await readScope(c),
				scopeRef: await readScopeRef(c),
				sessionId: await readSessionId(c),
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
				timeRange: timeRange.value,
				mode: mode.value,
				kbRestricted: c.get("kbRestricted"),
			})
			return c.json(bundle)
		} catch (err) {
			return internalError(c, err, "CONTEXT_BUNDLE_FAILED")
		}
	})

	v1.post("/read-file", async (c) => {
		const body = (await readJsonBody(c)) as Record<string, unknown>
		const relPath = typeof body.relPath === "string" ? body.relPath : ""
		if (!relPath.trim()) {
			return jsonError(c, 400, "VALIDATION_ERROR", "relPath is required")
		}
		try {
			const out = await memongoBridgeReadFile({
				relPath,
				from: typeof body.from === "number" ? body.from : undefined,
				lines: typeof body.lines === "number" ? body.lines : undefined,
				agentId: await readAgentId(c),
			})
			return c.json(out)
		} catch (err) {
			return internalError(c, err, "READ_FILE_FAILED")
		}
	})

	// Every miss (unknown id, another agent, scope or scopeRef, expired) is the
	// same 404 body, so the response never reveals that an id exists elsewhere.
	v1.post("/events/get", async (c) => {
		const body = (await readJsonBody(c)) as Record<string, unknown>
		const eventId = readEventId(body.eventId)
		if (!eventId) {
			return jsonError(
				c,
				400,
				"VALIDATION_ERROR",
				`eventId must be a non-empty string of at most ${MAX_EVENT_ID_LENGTH} characters without control characters`,
			)
		}
		const scopeError = await readScopeInputError(c)
		if (scopeError) return jsonError(c, 400, "VALIDATION_ERROR", scopeError)
		try {
			const event = await memongoBridgeGetEvent({
				eventId,
				agentId: await readAgentId(c),
				scope: await readScope(c),
				scopeRef: await readScopeRef(c),
				sessionKey: await readSessionCoordinate(c),
			})
			if (!event) {
				return jsonError(c, 404, "EVENT_NOT_FOUND", "event not found")
			}
			return c.json(event)
		} catch (err) {
			return internalError(c, err, "EVENT_GET_FAILED")
		}
	})
}
