import { describe, expect, it } from "vitest"
import {
	DEFAULT_SEARCH_BUDGET,
	getSearchBudgetSnapshot,
	hasActiveSearchBudget,
	resolveSearchBudgetLimits,
	runWithSearchBudget,
	tryConsumeSearchAggregation,
	tryConsumeSearchEmbed,
	tryReserveSearchBudget,
} from "./mongodb-search-budget.js"

describe("mongodb-search-budget", () => {
	it("resolves defaults when no overrides are given", () => {
		expect(resolveSearchBudgetLimits()).toEqual(DEFAULT_SEARCH_BUDGET)
		expect(resolveSearchBudgetLimits({})).toEqual(DEFAULT_SEARCH_BUDGET)
	})

	it("honors valid overrides and ignores invalid ones", () => {
		expect(
			resolveSearchBudgetLimits({ maxAggregations: 4, maxEmbeds: 2 }),
		).toEqual({ maxAggregations: 4, maxEmbeds: 2 })
		expect(
			resolveSearchBudgetLimits({ maxAggregations: 0, maxEmbeds: -3 }),
		).toEqual(DEFAULT_SEARCH_BUDGET)
		expect(
			resolveSearchBudgetLimits({ maxAggregations: 7.9, maxEmbeds: 3 }),
		).toEqual({ maxAggregations: 7, maxEmbeds: 3 })
	})

	it("is unbudgeted (always allows) outside a budget context", () => {
		expect(hasActiveSearchBudget()).toBe(false)
		expect(tryConsumeSearchAggregation()).toBe(true)
		expect(tryConsumeSearchEmbed()).toBe(true)
		expect(getSearchBudgetSnapshot()).toBeUndefined()
	})

	it("counts aggregations and embeds inside a budget context", async () => {
		const { budget } = await runWithSearchBudget(
			{ maxAggregations: 10, maxEmbeds: 4 },
			async () => {
				expect(hasActiveSearchBudget()).toBe(true)
				expect(tryConsumeSearchAggregation()).toBe(true)
				expect(tryConsumeSearchAggregation()).toBe(true)
				expect(tryConsumeSearchEmbed()).toBe(true)
				return "done"
			},
		)
		expect(budget.aggregations).toBe(2)
		expect(budget.embeds).toBe(1)
		expect(budget.exhausted).toBe(false)
		expect(budget.maxAggregations).toBe(10)
		expect(budget.maxEmbeds).toBe(4)
	})

	it("denies consumption once the budget is exhausted", async () => {
		const { budget } = await runWithSearchBudget(
			{ maxAggregations: 2, maxEmbeds: 1 },
			async () => {
				expect(tryConsumeSearchAggregation()).toBe(true)
				expect(tryConsumeSearchAggregation()).toBe(true)
				expect(tryConsumeSearchAggregation()).toBe(false)
				expect(tryConsumeSearchEmbed()).toBe(true)
				expect(tryConsumeSearchEmbed()).toBe(false)
			},
		)
		expect(budget.aggregations).toBe(2)
		expect(budget.embeds).toBe(1)
		expect(budget.exhausted).toBe(true)
	})

	it("shares one budget with nested runs (recursive backstop reuses it)", async () => {
		const { budget } = await runWithSearchBudget(
			{ maxAggregations: 3, maxEmbeds: 2 },
			async () => {
				expect(tryConsumeSearchAggregation()).toBe(true)
				const nested = await runWithSearchBudget(
					{ maxAggregations: 99, maxEmbeds: 99 },
					async () => {
						// Nested run must NOT replace the outer budget.
						expect(tryConsumeSearchAggregation()).toBe(true)
						expect(tryConsumeSearchAggregation()).toBe(true)
						// Outer budget is now exhausted.
						expect(tryConsumeSearchAggregation()).toBe(false)
						return "nested"
					},
				)
				expect(nested.value).toBe("nested")
			},
		)
		expect(budget.aggregations).toBe(3)
		expect(budget.maxAggregations).toBe(3)
	})

	it("tracks consumption across concurrent lanes in the same context", async () => {
		const { budget } = await runWithSearchBudget(
			{ maxAggregations: 10, maxEmbeds: 10 },
			async () => {
				await Promise.all([
					(async () => {
						tryConsumeSearchAggregation()
					})(),
					(async () => {
						tryConsumeSearchAggregation()
						tryConsumeSearchEmbed()
					})(),
				])
			},
		)
		expect(budget.aggregations).toBe(2)
		expect(budget.embeds).toBe(1)
	})

	it("reserves capacity atomically before concurrent consumers run", async () => {
		const { budget } = await runWithSearchBudget(
			{ maxAggregations: 3, maxEmbeds: 2 },
			async () => {
				const reservation = tryReserveSearchBudget({
					aggregations: 2,
					embeds: 1,
				})
				expect(reservation).toBeDefined()

				expect(tryConsumeSearchAggregation()).toBe(true)
				expect(tryConsumeSearchAggregation()).toBe(false)
				expect(tryConsumeSearchEmbed()).toBe(true)
				expect(tryConsumeSearchEmbed()).toBe(false)

				expect(reservation?.tryConsumeAggregation()).toBe(true)
				expect(reservation?.tryConsumeAggregation()).toBe(true)
				expect(reservation?.tryConsumeAggregation()).toBe(false)
				expect(reservation?.tryConsumeEmbed()).toBe(true)
				expect(reservation?.tryConsumeEmbed()).toBe(false)
				reservation?.release()
			},
		)
		expect(budget.aggregations).toBe(3)
		expect(budget.embeds).toBe(2)
	})

	it("fails an over-budget reservation without consuming partial capacity", async () => {
		const { budget } = await runWithSearchBudget(
			{ maxAggregations: 2, maxEmbeds: 1 },
			async () => {
				expect(
					tryReserveSearchBudget({ aggregations: 2, embeds: 2 }),
				).toBeUndefined()
				expect(tryConsumeSearchAggregation()).toBe(true)
				expect(tryConsumeSearchAggregation()).toBe(true)
				expect(tryConsumeSearchEmbed()).toBe(true)
			},
		)
		expect(budget.aggregations).toBe(2)
		expect(budget.embeds).toBe(1)
	})

	it("releases unused reserved capacity without charging it as consumed", async () => {
		const { budget } = await runWithSearchBudget(
			{ maxAggregations: 2, maxEmbeds: 1 },
			async () => {
				const reservation = tryReserveSearchBudget({
					aggregations: 2,
					embeds: 1,
				})
				expect(reservation?.tryConsumeAggregation()).toBe(true)
				reservation?.release()

				expect(tryConsumeSearchAggregation()).toBe(true)
				expect(tryConsumeSearchEmbed()).toBe(true)
			},
		)
		expect(budget.aggregations).toBe(2)
		expect(budget.embeds).toBe(1)
	})

	it("returns a bounded reservation outside a budget context", () => {
		const reservation = tryReserveSearchBudget({
			aggregations: 1,
			embeds: 1,
		})
		expect(reservation?.tryConsumeAggregation()).toBe(true)
		expect(reservation?.tryConsumeAggregation()).toBe(false)
		expect(reservation?.tryConsumeEmbed()).toBe(true)
		expect(reservation?.tryConsumeEmbed()).toBe(false)
		reservation?.release()
	})
})
