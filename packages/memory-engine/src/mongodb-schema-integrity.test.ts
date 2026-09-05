import { describe, expect, it, vi } from "vitest"
import type { Collection } from "mongodb"
import {
	checkChunkEventOrphans,
	checkEntityLinkOrphans,
	checkEpisodeEventOrphans,
	checkRelationEntityOrphans,
} from "./mongodb-schema-integrity.js"

/**
 * C-024 (WS-14) orphan-checker battery. Mirrors the checkKBOrphans unit
 * style: fake collections answering aggregate/find/countDocuments, so each
 * checker's reference-diffing logic runs for real against canned shapes.
 */

function aggCol(rows: Array<Record<string, unknown>>) {
	return {
		aggregate: vi.fn(() => ({
			toArray: vi.fn(async () => rows),
		})),
		countDocuments: vi.fn(async () => 0),
	} as unknown as Collection
}

function findCol(rows: Array<Record<string, unknown>>) {
	return {
		find: vi.fn(() => ({
			toArray: vi.fn(async () => rows),
		})),
	} as unknown as Collection
}

describe("checkRelationEntityOrphans (C-024)", () => {
	it("detects relations whose endpoint entities no longer exist", async () => {
		const relCol = aggCol([
			{ _id: "ent-a" },
			{ _id: "ent-b" },
			{ _id: "ent-ok" },
		])
		relCol.countDocuments = vi.fn(async () => 2)
		const entCol = findCol([{ entityId: "ent-ok" }])

		const result = await checkRelationEntityOrphans(relCol, entCol)

		expect(result).toEqual({
			orphanedRelationCount: 2,
			orphanedEntityIds: ["ent-a", "ent-b"],
		})
		// The exact relation count comes from a re-query, not endpoint sums —
		// a relation with both endpoints missing is one orphaned relation.
		expect(relCol.countDocuments).toHaveBeenCalledWith({
			$or: [
				{ fromEntityId: { $in: ["ent-a", "ent-b"] } },
				{ toEntityId: { $in: ["ent-a", "ent-b"] } },
			],
		})
	})

	it("returns zero orphans when every endpoint entity exists", async () => {
		const relCol = aggCol([{ _id: "ent-a" }, { _id: "ent-b" }])
		const entCol = findCol([{ entityId: "ent-a" }, { entityId: "ent-b" }])

		const result = await checkRelationEntityOrphans(relCol, entCol)

		expect(result).toEqual({ orphanedRelationCount: 0, orphanedEntityIds: [] })
		expect(relCol.countDocuments).not.toHaveBeenCalled()
	})

	it("returns zero for an empty relations collection without touching entities", async () => {
		const relCol = aggCol([])
		const entCol = findCol([])

		const result = await checkRelationEntityOrphans(relCol, entCol)

		expect(result).toEqual({ orphanedRelationCount: 0, orphanedEntityIds: [] })
		expect(entCol.find).not.toHaveBeenCalled()
	})

	it("scopes every query by agentId when one is given", async () => {
		const relCol = aggCol([{ _id: "ent-a" }])
		relCol.countDocuments = vi.fn(async () => 1)
		const entCol = findCol([])

		await checkRelationEntityOrphans(relCol, entCol, "agent-1")

		const [pipeline] = (relCol.aggregate as ReturnType<typeof vi.fn>).mock
			.calls[0]
		expect(pipeline[0]).toEqual({ $match: { agentId: "agent-1" } })
		expect(entCol.find).toHaveBeenCalledWith(
			{ entityId: { $in: ["ent-a"] }, agentId: "agent-1" },
			{ projection: { entityId: 1 } },
		)
		expect(relCol.countDocuments).toHaveBeenCalledWith({
			agentId: "agent-1",
			$or: [
				{ fromEntityId: { $in: ["ent-a"] } },
				{ toEntityId: { $in: ["ent-a"] } },
			],
		})
	})
})

describe("checkEntityLinkOrphans (C-024)", () => {
	it("detects entity_links whose endpoint entities no longer exist", async () => {
		const linkCol = aggCol([{ _id: "ent-a" }, { _id: "ent-ok" }])
		linkCol.countDocuments = vi.fn(async () => 4)
		const entCol = findCol([{ entityId: "ent-ok" }])

		const result = await checkEntityLinkOrphans(linkCol, entCol)

		expect(result).toEqual({
			orphanedLinkCount: 4,
			orphanedEntityIds: ["ent-a"],
		})
		expect(linkCol.countDocuments).toHaveBeenCalledWith({
			$or: [
				{ fromEntityId: { $in: ["ent-a"] } },
				{ toEntityId: { $in: ["ent-a"] } },
			],
		})
	})

	it("returns zero orphans when every link endpoint exists", async () => {
		const linkCol = aggCol([{ _id: "ent-a" }])
		const entCol = findCol([{ entityId: "ent-a" }])

		const result = await checkEntityLinkOrphans(linkCol, entCol)

		expect(result).toEqual({ orphanedLinkCount: 0, orphanedEntityIds: [] })
		expect(linkCol.countDocuments).not.toHaveBeenCalled()
	})

	it("returns zero for an empty entity_links collection", async () => {
		const linkCol = aggCol([])
		const entCol = findCol([])

		const result = await checkEntityLinkOrphans(linkCol, entCol)

		expect(result).toEqual({ orphanedLinkCount: 0, orphanedEntityIds: [] })
		expect(entCol.find).not.toHaveBeenCalled()
	})

	it("scopes every query by agentId when one is given", async () => {
		const linkCol = aggCol([{ _id: "ent-a" }])
		linkCol.countDocuments = vi.fn(async () => 1)
		const entCol = findCol([])

		await checkEntityLinkOrphans(linkCol, entCol, "agent-1")

		const [pipeline] = (linkCol.aggregate as ReturnType<typeof vi.fn>).mock
			.calls[0]
		expect(pipeline[0]).toEqual({ $match: { agentId: "agent-1" } })
		expect(entCol.find).toHaveBeenCalledWith(
			{ entityId: { $in: ["ent-a"] }, agentId: "agent-1" },
			{ projection: { entityId: 1 } },
		)
	})
})

