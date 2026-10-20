import { describe, expect, it } from "vitest"
import { createFakeContext, httpError, type Json } from "./fake-api.ts"
import { healthyBody } from "./probe-a-fixtures.ts"
import { planProbeA, runProbeA } from "./probe-a.ts"
import { createBudget } from "./budget.ts"

type Item = {
	agentId: string
	scope: string
	scopeRef: string
	text: string
	key?: string
	id?: string
	type: "event" | "structured"
}

type Options = {
	leakSearchAcrossAgents?: boolean
	leakLifecycleAcrossIdentity?: boolean
	keepDataOnErase?: boolean
	failSearchLane?: boolean
	partialErase?: boolean
}

function createFakeMemongo(options: Options = {}) {
	const items: Item[] = []
	let ids = 0
	const calls: string[] = []
	const mine = (c: Json, includeAllScopes = false) =>
		items.filter(
			(item) =>
				item.agentId === c.agentId &&
				(includeAllScopes ||
					(item.scope === c.scope && item.scopeRef === c.scopeRef)),
		)
	const markersOf = (found: Item[]) =>
		found.map((item) => item.text.split(" ").at(-1) as string)
	const leaked = (c: Json, shown: string[]) =>
		options.leakSearchAcrossAgents
			? [...shown, ...markersOf(items.filter((i) => i.agentId !== c.agentId))]
			: shown
	const broad =
		(route: Parameters<typeof healthyBody>[0]) => async (input: Json) => {
			calls.push(route)
			const body = healthyBody(
				route,
				leaked(input, markersOf(mine(input))),
			) as Json
			if (options.failSearchLane && route === "searchDetailed") {
				return {
					...body,
					metadata: {
						outcomeStatus: "partial",
						laneOutcomes: [
							{
								lane: "vector",
								stage: "retrieve",
								outcome: "failed",
								reason: "timeout",
							},
						],
					},
				}
			}
			return body
		}
	const lifecycle = async (
		route: "lifecycleGet" | "lifecycleHistory",
		input: Json,
	) => {
		calls.push(route)
		const handle = input.handle as Json
		const mismatch =
			handle.agentId !== input.agentId ||
			handle.scope !== input.scope ||
			handle.scopeRef !== input.scopeRef
		if (mismatch && !options.leakLifecycleAcrossIdentity)
			throw httpError(403, "FORBIDDEN")
		const found = items.find(
			(item) =>
				item.type === "structured" &&
				item.agentId === handle.agentId &&
				item.scope === handle.scope &&
				item.scopeRef === handle.scopeRef &&
				item.key === (handle.structured as Json).key,
		)
		if (!found) throw httpError(404, "NOT_FOUND")
		return healthyBody(route, [found.text.split(" ").at(-1) as string])
	}
	const api = {
		writeEvent: async (input: Json) => {
			ids += 1
			items.push({
				agentId: input.agentId as string,
				scope: input.scope as string,
				scopeRef: input.scopeRef as string,
				text: input.body as string,
				id: `ev-${ids}`,
				type: "event",
			})
			return {
				ok: true,
				eventId: `ev-${ids}`,
				chunkCreated: true,
				searchBarrier: { committed: true, status: "searchable", targets: [] },
			}
		},
		writeStructured: async (input: Json) => {
			ids += 1
			const entry = input.entry as Json
			items.push({
				agentId: input.agentId as string,
				scope: entry.scope as string,
				scopeRef: entry.scopeRef as string,
				text: entry.value as string,
				key: entry.key as string,
				id: `st-${ids}`,
				type: "structured",
			})
			return { upserted: true, id: `st-${ids}` }
		},
		eraseAgent: async (input: Json) => {
			calls.push("eraseAgent")
			const claimed = items.filter(
				(item) => item.agentId === input.agentId,
			).length
			if (!options.keepDataOnErase) {
				for (let i = items.length - 1; i >= 0; i -= 1) {
					if (items[i]?.agentId === input.agentId) items.splice(i, 1)
				}
			}
			return {
				agentId: input.agentId,
				status: options.partialErase ? "partial" : "complete",
				receipts: [{ collection: "events", deleted: claimed }],
				gateState: "open",
				completedAt: "2026-01-01T00:00:00.000Z",
			}
		},
		search: broad("search"),
		searchDetailed: broad("searchDetailed"),
		recallConversation: broad("recallConversation"),
		profile: broad("profile"),
		hydrateActiveSlate: broad("hydrateActiveSlate"),
		state: broad("state"),
		buildDiscoveryProjection: broad("buildDiscoveryProjection"),
		buildContextBundle: broad("buildContextBundle"),
		scanNovelty: broad("scanNovelty"),
		relevanceExplain: async (input: Json) => {
			calls.push("relevanceExplain")
			return healthyBody("relevanceExplain", markersOf(mine(input, true)))
		},
		readFile: async (input: Json) => {
			calls.push("readFile")
			const [path, query = ""] = (input.relPath as string).split("?")
			const params = new URLSearchParams(query)
			const key = (path as string).split(":")[2]
			const found = items.find(
				(item) =>
					item.key === key &&
					item.agentId === input.agentId &&
					item.scope === params.get("scope") &&
					item.scopeRef === params.get("scopeRef"),
			)
			return {
				text: found ? `value: ${found.text.split(" ").at(-1)}` : "",
				path,
			}
		},
		traceChain: async (input: Json) => {
			calls.push("traceChain")
			const found = items.find(
				(item) =>
					item.id === input.factId &&
					item.agentId === input.agentId &&
					item.scope === input.scope &&
					item.scopeRef === input.scopeRef,
			)
			return healthyBody(
				"traceChain",
				found ? [found.text.split(" ").at(-1) as string] : [],
			)
		},
		lifecycleGetAs: (input: Json) => lifecycle("lifecycleGet", input),
		lifecycleHistoryAs: (input: Json) => lifecycle("lifecycleHistory", input),
	}
	const requests: string[] = []
	const logged = Object.fromEntries(
		Object.entries(api).map(([name, fn]) => [
			name,
			(input: Json) => {
				requests.push(JSON.stringify(input))
				return (fn as (value: Json) => unknown)(input)
			},
		]),
	)
	return { api: logged, calls, items, requests }
}

