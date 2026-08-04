import type { Hono } from "hono"
import {
	memongoBridgeApplyMemoryFeedback,
	memongoBridgeDeleteLifecycleItem,
	memongoBridgeGetLifecycleHistory,
	memongoBridgeGetLifecycleItem,
	memongoBridgeUpdateLifecycleItem,
	memongoBridgeReportProcedureOutcome,
} from "@memongo/memory-bridge"
import { internalError, jsonError } from "../lib/errors.js"

import {
	MAX_HISTORY_LIMIT,
	readJsonBody,
	lifecycleHandleIdentityError,
	isRecord,
	readActorRole,
	readLifecycleHandle,
	readStructuredLifecyclePatch,
	readProcedureLifecyclePatch,
	type V1RouterEnv,
} from "./v1-helpers.js"

export function registerLifecycleRoutes(v1: Hono<V1RouterEnv>): void {
	v1.post("/lifecycle/get", async (c) => {
		const body = (await readJsonBody(c)) as Record<string, unknown>
		const handle = readLifecycleHandle(body.handle)
		if (!handle) {
			return jsonError(
				c,
				400,
				"VALIDATION_ERROR",
				"handle must be a valid structured/procedure stable handle",
			)
		}
		const identityError = await lifecycleHandleIdentityError(c, handle)
		if (identityError) {
			return jsonError(c, 403, "FORBIDDEN", identityError)
		}
		try {
			const item = await memongoBridgeGetLifecycleItem({ handle })
			if (!item) {
				return jsonError(c, 404, "NOT_FOUND", "memory not found")
			}
			return c.json(item)
		} catch (err) {
			return internalError(c, err, "LIFECYCLE_GET_FAILED")
		}
	})

	v1.post("/lifecycle/update", async (c) => {
		const body = (await readJsonBody(c)) as Record<string, unknown>
		const handle = readLifecycleHandle(body.handle)
		if (!handle) {
			return jsonError(
				c,
				400,
				"VALIDATION_ERROR",
				"handle must be a valid structured/procedure stable handle",
			)
		}
		const identityError = await lifecycleHandleIdentityError(c, handle)
		if (identityError) {
			return jsonError(c, 403, "FORBIDDEN", identityError)
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
			return internalError(c, err, "LIFECYCLE_UPDATE_FAILED")
		}
	})

	v1.post("/lifecycle/delete", async (c) => {
		const body = (await readJsonBody(c)) as Record<string, unknown>
		const handle = readLifecycleHandle(body.handle)
		if (!handle) {
			return jsonError(
				c,
				400,
				"VALIDATION_ERROR",
				"handle must be a valid structured/procedure stable handle",
			)
		}
		const identityError = await lifecycleHandleIdentityError(c, handle)
		if (identityError) {
			return jsonError(c, 403, "FORBIDDEN", identityError)
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
			return internalError(c, err, "LIFECYCLE_DELETE_FAILED")
		}
	})

	v1.post("/lifecycle/history", async (c) => {
		const body = (await readJsonBody(c)) as Record<string, unknown>
		const handle = readLifecycleHandle(body.handle)
		if (!handle) {
			return jsonError(
				c,
				400,
				"VALIDATION_ERROR",
				"handle must be a valid structured/procedure stable handle",
			)
		}
		const identityError = await lifecycleHandleIdentityError(c, handle)
		if (identityError) {
			return jsonError(c, 403, "FORBIDDEN", identityError)
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
			return internalError(c, err, "LIFECYCLE_HISTORY_FAILED")
		}
	})

	v1.post("/procedures/outcome", async (c) => {
		const body = (await readJsonBody(c)) as Record<string, unknown>
		const handle = readLifecycleHandle(body.handle)
		if (!handle || handle.family !== "procedure") {
			return jsonError(
				c,
				400,
				"VALIDATION_ERROR",
				"handle must be a valid procedure stable handle",
			)
		}
		const outcomeIdentityError = await lifecycleHandleIdentityError(c, handle)
		if (outcomeIdentityError) {
			return jsonError(c, 403, "FORBIDDEN", outcomeIdentityError)
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
			return internalError(c, err, "PROCEDURE_OUTCOME_FAILED")
		}
	})

	v1.post("/memory/feedback", async (c) => {
		const body = (await readJsonBody(c)) as Record<string, unknown>
		const handle = readLifecycleHandle(body.handle)
		if (!handle || handle.family !== "structured") {
			return jsonError(
				c,
				400,
				"VALIDATION_ERROR",
				"handle must be a valid structured memory stable handle",
			)
		}
		const feedbackIdentityError = await lifecycleHandleIdentityError(c, handle)
		if (feedbackIdentityError) {
			return jsonError(c, 403, "FORBIDDEN", feedbackIdentityError)
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
			return internalError(c, err, "MEMORY_FEEDBACK_FAILED")
		}
	})
}
