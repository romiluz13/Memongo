import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest"
import { MemongoClient, MemongoClientError } from "./client.js"
import type { MemongoSearchBarrierResult } from "./index.js"

const BARRIER_RESULT: MemongoSearchBarrierResult = {
	committed: true,
	status: "searchable",
	targets: [{ index: "events_text", status: "confirmed", attempts: 1 }],
}

type Call = { url: string; body: Record<string, unknown> }

function stubFetch(status: number, payload: unknown, calls: Call[]) {
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string, init?: RequestInit) => {
			calls.push({
				url: String(url),
				body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
			})
			return new Response(JSON.stringify(payload), {
				status,
				headers: { "Content-Type": "application/json" },
			})
		}),
	)
}

function client() {
	return new MemongoClient({ baseUrl: "http://memongo.test", maxRetries: 0 })
}

describe("MemongoClient search barrier (#101)", () => {
	afterEach(() => {
		vi.unstubAllGlobals()
	})

	it("sends searchBarrier on add and returns the barrier outcome", async () => {
		const calls: Call[] = []
		stubFetch(
			200,
			{
				ok: true,
				eventId: "evt-1",
				chunkCreated: true,
				searchBarrier: BARRIER_RESULT,
			},
			calls,
		)
		const out = await client().add({
			content: "hello",
			searchBarrier: { timeoutMs: 2000 },
		})
		expect(calls[0]?.url).toBe("http://memongo.test/v1/add")
		expect(calls[0]?.body.searchBarrier).toEqual({ timeoutMs: 2000 })
		expect(out.searchBarrier).toEqual(BARRIER_RESULT)
	})

	it("sends searchBarrier on writeEvent and returns the barrier outcome", async () => {
		const calls: Call[] = []
		const notYet = {
			committed: true,
			status: "not-yet-searchable",
			reason: "timeout",
			targets: [{ index: "chunks_vector", status: "pending", attempts: 10 }],
		}
		stubFetch(
			200,
			{ ok: true, eventId: "evt-2", chunkCreated: true, searchBarrier: notYet },
			calls,
		)
		const out = await client().writeEvent({
			role: "user",
			body: "hello",
			searchBarrier: {},
		})
		expect(calls[0]?.url).toBe("http://memongo.test/v1/write-event")
		expect(calls[0]?.body.searchBarrier).toEqual({})
		expect(out.searchBarrier).toEqual(notYet)
	})

	it("sends searchBarrier on writeStructured and writeProcedure", async () => {
		const calls: Call[] = []
		stubFetch(
			200,
			{ upserted: true, id: "x", searchBarrier: BARRIER_RESULT },
			calls,
		)
		const structured = await client().writeStructured({
			entry: { type: "fact", key: "k", value: "v" },
			searchBarrier: { timeoutMs: 5000 },
		})
		const procedure = await client().writeProcedure({
			entry: { procedureId: "p", name: "n", steps: ["s"] },
			searchBarrier: { timeoutMs: 5000 },
		})
		expect(calls.map((call) => call.url)).toEqual([
			"http://memongo.test/v1/write-structured",
			"http://memongo.test/v1/write-procedure",
		])
		for (const call of calls) {
			expect(call.body.searchBarrier).toEqual({ timeoutMs: 5000 })
		}
		expect(structured.searchBarrier).toEqual(BARRIER_RESULT)
		expect(procedure.searchBarrier).toEqual(BARRIER_RESULT)
	})

	it("omits searchBarrier from the body when it is not requested", async () => {
		const calls: Call[] = []
		stubFetch(200, { ok: true, eventId: "evt-3", chunkCreated: true }, calls)
		const out = await client().writeEvent({ role: "user", body: "hello" })
		expect(Object.hasOwn(calls[0]?.body ?? {}, "searchBarrier")).toBe(false)
		expect(out.searchBarrier).toBeUndefined()
	})

	it("surfaces 400 BARRIER_UNSUPPORTED as a MemongoClientError with its code", async () => {
		const calls: Call[] = []
		stubFetch(
			400,
			{
				error: {
					code: "BARRIER_UNSUPPORTED",
					message: "search barrier unsupported: target-missing",
					reason: "target-missing",
				},
			},
			calls,
		)
		const err = await client()
			.writeEvent({ role: "user", body: "hello", searchBarrier: {} })
			.catch((error: unknown) => error)
		expect(err).toBeInstanceOf(MemongoClientError)
		expect((err as MemongoClientError).status).toBe(400)
		expect((err as MemongoClientError).code).toBe("BARRIER_UNSUPPORTED")
		expect(calls).toHaveLength(1)
	})

	it("types the request option on all four write methods", () => {
		type Request = { timeoutMs?: number } | undefined
		expectTypeOf<
			Parameters<MemongoClient["add"]>[0]["searchBarrier"]
		>().toEqualTypeOf<Request>()
		expectTypeOf<
			Parameters<MemongoClient["writeEvent"]>[0]["searchBarrier"]
		>().toEqualTypeOf<Request>()
		expectTypeOf<
			Parameters<MemongoClient["writeStructured"]>[0]["searchBarrier"]
		>().toEqualTypeOf<Request>()
		expectTypeOf<
			Parameters<MemongoClient["writeProcedure"]>[0]["searchBarrier"]
		>().toEqualTypeOf<Request>()
	})
})
