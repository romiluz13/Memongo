/* eslint-disable @typescript-eslint/unbound-method -- Vitest mock method assertions */
import type { Db, Collection, Document } from "mongodb"
import { describe, it, expect, vi, beforeEach } from "vitest"

// Mock mongodb-events.js for checkAutoEpisodeTriggers tests
vi.mock("./mongodb-events.js", () => ({
	getEventsByTimeRange: vi.fn().mockResolvedValue([]),
	getUnconsolidatedEvents: vi.fn().mockResolvedValue([]),
	markEventsConsolidated: vi.fn().mockResolvedValue(0),
}))

import {
	hashSourceEventIds,
	materializeEpisode,
	getEpisodesByTimeRange,
	getEpisodesByType,
	searchEpisodes,
	checkAutoEpisodeTriggers,
	getEpisodesByIds,
	type Episode,
	type EpisodeSummarizer,
} from "./mongodb-episodes.js"
import {
	getUnconsolidatedEvents,
	markEventsConsolidated,
	getEventsByTimeRange as getEventsByTimeRangeMock,
} from "./mongodb-events.js"

// ---------------------------------------------------------------------------
// Helpers: stub MongoDB collection
// ---------------------------------------------------------------------------

function createMockCollection(
	overrides: Partial<Record<string, unknown>> = {},
): Collection {
	return {
		updateOne: vi.fn().mockResolvedValue({
			upsertedCount: 1,
			matchedCount: 0,
			modifiedCount: 0,
		}),
		find: vi.fn().mockReturnValue({
			sort: vi.fn().mockReturnValue({
				limit: vi.fn().mockReturnValue({
					toArray: vi.fn().mockResolvedValue([]),
				}),
			}),
			toArray: vi.fn().mockResolvedValue([]),
		}),
		...overrides,
	} as unknown as Collection
}

function createMockDb(collections: Record<string, Collection>): Db {
	return {
		collection: vi.fn((name: string) => {
			return collections[name] ?? createMockCollection()
		}),
	} as unknown as Db
}

const PREFIX = "test_"
const AGENT_ID = "agent-1"

const mockSummarizer: EpisodeSummarizer = vi.fn().mockResolvedValue({
	title: "Daily Standup Notes",
	summary: "Discussed project roadmap and blockers",
	tags: ["standup", "planning"],
})

function makeEventDocs(count: number, start: Date): Document[] {
	const docs: Document[] = []
	for (let i = 0; i < count; i++) {
		docs.push({
			eventId: `evt-${i}`,
			agentId: AGENT_ID,
			role: i % 2 === 0 ? "user" : "assistant",
			body: `Message ${i}`,
			scope: "agent",
			timestamp: new Date(start.getTime() + i * 60_000),
		})
	}
	return docs
}

