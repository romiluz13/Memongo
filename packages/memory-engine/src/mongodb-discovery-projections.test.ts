/* eslint-disable @typescript-eslint/unbound-method -- Vitest mock method assertions */
import type { Collection, Db, Document } from "mongodb"
import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("./mongodb-schema.js", () => ({
	entitiesCollection: vi.fn(),
	episodesCollection: vi.fn(),
	eventsCollection: vi.fn(),
	proceduresCollection: vi.fn(),
	relationsCollection: vi.fn(),
	structuredMemCollection: vi.fn(),
	structuredMemRevisionsCollection: vi.fn(),
}))

vi.mock("./mongodb-ops.js", () => ({
	recordProjectionRun: vi.fn().mockResolvedValue("run-1"),
}))

import { buildDiscoveryProjection } from "./mongodb-discovery-projections.js"
import { recordProjectionRun } from "./mongodb-ops.js"
import {
	entitiesCollection,
	episodesCollection,
	eventsCollection,
	proceduresCollection,
	relationsCollection,
	structuredMemCollection,
	structuredMemRevisionsCollection,
} from "./mongodb-schema.js"

const PREFIX = "test_"
const AGENT_ID = "agent-1"
const SCOPE = "workspace" as const
const SCOPE_REF = "workspace:demo"

function createMockFindCollection(docs: Document[]): Collection {
	return {
		find: vi.fn().mockReturnValue({
			sort: vi.fn().mockReturnValue({
				limit: vi.fn().mockReturnValue({
					toArray: vi.fn().mockResolvedValue(docs),
				}),
			}),
		}),
	} as unknown as Collection
}

function defaultParams() {
	return {
		db: {} as Db,
		prefix: PREFIX,
		agentId: AGENT_ID,
		scope: SCOPE,
		scopeRef: SCOPE_REF,
	}
}

