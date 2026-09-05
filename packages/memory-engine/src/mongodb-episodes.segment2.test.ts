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
	checkAutoEpisodeTriggers,
	getEpisodesByIds,
	resetAutoEpisodeNegativeMemoForTests,
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

function _makeEventDocs(count: number, start: Date): Document[] {
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

	// The trigger pipeline now spans real event queries plus scope-aware episode
	// writes. This mocked seam is parked until it is rewritten around a fake Db.
	describe("checkAutoEpisodeTriggers", () => {
		beforeEach(() => {
			vi.clearAllMocks()
			// C-034: the negative-result memo is module state keyed by
			// agent+scope+prefix; these tests share the same key, so a previous
			// test's memo would short-circuit the next one.
			resetAutoEpisodeNegativeMemoForTests()
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

		it("does not absorb events written between window selection and materialization", async () => {
			// Window selection picks evt-0/evt-1 (session gap before evt-2).
			const start = new Date("2026-03-15T10:00:00Z")
			const windowEvents = [
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
					body: "After gap",
					scope: "agent",
					timestamp: new Date(start.getTime() + 60 * 60_000),
				},
			]
			// An event written AFTER the window was selected but still inside the
			// derived time range: the old time-range re-query absorbed it.
			const lateEvent = {
				eventId: "evt-late",
				agentId: AGENT_ID,
				role: "assistant",
				body: "Late arrival",
				scope: "agent",
				timestamp: new Date(start.getTime() + 30_000),
			}

			vi.mocked(getUnconsolidatedEvents).mockResolvedValue(
				windowEvents as never,
			)
			vi.mocked(getEventsByTimeRangeMock).mockResolvedValue([
				windowEvents[0],
				lateEvent,
				windowEvents[1],
			] as never)

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
			// The late event must be NEITHER in the episode identity NOR marked
			// consolidated — it stays unconsolidated for a later episode.
			expect(result.episode?.sourceEventIds).toEqual(["evt-0", "evt-1"])
			expect(result.episode?.sourceEventIds).not.toContain("evt-late")
			const markedCall = vi.mocked(markEventsConsolidated).mock.calls[0]?.[0]
			expect(markedCall?.eventIds).toEqual(["evt-0", "evt-1"])
			expect(markedCall?.eventIds).not.toContain("evt-late")
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
			expect(mockSummarizer).toHaveBeenCalledWith(
				[
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
				],
				// Auto-triggered episodes are written under the "thread" lens.
				"thread",
			)
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

		it("best-effort suppresses work after a recent episode write", async () => {
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
			expect(getUnconsolidatedEvents).not.toHaveBeenCalled()
		})

		it("bases the best-effort cooldown on episode write time", async () => {
			const oldEvents = [
				{
					eventId: "evt-old-0",
					agentId: AGENT_ID,
					role: "user",
					body: "Old start",
					scope: "workspace",
					scopeRef: "workspace:one",
					timestamp: new Date("2020-01-01T10:00:00Z"),
				},
				{
					eventId: "evt-old-1",
					agentId: AGENT_ID,
					role: "assistant",
					body: "Old reply",
					scope: "workspace",
					scopeRef: "workspace:one",
					timestamp: new Date("2020-01-01T11:00:00Z"),
				},
			]
			vi.mocked(getUnconsolidatedEvents).mockResolvedValue(oldEvents as never)

			const recentEpisode = makeEpisodeDoc({
				scope: "workspace",
				scopeRef: "workspace:one",
				timeRange: {
					start: new Date("2020-01-01T10:00:00Z"),
					end: new Date("2020-01-01T11:00:00Z"),
				},
				updatedAt: new Date(),
			})
			const find = vi.fn((filter: Document) => ({
				sort: vi.fn().mockReturnValue({
					limit: vi.fn().mockReturnValue({
						toArray: vi
							.fn()
							.mockResolvedValue(filter.updatedAt ? [recentEpisode] : []),
					}),
				}),
			}))
			const episodesCol = createMockCollection({ find })
			const db = createMockDb({ [`${PREFIX}episodes`]: episodesCol })

			const result = await checkAutoEpisodeTriggers({
				db,
				prefix: PREFIX,
				agentId: AGENT_ID,
				summarizer: mockSummarizer,
				scope: "workspace",
				scopeRef: "workspace:one",
			})

			expect(result).toEqual({ triggered: false, reason: "rate_limited" })
			expect(find).toHaveBeenCalledWith({
				agentId: AGENT_ID,
				scope: "workspace",
				scopeRef: "workspace:one",
				status: { $ne: "deleted" },
				updatedAt: { $gte: expect.any(Date) },
			})
			expect(getUnconsolidatedEvents).not.toHaveBeenCalled()
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
