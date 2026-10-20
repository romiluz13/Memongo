import { describe, expect, it } from "vitest"
import { createBudget } from "./budget.ts"
import {
	createFakeClock,
	createFakeContext,
	httpError,
	type Json,
} from "./fake-api.ts"
import { type GItem, routeBody } from "./probe-g-fixtures.ts"
import type { GRouteId } from "./probe-g-model.ts"
import { planProbeG, runProbeG, SETTLE_MAX_MS } from "./probe-g.ts"

type Options = {
	staleRoute?: GRouteId
	deletedStillServed?: GRouteId
	updateFails?: boolean
	searchNeverShowsNew?: boolean
	clock?: ReturnType<typeof createFakeClock>
}

type Stored = GItem & {
	key: string
	id: string
	revisions: GItem[]
}

function createFakeG(options: Options = {}) {
	const items = new Map<string, Stored>()
	let counter = 0
	const clock = options.clock ?? createFakeClock()
	const byHandle = (handle: Json) => {
		const key = (handle.structured as Json).key as string
		const item = items.get(key)
		if (!item) throw httpError(404, "NOT_FOUND")
		return item
	}
	const plain = (item: Stored): GItem => ({
		key: item.key,
		value: item.value,
		revision: item.revision,
		state: item.state,
		...(item.validTo ? { validTo: item.validTo } : {}),
	})
	const shownFor = (route: GRouteId): GItem[] => {
		const all = [...items.values()]
		const stale = options.staleRoute === route
		return all
			.map((item) => {
				if (stale && item.state === "active" && item.revisions.length > 0) {
					return item.revisions[0] as GItem
				}
				if (
					options.deletedStillServed === route &&
					item.state === "invalidated"
				) {
					return { ...(item.revisions[0] as GItem) }
				}
				return plain(item)
			})
			.filter((item) => {
				if (route === "search" && options.searchNeverShowsNew) {
					return item.revision === 1
				}
				return item.state === "active" || options.deletedStillServed === route
			})
	}
	const broad = (route: GRouteId) => async () =>
		routeBody(route, shownFor(route))
	return {
		clock,
		items,
		api: {
			writeStructured: async (input: Json) => {
				counter += 1
				const entry = input.entry as Json
				items.set(entry.key as string, {
					key: entry.key as string,
					id: `st-${counter}`,
					value: entry.value as string,
					revision: 1,
					state: "active",
					revisions: [],
				})
				return { upserted: true, id: `st-${counter}` }
			},
			getLifecycleItem: async (input: Json) =>
				routeBody("lifecycleGet", [plain(byHandle(input.handle as Json))]),
			getLifecycleHistory: async (input: Json) => {
				const item = byHandle(input.handle as Json)
				const current =
					options.staleRoute === "lifecycleHistory" && item.revisions.length > 0
						? (item.revisions[0] as GItem)
						: plain(item)
				return routeBody("lifecycleHistory", [], {
					current,
					revisions: item.revisions,
				})
			},
			updateLifecycleItem: async (input: Json) => {
				if (options.updateFails)
					throw httpError(409, "MEMORY_LIFECYCLE_CONFLICT")
				const item = byHandle(input.handle as Json)
				item.revisions.push(plain(item))
				item.value = (input.patch as Json).value as string
				item.revision += 1
				return routeBody("lifecycleGet", [plain(item)])
			},
			deleteLifecycleItem: async (input: Json) => {
				const item = byHandle(input.handle as Json)
				item.revisions.push(plain(item))
				item.state = "invalidated"
				item.revision += 1
				item.validTo = new Date(clock.now()).toISOString()
				return routeBody("lifecycleGet", [plain(item)])
			},
			search: broad("search"),
			searchDetailed: broad("searchDetailed"),
			profile: broad("profile"),
			hydrateActiveSlate: broad("hydrateActiveSlate"),
			state: broad("state"),
			buildDiscoveryProjection: broad("buildDiscoveryProjection"),
			buildContextBundle: broad("buildContextBundle"),
			readFile: async (input: Json) => {
				const key = (input.relPath as string)
					.split(":")[2]
					?.split("?")[0] as string
				const item = items.get(key)
				return routeBody("readFile", item ? [plain(item)] : [])
			},
		},
	}
}

