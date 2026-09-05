import { randomUUID } from "node:crypto"
import type { MemoryScope } from "@memongo/lib"
import type { Db } from "mongodb"
import { createSubsystemLogger } from "@memongo/lib"
import { writeEvent, projectEventChunk } from "../mongodb-events.js"
import { extractAndUpsertEntities } from "../mongodb-graph.js"
import {
	extractStructuredCandidatesFromEvent,
	extractProcedureCandidatesFromEvent,
	promoteDerivedMemoryFromEvent,
	heuristicEpisodeSummarizer,
} from "../mongodb-derived-memory.js"
import { checkAutoEpisodeTriggers } from "../mongodb-episodes.js"
import { updateLaneCoverage } from "../mongodb-lane-coverage.js"
import { recordIngestRun } from "../mongodb-ops.js"
import { VALID_ROLES, VALID_SCOPES } from "../mongodb-search-ranking.js"
import { emitTelemetry } from "../mongodb-telemetry.js"

const log = createSubsystemLogger("memory:mongodb")

/**
 * Legacy inline write+project primitive, preserved for e2e harnesses only.
 *
 * WS-13 removed this function from the production surface
 * (`mongodb-manager-write.ts` / the manager re-export): it had no live
 * production callers — the manager's write path is `writeConversationEvent`
 * with the transactional extraction outbox — and it duplicated the lane
 * coverage / derived-memory logic that the job worker now owns. The e2e
 * suites (`real-e2e-v2`, `production-readiness`) use it as a convenience
 * primitive because it projects chunks and entities synchronously, with no
 * worker to drain, so assertions can inspect state immediately after the
 * call. It lives here, outside the package's production exports, so the
 * duplication is test-local and cannot regress back onto a live path.
 */
