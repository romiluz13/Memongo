/* eslint-disable @typescript-eslint/unbound-method -- Vitest mock method assertions */
import type { Collection, Db, Document } from "mongodb"
import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("./mongodb-active-slate.js", () => ({
	hydrateActiveSlate: vi.fn(),
}))

vi.mock("./mongodb-discovery-projections.js", () => ({
	buildDiscoveryProjection: vi.fn(),
}))

vi.mock("./mongodb-profile.js", () => ({
	synthesizeProfile: vi.fn(),
}))

vi.mock("./mongodb-schema.js", () => ({
	episodesCollection: vi.fn(),
	eventsCollection: vi.fn(),
}))

vi.mock("./mongodb-telemetry.js", () => ({
	emitTelemetry: vi.fn(),
}))

import { hydrateActiveSlate } from "./mongodb-active-slate.js"
import { buildContextBundle } from "./mongodb-context-bundle.js"
import { buildDiscoveryProjection } from "./mongodb-discovery-projections.js"
import { synthesizeProfile } from "./mongodb-profile.js"
import { episodesCollection, eventsCollection } from "./mongodb-schema.js"
import { emitTelemetry } from "./mongodb-telemetry.js"

const PREFIX = "test_"
const AGENT_ID = "agent-1"

function createFindCollection(params: {
	next?: Document | null
	docs?: Document[]
}): Collection {
	return {
		find: vi.fn().mockReturnValue({
			sort: vi.fn().mockReturnValue({
				limit: vi.fn().mockReturnValue({
					project: vi.fn().mockReturnValue({
						next: vi.fn().mockResolvedValue(params.next ?? null),
						toArray: vi.fn().mockResolvedValue(params.docs ?? []),
					}),
				}),
			}),
		}),
	} as unknown as Collection
}

