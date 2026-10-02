import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest"
import { MemongoClient } from "./client.js"
import type {
	MemongoLifecycleItem,
	MemongoLifecycleMutationResult,
	MemongoQuarantineDisposition,
	MemongoStructuredStableHandle,
} from "./index.js"

const handle: MemongoStructuredStableHandle = {
	family: "structured",
	id: "memory",
	agentId: "agent",
	scope: "agent",
	scopeRef: "agent",
	state: "active",
	revision: 2,
	structured: { type: "fact", key: "key" },
}
const item: MemongoLifecycleItem = {
	family: "structured",
	handle,
	data: { type: "fact", key: "key", value: "value" },
}
const held: MemongoLifecycleMutationResult = {
	quarantined: true,
	quarantineId: "quarantine",
	matchedPatterns: ["fixture-pattern"],
}
const heldWithoutId: MemongoLifecycleMutationResult = {
	quarantined: true,
	matchedPatterns: [],
}
const legacyDisposition: MemongoQuarantineDisposition = {}

function checkBranches(result: MemongoLifecycleMutationResult) {
	// @ts-expect-error A quarantine response has no memory handle.
	void result.handle
	// @ts-expect-error A quarantine response has no memory data.
	void result.data
	if (result.quarantined === true) {
		const patterns: string[] = result.matchedPatterns
		const quarantineId: string | undefined = result.quarantineId
		// @ts-expect-error Narrowing to quarantine does not manufacture a handle.
		void result.handle
		return [patterns, quarantineId]
	}
	const current: MemongoLifecycleItem = result
	if (current.family === "structured") {
		const value: string = current.data.value
		return value
	}
	const steps: string[] = current.data.steps
	return steps
}
void checkBranches

const methods = ["updateLifecycleItem", "applyMemoryFeedback"] as const
function call(client: MemongoClient, method: (typeof methods)[number]) {
	return method === "updateLifecycleItem"
		? client.updateLifecycleItem({ handle, patch: { value: "changed" } })
		: client.applyMemoryFeedback({
				handle,
				signal: "correct",
				patch: { value: "changed" },
			})
}
function prepare(body: MemongoLifecycleMutationResult, status: number) {
	const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
		new Request(url, init)
		return new Response(JSON.stringify(body), {
			status,
			headers: { "Content-Type": "application/json" },
		})
	})
	vi.stubGlobal("fetch", fetchMock)
	return {
		fetchMock,
		client: new MemongoClient({
			baseUrl: "http://127.0.0.1:3100",
			maxRetries: 2,
		}),
	}
}

describe("lifecycle quarantine response contracts", () => {
	afterEach(() => vi.unstubAllGlobals())
	it("exports a result shared by both methods and the unchanged disposition", () => {
		expectTypeOf<
			Awaited<ReturnType<MemongoClient["updateLifecycleItem"]>>
		>().toEqualTypeOf<MemongoLifecycleMutationResult>()
		expectTypeOf<
			Awaited<ReturnType<MemongoClient["applyMemoryFeedback"]>>
		>().toEqualTypeOf<MemongoLifecycleMutationResult>()
		expect(legacyDisposition).toEqual({})
	})
	for (const [status, body] of [
		[200, item],
		[202, held],
		[202, heldWithoutId],
	] as const) {
		it.each(
			methods,
		)(`returns HTTP ${status} unchanged for %s${body === heldWithoutId ? " without a quarantine ID" : ""}`, async (method) => {
			const { client, fetchMock } = prepare(body, status)
			const result = await call(client, method)
			expect(result).toEqual(body)
			expect(fetchMock).toHaveBeenCalledTimes(1)
			const [url, init] = fetchMock.mock.calls[0] ?? []
			expect(url).toBe(
				"http://127.0.0.1:3100/v1/" +
					(method === "updateLifecycleItem"
						? "lifecycle/update"
						: "memory/feedback"),
			)
			expect(init?.method).toBe("POST")
			expect(JSON.parse(String(init?.body))).toEqual(
				method === "updateLifecycleItem"
					? { handle, patch: { value: "changed" } }
					: { handle, signal: "correct", patch: { value: "changed" } },
			)
			if (result.quarantined === true) {
				expect(result).not.toHaveProperty("handle")
				expect(result).not.toHaveProperty("data")
				expect(result.matchedPatterns).toEqual(
					body === held ? ["fixture-pattern"] : [],
				)
			} else {
				expect(result.handle).toEqual(handle)
				expect(result.family).toBe("structured")
			}
		})
	}
	it("retains the procedure item branch on a successful update", async () => {
		const procedure: MemongoLifecycleItem = {
			family: "procedure",
			handle: {
				...handle,
				family: "procedure",
				procedure: { procedureId: "procedure" },
			},
			data: { procedureId: "procedure", name: "name", steps: ["step"] },
		}
		const { client, fetchMock } = prepare(procedure, 200)
		const result = await client.updateLifecycleItem({
			handle: procedure.handle,
			patch: { name: "changed" },
		})
		expect(result).toEqual(procedure)
		expect(fetchMock).toHaveBeenCalledTimes(1)
		if (result.quarantined !== true && result.family === "procedure") {
			expect(result.data.steps).toEqual(["step"])
		} else {
			throw new Error("Expected successful procedure result")
		}
	})
})