export async function writeEventAndProject(
	db: Db,
	prefix: string,
	event: {
		agentId: string
		role: string
		body: string
		scope: string
		sessionId?: string
		path?: string
		hash?: string
		metadata?: Record<string, unknown>
	},
	options?: {
		extractor?: import("../mongodb-entity-extractor.js").EntityExtractor
	},
): Promise<{ eventId: string; chunksCreated: number }> {
	const startMs = Date.now()
	try {
		// Validate scope and role before passing to writeEvent
		if (!VALID_SCOPES.has(event.scope)) {
			throw new Error(`Invalid scope: ${event.scope}`)
		}
		if (!VALID_ROLES.has(event.role)) {
			throw new Error(`Invalid role: ${event.role}`)
		}
		const written = await writeEvent({
			db,
			prefix,
			event: {
				eventId: randomUUID(),
				agentId: event.agentId,
				role: event.role as "user" | "assistant" | "system" | "tool",
				body: event.body,
				scope: event.scope as MemoryScope,
				sessionId: event.sessionId,
				channel: undefined,
				metadata: event.metadata,
			},
		})

		const projected = await projectEventChunk({
			db,
			prefix,
			event: {
				eventId: written.eventId,
				agentId: event.agentId,
				role: event.role as "user" | "assistant" | "system" | "tool",
				body: event.body,
				scope: event.scope as MemoryScope,
				scopeRef: written.scopeRef,
				timestamp: written.timestamp,
				...(event.sessionId ? { sessionId: event.sessionId } : {}),
				...(event.metadata ? { metadata: event.metadata } : {}),
			},
		})
		// Entity extraction (sync rule-based, non-blocking)
		let entityCount = 0
		try {
			const entityResult = await extractAndUpsertEntities({
				db,
				prefix,
				agentId: event.agentId,
				eventContent: event.body,
				scope: event.scope as MemoryScope,
				scopeRef: written.scopeRef,
				sourceEventId: written.eventId,
				extractor: options?.extractor,
			})
			entityCount = entityResult.entities.length
		} catch (err) {
			log.warn("entity extraction failed during writeEventAndProject", {
				error: err instanceof Error ? err.message : String(err),
				eventId: written.eventId,
			})
		}

		// Structured fact + procedure extraction (sync rule-based, non-blocking).
		// LLM-augmented promotion (issue #30) intentionally runs only in the
		// manager's background memory-job path (runBackgroundExtractionJob), never
		// inline here — extractSessionEnrichment is a 30s-timeout network call and
		// this function promotes synchronously on the write path.
		try {
			await promoteDerivedMemoryFromEvent({
				db,
				prefix,
				client: undefined,
				embeddingMode: "automated",
				event: {
					eventId: written.eventId,
					agentId: event.agentId,
					role: event.role as "user" | "assistant" | "system" | "tool",
					body: event.body,
					timestamp: written.timestamp,
					sessionId: event.sessionId,
					scope: event.scope as MemoryScope,
					scopeRef: written.scopeRef,
				},
			})
		} catch (err) {
			log.warn(
				"structured/procedure extraction failed during writeEventAndProject",
				{ error: err, eventId: written.eventId },
			)
		}

		// Episode trigger check (sync, non-blocking)
		// MUST capture result: episodeTriggered drives episodic lane coverage.
		let episodeTriggered = false
		try {
			const episodeResult = await checkAutoEpisodeTriggers({
				db,
				prefix,
				agentId: event.agentId,
				summarizer: heuristicEpisodeSummarizer,
				scope: event.scope as MemoryScope,
				scopeRef: written.scopeRef,
			})
			episodeTriggered = episodeResult.triggered
		} catch (err) {
			log.warn("episode trigger check failed during writeEventAndProject", {
				error: err instanceof Error ? err.message : String(err),
				eventId: written.eventId,
			})
		}

		// Lane coverage tracking (non-blocking)
		try {
			const increments: Record<string, number> = {
				"raw-window": 1, // every event populates raw-window
				hybrid: projected.chunkCreated ? 1 : 0,
			}
			if (entityCount > 0) {
				increments.graph = entityCount
			}
			// Structured lane counts regex/classification candidates only (P3.9):
			// the promotion resolver did a per-candidate findOne existence check
			// (N+1) and the counts only feed planner hints, never durable writes.
			// Regex-only, matching this function's regex-only promotion above.
			const candidates = extractStructuredCandidatesFromEvent({
				eventId: written.eventId,
				agentId: event.agentId,
				role: event.role as "user" | "assistant" | "system" | "tool",
				body: event.body,
				timestamp: written.timestamp,
				sessionId: event.sessionId,
				scope: event.scope as MemoryScope,
				scopeRef: written.scopeRef,
			})
			if (candidates.length > 0) {
				increments.structured = candidates.length
			}
			// Active-critical: check candidates for salience
			const criticalCount = candidates.filter(
				(c) => c.salience === "critical" || c.salience === "high",
			).length
			if (criticalCount > 0) {
				increments["active-critical"] = criticalCount
			}
			// Procedure lane: use candidate count from re-extraction
			const procedureCandidates = extractProcedureCandidatesFromEvent({
				eventId: written.eventId,
				agentId: event.agentId,
				role: event.role as "user" | "assistant" | "system" | "tool",
				body: event.body,
				timestamp: written.timestamp,
				sessionId: event.sessionId,
				scope: event.scope as MemoryScope,
				scopeRef: written.scopeRef,
			})
			if (procedureCandidates.length > 0) {
				increments.procedural = procedureCandidates.length
			}
			// Episodic lane: from captured checkAutoEpisodeTriggers result
			if (episodeTriggered) {
				increments.episodic = 1
			}
			await updateLaneCoverage({
				db,
				prefix,
				agentId: event.agentId,
				increments,
			})
		} catch (err) {
			log.warn("lane coverage update failed during writeEventAndProject", {
				error: err instanceof Error ? err.message : String(err),
				eventId: written.eventId,
			})
		}

		const durationMs = Date.now() - startMs
		await recordIngestRun({
			db,
			prefix,
			run: {
				agentId: event.agentId,
				source: "event-write",
				status: "ok",
				itemsProcessed: 1,
				itemsFailed: 0,
				durationMs,
			},
		})

		// Emit event-write telemetry (fire-and-forget)
		emitTelemetry(db, prefix, {
			meta: { agentId: event.agentId, operation: "event-write" },
			durationMs,
			ok: true,
			eventType: event.role,
			projectionTriggered: true,
		})

		return {
			eventId: written.eventId,
			chunksCreated: projected.chunkCreated ? 1 : 0,
		}
	} catch (err) {
		const durationMs = Date.now() - startMs
		await recordIngestRun({
			db,
			prefix,
			run: {
				agentId: event.agentId,
				source: "event-write",
				status: "failed",
				itemsProcessed: 0,
				itemsFailed: 1,
				durationMs,
			},
		}).catch((recErr) => {
			log.warn("recordIngestRun failed during error recovery", {
				error: recErr,
			})
		})
		log.error("writeEventAndProject failed", { error: err })
		throw err
	}
}
