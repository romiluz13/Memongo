import { beforeEach, describe, expect, it, vi } from "vitest"
import { MemongoClient } from "./client.js"

describe("client customId validation", () => {
	beforeEach(() => vi.unstubAllGlobals())

	function prepare() {
		const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
			new Request(url, init)
			return new Response(
				JSON.stringify(
					url.endsWith("/write-events")
						? { ok: true, receipts: [] }
						: { ok: true, eventId: "event", chunkCreated: false },
				),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			)
		})
		vi.stubGlobal("fetch", fetchMock)
		return {
			client: new MemongoClient({
				baseUrl: "http://127.0.0.1:3100",
				maxRetries: 0,
			}),
			fetchMock,
		}
	}

	it.each([
		["add", ""],
		["add", " \t "],
		["add", 123],
		["writeEvent", ""],
		["writeEvent", " \t "],
		["writeEvent", 123],
		["writeEvents", ""],
		["writeEvents", " \t "],
		["writeEvents", 123],
	] as const)("rejects %s invalid customId=%s before fetch", async (method, value) => {
		const { client, fetchMock } = prepare()
		const customId = value as unknown as string
		const result =
			method === "add"
				? client.add({ content: "body", customId })
				: method === "writeEvent"
					? client.writeEvent({ role: "user", body: "body", customId })
					: client.writeEvents({
							events: [
								{ role: "user", body: "valid", customId: "valid" },
								{ role: "user", body: "body", customId },
							],
						})
		await expect(result).rejects.toThrow("customId must be a non-empty string")
		expect(fetchMock).not.toHaveBeenCalled()
	})

	it.each([
		["add", "היי"],
		["add", "a\nb"],
		["add", "a\rb"],
		["add", "a\u0000b"],
		["writeEvent", "היי"],
		["writeEvent", "a\nb"],
		["writeEvent", "a\rb"],
		["writeEvent", "a\u0000b"],
	] as const)("rejects %s header-invalid customId=%s before fetch", async (method, customId) => {
		const { client, fetchMock } = prepare()
		const result =
			method === "add"
				? client.add({ content: "body", customId })
				: client.writeEvent({ role: "user", body: "body", customId })
		await expect(result).rejects.toThrow(
			"customId must be a valid Idempotency-Key header value",
		)
		expect(fetchMock).not.toHaveBeenCalled()
	})

	it("preserves Latin-1 header IDs and Unicode body-only batch IDs", async () => {
		const { client, fetchMock } = prepare()
		await client.add({ content: "body", customId: " café " })
		await client.writeEvent({ role: "user", body: "body", customId: "café" })
		await client.writeEvents({
			events: [{ role: "user", body: "body", customId: "היי\n" }],
		})
		const calls = fetchMock.mock.calls
		expect(calls).toHaveLength(3)
		for (const index of [0, 1]) {
			const init = calls[index]?.[1]
			const expected = index === 0 ? " café " : "café"
			expect((init?.headers as Record<string, string>)["Idempotency-Key"]).toBe(
				expected,
			)
			expect(JSON.parse(String(init?.body)).customId).toBe(expected)
		}
		const batch = calls[2]?.[1]
		expect(
			(batch?.headers as Record<string, string>)["Idempotency-Key"],
		).toBeUndefined()
		expect(JSON.parse(String(batch?.body)).events[0].customId).toBe("היי\n")
	})

	it("preserves null customId UUID generation on all three write methods", async () => {
		const { client, fetchMock } = prepare()
		const customId = null as unknown as string
		await client.add({ content: "body", customId })
		await client.writeEvent({ role: "user", body: "body", customId })
		await client.writeEvents({
			events: [{ role: "user", body: "body", customId }],
		})
		expect(fetchMock).toHaveBeenCalledTimes(3)
		for (const [index, [, init]] of fetchMock.mock.calls.entries()) {
			const body = JSON.parse(String(init?.body))
			const key = index === 2 ? body.events[0].customId : body.customId
			expect(key).toMatch(
				/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
			)
		}
	})
})
