import type { Collection, Document } from "mongodb"
import { afterEach, expect, it, vi } from "vitest"
import { findExactProcedureMatches } from "./mongodb-procedures.js"

const asOf = new Date("2026-10-02T00:00:00Z")
const options = {
	maxResults: 3,
	filter: {
		agentId: "owner",
		scope: "agent" as const,
		scopeRef: "agent:owner",
		state: "active" as const,
		currentOnly: true,
		asOf,
	},
}
function collection(error?: Error) {
	const find = vi.fn((_filter: Document, _options?: Document) => ({
		toArray: async () => {
			if (error) throw error
			return []
		},
	}))
	return { col: { find } as unknown as Collection, find }
}
afterEach(() => vi.unstubAllEnvs())
it.each([
	undefined,
	"1250",
	"not-a-number",
])("applies the existing processing limit for setting %s", async (setting) => {
	vi.stubEnv("MEMONGO_SEARCH_MAX_TIME_MS", setting)
	const { col, find } = collection()
	expect(
		await findExactProcedureMatches(col, "deploy (blue)", options),
	).toEqual([])
	expect(find).toHaveBeenCalledOnce()
	const [filter, findOptions] = find.mock.calls[0]
	expect(findOptions).toEqual({
		maxTimeMS: setting === "1250" ? 1250 : 10000,
		projection: {
			_id: 0,
			procedureId: 1,
			searchText: 1,
			sessionId: 1,
			confidence: 1,
			updatedAt: 1,
			state: 1,
			scope: 1,
			scopeRef: 1,
			provenance: 1,
			sourceEventIds: 1,
			validFrom: 1,
			validTo: 1,
		},
		sort: { updatedAt: -1 },
		limit: 3,
	})
	expect(filter).toEqual({
		$and: [
			{
				agentId: "owner",
				scope: "agent",
				scopeRef: "agent:owner",
				state: "active",
			},
			{
				$or: [{ validFrom: { $exists: false } }, { validFrom: { $lte: asOf } }],
			},
			{ $or: [{ validTo: { $exists: false } }, { validTo: { $gt: asOf } }] },
			{
				$or: [
					{ name: /^deploy \(blue\)$/i },
					{ triggerQueries: /^deploy \(blue\)$/i },
				],
			},
		],
	})
})
it("preserves the original cursor rejection", async () => {
	const error = new Error("query processing timed out")
	const { col } = collection(error)
	await expect(findExactProcedureMatches(col, "deploy", options)).rejects.toBe(
		error,
	)
})
it("keeps empty queries free of database calls", async () => {
	const { col, find } = collection()
	expect(await findExactProcedureMatches(col, "   ", options)).toEqual([])
	expect(find).not.toHaveBeenCalled()
})