describe("mongodb-discovery-projections", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("builds an entity brief with entity, relation, and structured provenance", async () => {
		vi.mocked(entitiesCollection)
			.mockReturnValueOnce(
				createMockFindCollection([
					{
						entityId: "ent-phoenix",
						name: "Phoenix",
						type: "project",
						updatedAt: new Date("2026-04-05T11:00:00.000Z"),
						scope: SCOPE,
						scopeRef: SCOPE_REF,
						sourceEventIds: ["evt-1"],
					},
				]),
			)
			.mockReturnValueOnce(
				createMockFindCollection([
					{
						entityId: "ent-alice",
						name: "Alice",
						type: "person",
						updatedAt: new Date("2026-04-05T10:00:00.000Z"),
						scope: SCOPE,
						scopeRef: SCOPE_REF,
						sourceEventIds: ["evt-2"],
					},
				]),
			)
		vi.mocked(relationsCollection).mockReturnValue(
			createMockFindCollection([
				{
					fromEntityId: "ent-phoenix",
					toEntityId: "ent-alice",
					type: "owns",
					state: "active",
					updatedAt: new Date("2026-04-05T11:05:00.000Z"),
					scope: SCOPE,
					scopeRef: SCOPE_REF,
					sourceEventIds: ["evt-3"],
				},
			]),
		)
		vi.mocked(structuredMemCollection).mockReturnValue(
			createMockFindCollection([
				{
					type: "decision",
					key: "phoenix-rollout",
					value: "Phoenix rollout stays behind a feature flag.",
					state: "active",
					salience: "high",
					updatedAt: new Date("2026-04-05T09:30:00.000Z"),
					scope: SCOPE,
					scopeRef: SCOPE_REF,
					sourceEventIds: ["evt-4"],
				},
			]),
		)

		const projection = await buildDiscoveryProjection({
			...defaultParams(),
			kind: "entity-brief",
			query: "Phoenix",
			maxItems: 4,
		})

		expect(projection.kind).toBe("entity-brief")
		expect(projection.title).toContain("Phoenix")
		expect(projection.sections.map((section) => section.title)).toEqual([
			"Entities",
			"Relationships",
			"Durable context",
		])
		expect(projection.sections[0]?.evidence[0]?.path).toBe(
			`entity:ent-phoenix?scope=${SCOPE}&scopeRef=${encodeURIComponent(SCOPE_REF)}`,
		)
		expect(projection.sections[1]?.evidence[0]?.path).toBe(
			`relation:ent-phoenix-ent-alice?scope=${SCOPE}&scopeRef=${encodeURIComponent(SCOPE_REF)}`,
		)
		expect(projection.sections[2]?.evidence[0]?.path).toBe(
			`structured:decision:phoenix-rollout?scope=${SCOPE}&scopeRef=${encodeURIComponent(SCOPE_REF)}`,
		)
		expect(projection.metadata.evidenceCount).toBe(3)
		expect(projection.metadata.sourceCounts).toEqual({
			graph: 2,
			structured: 1,
		})
		expect(recordProjectionRun).toHaveBeenCalledWith(
			expect.objectContaining({
				run: expect.objectContaining({
					projectionType: "entity-brief",
					status: "ok",
				}),
			}),
		)
	})

	it("builds a topic brief from episodes, procedures, and durable memory", async () => {
		vi.mocked(episodesCollection).mockReturnValue(
			createMockFindCollection([
				{
					episodeId: "ep-1",
					title: "Rollback planning",
					summary: "The team reviewed rollback criteria and release safety.",
					status: "active",
					timeRange: {
						start: new Date("2026-04-04T10:00:00.000Z"),
						end: new Date("2026-04-04T11:00:00.000Z"),
					},
					scope: SCOPE,
					scopeRef: SCOPE_REF,
					sourceEventIds: ["evt-10"],
				},
			]),
		)
		vi.mocked(structuredMemCollection).mockReturnValue(
			createMockFindCollection([
				{
					type: "fact",
					key: "rollback-window",
					value: "Rollback window remains open for 30 minutes after deploy.",
					state: "active",
					updatedAt: new Date("2026-04-04T11:10:00.000Z"),
					scope: SCOPE,
					scopeRef: SCOPE_REF,
					sourceEventIds: ["evt-11"],
				},
			]),
		)
		vi.mocked(proceduresCollection).mockReturnValue(
			createMockFindCollection([
				{
					procedureId: "rollback-runbook",
					name: "Rollback runbook",
					steps: ["Disable rollout", "Restore prior stable version"],
					state: "active",
					updatedAt: new Date("2026-04-04T11:20:00.000Z"),
					scope: SCOPE,
					scopeRef: SCOPE_REF,
					sourceEventIds: ["evt-12"],
				},
			]),
		)

		const projection = await buildDiscoveryProjection({
			...defaultParams(),
			kind: "topic-brief",
			query: "rollback",
		})

		expect(projection.kind).toBe("topic-brief")
		expect(projection.sections.map((section) => section.title)).toEqual([
			"Recent episodes",
			"Durable memory",
			"Procedures",
		])
		expect(projection.sections[0]?.evidence[0]?.path).toBe("episode:ep-1")
		expect(projection.sections[2]?.evidence[0]?.path).toBe(
			`procedure:rollback-runbook?scope=${SCOPE}&scopeRef=${encodeURIComponent(SCOPE_REF)}`,
		)
		expect(projection.metadata.sourceCounts).toEqual({
			episodic: 1,
			structured: 1,
			procedural: 1,
		})
	})

	it("builds a what-changed brief with default last-7d time range and partial status on lane failure", async () => {
		vi.useFakeTimers()
		vi.setSystemTime(new Date("2026-04-05T12:00:00.000Z"))

		vi.mocked(structuredMemRevisionsCollection).mockReturnValue(
			createMockFindCollection([
				{
					type: "decision",
					key: "routing-policy",
					value: "Old routing policy",
					supersededAt: new Date("2026-04-04T10:00:00.000Z"),
					scope: SCOPE,
					scopeRef: SCOPE_REF,
					sourceEventIds: ["evt-20"],
				},
			]),
		)
		vi.mocked(eventsCollection).mockReturnValue(
			createMockFindCollection([
				{
					eventId: "evt-21",
					role: "assistant",
					body: "Trust-aware routing is now enabled for current-state answers.",
					timestamp: new Date("2026-04-05T08:00:00.000Z"),
					scope: SCOPE,
					scopeRef: SCOPE_REF,
				},
			]),
		)
		vi.mocked(proceduresCollection).mockReturnValue({
			find: vi.fn(() => {
				throw new Error("procedures unavailable")
			}),
		} as unknown as Collection)
		vi.mocked(relationsCollection).mockReturnValue(createMockFindCollection([]))
		vi.mocked(structuredMemCollection).mockReturnValue(
			createMockFindCollection([]),
		)

		const projection = await buildDiscoveryProjection({
			...defaultParams(),
			kind: "what-changed",
		})

		expect(projection.kind).toBe("what-changed")
		expect(projection.metadata.partial).toBe(true)
		expect(projection.metadata.timeRange).toEqual({
			label: "last-7d",
			start: new Date("2026-03-29T12:00:00.000Z"),
			end: new Date("2026-04-05T12:00:00.000Z"),
		})
		expect(projection.sections.map((section) => section.title)).toEqual([
			"Structured changes",
			"Recent anchors",
		])
		expect(recordProjectionRun).toHaveBeenCalledWith(
			expect.objectContaining({
				run: expect.objectContaining({
					projectionType: "what-changed",
					status: "partial",
				}),
			}),
		)

		vi.useRealTimers()
	})

	it("builds structured change evidence with previous and current durable truth", async () => {
		vi.mocked(structuredMemRevisionsCollection).mockReturnValue(
			createMockFindCollection([
				{
					type: "decision",
					key: "routing-policy",
					value: "Old routing policy",
					supersededAt: new Date("2026-04-04T10:00:00.000Z"),
					scope: SCOPE,
					scopeRef: SCOPE_REF,
					sourceEventIds: ["evt-40"],
				},
			]),
		)
		vi.mocked(structuredMemCollection).mockImplementation(() => {
			const find = vi.fn((query?: Document) => {
				if (
					query?.state === "active" &&
					Array.isArray(query?.$or) &&
					query.$or.some(
						(entry) =>
							entry?.type === "decision" && entry?.key === "routing-policy",
					)
				) {
					return {
						toArray: vi.fn().mockResolvedValue([
							{
								type: "decision",
								key: "routing-policy",
								value: "Trust-aware routing policy",
								state: "active",
								updatedAt: new Date("2026-04-05T09:30:00.000Z"),
								scope: SCOPE,
								scopeRef: SCOPE_REF,
								sourceEventIds: ["evt-41"],
							},
						]),
					}
				}
				return {
					sort: vi.fn().mockReturnValue({
						limit: vi.fn().mockReturnValue({
							toArray: vi.fn().mockResolvedValue([]),
						}),
					}),
				}
			})
			return { find } as unknown as Collection
		})
		vi.mocked(proceduresCollection).mockReturnValue(
			createMockFindCollection([]),
		)
		vi.mocked(relationsCollection).mockReturnValue(createMockFindCollection([]))
		vi.mocked(eventsCollection).mockReturnValue(createMockFindCollection([]))

		const projection = await buildDiscoveryProjection({
			...defaultParams(),
			kind: "what-changed",
			maxItems: 4,
		})

		expect(projection.sections[0]?.title).toBe("Structured changes")
		expect(projection.sections[0]?.evidence[0]?.summary).toContain(
			"Old routing policy",
		)
		expect(projection.sections[0]?.evidence[0]?.summary).toContain(
			"Trust-aware routing policy",
		)
		expect(projection.sections[0]?.evidence[0]?.sourceEventIds).toEqual([
			"evt-40",
			"evt-41",
		])
	})

	it("builds a contradiction report from invalidated and conflicted lanes", async () => {
		vi.mocked(structuredMemCollection).mockReturnValue(
			createMockFindCollection([
				{
					type: "fact",
					key: "deployment-owner",
					value: "Alice owns deploy approvals.",
					state: "conflicted",
					updatedAt: new Date("2026-04-05T09:00:00.000Z"),
					scope: SCOPE,
					scopeRef: SCOPE_REF,
					sourceEventIds: ["evt-30"],
				},
			]),
		)
		vi.mocked(proceduresCollection).mockReturnValue(
			createMockFindCollection([
				{
					procedureId: "legacy-rollback",
					name: "Legacy rollback",
					state: "invalidated",
					updatedAt: new Date("2026-04-05T09:10:00.000Z"),
					scope: SCOPE,
					scopeRef: SCOPE_REF,
					sourceEventIds: ["evt-31"],
				},
			]),
		)
		vi.mocked(relationsCollection).mockReturnValue(
			createMockFindCollection([
				{
					fromEntityId: "ent-service",
					toEntityId: "ent-bob",
					type: "owns",
					state: "invalidated",
					updatedAt: new Date("2026-04-05T09:15:00.000Z"),
					scope: SCOPE,
					scopeRef: SCOPE_REF,
					sourceEventIds: ["evt-32"],
				},
			]),
		)

		const projection = await buildDiscoveryProjection({
			...defaultParams(),
			kind: "contradiction-report",
		})

		expect(projection.kind).toBe("contradiction-report")
		expect(projection.summary).toContain("3")
		expect(projection.sections.map((section) => section.title)).toEqual([
			"Structured contradictions",
			"Procedure contradictions",
			"Relation contradictions",
		])
		expect(projection.sections[1]?.evidence[0]?.path).toBe(
			`procedure:legacy-rollback?scope=${SCOPE}&scopeRef=${encodeURIComponent(SCOPE_REF)}`,
		)
		expect(projection.sections[2]?.evidence[0]?.path).toBe(
			`relation:ent-service-ent-bob?scope=${SCOPE}&scopeRef=${encodeURIComponent(SCOPE_REF)}`,
		)
	})
})