describe("mongodb-context-bundle", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		vi.mocked(hydrateActiveSlate).mockResolvedValue({
			agentId: AGENT_ID,
			scope: "agent",
			scopeRef: "agent:agent-1",
			items: [
				{
					kind: "active-critical",
					source: "structured",
					title: "phoenix-current-blocker",
					summary:
						"Atlas Local preview validation is blocking the Phoenix launch.",
					path: "structured:project:phoenix-current-blocker",
					timestamp: new Date("2026-04-05T10:00:00.000Z"),
				},
				{
					kind: "procedure",
					source: "procedural",
					title: "Phoenix rollback runbook",
					summary:
						"Disable rollout, restore stable image, verify health checks.",
					path: "procedure:phoenix-rollback",
					timestamp: new Date("2026-04-05T09:45:00.000Z"),
				},
			],
			metadata: {
				maxItems: 4,
				truncated: false,
				partial: false,
				countsByKind: { "active-critical": 1, procedure: 1 },
				sourceCounts: { structured: 1, procedural: 1 },
			},
			hydratedAt: new Date("2026-04-05T10:00:00.000Z"),
		})
		vi.mocked(buildDiscoveryProjection).mockResolvedValue({
			kind: "topic-brief",
			query: "Phoenix",
			title: "Phoenix topic brief",
			summary: "Phoenix has one active blocker and one rollback procedure.",
			scope: "agent",
			scopeRef: "agent:agent-1",
			sections: [],
			metadata: { partial: false, evidenceCount: 0, sourceCounts: {} },
			builtAt: new Date("2026-04-05T10:00:00.000Z"),
		})
		vi.mocked(synthesizeProfile).mockResolvedValue({
			agentId: AGENT_ID,
			scope: "agent",
			scopeRef: "agent:agent-1",
			preferences: [],
			decisions: [],
			facts: [],
			todos: [],
			topEntities: [],
			recentEpisodes: [],
			activityPatterns: {
				roleDistribution: {},
				totalEvents: 0,
				lastActive: null,
			},
			synthesizedAt: new Date("2026-04-05T10:00:00.000Z"),
		})
	})

	it("assembles active state, durable evidence, summary, and session events into a prompt-ready bundle", async () => {
		vi.mocked(episodesCollection).mockReturnValue(
			createFindCollection({
				next: {
					episodeId: "ep-1",
					title: "Phoenix launch review",
					summary: "The team aligned on launch timing and remaining blockers.",
					shortTermSummary:
						"Phoenix launch remains blocked on Atlas Local preview validation.",
					timeRange: {
						end: new Date("2026-04-05T09:55:00.000Z"),
					},
					scope: "agent",
					scopeRef: "agent:agent-1",
					sourceEventIds: ["evt-1"],
				},
			}),
		)
		vi.mocked(eventsCollection).mockReturnValue(
			createFindCollection({
				docs: [
					{
						eventId: "evt-10",
						role: "user",
						body: "The current blocker is Atlas Local preview validation.",
						timestamp: new Date("2026-04-05T10:05:00.000Z"),
						scope: "session",
						scopeRef: "session:session-main",
					},
					{
						eventId: "evt-11",
						role: "assistant",
						body: "I will prepare the rollout brief once validation passes.",
						timestamp: new Date("2026-04-05T10:06:00.000Z"),
						scope: "session",
						scopeRef: "session:session-main",
					},
				],
			}),
		)

		const bundle = await buildContextBundle({
			db: {} as Db,
			prefix: PREFIX,
			agentId: AGENT_ID,
			scope: "agent",
			scopeRef: "agent:agent-1",
			request: {
				query: "Phoenix handoff",
				sessionId: "session-main",
				tokenBudget: 320,
			},
			search: vi.fn().mockResolvedValue({
				results: [
					{
						path: "structured:decision:phoenix-release-window",
						startLine: 0,
						endLine: 0,
						score: 0.94,
						snippet:
							"Phoenix deploys on Monday afternoon after validation completes.",
						source: "structured",
						canonicalId: "structured:decision:phoenix-release-window",
						timestamp: new Date("2026-04-05T09:00:00.000Z"),
						scope: "agent",
						scopeRef: "agent:agent-1",
						trust: {
							score: 0.92,
							confidence: "high",
							exactness: "exact-id",
							freshness: "fresh",
							contradiction: "none",
							scopeMatch: "exact",
							provenance: "dense",
							sourceDiversity: "single",
							factors: ["latest"],
						},
					},
				],
				pathsExecuted: ["structured", "procedural"],
				trustSummary: {
					topScore: 0.92,
					topConfidence: "high",
					averageScore: 0.92,
					distribution: { high: 1, medium: 0, low: 0 },
					contradictionCount: 0,
					staleCount: 0,
					exactCount: 1,
					sourceDiversity: "single",
				},
			}),
		})

		expect(bundle.sections.map((section) => section.kind)).toEqual([
			"active-slate",
			"query-evidence",
			"summary",
			"recent-events",
		])
		expect(bundle.metadata.pathsExecuted).toEqual([
			"active-slate",
			"structured",
			"procedural",
			"episode-summary",
			"recent-events",
		])
		expect(bundle.metadata.trustSummary?.topConfidence).toBe("high")
		expect(bundle.rendered).toContain("## Active Slate")
		expect(bundle.rendered).toContain("## Direct Evidence")
		expect(bundle.rendered).toContain("## Recent Session Events")
		expect(hydrateActiveSlate).toHaveBeenCalledWith(
			expect.objectContaining({
				scope: "agent",
				scopeRef: "agent:agent-1",
			}),
		)
		expect(
			vi.mocked(vi.mocked(eventsCollection).mock.results[0]?.value.find).mock
				.calls[0]?.[0],
		).toEqual({
			agentId: AGENT_ID,
			scope: "session",
			scopeRef: "session:session-main",
		})
		expect(emitTelemetry).toHaveBeenCalledWith(
			expect.anything(),
			PREFIX,
			expect.objectContaining({
				meta: expect.objectContaining({ operation: "context-bundle" }),
			}),
		)
	})

	it("truncates sections to stay within the requested token budget", async () => {
		vi.mocked(episodesCollection).mockReturnValue(
			createFindCollection({ next: null }),
		)
		vi.mocked(eventsCollection).mockReturnValue(
			createFindCollection({
				docs: [
					{
						eventId: "evt-10",
						role: "user",
						body: "A very long body ".repeat(30),
						timestamp: new Date("2026-04-05T10:05:00.000Z"),
						scope: "session",
						scopeRef: "session:session-main",
					},
				],
			}),
		)

		const bundle = await buildContextBundle({
			db: {} as Db,
			prefix: PREFIX,
			agentId: AGENT_ID,
			scope: "agent",
			scopeRef: "agent:agent-1",
			request: {
				query: "Phoenix handoff",
				sessionId: "session-main",
				tokenBudget: 140,
			},
			search: vi.fn().mockResolvedValue({
				results: [
					{
						path: "structured:decision:phoenix-release-window",
						startLine: 0,
						endLine: 0,
						score: 0.94,
						snippet:
							"Phoenix deploys on Monday afternoon after validation completes. ".repeat(
								10,
							),
						source: "structured",
					},
				],
				pathsExecuted: ["structured"],
			}),
		})

		expect(bundle.metadata.truncated).toBe(true)
		expect(bundle.metadata.estimatedTokensUsed).toBeLessThanOrEqual(140)
		expect(bundle.sections.length).toBeGreaterThan(0)
	})

	it("returns partial output when a lane fails but other sections still succeed", async () => {
		vi.mocked(episodesCollection).mockReturnValue(
			createFindCollection({ next: null }),
		)
		vi.mocked(eventsCollection).mockReturnValue({
			find: vi.fn(() => {
				throw new Error("events timeout")
			}),
		} as unknown as Collection)

		const bundle = await buildContextBundle({
			db: {} as Db,
			prefix: PREFIX,
			agentId: AGENT_ID,
			scope: "agent",
			scopeRef: "agent:agent-1",
			request: {
				query: "Phoenix handoff",
			},
			search: vi.fn().mockRejectedValue(new Error("search timeout")),
		})

		expect(bundle.metadata.partial).toBe(true)
		expect(bundle.sections.map((section) => section.kind)).toEqual([
			"active-slate",
		])
	})

	it("wake-up mode limits token budget to 250 and includes profile", async () => {
		vi.mocked(hydrateActiveSlate).mockResolvedValue({
			agentId: AGENT_ID,
			scope: "agent",
			scopeRef: "agent:agent-1",
			items: [],
			metadata: {
				maxItems: 5,
				truncated: false,
				partial: false,
				countsByKind: {},
				sourceCounts: {},
			},
			hydratedAt: new Date(),
		})
		vi.mocked(episodesCollection).mockReturnValue(
			createFindCollection({ next: null }),
		)
		vi.mocked(eventsCollection).mockReturnValue(
			createFindCollection({ docs: [] }),
		)
		vi.mocked(synthesizeProfile).mockResolvedValue({
			agentId: AGENT_ID,
			scope: "agent",
			scopeRef: "agent:agent-1",
			preferences: [],
			decisions: [],
			facts: [
				{ key: "name", value: "Test", salience: "core", updatedAt: new Date() },
			],
			todos: [],
			topEntities: [],
			recentEpisodes: [],
			activityPatterns: {
				roleDistribution: {},
				totalEvents: 0,
				lastActive: null,
			},
			synthesizedAt: new Date(),
		})

		const bundle = await buildContextBundle({
			db: {} as Db,
			prefix: PREFIX,
			agentId: AGENT_ID,
			scope: "agent",
			scopeRef: "agent:agent-1",
			request: {
				mode: "wake-up",
				query: "should be ignored in wake-up",
			},
		})

		expect(bundle.metadata.tokenBudget).toBe(250)
		expect(bundle.sections.map((s) => s.kind)).toContain("profile")
		// wake-up ignores query → no query-evidence section
		expect(bundle.sections.map((s) => s.kind)).not.toContain("query-evidence")
	})

	it("wake-up mode skips discovery projection even when requested", async () => {
		vi.mocked(hydrateActiveSlate).mockResolvedValue({
			agentId: AGENT_ID,
			scope: "agent",
			scopeRef: "agent:agent-1",
			items: [],
			metadata: {
				maxItems: 5,
				truncated: false,
				partial: false,
				countsByKind: {},
				sourceCounts: {},
			},
			hydratedAt: new Date(),
		})
		vi.mocked(episodesCollection).mockReturnValue(
			createFindCollection({ next: null }),
		)
		vi.mocked(eventsCollection).mockReturnValue(
			createFindCollection({ docs: [] }),
		)
		vi.mocked(synthesizeProfile).mockResolvedValue({
			agentId: AGENT_ID,
			scope: "agent",
			scopeRef: "agent:agent-1",
			preferences: [],
			decisions: [],
			facts: [],
			todos: [],
			topEntities: [],
			recentEpisodes: [],
			activityPatterns: {
				roleDistribution: {},
				totalEvents: 0,
				lastActive: null,
			},
			synthesizedAt: new Date(),
		})

		const bundle = await buildContextBundle({
			db: {} as Db,
			prefix: PREFIX,
			agentId: AGENT_ID,
			scope: "agent",
			scopeRef: "agent:agent-1",
			request: {
				mode: "wake-up",
				includeDiscoveryProjection: true,
			},
		})

		expect(bundle.sections.map((s) => s.kind)).not.toContain(
			"discovery-projection",
		)
		// buildDiscoveryProjection should NOT have been called
		expect(vi.mocked(buildDiscoveryProjection)).not.toHaveBeenCalled()
	})

	it("splits query evidence into explicit and derived sections (3.2 multi-level)", async () => {
		vi.mocked(hydrateActiveSlate).mockResolvedValue({
			agentId: AGENT_ID,
			scope: "agent",
			scopeRef: "agent:agent-1",
			items: [],
			metadata: {
				maxItems: 10,
				truncated: false,
				partial: false,
				countsByKind: {},
				sourceCounts: {},
			},
			hydratedAt: new Date(),
		})
		vi.mocked(episodesCollection).mockReturnValue(
			createFindCollection({ next: null }) as unknown as Collection,
		)
		vi.mocked(eventsCollection).mockReturnValue(
			createFindCollection({ docs: [] }) as unknown as Collection,
		)
		vi.mocked(emitTelemetry).mockResolvedValue(undefined)

		const bundle = await buildContextBundle({
			db: {} as Db,
			prefix: PREFIX,
			agentId: AGENT_ID,
			scope: "agent",
			scopeRef: "agent:agent-1",
			request: {
				query: "What is the plan?",
			},
			search: vi.fn().mockResolvedValue({
				results: [
					{
						path: "structured:fact:user-stated-fact",
						startLine: 0,
						endLine: 0,
						score: 0.95,
						snippet: "User explicitly said: deploy on Monday",
						source: "structured",
						confidence: 1.0,
					},
					{
						path: "structured:fact:dreamer-extracted",
						startLine: 0,
						endLine: 0,
						score: 0.85,
						snippet: "Agent inferred: prefers morning deploys",
						source: "structured",
						confidence: 0.7,
					},
					{
						path: "structured:fact:inferred-pattern",
						startLine: 0,
						endLine: 0,
						score: 0.75,
						snippet: "Dreamer deduced: risk-averse approach",
						source: "structured",
						confidence: 0.4,
					},
				],
				pathsExecuted: ["structured"],
			}),
		})

		const evidenceSections = bundle.sections.filter(
			(s) => s.kind === "query-evidence",
		)
		expect(evidenceSections).toHaveLength(2)
		expect(evidenceSections[0].title).toBe("Direct Evidence")
		expect(evidenceSections[0].items).toHaveLength(1)
		expect(evidenceSections[1].title).toBe("Derived Insights")
		expect(evidenceSections[1].items).toHaveLength(2)
	})
})
