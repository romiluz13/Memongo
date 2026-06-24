/* eslint-disable @typescript-eslint/unbound-method -- Vitest mock method assertions */
import type { Collection, Db, Document } from "mongodb"
import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("./mongodb-schema.js", () => ({
	eventsCollection: vi.fn(),
	proceduresCollection: vi.fn(),
	structuredMemCollection: vi.fn(),
}))

vi.mock("./mongodb-telemetry.js", () => ({
	emitTelemetry: vi.fn(),
}))

import {
	hydrateActiveSlate,
	materializeBlocks,
} from "./mongodb-active-slate.js"
import {
	eventsCollection,
	proceduresCollection,
	structuredMemCollection,
} from "./mongodb-schema.js"
import { emitTelemetry } from "./mongodb-telemetry.js"

const PREFIX = "test_"
const AGENT_ID = "agent-1"
const SCOPE = "workspace" as const
const SCOPE_REF = "workspace:demo"

function createMockFindCollection(docs: Document[]): Collection {
	return {
		find: vi.fn().mockReturnValue({
			sort: vi.fn().mockReturnValue({
				limit: vi.fn().mockReturnValue({
					project: vi.fn().mockReturnValue({
						toArray: vi.fn().mockResolvedValue(docs),
					}),
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

describe("mongodb-active-slate", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("hydrates a tiny prioritized slate from active memory, procedures, and recent anchors", async () => {
		const now = new Date("2026-04-05T12:00:00.000Z")
		vi.useFakeTimers()
		vi.setSystemTime(now)

		vi.mocked(structuredMemCollection)
			.mockReturnValueOnce(
				createMockFindCollection([
					{
						type: "todo",
						key: "blocker-db-migration",
						value: "Database migration is blocked on rollout approval.",
						salience: "critical",
						state: "active",
						updatedAt: new Date("2026-04-05T11:30:00.000Z"),
						scope: SCOPE,
						scopeRef: SCOPE_REF,
						sourceEventIds: ["evt-1"],
					},
				]),
			)
			.mockReturnValueOnce(
				createMockFindCollection([
					{
						type: "decision",
						key: "decision-memory-routing",
						value: "Use trust-aware routing for current-state recall.",
						salience: "high",
						state: "active",
						updatedAt: new Date("2026-04-05T10:00:00.000Z"),
						scope: SCOPE,
						scopeRef: SCOPE_REF,
						sourceEventIds: ["evt-2"],
					},
				]),
			)
		vi.mocked(proceduresCollection).mockReturnValue(
			createMockFindCollection([
				{
					procedureId: "rollback-memory",
					name: "Rollback memory routing changes",
					steps: ["Disable flag", "Re-run proof pack", "Restore prior policy"],
					state: "active",
					updatedAt: new Date("2026-04-05T11:00:00.000Z"),
					scope: SCOPE,
					scopeRef: SCOPE_REF,
					sourceEventIds: ["evt-3"],
				},
			]),
		)
		vi.mocked(eventsCollection).mockReturnValue(
			createMockFindCollection([
				{
					eventId: "evt-4",
					role: "user",
					body: "We still need seeded proof before rollout.",
					timestamp: new Date("2026-04-05T11:45:00.000Z"),
					scope: SCOPE,
					scopeRef: SCOPE_REF,
				},
			]),
		)

		const slate = await hydrateActiveSlate({
			...defaultParams(),
			maxItems: 4,
		})

		expect(slate.agentId).toBe(AGENT_ID)
		expect(slate.scope).toBe(SCOPE)
		expect(slate.scopeRef).toBe(SCOPE_REF)
		expect(slate.items).toHaveLength(4)
		expect(slate.items.map((item) => item.kind)).toEqual([
			"active-critical",
			"procedure",
			"decision",
			"recent-anchor",
		])
		expect(slate.items.map((item) => item.path)).toEqual([
			`structured:todo:blocker-db-migration?scope=${SCOPE}&scopeRef=${encodeURIComponent(SCOPE_REF)}`,
			"procedure:rollback-memory",
			`structured:decision:decision-memory-routing?scope=${SCOPE}&scopeRef=${encodeURIComponent(SCOPE_REF)}`,
			"events/evt-4",
		])
		expect(slate.metadata.maxItems).toBe(4)
		expect(slate.metadata.truncated).toBe(false)
		expect(slate.metadata.countsByKind).toEqual({
			"active-critical": 1,
			procedure: 1,
			decision: 1,
			"recent-anchor": 1,
		})
		expect(emitTelemetry).toHaveBeenCalledWith(
			expect.anything(),
			expect.any(String),
			expect.objectContaining({
				meta: expect.objectContaining({
					operation: "active-slate-hydration",
				}),
			}),
		)

		vi.useRealTimers()
	})

	it("prioritizes explicit durable state before generated active-context projections", async () => {
		vi.mocked(structuredMemCollection)
			.mockReturnValueOnce(
				createMockFindCollection([
					{
						type: "fact",
						key: "active-context-latest",
						value: "Assistant answer about Phoenix validation.",
						salience: "critical",
						state: "active",
						updatedAt: new Date("2026-04-05T11:59:00.000Z"),
						scope: SCOPE,
						scopeRef: SCOPE_REF,
						tags: ["active-context", "phoenix"],
					},
					{
						type: "decision",
						key: "phoenix-release-window",
						value: "Phoenix deploys on Monday afternoon after validation.",
						salience: "critical",
						state: "active",
						updatedAt: new Date("2026-04-05T10:00:00.000Z"),
						scope: SCOPE,
						scopeRef: SCOPE_REF,
						tags: ["phoenix", "release"],
					},
				]),
			)
			.mockReturnValueOnce(createMockFindCollection([]))
		vi.mocked(proceduresCollection).mockReturnValue(
			createMockFindCollection([]),
		)
		vi.mocked(eventsCollection).mockReturnValue(createMockFindCollection([]))

		const slate = await hydrateActiveSlate({
			...defaultParams(),
			maxItems: 1,
		})

		expect(slate.items).toHaveLength(1)
		expect(slate.items[0]).toEqual(
			expect.objectContaining({
				title: "phoenix-release-window",
				summary: "Phoenix deploys on Monday afternoon after validation.",
			}),
		)
	})

	it("filters every query by agent scope and clamps requested size to six items", async () => {
		vi.mocked(structuredMemCollection)
			.mockReturnValueOnce(createMockFindCollection([]))
			.mockReturnValueOnce(createMockFindCollection([]))
		vi.mocked(proceduresCollection).mockReturnValue(
			createMockFindCollection([]),
		)
		vi.mocked(eventsCollection).mockReturnValue(createMockFindCollection([]))

		await hydrateActiveSlate({
			...defaultParams(),
			maxItems: 9,
		})

		const structuredCalls = vi
			.mocked(structuredMemCollection)
			.mock.results.map(
				(result) =>
					vi.mocked(result.value.find).mock.calls[0]?.[0] as
						| Document
						| undefined,
			)
		const procedureFilter = vi.mocked(
			vi.mocked(proceduresCollection).mock.results[0]?.value.find,
		).mock.calls[0]?.[0] as Document
		const eventFilter = vi.mocked(
			vi.mocked(eventsCollection).mock.results[0]?.value.find,
		).mock.calls[0]?.[0] as Document

		for (const filter of structuredCalls) {
			expect(filter).toMatchObject({
				agentId: AGENT_ID,
				scope: SCOPE,
				scopeRef: SCOPE_REF,
				state: "active",
			})
		}
		expect(procedureFilter).toMatchObject({
			agentId: AGENT_ID,
			scope: SCOPE,
			scopeRef: SCOPE_REF,
			state: "active",
		})
		expect(eventFilter).toMatchObject({
			agentId: AGENT_ID,
			scope: SCOPE,
			scopeRef: SCOPE_REF,
		})

		const firstStructuredLimit = vi.mocked(
			vi.mocked(vi.mocked(structuredMemCollection).mock.results[0]?.value.find)
				.mock.results[0]?.value.sort,
		).mock.results[0]?.value.limit
		expect(vi.mocked(firstStructuredLimit).mock.calls[0]?.[0]).toBe(6)
	})

	it("returns partial results when one source query fails", async () => {
		const failingStructured = {
			find: vi.fn(() => {
				throw new Error("structured timeout")
			}),
		} as unknown as Collection
		vi.mocked(structuredMemCollection)
			.mockReturnValueOnce(failingStructured)
			.mockReturnValueOnce(createMockFindCollection([]))
		vi.mocked(proceduresCollection).mockReturnValue(
			createMockFindCollection([
				{
					procedureId: "keep-running",
					name: "Keep running proof pack",
					steps: ["Seed", "Run", "Compare"],
					state: "active",
					updatedAt: new Date("2026-04-05T11:00:00.000Z"),
					scope: SCOPE,
					scopeRef: SCOPE_REF,
				},
			]),
		)
		vi.mocked(eventsCollection).mockReturnValue(createMockFindCollection([]))

		const slate = await hydrateActiveSlate(defaultParams())

		expect(slate.items).toHaveLength(1)
		expect(slate.items[0]?.kind).toBe("procedure")
		expect(slate.metadata.partial).toBe(true)
	})
})

describe("materializeBlocks", () => {
	function makeSlate(
		items: Array<{ kind: string; title: string; summary: string }>,
	) {
		return {
			agentId: "test-agent",
			scope: "user" as const,
			scopeRef: "u1",
			items: items.map((i) => ({
				kind: i.kind as
					| "active-critical"
					| "procedure"
					| "decision"
					| "current-state"
					| "recent-anchor",
				source: "structured" as const,
				title: i.title,
				summary: i.summary,
				path: "structured:test",
			})),
			metadata: {
				maxItems: 5,
				truncated: false,
				partial: false,
				countsByKind: {},
				sourceCounts: {},
			},
			hydratedAt: new Date(),
		}
	}

	it("groups items by kind → label", () => {
		const slate = makeSlate([
			{ kind: "active-critical", title: "Risk A", summary: "Bad thing" },
			{ kind: "decision", title: "Dec 1", summary: "We chose X" },
			{ kind: "active-critical", title: "Risk B", summary: "Another risk" },
		])
		const blocks = materializeBlocks(slate)

		expect(blocks.blocks).toHaveLength(2)
		const riskBlock = blocks.blocks.find((b) => b.label === "active-risks")
		expect(riskBlock?.items).toHaveLength(2)
		const workBlock = blocks.blocks.find((b) => b.label === "current-work")
		expect(workBlock?.items).toHaveLength(1)
	})

	it("computes token totals", () => {
		const slate = makeSlate([
			{
				kind: "current-state",
				title: "Name",
				summary: "Test user profile summary text",
			},
		])
		const blocks = materializeBlocks(slate)

		expect(blocks.totalTokenBudget).toBeGreaterThan(0)
		expect(blocks.totalActualTokens).toBeGreaterThan(0)
		expect(blocks.blocks[0]?.actualTokens).toBeGreaterThan(0)
	})

	it("accepts budget overrides", () => {
		const slate = makeSlate([
			{ kind: "procedure", title: "Step", summary: "Do thing" },
		])
		const blocks = materializeBlocks(slate, { "procedure-hints": 200 })

		const procBlock = blocks.blocks.find((b) => b.label === "procedure-hints")
		expect(procBlock?.tokenBudget).toBe(200)
		expect(blocks.totalTokenBudget).toBe(200)
	})

	it("returns empty blocks for empty slate", () => {
		const slate = makeSlate([])
		const blocks = materializeBlocks(slate)

		expect(blocks.blocks).toHaveLength(0)
		expect(blocks.totalTokenBudget).toBe(0)
		expect(blocks.totalActualTokens).toBe(0)
	})

	it("maps all 5 slate kinds to labeled blocks", () => {
		const slate = makeSlate([
			{ kind: "active-critical", title: "a", summary: "b" },
			{ kind: "procedure", title: "a", summary: "b" },
			{ kind: "decision", title: "a", summary: "b" },
			{ kind: "current-state", title: "a", summary: "b" },
			{ kind: "recent-anchor", title: "a", summary: "b" },
		])
		const blocks = materializeBlocks(slate)

		const labels = blocks.blocks.map((b) => b.label).sort()
		expect(labels).toEqual([
			"active-risks",
			"current-work",
			"procedure-hints",
			"recent-context",
			"user-profile",
		])
	})
})