describe("runProbeA against a correctly isolated fake", () => {
	it("passes with every required case executed and records the declared gaps", async () => {
		const fake = createFakeMemongo()
		const ctx = createFakeContext(fake.api)
		const result = await runProbeA(ctx)
		expect(result.outcome).toBe("pass")
		expect(result.cases.every((item) => item.outcome === "pass")).toBe(true)
		expect(result.extra?.gaps).toEqual([
			expect.objectContaining({ rowId: "discovery:contradiction-report" }),
			expect.objectContaining({ rowId: "searchKB" }),
		])
		expect(result.extra?.erase).toEqual({ confirmed: true })
	})

	it("makes exactly the calls the plan announced", async () => {
		const fake = createFakeMemongo()
		const ctx = createFakeContext(fake.api)
		await runProbeA(ctx)
		const plan = planProbeA()
		const counted = ctx.budget.snapshot().calls
		expect(counted["api-read"]).toBe(plan["api-read"])
		expect(counted["api-write"]).toBe(plan["api-write"])
	})

	it("reads every covered discovery kind and presents the readFile locator under each differing partition", async () => {
		const fake = createFakeMemongo()
		await runProbeA(createFakeContext(fake.api))
		const parsed = fake.requests.map((request) => JSON.parse(request) as Json)
		const kinds = new Set(parsed.map((request) => request.kind).filter(Boolean))
		expect([...kinds].sort()).toEqual([
			"entity-brief",
			"topic-brief",
			"what-changed",
		])
		const locators = parsed
			.map((request) => request.relPath)
			.filter((path): path is string => typeof path === "string")
		expect(locators.some((path) => path.includes("scope=tenant"))).toBe(true)
		expect(
			locators.some(
				(path) =>
					path.includes("codeword-self-") &&
					path.includes("scopeRef=probe-w2-"),
			),
		).toBe(true)
		expect(
			locators.some(
				(path) =>
					path.includes("codeword-self-") && path.includes("scope=tenant"),
			),
		).toBe(true)
	})

	it("never puts a marker in a request", async () => {
		const fake = createFakeMemongo()
		await runProbeA(createFakeContext(fake.api))
		const markers = fake.requests
			.slice(0, 8)
			.map((request) => request.split("codeword is ")[1]?.split('"')[0] ?? "")
		expect(markers.every((marker) => marker.startsWith("zq"))).toBe(true)
		expect(new Set(markers).size).toBe(4)
		const reads = fake.requests.slice(8)
		expect(reads.length).toBeGreaterThan(100)
		for (const marker of markers) {
			expect(reads.some((request) => request.includes(marker))).toBe(false)
		}
	})
})

