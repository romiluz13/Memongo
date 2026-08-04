import type { Hono } from "hono"
import {
	memongoBridgeBuildContextBundle,
	memongoBridgeBuildDiscoveryProjection,
	memongoBridgeHydrateActiveSlate,
	memongoBridgeReadFile,
} from "@memongo/memory-bridge"
import { internalError, jsonError } from "../lib/errors.js"

import {
	readAgentId,
	readJsonBody,
	readQuery,
	readSessionId,
	readScope,
	readScopeRef,
	readScopeInputError,
	readDiscoveryProjectionKind,
	type V1RouterEnv,
} from "./v1-helpers.js"

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
			const timeRange =
				typeof body.timeRange === "object" &&
				body.timeRange !== null &&
				!Array.isArray(body.timeRange)
					? (body.timeRange as Record<string, unknown>)
					: undefined
			const projection = await memongoBridgeBuildDiscoveryProjection({
				agentId: await readAgentId(c),
				kind,
				query: readQuery(body) || undefined,
				scope: await readScope(c),
				scopeRef: await readScopeRef(c),
				maxItems: typeof body.maxItems === "number" ? body.maxItems : undefined,
				timeRange: timeRange as
					| { preset?: string; start?: string; end?: string }
					| undefined,
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
			const timeRange =
				typeof body.timeRange === "object" &&
				body.timeRange !== null &&
				!Array.isArray(body.timeRange)
					? (body.timeRange as Record<string, unknown>)
					: undefined
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
				timeRange: timeRange as
					| { preset?: string; start?: string; end?: string }
					| undefined,
				mode: body.mode === "wake-up" ? "wake-up" : undefined,
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
}