function fakeContext(options: Options = {}) {
	const fake = createFakeG(options)
	const ctx = createFakeContext(fake.api, { clock: fake.clock })
	return { fake, ctx }
}

describe("runProbeG against a correct fake", () => {
	it("passes with every assessable route and lists the gaps", async () => {
		const { ctx } = fakeContext()
		const result = await runProbeG(ctx)
		expect(result.cases.filter((item) => item.outcome !== "pass")).toEqual([])
		expect(result.outcome).toBe("pass")
		expect(result.cases).toHaveLength(20)
		expect(result.extra?.gaps).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ route: "traceChain" }),
			]),
		)
	})

	it("stays within the planned call counts", async () => {
		const { ctx } = fakeContext()
		await runProbeG(ctx)
		const plan = planProbeG()
		const counted = ctx.budget.snapshot().calls
		expect(counted["api-write"]).toBe(plan["api-write"])
		expect(counted["api-read"]).toBeLessThanOrEqual(plan["api-read"])
		expect(counted["api-read"]).toBeGreaterThanOrEqual(40)
	})

	it("sends lifecycle reads with a live handle and the fresh revision", async () => {
		const { ctx, fake } = fakeContext()
		await runProbeG(ctx)
		const revisions = [...fake.items.values()].map((item) => item.revision)
		expect(revisions).toEqual([2, 2])
	})
})

describe("runProbeG against faulty fakes", () => {
	it("fails the stale route and nothing else", async () => {
		const { ctx } = fakeContext({ staleRoute: "profile" })
		const result = await runProbeG(ctx)
		const failed = result.cases.filter((item) => item.outcome === "fail")
		expect(failed.map((item) => item.caseId)).toEqual(["G/update/profile"])
		expect(failed[0]?.predicate).toBe("old-as-current:profile")
		expect(result.outcome).toBe("fail")
	})

	it("fails a deleted value that a route still serves as current", async () => {
		const { ctx } = fakeContext({ deletedStillServed: "hydrateActiveSlate" })
		const result = await runProbeG(ctx)
		expect(
			result.cases.find((item) => item.caseId === "G/delete/hydrateActiveSlate")
				?.outcome,
		).toBe("fail")
	})

	it("fails the history route when its current entry is stale", async () => {
		const { ctx } = fakeContext({ staleRoute: "lifecycleHistory" })
		const result = await runProbeG(ctx)
		expect(
			result.cases.find((item) => item.caseId === "G/update/lifecycleHistory")
				?.outcome,
		).toBe("fail")
	})

	it("is inconclusive on every route when the update is rejected", async () => {
		const { ctx } = fakeContext({ updateFails: true })
		const result = await runProbeG(ctx)
		const update = result.cases.filter((item) =>
			item.caseId.startsWith("G/update/"),
		)
		expect(update.every((item) => item.outcome === "inconclusive")).toBe(true)
		expect(result.outcome).toBe("inconclusive")
	})

	it("waits up to the settle bound for the new value and then judges what it reads", async () => {
		const clock = createFakeClock()
		const { ctx } = fakeContext({ searchNeverShowsNew: true, clock })
		const result = await runProbeG(ctx)
		const settle = (
			result.extra?.settle as Record<
				string,
				{ satisfied: boolean; polls: number }
			>
		).update
		expect(settle?.satisfied).toBe(false)
		expect(settle?.polls).toBe(SETTLE_MAX_MS / 1_000 + 1)
		expect(
			result.cases.find((item) => item.caseId === "G/update/search")?.outcome,
		).toBe("inconclusive")
	})

	it("stops cleanly when the budget refuses mid-sequence", async () => {
		const limited = createFakeContext(createFakeG().api, {
			budget: createBudget({
				ceilingUsd: 1,
				prices: {},
				caps: { "api-read": 12, "api-write": 100 },
			}),
		})
		const result = await runProbeG(limited)
		expect(result.reasons.join(" ")).toMatch(/budget-refusal:cap/)
		expect(result.outcome).toBe("inconclusive")
	})
})