describe("runProbeA against faulty fakes", () => {
	it("fails with a role-based predicate when search leaks another agent's data", async () => {
		const fake = createFakeMemongo({ leakSearchAcrossAgents: true })
		const result = await runProbeA(createFakeContext(fake.api))
		expect(result.outcome).toBe("fail")
		const leaks = result.cases.filter((item) => item.outcome === "fail")
		expect(leaks.length).toBeGreaterThan(0)
		expect(leaks.every((item) => item.predicate?.startsWith("leak:"))).toBe(
			true,
		)
		expect(leaks.some((item) => item.caseId.startsWith("A/search/"))).toBe(true)
		expect(leaks.every((item) => item.evidence !== undefined)).toBe(true)
	})

	it("fails when lifecycle get serves a foreign handle", async () => {
		const fake = createFakeMemongo({ leakLifecycleAcrossIdentity: true })
		const result = await runProbeA(createFakeContext(fake.api))
		expect(result.outcome).toBe("fail")
		expect(
			result.cases.some(
				(item) =>
					item.outcome === "fail" && item.caseId.startsWith("A/lifecycle:get/"),
			),
		).toBe(true)
	})

	it("fails when data survives a complete erase", async () => {
		const fake = createFakeMemongo({ keepDataOnErase: true })
		const result = await runProbeA(createFakeContext(fake.api))
		expect(result.extra?.erase).toEqual({ confirmed: true })
		expect(result.outcome).toBe("fail")
		expect(
			result.cases.some((item) =>
				item.predicate?.startsWith("erased-present:"),
			),
		).toBe(true)
	})

	it("is inconclusive, not failed, when the erase was partial and data remains", async () => {
		const fake = createFakeMemongo({
			keepDataOnErase: true,
			partialErase: true,
		})
		const result = await runProbeA(createFakeContext(fake.api))
		expect(result.outcome).toBe("inconclusive")
		expect(result.cases.some((item) => item.outcome === "fail")).toBe(false)
	})

	it("is inconclusive when a search lane degrades inside a 200", async () => {
		const fake = createFakeMemongo({ failSearchLane: true })
		const result = await runProbeA(createFakeContext(fake.api))
		expect(result.outcome).toBe("inconclusive")
		expect(
			result.cases.some(
				(item) =>
					item.caseId.startsWith("A/searchDetailed/") &&
					item.outcome === "inconclusive",
			),
		).toBe(true)
	})

	it("is inconclusive when seeding fails and reports the reason", async () => {
		const fake = createFakeMemongo()
		const api = {
			...fake.api,
			writeEvent: async () => {
				throw httpError(503, "SERVICE_UNAVAILABLE")
			},
		}
		const result = await runProbeA(createFakeContext(api))
		expect(result.outcome).toBe("inconclusive")
		expect(result.reasons.join(" ")).toMatch(/seed-event-failed/)
		expect(fake.calls).not.toContain("search")
	})

	it("stops cleanly when the budget refuses, keeping what it already observed", async () => {
		const fake = createFakeMemongo({ leakSearchAcrossAgents: true })
		const budget = createBudget({
			ceilingUsd: 1,
			prices: {},
			caps: { "api-read": 14, "api-write": 100 },
		})
		const result = await runProbeA(createFakeContext(fake.api, { budget }))
		expect(result.reasons.join(" ")).toMatch(/budget-refusal:cap/)
		expect(result.outcome).toBe("fail")
	})
})