describe("checkChunkEventOrphans (C-024)", () => {
	it("counts orphaned chunks and distinct missing event ids via the events/ path", async () => {
		const chunksCol = findCol([
			{ path: "events/ev-1" },
			{ path: "events/ev-2" },
			{ path: "events/ev-2" },
		])
		const eventsCol = findCol([{ eventId: "ev-1" }])

		const result = await checkChunkEventOrphans(chunksCol, eventsCol)

		expect(result).toEqual({
			orphanedChunkCount: 2,
			orphanedEventIds: ["ev-2"],
		})
		// Only events/-prefixed paths participate — the chunk has no direct
		// eventId field, the reference lives in the path suffix.
		expect(chunksCol.find).toHaveBeenCalledWith(
			{ path: /^events\// },
			{ projection: { path: 1 } },
		)
		expect(eventsCol.find).toHaveBeenCalledWith(
			{ eventId: { $in: ["ev-1", "ev-2"] } },
			{ projection: { eventId: 1 } },
		)
	})

	it("returns zero orphans when every chunk's event exists", async () => {
		const chunksCol = findCol([{ path: "events/ev-1" }])
		const eventsCol = findCol([{ eventId: "ev-1" }])

		const result = await checkChunkEventOrphans(chunksCol, eventsCol)

		expect(result).toEqual({ orphanedChunkCount: 0, orphanedEventIds: [] })
	})

	it("ignores bare events/ paths with an empty event id", async () => {
		const chunksCol = findCol([{ path: "events/" }, { path: "events/ev-1" }])
		const eventsCol = findCol([{ eventId: "ev-1" }])

		const result = await checkChunkEventOrphans(chunksCol, eventsCol)

		expect(result).toEqual({ orphanedChunkCount: 0, orphanedEventIds: [] })
	})

	it("scopes chunk and event queries by agentId when one is given", async () => {
		const chunksCol = findCol([{ path: "events/ev-1" }])
		const eventsCol = findCol([])

		await checkChunkEventOrphans(chunksCol, eventsCol, "agent-1")

		expect(chunksCol.find).toHaveBeenCalledWith(
			{ path: /^events\//, agentId: "agent-1" },
			{ projection: { path: 1 } },
		)
		expect(eventsCol.find).toHaveBeenCalledWith(
			{ eventId: { $in: ["ev-1"] }, agentId: "agent-1" },
			{ projection: { eventId: 1 } },
		)
	})
})

describe("checkEpisodeEventOrphans (C-024)", () => {
	it("counts episodes with at least one missing source event", async () => {
		const episodesCol = findCol([
			{ sourceEventIds: ["ev-1", "ev-2"] },
			{ sourceEventIds: ["ev-1"] },
			{ sourceEventIds: [] },
		])
		const eventsCol = findCol([{ eventId: "ev-1" }])

		const result = await checkEpisodeEventOrphans(episodesCol, eventsCol)

		expect(result).toEqual({
			orphanedEpisodeCount: 1,
			orphanedEventIds: ["ev-2"],
		})
		expect(eventsCol.find).toHaveBeenCalledWith(
			{ eventId: { $in: ["ev-1", "ev-2"] } },
			{ projection: { eventId: 1 } },
		)
	})

	it("returns zero orphans when every source event exists", async () => {
		const episodesCol = findCol([{ sourceEventIds: ["ev-1", "ev-2"] }])
		const eventsCol = findCol([{ eventId: "ev-1" }, { eventId: "ev-2" }])

		const result = await checkEpisodeEventOrphans(episodesCol, eventsCol)

		expect(result).toEqual({ orphanedEpisodeCount: 0, orphanedEventIds: [] })
	})

	it("skips episodes without a sourceEventIds array", async () => {
		const episodesCol = findCol([{ episodeId: "ep-legacy" }])
		const eventsCol = findCol([])

		const result = await checkEpisodeEventOrphans(episodesCol, eventsCol)

		expect(result).toEqual({ orphanedEpisodeCount: 0, orphanedEventIds: [] })
		expect(eventsCol.find).not.toHaveBeenCalled()
	})

	it("scopes episode and event queries by agentId when one is given", async () => {
		const episodesCol = findCol([{ sourceEventIds: ["ev-1"] }])
		const eventsCol = findCol([])

		await checkEpisodeEventOrphans(episodesCol, eventsCol, "agent-1")

		expect(episodesCol.find).toHaveBeenCalledWith(
			{ sourceEventIds: { $exists: true }, agentId: "agent-1" },
			{ projection: { sourceEventIds: 1 } },
		)
		expect(eventsCol.find).toHaveBeenCalledWith(
			{ eventId: { $in: ["ev-1"] }, agentId: "agent-1" },
			{ projection: { eventId: 1 } },
		)
	})
})
