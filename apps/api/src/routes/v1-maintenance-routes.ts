import type { Hono } from "hono"
import {
	memongoBridgeTraceChain,
	memongoBridgeScanNovelty,
	memongoBridgeConsolidate,
	memongoBridgeSelfEdit,
} from "@memongo/memory-bridge"
import { internalError, jsonError } from "../lib/errors.js"
import {
	chainTraceCollectionSchema,
	validateWithSchema,
} from "../lib/validation.js"

import {
	readAgentId,
	readJsonBody,
	readScope,
	readScopeRef,
	type V1RouterEnv,
} from "./v1-helpers.js"

export function registerMaintenanceRoutes(v1: Hono<V1RouterEnv>): void {
	v1.post("/chain-trace", async (c) => {
		const body = (await readJsonBody(c)) as Record<string, unknown>
		const factId = typeof body.factId === "string" ? body.factId : ""
		const collection =
			typeof body.collection === "string" ? body.collection : ""
		if (!factId.trim()) {
			return jsonError(c, 400, "VALIDATION_ERROR", "factId is required")
		}
		if (!collection.trim()) {
			return jsonError(c, 400, "VALIDATION_ERROR", "collection is required")
		}
		// WS-08 / C-015: `collection` used to be any non-empty string, and the
		// engine answered a plausible-but-wrong name with a fabricated empty
		// `chainComplete: true` chain — indistinguishable from "no premises
		// exist". Validate against the canonical traversal allowlist and name
		// the traversable collections on rejection.
		const parsedCollection = validateWithSchema(
			chainTraceCollectionSchema,
			collection,
			"collection",
		)
		if (!parsedCollection.ok) {
			return jsonError(
				c,
				400,
				"VALIDATION_ERROR",
				"collection must be structured_mem|entities|relations|procedures|entity_links",
			)
		}
		try {
			const chain = await memongoBridgeTraceChain({
				agentId: await readAgentId(c),
				factId,
				collection: parsedCollection.value,
				maxDepth: typeof body.maxDepth === "number" ? body.maxDepth : undefined,
			})
			return c.json(chain)
		} catch (err) {
			return internalError(c, err, "CHAIN_TRACE_FAILED")
		}
	})

	v1.post("/novelty-scan", async (c) => {
		const body = (await readJsonBody(c)) as Record<string, unknown>
		try {
			const report = await memongoBridgeScanNovelty({
				agentId: await readAgentId(c),
				limit: typeof body.limit === "number" ? body.limit : undefined,
				scope: await readScope(c),
				scopeRef: await readScopeRef(c),
			})
			return c.json(report)
		} catch (err) {
			return internalError(c, err, "NOVELTY_SCAN_FAILED")
		}
	})

	v1.post("/consolidate", async (c) => {
		const body = (await readJsonBody(c)) as Record<string, unknown>
		for (const field of ["resolveContradictions", "llmDedup"] as const) {
			if (field in body && typeof body[field] !== "boolean") {
				return jsonError(
					c,
					400,
					"VALIDATION_ERROR",
					`${field} must be a boolean when provided`,
				)
			}
		}
		try {
			const result = await memongoBridgeConsolidate({
				agentId: await readAgentId(c),
				maxEvents:
					typeof body.maxEvents === "number" ? body.maxEvents : undefined,
				minCombinedScore:
					typeof body.minCombinedScore === "number"
						? body.minCombinedScore
						: undefined,
				resolveContradictions:
					typeof body.resolveContradictions === "boolean"
						? body.resolveContradictions
						: undefined,
				llmDedup:
					typeof body.llmDedup === "boolean" ? body.llmDedup : undefined,
				scope: await readScope(c),
				scopeRef: await readScopeRef(c),
			})
			return c.json(result)
		} catch (err) {
			return internalError(c, err, "CONSOLIDATE_FAILED")
		}
	})

	v1.post("/self-edit", async (c) => {
		const body = (await readJsonBody(c)) as Record<string, unknown>
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
				agentId: await readAgentId(c),
				block: block as "user" | "persona" | "instructions",
				action: action as "append" | "replace" | "prepend",
				content,
			})
			// C-008: a `user`-block edit whose merged content tripped the
			// injection classifier is held in memory_quarantine for review —
			// 202 Accepted (held), not a clean 200 self-edit.
			if (result.quarantined) {
				return c.json(result, 202)
			}
			return c.json(result)
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err)
			// #29: a persona/instructions self-edit blocked by the injection screen
			// is a client-side rejection, not a server fault.
			if (err instanceof Error && err.name === "SelfEditRejectedError") {
				return jsonError(c, 422, "SELF_EDIT_REJECTED", message)
			}
			return internalError(c, err, "SELF_EDIT_FAILED")
		}
	})
}