function makeEpisodeDoc(overrides: Partial<Episode> = {}): Document {
	return {
		episodeId: "ep-1",
		type: "daily",
		title: "Daily Standup Notes",
		summary: "Discussed project roadmap and blockers",
		agentId: AGENT_ID,
		scope: "agent",
		timeRange: {
			start: new Date("2026-03-15T09:00:00Z"),
			end: new Date("2026-03-15T10:00:00Z"),
		},
		sourceEventCount: 5,
		sourceEventIds: ["evt-0", "evt-1", "evt-2", "evt-3", "evt-4"],
		tags: ["standup", "planning"],
		updatedAt: new Date("2026-03-15T10:00:00Z"),
		...overrides,
	}
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("mongodb-episodes", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	// These checks are validated in the live MongoDB suite in
	// src/memory/real-e2e-v2.e2e.test.ts. The mocked-events seam in this file is
	// still too stale to trust for episode materialization behavior.
	describe("episode hardening", () => {
		it("returns the persisted episodeId when re-materializing an existing episode", async () => {
			const start = new Date("2026-03-15T09:00:00Z")
			const end = new Date("2026-03-15T10:00:00Z")
			const eventDocs = makeEventDocs(4, start)
			vi.mocked(getEventsByTimeRangeMock).mockResolvedValue(eventDocs as never)

			const episodesCol = createMockCollection({
				updateOne: vi.fn().mockResolvedValue({
					upsertedCount: 0,
					matchedCount: 1,
					modifiedCount: 1,
				}),
			})
			;(
				episodesCol as unknown as { findOne: ReturnType<typeof vi.fn> }
			).findOne = vi.fn().mockResolvedValue({ episodeId: "ep-existing" })
			const db = createMockDb({
				[`${PREFIX}episodes`]: episodesCol,
			})

			const result = await materializeEpisode({
				db,
				prefix: PREFIX,
				agentId: AGENT_ID,
				type: "daily",
				timeRange: { start, end },
				summarizer: mockSummarizer,
			})

			expect(result).not.toBeNull()
			expect(result?.episodeId).toBe("ep-existing")
			expect(
				(episodesCol as unknown as { findOne: ReturnType<typeof vi.fn> })
					.findOne,
			).toHaveBeenCalledOnce()
		})

		it("keeps auto episodes scoped by scopeRef and consolidates only the pre-gap window", async () => {
			const start = new Date("2026-03-15T09:00:00Z")
			const events = [
				{
					eventId: "evt-1",
					agentId: AGENT_ID,
					role: "user",
					body: "Morning update",
					scope: "workspace",
					scopeRef: "workspace:one",
					timestamp: new Date(start.getTime()),
				},
				{
					eventId: "evt-2",
					agentId: AGENT_ID,
					role: "assistant",
					body: "Captured",
					scope: "workspace",
					scopeRef: "workspace:one",
					timestamp: new Date(start.getTime() + 60_000),
				},
				{
					eventId: "evt-3",
					agentId: AGENT_ID,
					role: "user",
					body: "New topic after a long gap",
					scope: "workspace",
					scopeRef: "workspace:one",
					timestamp: new Date(start.getTime() + 120 * 60_000),
				},
			]

			vi.mocked(getUnconsolidatedEvents).mockResolvedValue(events as never)
			vi.mocked(getEventsByTimeRangeMock).mockResolvedValue(
				events.slice(0, 2) as never,
			)

			const findResult = {
				sort: vi.fn().mockReturnValue({
					limit: vi.fn().mockReturnValue({
						toArray: vi.fn().mockResolvedValue([]),
					}),
				}),
			}
			const episodesCol = createMockCollection({
				find: vi.fn().mockReturnValue(findResult),
			})
			const db = createMockDb({
				[`${PREFIX}episodes`]: episodesCol,
			})

			const result = await checkAutoEpisodeTriggers({
				db,
				prefix: PREFIX,
				agentId: AGENT_ID,
				summarizer: mockSummarizer,
				scope: "workspace",
				scopeRef: "workspace:one",
				sessionGapMinutes: 30,
			})

			expect(result.triggered).toBe(true)
			expect(vi.mocked(getUnconsolidatedEvents)).toHaveBeenCalledWith(
				expect.objectContaining({
					scope: "workspace",
					scopeRef: "workspace:one",
				}),
			)
			expect(episodesCol.find).toHaveBeenCalledWith(
				expect.objectContaining({
					scope: "workspace",
					scopeRef: "workspace:one",
				}),
			)
			expect(vi.mocked(markEventsConsolidated)).toHaveBeenCalledWith(
				expect.objectContaining({
					eventIds: ["evt-1", "evt-2"],
				}),
			)
		})
	})

	// Covered by live episode materialization in src/memory/real-e2e-v2.e2e.test.ts.
	// This block still depends on a stale mocked-events seam.
	describe("materializeEpisode", () => {
		it("creates an episode from a time range of events", async () => {
			const start = new Date("2026-03-15T09:00:00Z")
			const end = new Date("2026-03-15T10:00:00Z")
			const eventDocs = makeEventDocs(5, start)

			// Mock getEventsByTimeRange to return events (module-level mock)
			vi.mocked(getEventsByTimeRangeMock).mockResolvedValue(eventDocs as never)

			// Episodes collection for the upsert
			const episodesCol = createMockCollection()
			const db = createMockDb({
				[`${PREFIX}episodes`]: episodesCol,
			})

			const result = await materializeEpisode({
				db,
				prefix: PREFIX,
				agentId: AGENT_ID,
				type: "daily",
				timeRange: { start, end },
				summarizer: mockSummarizer,
			})

			expect(result).not.toBeNull()
			expect(result?.type).toBe("daily")
			expect(result?.title).toBe("Daily Standup Notes")
			expect(result?.summary).toBe("Discussed project roadmap and blockers")
			expect(result?.agentId).toBe(AGENT_ID)
			expect(result?.sourceEventCount).toBe(5)
			expect(result?.timeRange.start).toEqual(start)
			expect(result?.timeRange.end).toEqual(end)

			// Verify summarizer was called with events
			expect(mockSummarizer).toHaveBeenCalledOnce()
			const summarizerArgs = (mockSummarizer as ReturnType<typeof vi.fn>).mock
				.calls[0][0]
			expect(summarizerArgs).toHaveLength(5)
			expect(summarizerArgs[0].role).toBe("user")
			expect(summarizerArgs[0].body).toBe("Message 0")

			// Verify upsert was called on episodes collection
			expect(episodesCol.updateOne).toHaveBeenCalledOnce()
		})

		it("enforces the per-scope cap by deleting the oldest episodes beyond it (WS-13)", async () => {
			vi.stubEnv("MEMONGO_EPISODES_MAX_PER_SCOPE", "3")
			try {
				const start = new Date("2026-03-15T09:00:00Z")
				vi.mocked(getEventsByTimeRangeMock).mockResolvedValue(
					makeEventDocs(2, start) as never,
				)
				const countDocuments = vi.fn(async () => 5)
				const findOverflow = vi
					.fn()
					.mockReturnValue({ toArray: vi.fn(async () => [
						{ episodeId: "ep-old-1" },
						{ episodeId: "ep-old-2" },
					]) })
				const deleteMany = vi.fn(async () => ({ deletedCount: 2 }))
				const episodesCol = createMockCollection({
					countDocuments,
					find: findOverflow,
					deleteMany,
				})
				const db = createMockDb({
					[`${PREFIX}episodes`]: episodesCol,
				})

				await materializeEpisode({
					db,
					prefix: PREFIX,
					agentId: AGENT_ID,
					type: "daily",
					timeRange: { start, end: new Date("2026-03-15T10:00:00Z") },
					summarizer: mockSummarizer,
				})

				const scopeFilter = {
					agentId: AGENT_ID,
					scope: "agent",
					scopeRef: "agent:agent-1",
				}
				// 5 stored, cap 3 → the 2 oldest (createdAt asc) go.
				expect(countDocuments).toHaveBeenCalledWith(scopeFilter)
				expect(findOverflow).toHaveBeenCalledWith(scopeFilter, {
					sort: { createdAt: 1 },
					limit: 2,
					projection: { episodeId: 1 },
				})
				expect(deleteMany).toHaveBeenCalledWith({
					agentId: AGENT_ID,
					episodeId: { $in: ["ep-old-1", "ep-old-2"] },
				})
			} finally {
				vi.unstubAllEnvs()
			}
		})

		it("leaves the scope alone when the count is within the cap (WS-13)", async () => {
			vi.stubEnv("MEMONGO_EPISODES_MAX_PER_SCOPE", "3")
			try {
				const start = new Date("2026-03-15T09:00:00Z")
				vi.mocked(getEventsByTimeRangeMock).mockResolvedValue(
					makeEventDocs(2, start) as never,
				)
				const countDocuments = vi.fn(async () => 3)
				const findOverflow = vi.fn()
				const deleteMany = vi.fn()
				const episodesCol = createMockCollection({
					countDocuments,
					find: findOverflow,
					deleteMany,
				})
				const db = createMockDb({
					[`${PREFIX}episodes`]: episodesCol,
				})

				await materializeEpisode({
					db,
					prefix: PREFIX,
					agentId: AGENT_ID,
					type: "daily",
					timeRange: { start, end: new Date("2026-03-15T10:00:00Z") },
					summarizer: mockSummarizer,
				})

				expect(countDocuments).toHaveBeenCalledOnce()
				expect(findOverflow).not.toHaveBeenCalled()
				expect(deleteMany).not.toHaveBeenCalled()
			} finally {
				vi.unstubAllEnvs()
			}
		})

		it("skips cap enforcement entirely when the cap is disabled (WS-13)", async () => {
			vi.stubEnv("MEMONGO_EPISODES_MAX_PER_SCOPE", "0")
			try {
				const start = new Date("2026-03-15T09:00:00Z")
				vi.mocked(getEventsByTimeRangeMock).mockResolvedValue(
					makeEventDocs(2, start) as never,
				)
				const countDocuments = vi.fn()
				const episodesCol = createMockCollection({ countDocuments })
				const db = createMockDb({
					[`${PREFIX}episodes`]: episodesCol,
				})

				await materializeEpisode({
					db,
					prefix: PREFIX,
					agentId: AGENT_ID,
					type: "daily",
					timeRange: { start, end: new Date("2026-03-15T10:00:00Z") },
					summarizer: mockSummarizer,
				})

				expect(countDocuments).not.toHaveBeenCalled()
			} finally {
				vi.unstubAllEnvs()
			}
		})

		it("passes the episode type to the summarizer so lenses differ", async () => {
			// Without this, a daily, a topic and a decision episode over one window
			// are byte-identical clones — the summarizer had no way to tell them
			// apart — and all three surface together in a single search.
			const start = new Date("2026-03-15T09:00:00Z")
			vi.mocked(getEventsByTimeRangeMock).mockResolvedValue(
				makeEventDocs(4, start) as never,
			)
			const episodesCol = createMockCollection()
			const db = createMockDb({ [`${PREFIX}episodes`]: episodesCol })

			await materializeEpisode({
				db,
				prefix: PREFIX,
				agentId: AGENT_ID,
				type: "decision",
				timeRange: { start, end: new Date(start.getTime() + 3_600_000) },
				summarizer: mockSummarizer,
			})

			expect(mockSummarizer).toHaveBeenCalledWith(expect.any(Array), "decision")
		})

		it("keys episode identity on the event set, not the query window", async () => {
			// The auto-trigger derives timeRange from whichever event window it
			// happened to select (resolveTriggeredEpisodeWindow), so two runs over
			// the SAME events can produce slightly different window boundaries.
			// When timeRange was part of the upsert identity, that jitter minted a
			// brand-new episode over identical content — observed live as three
			// episode documents with byte-identical summaries and identical
			// 18-element sourceEventIds, all competing for retrieval slots.
			const start = new Date("2026-03-15T09:00:00Z")
			const end = new Date("2026-03-15T10:00:00Z")
			const eventDocs = makeEventDocs(5, start)
			vi.mocked(getEventsByTimeRangeMock).mockResolvedValue(eventDocs as never)

			const episodesCol = createMockCollection()
			const db = createMockDb({ [`${PREFIX}episodes`]: episodesCol })

			await materializeEpisode({
				db,
				prefix: PREFIX,
				agentId: AGENT_ID,
				type: "daily",
				timeRange: { start, end },
				summarizer: mockSummarizer,
			})
			// Same events, a window widened by one second.
			await materializeEpisode({
				db,
				prefix: PREFIX,
				agentId: AGENT_ID,
				type: "daily",
				timeRange: { start, end: new Date(end.getTime() + 1000) },
				summarizer: mockSummarizer,
			})

			const calls = (episodesCol.updateOne as ReturnType<typeof vi.fn>).mock
				.calls
			expect(calls).toHaveLength(2)
			const [filterA] = calls[0]
			const [filterB] = calls[1]

			// Both runs must address the SAME document.
			expect(filterA).toEqual(filterB)
			// The window must not be part of that address...
			expect(filterA["timeRange.start"]).toBeUndefined()
			expect(filterA["timeRange.end"]).toBeUndefined()
			// ...and the event set must be.
			expect(typeof filterA.sourceEventsHash).toBe("string")
			expect(filterA.sourceEventsHash).toHaveLength(64)

			// timeRange is still recorded, just as derived data rather than identity.
			const [, updateA] = calls[0]
			expect(updateA.$set.timeRange).toEqual({ start, end })
		})

		it("gives a different identity to a genuinely different event set", async () => {
			const start = new Date("2026-03-15T09:00:00Z")
			const end = new Date("2026-03-15T10:00:00Z")
			const episodesCol = createMockCollection()
			const db = createMockDb({ [`${PREFIX}episodes`]: episodesCol })

			vi.mocked(getEventsByTimeRangeMock).mockResolvedValue(
				makeEventDocs(5, start) as never,
			)
			await materializeEpisode({
				db,
				prefix: PREFIX,
				agentId: AGENT_ID,
				type: "daily",
				timeRange: { start, end },
				summarizer: mockSummarizer,
			})
			vi.mocked(getEventsByTimeRangeMock).mockResolvedValue(
				makeEventDocs(6, start) as never,
			)
			await materializeEpisode({
				db,
				prefix: PREFIX,
				agentId: AGENT_ID,
				type: "daily",
				timeRange: { start, end },
				summarizer: mockSummarizer,
			})

			const calls = (episodesCol.updateOne as ReturnType<typeof vi.fn>).mock
				.calls
			expect(calls[0][0].sourceEventsHash).not.toBe(
				calls[1][0].sourceEventsHash,
			)
		})

		it("stores sourceEventCount and sample sourceEventIds", async () => {
			const start = new Date("2026-03-15T09:00:00Z")
			const end = new Date("2026-03-15T10:00:00Z")
			const eventDocs = makeEventDocs(5, start)

			vi.mocked(getEventsByTimeRangeMock).mockResolvedValue(eventDocs as never)

			const episodesCol = createMockCollection()
			const db = createMockDb({
				[`${PREFIX}episodes`]: episodesCol,
			})

			const result = await materializeEpisode({
				db,
				prefix: PREFIX,
				agentId: AGENT_ID,
				type: "daily",
				timeRange: { start, end },
				summarizer: mockSummarizer,
			})

			expect(result).not.toBeNull()
			expect(result?.sourceEventCount).toBe(5)
			expect(result?.sourceEventIds).toBeDefined()
			expect(result?.sourceEventIds).toEqual([
				"evt-0",
				"evt-1",
				"evt-2",
				"evt-3",
				"evt-4",
			])

			// Verify the upsert includes sourceEventCount and sourceEventIds
			const [, update] = (episodesCol.updateOne as ReturnType<typeof vi.fn>)
				.mock.calls[0]
			expect(update.$set.sourceEventCount).toBe(5)
			expect(update.$set.sourceEventIds).toEqual([
				"evt-0",
				"evt-1",
				"evt-2",
				"evt-3",
				"evt-4",
			])
		})

		it("returns null when fewer than 2 events in time range", async () => {
			const start = new Date("2026-03-15T09:00:00Z")
			const end = new Date("2026-03-15T10:00:00Z")
			const eventDocs = makeEventDocs(1, start)

			vi.mocked(getEventsByTimeRangeMock).mockResolvedValue(eventDocs as never)

			const episodesCol = createMockCollection()
			const db = createMockDb({
				[`${PREFIX}episodes`]: episodesCol,
			})

			const result = await materializeEpisode({
				db,
				prefix: PREFIX,
				agentId: AGENT_ID,
				type: "daily",
				timeRange: { start, end },
				summarizer: mockSummarizer,
			})

			expect(result).toBeNull()
			// Summarizer should NOT be called
			expect(mockSummarizer).not.toHaveBeenCalled()
			// No upsert should happen
			expect(episodesCol.updateOne).not.toHaveBeenCalled()
		})
	})

	describe("getEpisodesByTimeRange", () => {
		it("returns episodes overlapping the range", async () => {
			const episodeDoc = makeEpisodeDoc()
			const findResult = {
				sort: vi.fn().mockReturnValue({
					limit: vi.fn().mockReturnValue({
						toArray: vi.fn().mockResolvedValue([episodeDoc]),
					}),
				}),
			}
			const episodesCol = createMockCollection({
				find: vi.fn().mockReturnValue(findResult),
			})
			const db = createMockDb({ [`${PREFIX}episodes`]: episodesCol })

			const results = await getEpisodesByTimeRange({
				db,
				prefix: PREFIX,
				agentId: AGENT_ID,
				start: new Date("2026-03-15T08:00:00Z"),
				end: new Date("2026-03-15T11:00:00Z"),
			})

			expect(results).toHaveLength(1)
			expect(results[0].episodeId).toBe("ep-1")
			expect(results[0].type).toBe("daily")

			// Verify the overlap query: episode.timeRange.start <= end AND episode.timeRange.end >= start
			const [filter] = (episodesCol.find as ReturnType<typeof vi.fn>).mock
				.calls[0]
			expect(filter.agentId).toBe(AGENT_ID)
			expect(filter["timeRange.start"]).toEqual({
				$lte: new Date("2026-03-15T11:00:00Z"),
			})
			expect(filter["timeRange.end"]).toEqual({
				$gte: new Date("2026-03-15T08:00:00Z"),
			})
		})
	})

	describe("getEpisodesByType", () => {
		it("returns episodes of a given type", async () => {
			const episodeDoc = makeEpisodeDoc()
			const findResult = {
				sort: vi.fn().mockReturnValue({
					limit: vi.fn().mockReturnValue({
						toArray: vi.fn().mockResolvedValue([episodeDoc]),
					}),
				}),
			}
			const episodesCol = createMockCollection({
				find: vi.fn().mockReturnValue(findResult),
			})
			const db = createMockDb({ [`${PREFIX}episodes`]: episodesCol })

			const results = await getEpisodesByType({
				db,
				prefix: PREFIX,
				agentId: AGENT_ID,
				type: "daily",
			})

			expect(results).toHaveLength(1)
			expect(results[0].type).toBe("daily")

			const [filter] = (episodesCol.find as ReturnType<typeof vi.fn>).mock
				.calls[0]
			expect(filter).toEqual({
				agentId: AGENT_ID,
				type: "daily",
				status: { $ne: "deleted" },
			})
		})
	})

	describe("searchEpisodes", () => {
		it("uses regex search on summary/title", async () => {
			const episodeDoc = makeEpisodeDoc()
			const findResult = {
				sort: vi.fn().mockReturnValue({
					limit: vi.fn().mockReturnValue({
						toArray: vi.fn().mockResolvedValue([episodeDoc]),
					}),
				}),
			}
			const episodesCol = createMockCollection({
				find: vi.fn().mockReturnValue(findResult),
			})
			const db = createMockDb({ [`${PREFIX}episodes`]: episodesCol })

			const results = await searchEpisodes({
				db,
				prefix: PREFIX,
				query: "standup",
				agentId: AGENT_ID,
			})

			expect(results).toHaveLength(1)
			expect(results[0].title).toBe("Daily Standup Notes")

			// Verify $regex search on title/summary with $or
			const [filter] = (episodesCol.find as ReturnType<typeof vi.fn>).mock
				.calls[0]
			expect(filter.agentId).toBe(AGENT_ID)
			expect(filter.$or).toBeDefined()
			expect(filter.$or).toHaveLength(2)
		})

		it("routes through $search autocomplete on episode_autocomplete when textSearch capability is on (P3.8)", async () => {
			const episodeDoc = makeEpisodeDoc()
			const episodesCol = createMockCollection({
				aggregate: vi.fn().mockReturnValue({
					toArray: vi.fn().mockResolvedValue([episodeDoc]),
				}),
			})
			const db = createMockDb({ [`${PREFIX}episodes`]: episodesCol })

			const results = await searchEpisodes({
				db,
				prefix: PREFIX,
				query: "standup",
				agentId: AGENT_ID,
				textSearchAvailable: true,
			})

			expect(results).toHaveLength(1)
			expect(results[0].title).toBe("Daily Standup Notes")

			// No request-path $regex scan when the search index can serve it
			expect(episodesCol.find).not.toHaveBeenCalled()
			const aggCalls = (episodesCol.aggregate as ReturnType<typeof vi.fn>).mock
				.calls
			expect(aggCalls).toHaveLength(1)
			const pipeline = aggCalls[0][0] as Document[]
			const searchStage = pipeline[0].$search as Record<string, unknown>
			expect(searchStage.index).toBe("episode_autocomplete")
			const compound = searchStage.compound as Record<string, unknown>
			const shouldClauses = compound.should as Array<Record<string, unknown>>
			expect(shouldClauses[0]).toHaveProperty("autocomplete")
			// Tenant isolation is a search filter, not a post-filter
			const filterClauses = compound.filter as Array<Record<string, unknown>>
			expect(filterClauses).toContainEqual({
				equals: { path: "agentId", value: AGENT_ID },
			})
			// P3.8: user-driven $search pipelines carry a maxTimeMS ceiling
			const options = aggCalls[0][1] as { maxTimeMS?: number } | undefined
			expect(typeof options?.maxTimeMS).toBe("number")
		})

		it("falls back to the escaped $regex path when $search fails at runtime", async () => {
			const episodeDoc = makeEpisodeDoc()
			const findResult = {
				sort: vi.fn().mockReturnValue({
					limit: vi.fn().mockReturnValue({
						toArray: vi.fn().mockResolvedValue([episodeDoc]),
					}),
				}),
			}
			const episodesCol = createMockCollection({
				aggregate: vi.fn().mockReturnValue({
					toArray: vi.fn().mockRejectedValue(new Error("mongot unavailable")),
				}),
				find: vi.fn().mockReturnValue(findResult),
			})
			const db = createMockDb({ [`${PREFIX}episodes`]: episodesCol })

			const results = await searchEpisodes({
				db,
				prefix: PREFIX,
				query: "standup",
				agentId: AGENT_ID,
				textSearchAvailable: true,
			})

			expect(episodesCol.aggregate).toHaveBeenCalledOnce()
			expect(episodesCol.find).toHaveBeenCalledOnce()
			expect(results).toHaveLength(1)
		})

		it("keeps the regex fallback escaped when textSearch capability is off", async () => {
			const findResult = {
				sort: vi.fn().mockReturnValue({
					limit: vi.fn().mockReturnValue({
						toArray: vi.fn().mockResolvedValue([]),
					}),
				}),
			}
			const episodesCol = createMockCollection({
				aggregate: vi.fn(),
				find: vi.fn().mockReturnValue(findResult),
			})
			const db = createMockDb({ [`${PREFIX}episodes`]: episodesCol })

			await searchEpisodes({
				db,
				prefix: PREFIX,
				query: "a+b testing",
				agentId: AGENT_ID,
				textSearchAvailable: false,
			})

			expect(episodesCol.aggregate).not.toHaveBeenCalled()
			const [filter] = (episodesCol.find as ReturnType<typeof vi.fn>).mock
				.calls[0]
			const titleRegex = filter.$or?.[0]?.title?.$regex as RegExp
			expect(titleRegex).toBeInstanceOf(RegExp)
			// Metacharacters inside a keyword must be escaped, not interpreted.
			expect(titleRegex.source).toBe("a\\+b|testing")
		})
	})

	// Covered by live episode materialization and scope-aware upserts.
	describe("idempotent upsert", () => {
		it("duplicate materialization for same time range updates existing episode", async () => {
			const start = new Date("2026-03-15T09:00:00Z")
			const end = new Date("2026-03-15T10:00:00Z")
			const eventDocs = makeEventDocs(5, start)

			vi.mocked(getEventsByTimeRangeMock).mockResolvedValue(eventDocs as never)

			// Episodes collection: second call means update (upsertedCount: 0)
			const episodesCol = createMockCollection({
				updateOne: vi.fn().mockResolvedValue({
					upsertedCount: 0,
					matchedCount: 1,
					modifiedCount: 1,
				}),
				findOne: vi.fn().mockResolvedValue({ episodeId: "ep-existing" }),
			})
			const db = createMockDb({
				[`${PREFIX}episodes`]: episodesCol,
			})

			const result = await materializeEpisode({
				db,
				prefix: PREFIX,
				agentId: AGENT_ID,
				type: "daily",
				timeRange: { start, end },
				summarizer: mockSummarizer,
			})

			expect(result).not.toBeNull()

			// Verify the upsert filter uses the idempotent key
			const [filter, , opts] = (
				episodesCol.updateOne as ReturnType<typeof vi.fn>
			).mock.calls[0]
			expect(filter.agentId).toBe(AGENT_ID)
			expect(filter.type).toBe("daily")
			// The idempotent key is the event set, not the query window — a window
			// that shifts by a fraction of a second must still address the same
			// episode. See "keys episode identity on the event set" above.
			expect(filter.sourceEventsHash).toEqual(
				hashSourceEventIds(["evt-0", "evt-1", "evt-2", "evt-3", "evt-4"]),
			)
			expect(opts).toEqual({ upsert: true })
			expect(result?.episodeId).toBe("ep-existing")
		})
	})

	// Covered indirectly by live episode creation; rewrite with a fake Db/event
	// harness before turning this back on.
	describe("summarizer output validation", () => {
		it("throws when summarizer returns empty title", async () => {
			const start = new Date("2026-03-15T09:00:00Z")
			const end = new Date("2026-03-15T10:00:00Z")
			const eventDocs = makeEventDocs(5, start)

			vi.mocked(getEventsByTimeRangeMock).mockResolvedValue(eventDocs as never)

			const episodesCol = createMockCollection()
			const db = createMockDb({
				[`${PREFIX}episodes`]: episodesCol,
			})

			const badSummarizer: EpisodeSummarizer = vi.fn().mockResolvedValue({
				title: "",
				summary: "Some summary",
				tags: [],
			})

			await expect(
				materializeEpisode({
					db,
					prefix: PREFIX,
					agentId: AGENT_ID,
					type: "daily",
					timeRange: { start, end },
					summarizer: badSummarizer,
				}),
			).rejects.toThrow(/title/i)

			// Upsert should NOT be called
			expect(episodesCol.updateOne).not.toHaveBeenCalled()
		})

		it("throws when summarizer returns empty summary", async () => {
			const start = new Date("2026-03-15T09:00:00Z")
			const end = new Date("2026-03-15T10:00:00Z")
			const eventDocs = makeEventDocs(5, start)

			vi.mocked(getEventsByTimeRangeMock).mockResolvedValue(eventDocs as never)

			const episodesCol = createMockCollection()
			const db = createMockDb({
				[`${PREFIX}episodes`]: episodesCol,
			})

			const badSummarizer: EpisodeSummarizer = vi.fn().mockResolvedValue({
				title: "Some title",
				summary: "",
				tags: [],
			})

			await expect(
				materializeEpisode({
					db,
					prefix: PREFIX,
					agentId: AGENT_ID,
					type: "daily",
					timeRange: { start, end },
					summarizer: badSummarizer,
				}),
			).rejects.toThrow(/summary/i)

			expect(episodesCol.updateOne).not.toHaveBeenCalled()
		})
	})

	describe("empty query guard", () => {
		it("returns empty array for empty query string", async () => {
			const episodesCol = createMockCollection()
			const db = createMockDb({ [`${PREFIX}episodes`]: episodesCol })

			const results = await searchEpisodes({
				db,
				prefix: PREFIX,
				query: "",
				agentId: AGENT_ID,
			})

			expect(results).toEqual([])
			// find() should NOT be called - early return
			expect(episodesCol.find).not.toHaveBeenCalled()
		})

		it("returns empty array for whitespace-only query", async () => {
			const episodesCol = createMockCollection()
			const db = createMockDb({ [`${PREFIX}episodes`]: episodesCol })

			const results = await searchEpisodes({
				db,
				prefix: PREFIX,
				query: "   ",
				agentId: AGENT_ID,
			})

			expect(results).toEqual([])
			expect(episodesCol.find).not.toHaveBeenCalled()
		})
	})

	describe("search query normalization", () => {
		it("uses keyword-aware regex matching for summary-style queries", async () => {
			const toArray = vi.fn().mockResolvedValue([])
			const limit = vi.fn().mockReturnValue({ toArray })
			const sort = vi.fn().mockReturnValue({ limit })
			const find = vi.fn().mockReturnValue({ sort })
			const episodesCol = createMockCollection({ find })
			const db = createMockDb({ [`${PREFIX}episodes`]: episodesCol })

			await searchEpisodes({
				db,
				prefix: PREFIX,
				query: "Summarize what happened in the Phoenix release blocker thread",
				agentId: AGENT_ID,
			})

			const [filter] = find.mock.calls[0] as [Document]
			const titleRegex = filter.$or?.[0]?.title?.$regex as RegExp
			expect(titleRegex).toBeInstanceOf(RegExp)
			expect(titleRegex.source).toContain("phoenix")
			expect(titleRegex.source).toContain("release")
			expect(titleRegex.source).toContain("blocker")
			expect(titleRegex.source).not.toContain("summarize")
		})
	})

	// Covered by live materialization semantics; current unit seam is stale.
	describe("episodeId stability on re-materialization", () => {
		it("places episodeId in $setOnInsert, not $set", async () => {
			const start = new Date("2026-03-15T09:00:00Z")
			const end = new Date("2026-03-15T10:00:00Z")
			const eventDocs = makeEventDocs(5, start)

			vi.mocked(getEventsByTimeRangeMock).mockResolvedValue(eventDocs as never)

			const episodesCol = createMockCollection()
			const db = createMockDb({
				[`${PREFIX}episodes`]: episodesCol,
			})

			await materializeEpisode({
				db,
				prefix: PREFIX,
				agentId: AGENT_ID,
				type: "daily",
				timeRange: { start, end },
				summarizer: mockSummarizer,
			})

			const [, update] = (episodesCol.updateOne as ReturnType<typeof vi.fn>)
				.mock.calls[0]

			// episodeId must NOT be in $set (would overwrite on re-materialization)
			expect(update.$set.episodeId).toBeUndefined()
			// episodeId MUST be in $setOnInsert (only assigned on first creation)
			expect(update.$setOnInsert.episodeId).toBeDefined()
			expect(typeof update.$setOnInsert.episodeId).toBe("string")
		})
	})

	// The materializeEpisode portion is stale due to mocked-event drift.
	describe("error handling", () => {
		it("materializeEpisode wraps and re-throws errors", async () => {
			const start = new Date("2026-03-15T09:00:00Z")
			const end = new Date("2026-03-15T10:00:00Z")
			const eventDocs = makeEventDocs(5, start)

			vi.mocked(getEventsByTimeRangeMock).mockResolvedValue(eventDocs as never)

			const episodesCol = createMockCollection({
				updateOne: vi.fn().mockRejectedValue(new Error("db write failed")),
			})
			const db = createMockDb({
				[`${PREFIX}episodes`]: episodesCol,
			})

			await expect(
				materializeEpisode({
					db,
					prefix: PREFIX,
					agentId: AGENT_ID,
					type: "daily",
					timeRange: { start, end },
					summarizer: mockSummarizer,
				}),
			).rejects.toThrow("db write failed")
		})

		it("searchEpisodes wraps and re-throws errors", async () => {
			const episodesCol = createMockCollection({
				find: vi.fn().mockImplementation(() => {
					throw new Error("db read failed")
				}),
			})
			const db = createMockDb({ [`${PREFIX}episodes`]: episodesCol })

			await expect(
				searchEpisodes({
					db,
					prefix: PREFIX,
					query: "test",
					agentId: AGENT_ID,
				}),
			).rejects.toThrow("db read failed")
		})
	})

	describe("status lifecycle", () => {
		it("updateEpisodeStatus sets status field on episode", async () => {
			const episodesCol = createMockCollection({
				updateOne: vi
					.fn()
					.mockResolvedValue({ matchedCount: 1, modifiedCount: 1 }),
			})
			const db = createMockDb({ [`${PREFIX}episodes`]: episodesCol })

			const { updateEpisodeStatus } = await import("./mongodb-episodes.js")
			const result = await updateEpisodeStatus({
				db,
				prefix: PREFIX,
				episodeId: "ep-1",
				agentId: AGENT_ID,
				status: "archived",
			})

			expect(result).toBe(true)
			const [filter, update] = (
				episodesCol.updateOne as ReturnType<typeof vi.fn>
			).mock.calls[0]
			expect(filter).toEqual({ episodeId: "ep-1", agentId: AGENT_ID })
			expect(update).toEqual({
				$set: { status: "archived", updatedAt: expect.any(Date) },
			})
		})

		it("updateEpisodeStatus returns false when episode not found", async () => {
			const episodesCol = createMockCollection({
				updateOne: vi
					.fn()
					.mockResolvedValue({ matchedCount: 0, modifiedCount: 0 }),
			})
			const db = createMockDb({ [`${PREFIX}episodes`]: episodesCol })

			const { updateEpisodeStatus } = await import("./mongodb-episodes.js")
			const result = await updateEpisodeStatus({
				db,
				prefix: PREFIX,
				episodeId: "nonexistent",
				agentId: AGENT_ID,
				status: "deleted",
			})

			expect(result).toBe(false)
		})

		it("getEpisodesByTimeRange excludes deleted episodes", async () => {
			const findResult = {
				sort: vi.fn().mockReturnValue({
					limit: vi.fn().mockReturnValue({
						toArray: vi.fn().mockResolvedValue([]),
					}),
				}),
			}
			const episodesCol = createMockCollection({
				find: vi.fn().mockReturnValue(findResult),
			})
			const db = createMockDb({ [`${PREFIX}episodes`]: episodesCol })

			await getEpisodesByTimeRange({
				db,
				prefix: PREFIX,
				agentId: AGENT_ID,
				start: new Date("2026-03-15T08:00:00Z"),
				end: new Date("2026-03-15T11:00:00Z"),
			})

			const [filter] = (episodesCol.find as ReturnType<typeof vi.fn>).mock
				.calls[0]
			expect(filter.status).toEqual({ $ne: "deleted" })
		})

		it("getEpisodesByType excludes deleted episodes", async () => {
			const findResult = {
				sort: vi.fn().mockReturnValue({
					limit: vi.fn().mockReturnValue({
						toArray: vi.fn().mockResolvedValue([]),
					}),
				}),
			}
			const episodesCol = createMockCollection({
				find: vi.fn().mockReturnValue(findResult),
			})
			const db = createMockDb({ [`${PREFIX}episodes`]: episodesCol })

			await getEpisodesByType({
				db,
				prefix: PREFIX,
				agentId: AGENT_ID,
				type: "daily",
			})

			const [filter] = (episodesCol.find as ReturnType<typeof vi.fn>).mock
				.calls[0]
			expect(filter.status).toEqual({ $ne: "deleted" })
		})

		it("searchEpisodes excludes deleted episodes", async () => {
			const findResult = {
				sort: vi.fn().mockReturnValue({
					limit: vi.fn().mockReturnValue({
						toArray: vi.fn().mockResolvedValue([]),
					}),
				}),
			}
			const episodesCol = createMockCollection({
				find: vi.fn().mockReturnValue(findResult),
			})
			const db = createMockDb({ [`${PREFIX}episodes`]: episodesCol })

			await searchEpisodes({
				db,
				prefix: PREFIX,
				query: "standup",
				agentId: AGENT_ID,
			})

			const [filter] = (episodesCol.find as ReturnType<typeof vi.fn>).mock
				.calls[0]
			expect(filter.status).toEqual({ $ne: "deleted" })
		})

		it("getEpisodesByIds excludes deleted episodes", async () => {
			const findFn = vi
				.fn()
				.mockReturnValue({ toArray: vi.fn().mockResolvedValue([]) })
			const episodesCol = createMockCollection({ find: findFn })
			const db = createMockDb({ [`${PREFIX}episodes`]: episodesCol })

			await getEpisodesByIds({
				db,
				prefix: PREFIX,
				episodeIds: ["ep-1"],
				agentId: AGENT_ID,
			})

			const [filter] = findFn.mock.calls[0]
			expect(filter.status).toEqual({ $ne: "deleted" })
		})
	})
})
