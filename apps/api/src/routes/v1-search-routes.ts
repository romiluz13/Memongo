import type { Hono } from "hono"
import {
	memongoBridgeImportConversations,
	memongoBridgeRecallConversation,
	memongoBridgeSearch,
	memongoBridgeSearchDetailed,
	memongoBridgeSearchKB,
} from "@memongo/memory-bridge"
import { internalError, jsonError } from "../lib/errors.js"
import { kbFilterSchema, validateWithSchema } from "../lib/validation.js"

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
			const results = await memongoBridgeSearch({
				query,
				agentId: await readAgentId(c),
				maxResults: readLimit(body),
				minScore: typeof body.minScore === "number" ? body.minScore : undefined,
				sessionKey: await readSessionKey(c),
				scope: await readScope(c),
				scopeRef: await readScopeRef(c),
			})
			return c.json({ results })
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
			const results = await memongoBridgeSearchKB({
				query,
				agentId: await readAgentId(c),
				scopeRef: await readScopeRef(c),
				maxResults: readLimit(body),
				minScore: typeof body.minScore === "number" ? body.minScore : undefined,
				filter,
				fusionMethod:
					body.fusionMethod === "scoreFusion" ||
					body.fusionMethod === "rankFusion" ||
					body.fusionMethod === "js-merge"
						? body.fusionMethod
						: undefined,
			})
			return c.json({ results })
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
				agentId: await readAgentId(c),
				scope: await readScope(c),
				scopeRef: await readScopeRef(c),
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
			return internalError(c, err, "SEARCH_DETAILED_FAILED")
		}
	})
}
