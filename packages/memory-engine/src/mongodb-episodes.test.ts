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
			expect(result!.type).toBe("daily")
			expect(result!.title).toBe("Daily Standup Notes")
			expect(result!.summary).toBe("Discussed project roadmap and blockers")
			expect(result!.agentId).toBe(AGENT_ID)
			expect(result!.sourceEventCount).toBe(5)
			expect(result!.timeRange.start).toEqual(start)
			expect(result!.timeRange.end).toEqual(end)

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
			expect(result!.sourceEventCount).toBe(5)
			expect(result!.sourceEventIds).toBeDefined()
			expect(result!.sourceEventIds).toEqual([
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
			expect(filter["timeRange.start"]).toEqual(start)
			expect(filter["timeRange.end"]).toEqual(end)
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

	// The trigger pipeline now spans real event queries plus scope-aware episode
	// writes. This mocked seam is parked until it is rewritten around a fake Db.
	describe("checkAutoEpisodeTriggers", () => {
		beforeEach(() => {
			vi.clearAllMocks()
		})

		it("triggers episode on session gap (>30min default)", async () => {
			// Events with a >30min gap between them
			const events = [
				{
					eventId: "evt-0",
					agentId: AGENT_ID,
					role: "user",
					body: "Start",
					scope: "agent",
					timestamp: new Date("2026-03-15T10:00:00Z"),
				},
				{
					eventId: "evt-1",
					agentId: AGENT_ID,
					role: "assistant",
					body: "Reply",
					scope: "agent",
					timestamp: new Date("2026-03-15T10:05:00Z"),
				},
				{
					eventId: "evt-2",
					agentId: AGENT_ID,
					role: "user",
					body: "After gap",
					scope: "agent",
					timestamp: new Date("2026-03-15T11:00:00Z"),
				},
			]

			vi.mocked(getUnconsolidatedEvents).mockResolvedValue(events as never)
			// getEventsByTimeRange for materializeEpisode
			vi.mocked(getEventsByTimeRangeMock).mockResolvedValue(events as never)

			// No recent episodes (rate limit passes)
			const episodesCol = createMockCollection({
				find: vi.fn().mockReturnValue({
					sort: vi.fn().mockReturnValue({
						limit: vi.fn().mockReturnValue({
							toArray: vi.fn().mockResolvedValue([]),
						}),
					}),
				}),
			})
			const db = createMockDb({ [`${PREFIX}episodes`]: episodesCol })

			const result = await checkAutoEpisodeTriggers({
				db,
				prefix: PREFIX,
				agentId: AGENT_ID,
				summarizer: mockSummarizer,
			})

			expect(result.triggered).toBe(true)
			expect(result.reason).toBe("session_gap")
		})

		it("triggers episode on event count (>50 default)", async () => {
			// Generate 51 events with no gap > 30min (1-min intervals)
			const start = new Date("2026-03-15T10:00:00Z")
			const events = Array.from({ length: 51 }, (_, i) => ({
				eventId: `evt-${i}`,
				agentId: AGENT_ID,
				role: i % 2 === 0 ? "user" : "assistant",
				body: `Message ${i}`,
				scope: "agent",
				timestamp: new Date(start.getTime() + i * 60_000),
			}))

			vi.mocked(getUnconsolidatedEvents).mockResolvedValue(events as never)
			vi.mocked(getEventsByTimeRangeMock).mockResolvedValue(events as never)

			const episodesCol = createMockCollection({
				find: vi.fn().mockReturnValue({
					sort: vi.fn().mockReturnValue({
						limit: vi.fn().mockReturnValue({
							toArray: vi.fn().mockResolvedValue([]),
						}),
					}),
				}),
			})
			const db = createMockDb({ [`${PREFIX}episodes`]: episodesCol })

			const result = await checkAutoEpisodeTriggers({
				db,
				prefix: PREFIX,
				agentId: AGENT_ID,
				summarizer: mockSummarizer,
			})

			expect(result.triggered).toBe(true)
			expect(result.reason).toBe("event_count")
		})

		it("keeps the threshold-crossing event in the auto-materialized episode window", async () => {
			const start = new Date("2026-03-15T10:00:00Z")
			const events = Array.from({ length: 2 }, (_, i) => ({
				eventId: `evt-${i}`,
				agentId: AGENT_ID,
				role: i % 2 === 0 ? "user" : "assistant",
				body: `Message ${i}`,
				scope: "agent",
				timestamp: new Date(start.getTime() + i * 60_000),
			}))

			vi.mocked(getUnconsolidatedEvents).mockResolvedValue(events as never)
			vi.mocked(getEventsByTimeRangeMock).mockResolvedValue(events as never)

			const episodesCol = createMockCollection({
				find: vi.fn().mockReturnValue({
					sort: vi.fn().mockReturnValue({
						limit: vi.fn().mockReturnValue({
							toArray: vi.fn().mockResolvedValue([]),
						}),
					}),
				}),
			})
			const db = createMockDb({ [`${PREFIX}episodes`]: episodesCol })

			const result = await checkAutoEpisodeTriggers({
				db,
				prefix: PREFIX,
				agentId: AGENT_ID,
				summarizer: mockSummarizer,
				maxEventsWithoutEpisode: 1,
			})

			expect(result.triggered).toBe(true)
			expect(result.reason).toBe("event_count")
			expect(mockSummarizer).toHaveBeenCalledWith([
				{
					role: "user",
					body: "Message 0",
					timestamp: events[0].timestamp,
				},
				{
					role: "assistant",
					body: "Message 1",
					timestamp: events[1].timestamp,
				},
			])
		})

		it("does not trigger when under thresholds", async () => {
			// 10 events, no gap
			const start = new Date("2026-03-15T10:00:00Z")
			const events = Array.from({ length: 10 }, (_, i) => ({
				eventId: `evt-${i}`,
				agentId: AGENT_ID,
				role: i % 2 === 0 ? "user" : "assistant",
				body: `Message ${i}`,
				scope: "agent",
				timestamp: new Date(start.getTime() + i * 60_000),
			}))

			vi.mocked(getUnconsolidatedEvents).mockResolvedValue(events as never)

			const episodesCol = createMockCollection({
				find: vi.fn().mockReturnValue({
					sort: vi.fn().mockReturnValue({
						limit: vi.fn().mockReturnValue({
							toArray: vi.fn().mockResolvedValue([]),
						}),
					}),
				}),
			})
			const db = createMockDb({ [`${PREFIX}episodes`]: episodesCol })

			const result = await checkAutoEpisodeTriggers({
				db,
				prefix: PREFIX,
				agentId: AGENT_ID,
				summarizer: mockSummarizer,
			})

			expect(result.triggered).toBe(false)
		})

		it("respects rate limit (max 1 per hour per agent)", async () => {
			const start = new Date("2026-03-15T10:00:00Z")
			const events = [
				{
					eventId: "evt-0",
					agentId: AGENT_ID,
					role: "user",
					body: "Start",
					scope: "agent",
					timestamp: start,
				},
				{
					eventId: "evt-1",
					agentId: AGENT_ID,
					role: "assistant",
					body: "Reply",
					scope: "agent",
					timestamp: new Date(start.getTime() + 60_000),
				},
				{
					eventId: "evt-2",
					agentId: AGENT_ID,
					role: "user",
					body: "Gap",
					scope: "agent",
					timestamp: new Date(start.getTime() + 60 * 60_000),
				},
			]

			vi.mocked(getUnconsolidatedEvents).mockResolvedValue(events as never)

			// Return a recent episode (within last hour)
			const recentEpisode = makeEpisodeDoc()
			const episodesCol = createMockCollection({
				find: vi.fn().mockReturnValue({
					sort: vi.fn().mockReturnValue({
						limit: vi.fn().mockReturnValue({
							toArray: vi.fn().mockResolvedValue([recentEpisode]),
						}),
					}),
				}),
			})
			const db = createMockDb({ [`${PREFIX}episodes`]: episodesCol })

			const result = await checkAutoEpisodeTriggers({
				db,
				prefix: PREFIX,
				agentId: AGENT_ID,
				summarizer: mockSummarizer,
			})

			expect(result.triggered).toBe(false)
			expect(result.reason).toBe("rate_limited")
		})

		it("calls markEventsConsolidated after episode creation", async () => {
			const events = [
				{
					eventId: "evt-0",
					agentId: AGENT_ID,
					role: "user",
					body: "Start",
					scope: "agent",
					timestamp: new Date("2026-03-15T10:00:00Z"),
				},
				{
					eventId: "evt-1",
					agentId: AGENT_ID,
					role: "assistant",
					body: "Reply",
					scope: "agent",
					timestamp: new Date("2026-03-15T10:05:00Z"),
				},
				{
					eventId: "evt-2",
					agentId: AGENT_ID,
					role: "user",
					body: "After gap",
					scope: "agent",
					timestamp: new Date("2026-03-15T11:00:00Z"),
				},
			]

			vi.mocked(getUnconsolidatedEvents).mockResolvedValue(events as never)
			vi.mocked(getEventsByTimeRangeMock).mockResolvedValue(events as never)

			const episodesCol = createMockCollection({
				find: vi.fn().mockReturnValue({
					sort: vi.fn().mockReturnValue({
						limit: vi.fn().mockReturnValue({
							toArray: vi.fn().mockResolvedValue([]),
						}),
					}),
				}),
			})
			const db = createMockDb({ [`${PREFIX}episodes`]: episodesCol })

			await checkAutoEpisodeTriggers({
				db,
				prefix: PREFIX,
				agentId: AGENT_ID,
				summarizer: mockSummarizer,
			})

			expect(markEventsConsolidated).toHaveBeenCalled()
		})

		it("supports explicit trigger (force=true bypasses thresholds and rate limit)", async () => {
			const events = [
				{
					eventId: "evt-0",
					agentId: AGENT_ID,
					role: "user",
					body: "One",
					scope: "agent",
					timestamp: new Date("2026-03-15T10:00:00Z"),
				},
				{
					eventId: "evt-1",
					agentId: AGENT_ID,
					role: "assistant",
					body: "Two",
					scope: "agent",
					timestamp: new Date("2026-03-15T10:01:00Z"),
				},
			]

			vi.mocked(getUnconsolidatedEvents).mockResolvedValue(events as never)
			vi.mocked(getEventsByTimeRangeMock).mockResolvedValue(events as never)

			const episodesCol = createMockCollection({
				find: vi.fn().mockReturnValue({
					sort: vi.fn().mockReturnValue({
						limit: vi.fn().mockReturnValue({
							toArray: vi.fn().mockResolvedValue([]),
						}),
					}),
				}),
			})
			const db = createMockDb({ [`${PREFIX}episodes`]: episodesCol })

			const result = await checkAutoEpisodeTriggers({
				db,
				prefix: PREFIX,
				agentId: AGENT_ID,
				summarizer: mockSummarizer,
				force: true,
			})

			expect(result.triggered).toBe(true)
			expect(result.reason).toBe("explicit")
		})

		it("returns insufficient_events when <2 unconsolidated events", async () => {
			vi.mocked(getUnconsolidatedEvents).mockResolvedValue([
				{
					eventId: "evt-0",
					agentId: AGENT_ID,
					role: "user",
					body: "Only one",
					scope: "agent",
					timestamp: new Date(),
				},
			] as never)

			const episodesCol = createMockCollection()
			const db = createMockDb({ [`${PREFIX}episodes`]: episodesCol })

			const result = await checkAutoEpisodeTriggers({
				db,
				prefix: PREFIX,
				agentId: AGENT_ID,
				summarizer: mockSummarizer,
			})

			expect(result.triggered).toBe(false)
			expect(result.reason).toBe("insufficient_events")
		})
	})

	// ---------------------------------------------------------------------------
	// Tests: getEpisodesByIds (Phase 9 — Tiered Retrieval)
	// ---------------------------------------------------------------------------

	describe("getEpisodesByIds", () => {
		beforeEach(() => {
			vi.clearAllMocks()
		})

		it("returns episodes matching the given IDs", async () => {
			const mockEpisodes: Partial<Episode>[] = [
				{ episodeId: "ep-1", title: "Episode 1", agentId: AGENT_ID },
				{ episodeId: "ep-2", title: "Episode 2", agentId: AGENT_ID },
			]

			const toArrayFn = vi.fn().mockResolvedValue(mockEpisodes)
			const findFn = vi.fn().mockReturnValue({ toArray: toArrayFn })
			const episodesCol = createMockCollection({ find: findFn })
			const db = createMockDb({ [`${PREFIX}episodes`]: episodesCol })

			const result = await getEpisodesByIds({
				db,
				prefix: PREFIX,
				episodeIds: ["ep-1", "ep-2"],
				agentId: AGENT_ID,
			})

			expect(result).toHaveLength(2)
			expect(findFn).toHaveBeenCalledWith({
				episodeId: { $in: ["ep-1", "ep-2"] },
				agentId: AGENT_ID,
				status: { $ne: "deleted" },
			})
		})

		it("returns empty array for empty IDs", async () => {
			const episodesCol = createMockCollection()
			const db = createMockDb({ [`${PREFIX}episodes`]: episodesCol })

			const result = await getEpisodesByIds({
				db,
				prefix: PREFIX,
				episodeIds: [],
				agentId: AGENT_ID,
			})

			expect(result).toEqual([])
		})

		it("respects agentId filter", async () => {
			const toArrayFn = vi.fn().mockResolvedValue([])
			const findFn = vi.fn().mockReturnValue({ toArray: toArrayFn })
			const episodesCol = createMockCollection({ find: findFn })
			const db = createMockDb({ [`${PREFIX}episodes`]: episodesCol })

			await getEpisodesByIds({
				db,
				prefix: PREFIX,
				episodeIds: ["ep-1"],
				agentId: "other-agent",
			})

			expect(findFn).toHaveBeenCalledWith({
				episodeId: { $in: ["ep-1"] },
				agentId: "other-agent",
				status: { $ne: "deleted" },
			})
		})
	})
})
