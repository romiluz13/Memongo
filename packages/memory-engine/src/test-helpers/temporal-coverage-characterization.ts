import type { Db, Document } from "mongodb"
import { searchTemporalCoverageEvents } from "../mongodb-search-lanes.js"
import type { SearchTierOutcome } from "../search-outcomes.js"

// The temporal-coverage lane characterization fixture, captured before its
// session-scoped selector moved into its own module: the exact pipelines it
// sends and the exact results it returns must not change with the move.

const questionDate = new Date("2026-03-20T00:00:00Z")
const namespace = {
	agentId: "agent-fern",
	scope: "agent",
	scopeRef: "agent:fern",
} as const

function turn(
	eventId: string,
	sessionId: string,
	day: string,
	body: string,
	score = 1,
): Document {
	return {
		eventId,
		...namespace,
		sessionId,
		role: "user",
		body,
		timestamp: new Date(`2026-03-${day}T09:00:00Z`),
		score,
	}
}

const anchorHits = [
	turn("hit-a", "s-alder", "10", "we planted the orchard saplings", 4),
	turn("hit-b", "s-birch", "12", "orchard frost netting arrived", 3),
	turn("hit-c", "s-alder", "11", "the orchard needs mulch", 2),
]

const expansionRows = [
	turn("alder-1", "s-alder", "09", "good morning, quick question"),
	turn("alder-2", "s-alder", "10", "we planted the orchard saplings"),
	turn("alder-3", "s-alder", "11", "the orchard needs mulch"),
	turn("alder-4", "s-alder", "12", "orchard irrigation timer"),
	turn("birch-1", "s-birch", "12", "orchard frost netting arrived"),
	turn("birch-2", "s-birch", "13", "unrelated note about tea"),
	turn("stray-1", "s-cedar", "13", "orchard in another session"),
]

function database() {
	const pipelines: Document[][] = []
	const db = {
		collection: () => ({
			aggregate: (pipeline: Document[]) => {
				pipelines.push(pipeline)
				return {
					toArray: async () => {
						const isExpansion = pipeline[0]?.$search?.compound?.filter?.some(
							(clause: Document) => clause.in?.path === "sessionId",
						)
						return isExpansion ? expansionRows : anchorHits
					},
				}
			},
		}),
	} as unknown as Db
	return { db, pipelines }
}

export async function runCharacterizedTemporalCoverage() {
	const { db, pipelines } = database()
	const rows: SearchTierOutcome[] = []
	const results = await searchTemporalCoverageEvents({
		db,
		prefix: "mem_",
		query: "when did the orchard work happen recently",
		questionDate,
		...namespace,
		maxResults: 6,
		capabilities: {
			vectorSearch: true,
			textSearch: true,
			scoreFusion: false,
			rankFusion: true,
			storedSource: false,
			vectorIndexMethod: false,
		},
		onTierOutcome: (row) => rows.push(row),
	})
	return { pipelines, rows, results }
}
