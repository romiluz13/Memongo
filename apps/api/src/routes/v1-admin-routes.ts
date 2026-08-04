import type { Hono } from "hono"
import {
	memongoBridgeAccessSummaries,
	memongoBridgeAccessTrends,
	memongoBridgeGetMemoryJob,
	memongoBridgeGetRecallTrace,
	memongoBridgeListMemoryJobs,
	memongoBridgeListRecallTraces,
	memongoBridgeRelevanceExplain,
	memongoBridgeRelevanceReport,
	memongoBridgeRelevanceSampleRate,
} from "@memongo/memory-bridge"
import { internalError, jsonError } from "../lib/errors.js"

import {
	readAgentId,
	readJsonBody,
	parseListLimit,
	readAccessCollection,
	type V1RouterEnv,
} from "./v1-helpers.js"

export function registerAdminRoutes(v1: Hono<V1RouterEnv>): void {
	v1.post("/admin/relevance/explain", async (c) => {
		const body = (await readJsonBody(c)) as Record<string, unknown>
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
				agentId: await readAgentId(c),
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
			return internalError(c, err, "RELEVANCE_EXPLAIN_FAILED")
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
			return internalError(c, err, "RELEVANCE_REPORT_FAILED")
		}
	})

	v1.get("/admin/relevance/sample-rate", async (c) => {
		const agentId = c.req.query("agentId") ?? undefined
		try {
			const out = await memongoBridgeRelevanceSampleRate({ agentId })
			return c.json(out)
		} catch (err) {
			return internalError(c, err, "RELEVANCE_SAMPLE_RATE_FAILED")
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
			return internalError(c, err, "ACCESS_TRENDS_FAILED")
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
			return internalError(c, err, "ACCESS_SUMMARIES_FAILED")
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
			return internalError(c, err, "TRACE_LIST_FAILED")
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
			return internalError(c, err, "TRACE_GET_FAILED")
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
			return internalError(c, err, "JOB_LIST_FAILED")
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
			return internalError(c, err, "JOB_GET_FAILED")
		}
	})
}
