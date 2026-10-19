// Projection shapes, provenance and TTL guards. Content matching is modeled
// through test-helpers/search-model-db.ts; the Search-specific behavior
// (analyzers, re-checks, typed failure rows) lives in
// mongodb-discovery-search.test.ts.
import type { Document } from "mongodb"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { buildDiscoveryProjection } from "./mongodb-discovery-projections.js"
import {
	createSearchModelDb,
	type SearchModelDb,
} from "./test-helpers/search-model-db.js"
import type { MemoryDiscoveryProjectionKind } from "./types.js"

const AGENT_ID = "agent-1"
const SCOPE = "workspace" as const
const SCOPE_REF = "workspace:demo"
const TENANT = { agentId: AGENT_ID, scope: SCOPE, scopeRef: SCOPE_REF }
const REF = `scope=${SCOPE}&scopeRef=${encodeURIComponent(SCOPE_REF)}`

let model: SearchModelDb

function run(
	kind: MemoryDiscoveryProjectionKind,
	extra: { query?: string; maxItems?: number } = {},
) {
	return buildDiscoveryProjection({
		db: model.db,
		prefix: "test_",
		agentId: AGENT_ID,
		scope: SCOPE,
		scopeRef: SCOPE_REF,
		kind,
		...extra,
	})
}

const at = (iso: string) => new Date(iso)

beforeEach(() => {
	model = createSearchModelDb()
})
afterEach(() => {
	model.expectNoModelErrors()
	vi.useRealTimers()
})

