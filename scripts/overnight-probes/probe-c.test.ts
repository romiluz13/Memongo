import { describe, expect, it } from "vitest"
import {
	createFakeClock,
	createFakeContext,
	httpError,
	type Json,
} from "./fake-api.ts"
import { MAX_POLLS } from "./kit.ts"
import { planProbeC, runProbeC } from "./probe-c.ts"
import { type GItem, routeBody } from "./probe-g-fixtures.ts"

type Options = {
	staleOldFirst?: boolean
	updateFails?: boolean
	updateNeverIndexed?: boolean
	historyDropsRevisions?: boolean
	dropInvalidatedByLink?: boolean
	degradeUpdateSearch?: boolean
	handleWithoutRevision?: boolean
}

type Stored = GItem & {
	key: string
	id: string
	revisions: GItem[]
	invalidatedBy?: Json
}

function createFakeC(options: Options = {}) {
	const clock = createFakeClock()
	const items = new Map<string, Stored>()
	const events: { body: string; timestamp: string }[] = []
	let counter = 0
	let updated = false
	const tally = { degradedSearches: 0, updates: 0 }
	const plain = (item: Stored): GItem => ({
		key: item.key,
		value: item.value,
		revision: item.revision,
		state: item.state,
		identity: item.identity,
		...(item.validTo ? { validTo: item.validTo } : {}),
	})
	const byKey = (key: string) => {
		const item = items.get(key)
		if (!item) throw httpError(404, "NOT_FOUND")
		return item
	}
	const keyOf = (handle: Json) => (handle.structured as Json).key as string
	const rows = (): GItem[] => {
		const shown: GItem[] = []
		for (const item of items.values()) {
			if (options.staleOldFirst && item.revisions.length > 0) {
				const old = item.revisions[0] as GItem
				shown.push({ ...old, state: "active" })
			}
			if (item.state === "active") {
				if (options.updateNeverIndexed && item.revisions.length > 0) {
					shown.push(item.revisions[0] as GItem)
				} else {
					shown.push(plain(item))
				}
			}
		}
		return shown
	}
	const eventRows = () =>
		[...events].reverse().map((event) => ({ snippet: event.body }))
	const api = {
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
				identity: {
					id: `st-${counter}`,
					agentId: input.agentId as string,
					scope: entry.scope as string,
					scopeRef: entry.scopeRef as string,
				},
			})
			return { upserted: true, id: `st-${counter}` }
		},
		writeEvent: async (input: Json) => {
			events.push({
				body: input.body as string,
				timestamp: input.timestamp as string,
			})
			return { ok: true, eventId: `ev-${events.length}`, chunkCreated: true }
		},
		getLifecycleItem: async (input: Json) => {
			const body = routeBody("lifecycleGet", [
				plain(byKey(keyOf(input.handle as Json))),
			]) as { handle: Json }
			return options.handleWithoutRevision
				? { ...body, handle: { ...body.handle, revision: undefined } }
				: body
		},
		getLifecycleHistory: async (input: Json) => {
			const item = byKey(keyOf(input.handle as Json))
			return routeBody("lifecycleHistory", [], {
				current: plain(item),
				revisions: options.historyDropsRevisions ? [] : item.revisions,
			})
		},
		updateLifecycleItem: async (input: Json) => {
			if (options.updateFails) throw httpError(409, "MEMORY_LIFECYCLE_CONFLICT")
			const item = byKey(keyOf(input.handle as Json))
			updated = true
			tally.updates += 1
			item.revisions.push(plain(item))
			item.value = (input.patch as Json).value as string
			item.revision += 1
			return routeBody("lifecycleGet", [plain(item)])
		},
		deleteLifecycleItem: async (input: Json) => {
			const item = byKey(keyOf(input.handle as Json))
			item.revisions.push(plain(item))
			item.state = "invalidated"
			item.revision += 1
			item.validTo = new Date(clock.now()).toISOString()
			item.invalidatedBy = options.dropInvalidatedByLink
				? { reason: "lifecycle" }
				: (input.invalidatedBy as Json)
			return routeBody("lifecycleGet", [plain(item)])
		},
		readFile: async (input: Json) => {
			const key = (input.relPath as string)
				.split(":")[2]
				?.split("?")[0] as string
			const item = items.get(key)
			if (!item) return { text: "" }
			const base = routeBody("readFile", [plain(item)]) as { text: string }
			return {
				text: item.invalidatedBy
					? `${base.text}\ninvalidatedBy: ${JSON.stringify(item.invalidatedBy)}`
					: base.text,
			}
		},
		search: async (input: Json) => {
			const degraded =
				options.degradeUpdateSearch === true &&
				updated &&
				String(input.query).includes("launch pad")
			if (degraded) tally.degradedSearches += 1
			return {
				...(routeBody("search", rows()) as Json),
				results: [
					...rows().map((row) => ({ snippet: row.value })),
					...eventRows(),
				],
				...(degraded ? { outcomes: { status: "partial", lanes: [] } } : {}),
			}
		},
		searchDetailed: async () => routeBody("searchDetailed", rows()),
	}
	return { api, clock, items, events, tally }
}

