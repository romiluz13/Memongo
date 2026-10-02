import { MEMONGO_API_ROUTES } from "@memongo/lib"
import { Hono } from "hono"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { openApiSpec } from "./openapi-spec.js"
import { createV1Router } from "./routes/v1.js"

const bridge = vi.hoisted(() => ({
	memongoBridgeSync: vi.fn(
		async (_input: Record<string, unknown>) => undefined,
	),
	memongoBridgeScanNovelty: vi.fn(async (_input: Record<string, unknown>) => ({
		items: [],
	})),
	memongoBridgeRelevanceReport: vi.fn(
		async (_input: Record<string, unknown>) => ({ samples: 0 }),
	),
}))
vi.mock(
	"@memongo/memory-bridge",
	() =>
		new Proxy(bridge, {
			get(target, key) {
				if (key === "then") return undefined
				if (key in target) return target[key as keyof typeof target]
				return vi.fn(() => {
					throw new Error("unexpected bridge call")
				})
			},
		}),
)
beforeEach(() => vi.clearAllMocks())
const app = () => new Hono().route("/v1", createV1Router())
type Operation = {
	requestBody?: {
		required?: boolean
		content?: Record<
			string,
			{
				schema?: {
					required?: readonly string[]
					properties?: Record<string, unknown>
				}
			}
		>
	}
	parameters?: ReadonlyArray<{
		name?: string
		in?: string
		required?: boolean
		schema?: unknown
		description?: string
	}>
}
const paths = openApiSpec.paths as Record<string, Record<string, Operation>>
describe("documented existing request seams", () => {
	it.each([
		{ path: "/v1/sync", fields: ["agentId", "reason", "force"] },
		{ path: "/v1/admin/relevance/report", fields: ["windowMs"] },
		{
			path: "/v1/novelty-scan",
			fields: ["agentId", "limit", "scope", "scopeRef"],
		},
	])("lists optional fields for $path", ({ path, fields }) => {
		expect(
			MEMONGO_API_ROUTES.find((route) => route.path === path)?.optionalFields,
		).toEqual(fields)
	})
	it("documents the optional sync body without requiring fields", () => {
		const body = paths["/v1/sync"]?.post?.requestBody
		expect(body).toBeDefined()
		expect(body?.required).not.toBe(true)
		const schema = body?.content?.["application/json"]?.schema
		expect(schema?.required ?? []).toEqual([])
		expect(schema?.properties).toMatchObject({
			agentId: { type: "string" },
			reason: { type: "string" },
			force: { type: "boolean" },
		})
	})
	it("documents the optional unbounded numeric window query", () => {
		const parameter = paths[
			"/v1/admin/relevance/report"
		]?.get?.parameters?.find((value) => value.name === "windowMs")
		expect(parameter).toMatchObject({
			in: "query",
			required: false,
			schema: { type: "number" },
		})
		expect(parameter?.schema).toEqual({ type: "number" })
		expect(parameter?.description).toContain("Non-finite values are ignored")
	})
	it("documents novelty scopeRef as an optional string", () => {
		expect(
			paths["/v1/novelty-scan"]?.post?.requestBody?.content?.[
				"application/json"
			]?.schema?.properties?.scopeRef,
		).toMatchObject({ type: "string" })
	})
	it("already forwards sync agent, reason and force", async () => {
		const response = await app().request("/v1/sync", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				agentId: "agent",
				reason: "manual",
				force: false,
			}),
		})
		expect(response.status).toBe(200)
		expect(bridge.memongoBridgeSync).toHaveBeenCalledExactlyOnceWith({
			agentId: "agent",
			reason: "manual",
			force: false,
		})
	})
	it("already accepts a sync request with no body", async () => {
		expect((await app().request("/v1/sync", { method: "POST" })).status).toBe(
			200,
		)
		expect(bridge.memongoBridgeSync).toHaveBeenCalledExactlyOnceWith({
			agentId: undefined,
			reason: undefined,
			force: undefined,
		})
	})
	it("already forwards novelty scopeRef", async () => {
		const response = await app().request("/v1/novelty-scan", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				agentId: "agent",
				scope: "workspace",
				scopeRef: "project",
				limit: 5,
			}),
		})
		expect(response.status).toBe(200)
		expect(bridge.memongoBridgeScanNovelty).toHaveBeenCalledExactlyOnceWith({
			agentId: "agent",
			scope: "workspace",
			scopeRef: "project",
			limit: 5,
		})
	})
	it.each([
		{ raw: "0", value: 0 },
		{ raw: "-1", value: -1 },
		{ raw: "1e3", value: 1000 },
		{ raw: "0x10", value: 16 },
		{ raw: "", value: undefined },
		{ raw: "abc", value: undefined },
	])("already applies the finite window check to $raw", async ({
		raw,
		value,
	}) => {
		const response = await app().request(
			`/v1/admin/relevance/report?windowMs=${encodeURIComponent(raw)}`,
		)
		expect(response.status).toBe(200)
		expect(bridge.memongoBridgeRelevanceReport).toHaveBeenCalledExactlyOnceWith(
			{ agentId: undefined, windowMs: value },
		)
	})
})