describe("mongodb-discovery-projections", () => {
	it("builds an entity brief with entity, relation, and structured provenance", async () => {
		await model.seed("entities", [
			{
				...TENANT,
				entityId: "ent-phoenix",
				name: "Phoenix",
				type: "project",
				updatedAt: at("2026-04-05T11:00:00.000Z"),
				sourceEventIds: ["evt-1"],
			},
			{
				...TENANT,
				entityId: "ent-alice",
				name: "Alice",
				type: "person",
				updatedAt: at("2026-04-05T10:00:00.000Z"),
				sourceEventIds: ["evt-2"],
			},
		])
		await model.seed("relations", [
			{
				...TENANT,
				fromEntityId: "ent-phoenix",
				toEntityId: "ent-alice",
				type: "owns",
				state: "active",
				updatedAt: at("2026-04-05T11:05:00.000Z"),
				sourceEventIds: ["evt-3"],
			},
		])
		await model.seed("structured_mem", [
			{
				...TENANT,
				type: "decision",
				key: "phoenix-rollout",
				value: "Phoenix rollout stays behind a feature flag.",
				state: "active",
				salience: "high",
				updatedAt: at("2026-04-05T09:30:00.000Z"),
				sourceEventIds: ["evt-4"],
			},
		])
		model.refreshIndexes()

		const projection = await run("entity-brief", {
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
			`entity:ent-phoenix?${REF}`,
		)
		expect(projection.sections[1]?.evidence[0]?.path).toBe(
			`relation:ent-phoenix-ent-alice-owns?${REF}`,
		)
		expect(projection.sections[1]?.evidence[0]?.title).toBe(
			"Phoenix owns Alice",
		)
		expect(projection.sections[2]?.evidence[0]?.path).toBe(
			`structured:decision:phoenix-rollout?${REF}`,
		)
		expect(projection.metadata.evidenceCount).toBe(3)
		expect(projection.metadata.sourceCounts).toEqual({
			graph: 2,
			structured: 1,
		})
		expect(projection.metadata.failures).toEqual([])
		expect(model.fake.all("projection_runs")).toEqual([
			expect.objectContaining({ projectionType: "entity-brief", status: "ok" }),
		])
	})

	it("builds a topic brief from episodes, procedures, and durable memory", async () => {
		await model.seed("episodes", [
			{
				...TENANT,
				episodeId: "ep-1",
				title: "Rollback planning",
				summary: "The team reviewed rollback criteria and release safety.",
				status: "active",
				timeRange: {
					start: at("2026-04-04T10:00:00.000Z"),
					end: at("2026-04-04T11:00:00.000Z"),
				},
				sourceEventIds: ["evt-10"],
			},
		])
		await model.seed("structured_mem", [
			{
				...TENANT,
				type: "fact",
				key: "rollback-window",
				value: "Rollback window remains open for 30 minutes after deploy.",
				state: "active",
				updatedAt: at("2026-04-04T11:10:00.000Z"),
				sourceEventIds: ["evt-11"],
			},
		])
		await model.seed("procedures", [
			{
				...TENANT,
				procedureId: "rollback-runbook",
				name: "Rollback runbook",
				searchText:
					"Rollback runbook Disable rollout Restore prior stable version",
				steps: ["Disable rollout", "Restore prior stable version"],
				state: "active",
				updatedAt: at("2026-04-04T11:20:00.000Z"),
				sourceEventIds: ["evt-12"],
			},
		])
		model.refreshIndexes()

		const projection = await run("topic-brief", { query: "rollback" })

		expect(projection.kind).toBe("topic-brief")
		expect(projection.sections.map((section) => section.title)).toEqual([
			"Recent episodes",
			"Durable memory",
			"Procedures",
		])
		expect(projection.sections[0]?.evidence[0]?.path).toBe("episode:ep-1")
		expect(projection.sections[2]?.evidence[0]?.path).toBe(
			`procedure:rollback-runbook?${REF}`,
		)
		expect(projection.sections[2]?.evidence[0]?.summary).toBe(
			"Disable rollout -> Restore prior stable version",
		)
		expect(projection.metadata.sourceCounts).toEqual({
			episodic: 1,
			structured: 1,
			procedural: 1,
		})
	})

	it("builds a what-changed brief with the default last-7d time range", async () => {
		vi.useFakeTimers()
		vi.setSystemTime(at("2026-04-05T12:00:00.000Z"))
		await model.seed("structured_mem_revisions", [
			{
				...TENANT,
				type: "decision",
				key: "routing-policy",
				value: "Old routing policy",
				supersededAt: at("2026-04-04T10:00:00.000Z"),
				sourceEventIds: ["evt-20"],
			},
		])
		await model.seed("events", [
			{
				...TENANT,
				eventId: "evt-21",
				role: "assistant",
				body: "Trust-aware routing is now enabled for current-state answers.",
				timestamp: at("2026-04-05T08:00:00.000Z"),
			},
		])

		const projection = await run("what-changed")

		expect(projection.kind).toBe("what-changed")
		expect(projection.metadata.partial).toBe(false)
		expect(projection.metadata.failures).toEqual([])
		expect(projection.metadata.timeRange).toEqual({
			label: "last-7d",
			start: at("2026-03-29T12:00:00.000Z"),
			end: at("2026-04-05T12:00:00.000Z"),
		})
		expect(projection.sections.map((section) => section.title)).toEqual([
			"Structured changes",
			"Recent anchors",
		])
	})

	it("builds structured change evidence with previous and current durable truth", async () => {
		await model.seed("structured_mem_revisions", [
			{
				...TENANT,
				type: "decision",
				key: "routing-policy",
				value: "Old routing policy",
				supersededAt: new Date(Date.now() - 86_400_000),
				sourceEventIds: ["evt-40"],
			},
		])
		await model.seed("structured_mem", [
			{
				...TENANT,
				type: "decision",
				key: "routing-policy",
				value: "Trust-aware routing policy",
				state: "active",
				updatedAt: new Date(Date.now() - 3_600_000),
				sourceEventIds: ["evt-41"],
			},
		])

		const projection = await run("what-changed", { maxItems: 4 })

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
		await model.seed("structured_mem", [
			{
				...TENANT,
				type: "fact",
				key: "deployment-owner",
				value: "Alice owns deploy approvals.",
				state: "conflicted",
				updatedAt: at("2026-04-05T09:00:00.000Z"),
				sourceEventIds: ["evt-30"],
			},
		])
		await model.seed("procedures", [
			{
				...TENANT,
				procedureId: "legacy-rollback",
				name: "Legacy rollback",
				state: "invalidated",
				updatedAt: at("2026-04-05T09:10:00.000Z"),
				sourceEventIds: ["evt-31"],
			},
		])
		await model.seed("relations", [
			{
				...TENANT,
				fromEntityId: "ent-service",
				toEntityId: "ent-bob",
				type: "owns",
				state: "invalidated",
				updatedAt: at("2026-04-05T09:15:00.000Z"),
				sourceEventIds: ["evt-32"],
			},
		])

		const projection = await run("contradiction-report")

		expect(projection.kind).toBe("contradiction-report")
		expect(projection.summary).toContain("3")
		expect(projection.sections.map((section) => section.title)).toEqual([
			"Structured contradictions",
			"Procedure contradictions",
			"Relation contradictions",
		])
		expect(projection.sections[1]?.evidence[0]?.path).toBe(
			`procedure:legacy-rollback?${REF}`,
		)
		expect(projection.sections[2]?.evidence[0]?.path).toBe(
			`relation:ent-service-ent-bob-owns?${REF}`,
		)
	})

	it.each([
		undefined,
		"   ",
	])("treats query %j as no query for what-changed and contradiction reads", async (query) => {
		await model.seed("relations", [
			{
				...TENANT,
				fromEntityId: "a",
				toEntityId: "b",
				type: "owns",
				state: "conflicted",
				updatedAt: new Date(),
			},
		])
		const result = await run("contradiction-report", { query })
		expect(result.sections[0]?.title).toBe("Relation contradictions")
		expect(
			["entities", "structured_mem", "procedures"].flatMap((suffix) =>
				model.searchPipelines(suffix),
			),
		).toEqual([])
	})
})

describe("TTL expiry guards (B1)", () => {
	const expired = new Date(Date.now() - 86_400_000)

	async function seedStructured(state: string, extra: Document = {}) {
		await model.seed("structured_mem", [
			{
				...TENANT,
				type: "fact",
				key: "live",
				value: "phoenix rollback live record",
				state,
				updatedAt: new Date(),
			},
			{
				...TENANT,
				type: "fact",
				key: "stale",
				value: "phoenix rollback stale record",
				state,
				updatedAt: new Date(),
				expiresAt: expired,
				...extra,
			},
		])
		model.refreshIndexes()
	}

	it.each([
		["entity-brief", "Durable context"],
		["topic-brief", "Durable memory"],
	] as const)("%s excludes expired structured records", async (kind, section) => {
		await seedStructured("active")
		const projection = await run(kind, { query: "phoenix rollback" })
		expect(
			projection.sections
				.find((entry) => entry.title === section)
				?.evidence.map((entry) => entry.title),
		).toEqual(["live"])
	})

	it("what-changed current-state lane excludes expired structured records", async () => {
		await model.seed("structured_mem_revisions", [
			{
				...TENANT,
				type: "fact",
				key: "stale",
				value: "old",
				supersededAt: new Date(Date.now() - 3_600_000),
			},
		])
		await model.seed("structured_mem", [
			{
				...TENANT,
				type: "fact",
				key: "stale",
				value: "current but expired",
				state: "active",
				updatedAt: new Date(),
				expiresAt: expired,
			},
		])
		const projection = await run("what-changed")
		const summary = projection.sections[0]?.evidence[0]?.summary ?? ""
		expect(summary).toContain("old")
		expect(summary).not.toContain("current but expired")
	})

	it.each([
		undefined,
		"phoenix",
	])("contradiction report excludes expired structured records (query %s)", async (query) => {
		await seedStructured("conflicted")
		const projection = await run("contradiction-report", { query })
		expect(
			projection.sections
				.find((entry) => entry.title === "Structured contradictions")
				?.evidence.map((entry) => entry.title),
		).toEqual(["live"])
	})
})
