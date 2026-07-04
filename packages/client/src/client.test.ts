import { afterEach, describe, expect, it, vi } from "vitest"
import { MemongoClient } from "./client.js"

describe("MemongoClient context bundle format", () => {
	afterEach(() => {
		vi.restoreAllMocks()
	})

	it("does not send a format field by default", async () => {
		const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(JSON.stringify({ rendered: "## Active Slate" }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			}),
		)
		const client = new MemongoClient({ baseUrl: "http://memongo.test" })

		await client.buildContextBundle({ query: "Phoenix" })

		expect(fetchMock).toHaveBeenCalledWith(
			"http://memongo.test/v1/context-bundle",
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify({
					query: "Phoenix",
				}),
			}),
		)
	})

	it("sends explicit context format only when requested", async () => {
		const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(JSON.stringify({ rendered: "context_bundle" }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			}),
		)
		const client = new MemongoClient({ baseUrl: "http://memongo.test" })

		await client.buildContextBundle({
			query: "Phoenix",
			format: "auto",
		})

		expect(fetchMock).toHaveBeenCalledWith(
			"http://memongo.test/v1/context-bundle",
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify({
					query: "Phoenix",
					format: "auto",
				}),
			}),
		)
	})
})
