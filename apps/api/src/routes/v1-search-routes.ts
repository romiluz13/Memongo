import type { Hono } from "hono"
import type { z } from "zod"
import {
	memongoBridgeImportConversations,
	memongoBridgeRecallConversation,
	memongoBridgeSearchDetailed,
	memongoBridgeSearchKBWithDegradation,
	memongoBridgeSearchWithDegradation,
} from "@memongo/memory-bridge"
import { internalError, jsonError } from "../lib/errors.js"
import {
	conversationScopeSchema,
	kbFilterSchema,
	proceduralScopeSchema,
	referenceScopeSchema,
	searchConfigSchema,
	searchModeSchema,
	sourcePreferenceSchema,
	structuredScopeSchema,
	timeRangeSchema,
	validateWithSchema,
} from "../lib/validation.js"

import {
	readAgentId,
	readJsonBody,
	readQuery,
	readLimit,
	readSessionKey,
	readScope,
	readScopeRef,
	readScopeInputError,
	readConversationRoles,
	isRecallConversationValidationError,
	isDatasetPathValidationError,
	readDateValue,
	type V1RouterEnv,
} from "./v1-helpers.js"

export function registerSearchRoutes(v1: Hono<V1RouterEnv>): void {
	v1.post("/search", async (c) => {
		const body = (await readJsonBody(c)) as Record<string, unknown>
		const query = readQuery(body)
		if (!query.trim()) {
			return jsonError(c, 400, "VALIDATION_ERROR", "query is required")
		}
		const scopeError = await readScopeInputError(c)
		if (scopeError) {
			return jsonError(c, 400, "VALIDATION_ERROR", scopeError)
		}
		try {
			const { results, degradation } = await memongoBridgeSearchWithDegradation(
				{
					query,
					agentId: await readAgentId(c),
					maxResults: readLimit(body),
					minScore:
						typeof body.minScore === "number" ? body.minScore : undefined,
					sessionKey: await readSessionKey(c),
					scope: await readScope(c),
					scopeRef: await readScopeRef(c),
				},
			)
			// WS-12 (C-019): throttling is served as throttling — the
			// degradation marker rides the 200 so a degraded answer never
			// reads as "no memories found" at the agent boundary.
			return c.json(degradation ? { results, degradation } : { results })
		} catch (err) {
			return internalError(c, err, "SEARCH_FAILED")
		}
	})

	v1.post("/search-kb", async (c) => {
		const body = (await readJsonBody(c)) as Record<string, unknown>
		const query = readQuery(body)
		if (!query.trim()) {
			return jsonError(c, 400, "VALIDATION_ERROR", "query is required")
		}
		// P2.8: the KB filter feeds a MongoDB query — validate it (typed fields,
		// no operator-shaped keys) instead of casting the raw object through.
		let filter:
			| { tags?: string[]; category?: string; source?: string }
			| undefined
		if (body.filter !== undefined) {
			const parsedFilter = validateWithSchema(
				kbFilterSchema,
				body.filter,
				"filter",
			)
			if (!parsedFilter.ok) {
				return jsonError(c, 400, "VALIDATION_ERROR", parsedFilter.message)
			}
			filter = parsedFilter.value
		}
		try {
			const { results, degradation } =
				await memongoBridgeSearchKBWithDegradation({
					query,
					agentId: await readAgentId(c),
					scopeRef: await readScopeRef(c),
					maxResults: readLimit(body),
					minScore:
						typeof body.minScore === "number" ? body.minScore : undefined,
					filter,
					fusionMethod:
						body.fusionMethod === "scoreFusion" ||
						body.fusionMethod === "rankFusion" ||
						body.fusionMethod === "js-merge"
							? body.fusionMethod
							: undefined,
				})
			// WS-12 (C-019): a dropped vector lane means the text-lane results
			// stand with degraded ranking — the marker says which, so degraded
			// ranking never reads as authoritative.
			return c.json(degradation ? { results, degradation } : { results })
		} catch (err) {
			return internalError(c, err, "SEARCH_KB_FAILED")
		}
	})

	v1.post("/recall-conversation", async (c) => {
		const body = (await readJsonBody(c)) as Record<string, unknown>
		const roles = readConversationRoles(body)
		if (roles === null) {
			return jsonError(
				c,
				400,
				"VALIDATION_ERROR",
				"roles must contain only user|assistant|system|tool",
			)
		}
		const asOf = readDateValue(body.asOf)
		if (asOf === null) {
			return jsonError(c, 400, "VALIDATION_ERROR", "asOf must be a valid date")
		}
		try {
			const result = await memongoBridgeRecallConversation({
				agentId: await readAgentId(c),
				scope: await readScope(c),
				scopeRef: await readScopeRef(c),
				query: typeof body.query === "string" ? body.query : undefined,
				sessionId:
					typeof body.sessionId === "string" ? body.sessionId : undefined,
				roles,
				startTime:
					typeof body.startTime === "string" ? body.startTime : undefined,
				endTime: typeof body.endTime === "string" ? body.endTime : undefined,
				asOf: asOf?.toISOString(),
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
			return internalError(c, err, "RECALL_CONVERSATION_FAILED")
		}
	})

	v1.post("/import/conversations", async (c) => {
		const body = (await readJsonBody(c)) as Record<string, unknown>
		if (
			typeof body.datasetPath !== "string" ||
			body.datasetPath.trim() === ""
		) {
			return jsonError(c, 400, "VALIDATION_ERROR", "datasetPath is required")
		}
		try {
			const result = await memongoBridgeImportConversations({
				agentId: await readAgentId(c),
				datasetPath: body.datasetPath,
				scope: await readScope(c),
				scopeRef: await readScopeRef(c),
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
			if (isDatasetPathValidationError(err)) {
				return jsonError(c, 400, "VALIDATION_ERROR", message)
			}
			return internalError(c, err, "CONVERSATION_IMPORT_FAILED")
		}
	})

	v1.post("/search-detailed", async (c) => {
		const body = (await readJsonBody(c)) as Record<string, unknown>
		const scopeError = await readScopeInputError(c)
		if (scopeError) {
			return jsonError(c, 400, "VALIDATION_ERROR", scopeError)
		}
		const query = readQuery(body)
		if (!query.trim()) {
			return jsonError(c, 400, "VALIDATION_ERROR", "query is required")
		}
		try {
			// WS-08 / C-012: every nested object of /search-detailed used to be
			// type-cast straight through (a typo'd timeRange preset silently
			// degraded to no time constraint, operator-shaped keys flowed into
			// the engine's config merge). Each optional input is now parsed
			// against a strict zod schema; a rejection returns 400 naming the
			// offending field instead of casting the raw object through.
			const optional = <S extends z.ZodTypeAny>(
				schema: S,
				raw: unknown,
				field: string,
			) =>
				raw === undefined
					? ({ ok: true as const, value: undefined } as const)
					: validateWithSchema(schema, raw, field)
			const searchMode = optional(
				searchModeSchema,
				body.searchMode,
				"searchMode",
			)
			if (!searchMode.ok) {
				return jsonError(c, 400, "VALIDATION_ERROR", searchMode.message)
			}
			const sourcePreference = optional(
				sourcePreferenceSchema,
				body.sourcePreference,
				"sourcePreference",
			)
			if (!sourcePreference.ok) {
				return jsonError(c, 400, "VALIDATION_ERROR", sourcePreference.message)
			}
			const timeRange = optional(timeRangeSchema, body.timeRange, "timeRange")
			if (!timeRange.ok) {
				return jsonError(c, 400, "VALIDATION_ERROR", timeRange.message)
			}
			const conversationScope = optional(
				conversationScopeSchema,
				body.conversationScope,
				"conversationScope",
			)
			if (!conversationScope.ok) {
				return jsonError(c, 400, "VALIDATION_ERROR", conversationScope.message)
			}
			const structuredScope = optional(
				structuredScopeSchema,
				body.structuredScope,
				"structuredScope",
			)
			if (!structuredScope.ok) {
				return jsonError(c, 400, "VALIDATION_ERROR", structuredScope.message)
			}
			const referenceScope = optional(
				referenceScopeSchema,
				body.referenceScope,
				"referenceScope",
			)
			if (!referenceScope.ok) {
				return jsonError(c, 400, "VALIDATION_ERROR", referenceScope.message)
			}
			const proceduralScope = optional(
				proceduralScopeSchema,
				body.proceduralScope,
				"proceduralScope",
			)
			if (!proceduralScope.ok) {
				return jsonError(c, 400, "VALIDATION_ERROR", proceduralScope.message)
			}
			const searchConfig = optional(
				searchConfigSchema,
				body.searchConfig,
				"searchConfig",
			)
			if (!searchConfig.ok) {
				return jsonError(c, 400, "VALIDATION_ERROR", searchConfig.message)
			}
			const result = await memongoBridgeSearchDetailed({
				query,
				agentId: await readAgentId(c),
				scope: await readScope(c),
				scopeRef: await readScopeRef(c),
				maxResults: readLimit(body),
				minScore: typeof body.minScore === "number" ? body.minScore : undefined,
				searchMode: searchMode.value,
				sourcePreference: sourcePreference.value,
				timeRange: timeRange.value,
				needExactEvidence:
					typeof body.needExactEvidence === "boolean"
						? body.needExactEvidence
						: undefined,
				maxPasses:
					typeof body.maxPasses === "number" ? body.maxPasses : undefined,
				returnPlan:
					typeof body.returnPlan === "boolean" ? body.returnPlan : undefined,
				conversationScope: conversationScope.value,
				structuredScope: structuredScope.value,
				referenceScope: referenceScope.value,
				proceduralScope: proceduralScope.value,
				searchConfig: searchConfig.value,
			})
			return c.json(result)
		} catch (err) {
			return internalError(c, err, "SEARCH_DETAILED_FAILED")
		}
	})
}
