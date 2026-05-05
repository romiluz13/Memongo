import { createHash } from "node:crypto"
import type { Db } from "mongodb"
import type { MemoryScope } from "@memongo/lib/types/memory"
import { createSubsystemLogger } from "@memongo/lib"
import { renderEventChunkText } from "./mongodb-events.js"
import { chunksCollection, eventsCollection } from "./mongodb-schema.js"

const log = createSubsystemLogger("memory:mongodb:conversation-windows")

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ConversationWindow = {
	sessionId: string
	windowIndex: number
	startTurnIndex: number
	endTurnIndex: number
	events: Array<{
		eventId: string
		role: string
		body: string
		timestamp: Date
	}>
	text: string // concatenated role-labeled text
}

// ---------------------------------------------------------------------------
// Pure function: build conversation windows from session events
// ---------------------------------------------------------------------------

/**
 * Build conversation windows from a list of session events.
 * Pure function -- no DB access.
 *
 * @param sessionId - Session identifier
 * @param events - Ordered list of events in the session
 * @param windowSize - Number of turns per window (default: 7)
 * @param overlap - Number of overlapping turns between adjacent windows (default: 2)
 * @returns Array of ConversationWindow objects (empty if < 5 events)
 */
export function buildConversationWindows(
	sessionId: string,
	events: ReadonlyArray<{
		eventId: string
		role: string
		body: string
		timestamp: Date
	}>,
	windowSize = 7,
	overlap = 2,
): ConversationWindow[] {
	if (events.length < 5) {
		return []
	}

	// Guard: overlap >= windowSize would make stride <= 0, causing infinite loop
	const stride = Math.max(1, windowSize - overlap)
	const windows: ConversationWindow[] = []
	let windowIndex = 0

	for (let start = 0; start < events.length; start += stride) {
		const end = Math.min(start + windowSize, events.length)
		const windowEvents = events.slice(start, end)

		const text = windowEvents
			.map((e) =>
				renderEventChunkText({
					role: e.role as "user" | "assistant" | "system" | "tool",
					body: e.body,
				}),
			)
			.join("\n")

		windows.push({
			sessionId,
			windowIndex,
			startTurnIndex: start,
			endTurnIndex: end - 1,
			events: windowEvents,
			text,
		})

		windowIndex++

		// If we've reached the end, stop
		if (end >= events.length) {
			break
		}
	}

	return windows
}

// ---------------------------------------------------------------------------
// Async function: project conversation windows into chunks collection
// ---------------------------------------------------------------------------

/**
 * Project conversation windows into the chunks collection.
 * Each window becomes a chunk at `windows/{sessionId}/{windowIndex}`.
 * Idempotent: uses upsert with path as unique key.
 *
 * Fetches all events for the session, builds windows, and upserts chunks.
 */
export async function projectConversationWindows(params: {
	db: Db
	prefix: string
	agentId: string
	sessionId: string
	scope: MemoryScope
	scopeRef: string
	windowSize?: number
	overlap?: number
}): Promise<{ windowsCreated: number }> {
	const { db, prefix, agentId, sessionId, scope, scopeRef } = params
	const windowSize = params.windowSize ?? 7
	const overlap = params.overlap ?? 2

	// Fetch all events for this session
	const eventsCol = eventsCollection(db, prefix)
	const rawResult = await eventsCol
		.find({ agentId, sessionId })
		.sort({ timestamp: 1 })
		.limit(1000)
		.toArray()
	const sessionEvents = rawResult as unknown as Array<{
		eventId: string
		role: string
		body: string
		timestamp: Date
	}>
	if (!Array.isArray(sessionEvents) || sessionEvents.length === 0) {
		return { windowsCreated: 0 }
	}

	const windows = buildConversationWindows(
		sessionId,
		sessionEvents,
		windowSize,
		overlap,
	)

	if (windows.length === 0) {
		return { windowsCreated: 0 }
	}

	const chunks = chunksCollection(db, prefix)
	let windowsCreated = 0

	for (const win of windows) {
		const path = `windows/${sessionId}/${win.windowIndex}`
		const hash = createHash("sha256").update(win.text).digest("hex")
		const now = new Date()

		await chunks.updateOne(
			{ path },
			{
				$set: {
					text: win.text,
					hash,
					source: "conversation",
					agentId,
					scope,
					scopeRef,
					updatedAt: now,
					sessionId,
					windowIndex: win.windowIndex,
					timestamp: win.events[0].timestamp,
				},
				$setOnInsert: {
					path,
					createdAt: now,
				},
			},
			{ upsert: true },
		)
		windowsCreated++
	}

	log.info(
		`projected ${windowsCreated} conversation windows for session=${sessionId} agent=${agentId}`,
	)
	return { windowsCreated }
}
