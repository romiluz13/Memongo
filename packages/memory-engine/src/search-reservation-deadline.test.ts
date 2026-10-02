import type { Db } from "mongodb"
import { afterEach, expect, it, vi } from "vitest"
import {
	runWithSearchBudget,
	tryReserveSearchBudget,
} from "./mongodb-search-budget.js"
import { searchConversationEvidenceEvents } from "./mongodb-search-lanes.js"

afterEach(() => vi.restoreAllMocks())
const limits = { maxAggregations: 3, maxEmbeds: 2, maxWallMs: 10 }

it("denies an expired reservation without converting its remaining capacity", async () => {
	let now = 1000
	vi.spyOn(Date, "now").mockImplementation(() => now)
	const { budget } = await runWithSearchBudget(limits, async () => {
		const reservation = tryReserveSearchBudget({ aggregations: 2, embeds: 1 })!
		now = 1011
		expect(reservation.tryConsumeAggregation()).toBe(false)
		expect(reservation.tryConsumeEmbed()).toBe(false)
		reservation.release()
		reservation.release()
	})
	expect(budget).toMatchObject({ aggregations: 0, embeds: 0, exhausted: true })
})

it("keeps prior consumption and the shared parent deadline in nested work", async () => {
	let now = 1000
	vi.spyOn(Date, "now").mockImplementation(() => now)
	const { budget } = await runWithSearchBudget(limits, async () => {
		const reservation = tryReserveSearchBudget({ aggregations: 2, embeds: 1 })!
		expect(reservation.tryConsumeAggregation()).toBe(true)
		now = 1011
		const nested = await runWithSearchBudget(
			{ ...limits, maxWallMs: 1000 },
			async () => reservation.tryConsumeAggregation(),
		)
		expect(nested.value).toBe(false)
		expect(reservation.tryConsumeEmbed()).toBe(false)
		reservation.release()
		reservation.release()
	})
	expect(budget).toMatchObject({ aggregations: 1, embeds: 0, exhausted: true })
})

it("does not dispatch the direct conversation-evidence consumer with expired reservation", async () => {
	let now = 1000
	vi.spyOn(Date, "now").mockImplementation(() => now)
	const aggregate = vi.fn(() => ({ toArray: async () => [] }))
	const db = { collection: () => ({ aggregate }) } as unknown as Db
	const { budget, value } = await runWithSearchBudget(limits, async () => {
		const reservation = tryReserveSearchBudget({ aggregations: 2, embeds: 1 })!
		now = 1011
		try {
			return await searchConversationEvidenceEvents({
				db,
				prefix: "test_",
				query: "we discussed the plan",
				questionDate: undefined,
				agentId: "owner",
				scope: "agent",
				scopeRef: "agent:owner",
				maxResults: 5,
				numCandidates: 20,
				capabilities: {
					vectorSearch: true,
					textSearch: true,
					scoreFusion: false,
					rankFusion: false,
					storedSource: false,
					vectorIndexMethod: false,
				},
				embeddingMode: "automated",
				queryEmbeddingModel: "voyage-4-large",
				budgetReservation: reservation,
			})
		} finally {
			reservation.release()
		}
	})
	expect(value).toEqual([])
	expect(aggregate).not.toHaveBeenCalled()
	expect(budget).toMatchObject({ aggregations: 0, embeds: 0, exhausted: true })
})

it("retains the existing strict-after-deadline boundary", async () => {
	let now = 1000
	vi.spyOn(Date, "now").mockImplementation(() => now)
	const { budget } = await runWithSearchBudget(limits, async () => {
		const reservation = tryReserveSearchBudget({ aggregations: 1, embeds: 1 })!
		now = 1010
		expect(reservation.tryConsumeAggregation()).toBe(true)
		expect(reservation.tryConsumeEmbed()).toBe(true)
		reservation.release()
	})
	expect(budget).toMatchObject({ aggregations: 1, embeds: 1, exhausted: false })
})

it("keeps no-wall reservations and unbudgeted reservations unchanged", async () => {
	let now = 1000
	vi.spyOn(Date, "now").mockImplementation(() => now)
	const unbudgeted = tryReserveSearchBudget({ aggregations: 1, embeds: 1 })!
	const { budget } = await runWithSearchBudget(
		{ maxAggregations: 2, maxEmbeds: 1 },
		async () => {
			const reservation = tryReserveSearchBudget({
				aggregations: 1,
				embeds: 1,
			})!
			now = 9000
			expect(reservation.tryConsumeAggregation()).toBe(true)
			expect(reservation.tryConsumeEmbed()).toBe(true)
			reservation.release()
		},
	)
	expect(unbudgeted.tryConsumeAggregation()).toBe(true)
	expect(unbudgeted.tryConsumeEmbed()).toBe(true)
	unbudgeted.release()
	expect(budget).toMatchObject({ aggregations: 1, embeds: 1, exhausted: false })
})
