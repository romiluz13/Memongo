import { Hono } from "hono"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createV1Router } from "./routes/v1.js"
import { readLifecycleHandle } from "./routes/v1-helpers.js"

const bridge = vi.hoisted(() => ({
	memongoBridgeGetLifecycleItem: vi.fn(async () => ({ id: "memory-1" })),
	memongoBridgeUpdateLifecycleItem: vi.fn(async () => ({ id: "memory-1" })),
	memongoBridgeDeleteLifecycleItem: vi.fn(async () => ({ id: "memory-1" })),
	memongoBridgeGetLifecycleHistory: vi.fn(async () => [{ id: "memory-1" }]),
	memongoBridgeReportProcedureOutcome: vi.fn(async () => ({ id: "memory-1" })),
	memongoBridgeApplyMemoryFeedback: vi.fn(async () => ({ id: "memory-1" })),
}))
vi.mock(
	"@memongo/memory-bridge",
	() =>
		new Proxy(bridge, {
			get(target, key) {
				if (key === "then") return undefined
				if (key in target) return target[key as keyof typeof target]
				return vi.fn(() => {
					throw new Error("Unexpected bridge operation")
				})
			},
		}),
)
beforeEach(() => vi.clearAllMocks())
afterEach(() => vi.restoreAllMocks())

function handle(family: "structured" | "procedure", revision: unknown) {
	return {
		family,
		id: "memory-1",
		agentId: "agent-1",
		scope: "agent",
		scopeRef: "agent-1",
		state: "active",
		revision,
		...(family === "structured"
			? { structured: { type: "fact", key: "key" } }
			: { procedure: { procedureId: "procedure" } }),
	}
}
const invalid = [
	undefined,
	null,
	"1",
	{},
	1.5,
	Number.NaN,
	Number.POSITIVE_INFINITY,
	Number.NEGATIVE_INFINITY,
	0,
	-1,
]

describe("lifecycle handle revision admission", () => {
	it.each([
		"structured",
		"procedure",
	] as const)("rejects invalid revisions for %s handles", (family) => {
		for (const revision of invalid)
			expect(
				readLifecycleHandle(handle(family, revision)),
				String(revision),
			).toBeNull()
	})
	it.each([
		1,
		2,
		Number.MAX_SAFE_INTEGER,
		2 ** 53,
	])("preserves existing positive integer revision %s", (revision) => {
		for (const family of ["structured", "procedure"] as const)
			expect(readLifecycleHandle(handle(family, revision))?.revision).toBe(
				revision,
			)
	})

	it.each([
		["/lifecycle/get", "structured", {}],
		["/lifecycle/update", "structured", { patch: { value: "updated" } }],
		["/lifecycle/delete", "structured", {}],
		["/lifecycle/history", "structured", {}],
		["/procedures/outcome", "procedure", { success: true }],
		["/memory/feedback", "structured", { signal: "confirm" }],
	] as const)("rejects malformed revision before %s dispatch and preserves a valid handle", async (path, family, fields) => {
		const app = new Hono().route("/v1", createV1Router())
		for (const revision of [undefined, null, "1", 1.5, 0]) {
			const res = await app.request("/v1" + path, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ ...fields, handle: handle(family, revision) }),
			})
			expect(res.status, String(revision)).toBe(400)
			expect(
				((await res.json()) as { error: { code: string } }).error.code,
			).toBe("VALIDATION_ERROR")
			for (const mock of Object.values(bridge))
				expect(mock).not.toHaveBeenCalled()
		}
		const overflowing = JSON.stringify({
			...fields,
			handle: handle(family, 2),
		}).replace('"revision":2', '"revision":1e400')
		const overflow = await app.request("/v1" + path, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: overflowing,
		})
		expect(overflow.status).toBe(400)
		for (const mock of Object.values(bridge))
			expect(mock).not.toHaveBeenCalled()
		const res = await app.request("/v1" + path, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ ...fields, handle: handle(family, 2) }),
		})
		expect(res.status).toBe(200)
		expect(
			Object.values(bridge).reduce(
				(count, mock) => count + mock.mock.calls.length,
				0,
			),
		).toBe(1)
	})
})

describe("lifecycle certainty admission", () => {
	it.each([
		["/lifecycle/update", "structured", "confidence", -0.1],
		["/lifecycle/update", "structured", "confidence", 1.1],
		["/lifecycle/update", "structured", "sourceReliability", -0.1],
		["/lifecycle/update", "structured", "sourceReliability", 1.1],
		["/lifecycle/update", "procedure", "confidence", -0.1],
		["/lifecycle/update", "procedure", "confidence", 1.1],
		["/memory/feedback", "structured", "confidence", -0.1],
		["/memory/feedback", "structured", "confidence", 1.1],
		["/memory/feedback", "structured", "sourceReliability", -0.1],
		["/memory/feedback", "structured", "sourceReliability", 1.1],
	] as const)("rejects %s %s %s=%s before dispatch", async (path, family, field, value) => {
		const app = new Hono().route("/v1", createV1Router())
		const res = await app.request("/v1" + path, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				handle: handle(family, 2),
				patch: { [field]: value },
				...(path === "/memory/feedback" ? { signal: "correct" } : {}),
			}),
		})
		expect(res.status).toBe(400)
		expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
			"VALIDATION_ERROR",
		)
		for (const mock of Object.values(bridge))
			expect(mock).not.toHaveBeenCalled()
	})

	it.each([
		["/lifecycle/update", "structured", 0],
		["/lifecycle/update", "structured", 0.5],
		["/lifecycle/update", "structured", 1],
		["/lifecycle/update", "procedure", 0],
		["/lifecycle/update", "procedure", 0.5],
		["/lifecycle/update", "procedure", 1],
		["/memory/feedback", "structured", 0],
		["/memory/feedback", "structured", 0.5],
		["/memory/feedback", "structured", 1],
	] as const)("preserves %s %s certainty=%s", async (path, family, certainty) => {
		const app = new Hono().route("/v1", createV1Router())
		const patch = {
			confidence: certainty,
			...(family === "structured" ? { sourceReliability: certainty } : {}),
		}
		const stableHandle = handle(family, 2)
		const res = await app.request("/v1" + path, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				handle: stableHandle,
				patch,
				...(path === "/memory/feedback" ? { signal: "correct" } : {}),
			}),
		})
		expect(res.status).toBe(200)
		if (path === "/memory/feedback") {
			expect(bridge.memongoBridgeApplyMemoryFeedback).toHaveBeenCalledWith({
				handle: stableHandle,
				patch,
				signal: "correct",
			})
		} else {
			expect(bridge.memongoBridgeUpdateLifecycleItem).toHaveBeenCalledWith({
				handle: stableHandle,
				patch,
			})
		}
	})
})
