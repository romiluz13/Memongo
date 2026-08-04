import type { Hono } from "hono"
import {
	memongoBridgeGetDetailedStatus,
	memongoBridgeProbeEmbedding,
	memongoBridgeProbeVector,
	memongoBridgeProfile,
	memongoBridgeGetState,
	memongoBridgeStats,
	memongoBridgeStatus,
	memongoBridgeSync,
} from "@memongo/memory-bridge"
import { internalError, jsonError } from "../lib/errors.js"
import { MEMONGO_API_VERSION } from "../version.js"

import {
	readAgentId,
	readJsonBody,
	readScope,
	readScopeRef,
	readScopeInputError,
	type V1RouterEnv,
} from "./v1-helpers.js"

export function registerStatusRoutes(v1: Hono<V1RouterEnv>): void {
	v1.post("/profile", async (c) => {
		const body = (await readJsonBody(c)) as Record<string, unknown>
		const scopeError = await readScopeInputError(c)
		if (scopeError) {
			return jsonError(c, 400, "VALIDATION_ERROR", scopeError)
		}
		try {
			const profile = await memongoBridgeProfile({
				agentId: await readAgentId(c),
				scope: await readScope(c),
				scopeRef: await readScopeRef(c),
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
			return internalError(c, err, "PROFILE_FAILED")
		}
	})

	v1.get("/state", async (c) => {
		const scopeError = await readScopeInputError(c)
		if (scopeError) {
			return jsonError(c, 400, "VALIDATION_ERROR", scopeError)
		}
		const agentId = await readAgentId(c)
		const scope = await readScope(c)
		const scopeRef = await readScopeRef(c)
		try {
			const state = await memongoBridgeGetState({ agentId, scope, scopeRef })
			return c.json(state)
		} catch (err) {
			return internalError(c, err, "STATE_FAILED")
		}
	})

	v1.get("/status", async (c) => {
		const agentId = c.req.query("agentId") ?? undefined
		try {
			const status = await memongoBridgeStatus({ agentId })
			// Echo the server release version so clients can detect version skew
			// against their `x-memongo-client-version` header.
			return c.json({ version: MEMONGO_API_VERSION, ...status })
		} catch (err) {
			return internalError(c, err, "STATUS_FAILED")
		}
	})

	v1.get("/status/detailed", async (c) => {
		const agentId = c.req.query("agentId") ?? undefined
		try {
			const status = await memongoBridgeGetDetailedStatus({ agentId })
			return c.json(status)
		} catch (err) {
			return internalError(c, err, "DETAILED_STATUS_FAILED")
		}
	})

	v1.get("/stats", async (c) => {
		const agentId = c.req.query("agentId") ?? undefined
		try {
			const stats = await memongoBridgeStats({ agentId })
			return c.json(stats)
		} catch (err) {
			return internalError(c, err, "STATS_FAILED")
		}
	})

	v1.post("/sync", async (c) => {
		const body = (await readJsonBody(c)) as Record<string, unknown>
		try {
			await memongoBridgeSync({
				agentId: await readAgentId(c),
				reason: typeof body.reason === "string" ? body.reason : undefined,
				force: typeof body.force === "boolean" ? body.force : undefined,
			})
			return c.json({ ok: true })
		} catch (err) {
			return internalError(c, err, "SYNC_FAILED")
		}
	})

	v1.get("/probes/embedding", async (c) => {
		const agentId = c.req.query("agentId") ?? undefined
		try {
			const result = await memongoBridgeProbeEmbedding({ agentId })
			return c.json(result)
		} catch (err) {
			return internalError(c, err, "PROBE_EMBEDDING_FAILED")
		}
	})

	v1.get("/probes/vector", async (c) => {
		const agentId = c.req.query("agentId") ?? undefined
		try {
			const ok = await memongoBridgeProbeVector({ agentId })
			return c.json({ ok })
		} catch (err) {
			return internalError(c, err, "PROBE_VECTOR_FAILED")
		}
	})
}
