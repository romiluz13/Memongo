import { afterEach, expect, expectTypeOf, it, vi } from "vitest"
import { MemongoClient } from "./client.js"
import type { MemongoQuarantineReviewReceipt } from "./index.js"

const ordinary: MemongoQuarantineReviewReceipt = {
	quarantineId: "quarantine",
	agentId: "agent",
	status: "rejected",
	reviewedAt: "2026-10-02T00:00:00.000Z",
}
const recovered: MemongoQuarantineReviewReceipt = {
	...ordinary,
	memoryMayRemain: true,
	auditError: "fixture audit failed",
}
const promoted: MemongoQuarantineReviewReceipt = {
	...ordinary,
	status: "promoted",
	memoryId: "memory",
	finalizeError: "fixture finalize failed",
}

afterEach(() => vi.unstubAllGlobals())

it("exports optional recovery and finalization fields", () => {
	expectTypeOf<
		MemongoQuarantineReviewReceipt["memoryMayRemain"]
	>().toEqualTypeOf<true | undefined>()
	expectTypeOf<MemongoQuarantineReviewReceipt["finalizeError"]>().toEqualTypeOf<
		string | undefined
	>()
})

it.each([
	ordinary,
	recovered,
	promoted,
])("returns receipt unchanged for $status $memoryMayRemain $finalizeError", async (body) => {
	const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
		new Request(url, init)
		return new Response(JSON.stringify(body), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		})
	})
	vi.stubGlobal("fetch", fetchMock)
	const client = new MemongoClient({
		baseUrl: "http://127.0.0.1:3100",
		maxRetries: 0,
	})
	const input = { quarantineId: "quarantine", agentId: "agent" }
	const result =
		body.status === "promoted"
			? await client.promoteQuarantined(input)
			: await client.rejectQuarantined(input)
	expect(result).toEqual(body)
	expect(fetchMock).toHaveBeenCalledTimes(1)
	expect(fetchMock.mock.calls[0]?.[0]).toBe(
		`http://127.0.0.1:3100/v1/admin/quarantine/${body.status === "promoted" ? "promote" : "reject"}`,
	)
	expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual(input)
})