function context(options: Options = {}) {
	const fake = createFakeC(options)
	return { fake, ctx: createFakeContext(fake.api, { clock: fake.clock }) }
}

describe("runProbeC", () => {
	it("passes both explicit sequences against a correct fake and records the capability observation", async () => {
		const { ctx } = context()
		const result = await runProbeC(ctx)
		expect(result.cases.filter((item) => item.outcome !== "pass")).toEqual([])
		expect(result.cases).toHaveLength(6)
		expect(result.outcome).toBe("pass")
		const automatic = result.extra?.automaticCorrection as Json
		expect(automatic.observed).toBe(true)
		expect(automatic.kind).toMatch(/capability observation/)
	})

	it("stays within the planned call counts", async () => {
		const { ctx } = context()
		await runProbeC(ctx)
		const plan = planProbeC()
		const counted = ctx.budget.snapshot().calls
		expect(counted["api-write"]).toBe(plan["api-write"])
		expect(counted["api-read"]).toBeLessThanOrEqual(plan["api-read"])
	})

	it("fails when the stale old value is served ahead of the new one", async () => {
		const { ctx } = context({ staleOldFirst: true })
		const result = await runProbeC(ctx)
		const failed = result.cases.filter((item) => item.outcome === "fail")
		expect(
			failed.some((item) => item.predicate === "old-ranked-at-or-above-new"),
		).toBe(true)
		expect(result.outcome).toBe("fail")
	})

	it("is inconclusive when the update is rejected", async () => {
		const { ctx } = context({ updateFails: true })
		const result = await runProbeC(ctx)
		const update = result.cases.filter((item) =>
			item.caseId.startsWith("C/update/"),
		)
		expect(update.every((item) => item.outcome === "inconclusive")).toBe(true)
	})

	it("is inconclusive when the asynchronous update is never indexed", async () => {
		const { ctx } = context({ updateNeverIndexed: true })
		const result = await runProbeC(ctx)
		const search = result.cases.find(
			(item) => item.caseId === "C/update/search",
		)
		expect(search?.outcome).toBe("inconclusive")
		expect(search?.reason).toMatch(/async-update-unobserved/)
	})

	it("does not treat a degraded response that contains the new value as the update having settled", async () => {
		const { ctx, fake } = context({ degradeUpdateSearch: true })
		const result = await runProbeC(ctx)
		expect(fake.tally.degradedSearches).toBe(MAX_POLLS)
		const search = result.cases.find(
			(item) => item.caseId === "C/update/search",
		)
		expect(search?.outcome).toBe("inconclusive")
	})

	it("does not mutate with a substitute handle when the pre-read handle is malformed", async () => {
		const { ctx, fake } = context({ handleWithoutRevision: true })
		const result = await runProbeC(ctx)
		expect(fake.tally.updates).toBe(0)
		expect(result.reasons.join(" ")).toContain("handle-invalid:update:revision")
		expect(result.outcome).toBe("inconclusive")
		expect(
			result.cases.some((item) => item.caseId.startsWith("C/update/")),
		).toBe(false)
	})

	it("fails when history keeps no revision of the old value", async () => {
		const { ctx } = context({ historyDropsRevisions: true })
		const result = await runProbeC(ctx)
		expect(
			result.cases.find((item) => item.caseId === "C/update/lifecycle")
				?.predicate,
		).toBe("history-missing-old-revision")
	})

	it("fails when the invalidation carries no link to the replacement", async () => {
		const { ctx } = context({ dropInvalidatedByLink: true })
		const result = await runProbeC(ctx)
		expect(
			result.cases.find((item) => item.caseId === "C/supersede/lifecycle")
				?.predicate,
		).toBe("supersession-link-missing")
	})
})
