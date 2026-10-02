import { createRequire } from "node:module"
import { API_ERROR_OPENAPI_REF, MEMONGO_API_ROUTES } from "@memongo/lib"
import { Hono } from "hono"
import {
	MongoNetworkError,
	MongoNetworkTimeoutError,
	MongoServerSelectionError,
	type TopologyDescription,
	TopologyType,
} from "mongodb"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { openApiSpec } from "./openapi-spec.js"
import { createV1Router } from "./routes/v1.js"

const { TopologyDescription: DriverTopologyDescription } = createRequire(
	import.meta.url,
)("mongodb/lib/sdam/topology_description.js") as {
	TopologyDescription: new (type: TopologyType) => TopologyDescription
}
const bridge = vi.hoisted(() => ({ memongoBridgeGetState: vi.fn() }))
vi.mock(
	"@memongo/memory-bridge",
	() =>
		new Proxy(bridge, {
			get(target, key) {
				if (key === "then") return undefined
				if (key in target) return target[key as keyof typeof target]
				return vi.fn(() => {
					throw new Error("unexpected bridge operation")
				})
			},
		}),
)
beforeEach(() => {
	vi.resetAllMocks()
	vi.spyOn(console, "error").mockImplementation(() => {})
})
afterEach(() => vi.restoreAllMocks())
function request(path = "/v1/state") {
	const app = new Hono().route("/v1", createV1Router())
	return app.request(path)
}
function network() {
	return new MongoNetworkError("private-network-detail")
}
function timeout() {
	return new MongoNetworkTimeoutError("private-timeout-detail")
}
function selection() {
	return new MongoServerSelectionError(
		"private-selection-detail",
		new DriverTopologyDescription(TopologyType.Unknown),
	)
}

describe("state failure status", () => {
	it.each([
		network,
		timeout,
		selection,
	])("maps homogeneous installed driver failures to 503 (%#)", async (makeError) => {
		bridge.memongoBridgeGetState.mockRejectedValue(
			new AggregateError(
				[makeError(), makeError(), makeError()],
				"private aggregate",
			),
		)
		const response = await request()
		expect(response.status).toBe(503)
		expect(await response.json()).toEqual({
			error: {
				code: "SERVICE_UNAVAILABLE",
				message: "dependency unavailable (request id: no-request-id)",
			},
		})
		expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain(
			"private",
		)
	})
	it("maps heterogeneous supported reasons and cause wrappers without logging raw reasons", async () => {
		bridge.memongoBridgeGetState.mockRejectedValue(
			new AggregateError(
				[
					network(),
					timeout(),
					new Error("private wrapper", { cause: selection() }),
				],
				"private aggregate",
			),
		)
		const response = await request()
		expect(response.status).toBe(503)
		expect(await response.json()).toEqual(
			expect.objectContaining({
				error: expect.objectContaining({ code: "SERVICE_UNAVAILABLE" }),
			}),
		)
		expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain(
			"private",
		)
	})
	it.each([
		() =>
			new AggregateError(
				[network(), new TypeError("private bug"), timeout()],
				"private aggregate",
			),
		() =>
			new AggregateError(
				[network(), "private failure", timeout()],
				"private aggregate",
			),
		() =>
			new AggregateError(
				[
					Object.assign(new Error("private primary"), {
						name: "NotWritablePrimary",
					}),
				],
				"private aggregate",
			),
		() => new AggregateError([], "private aggregate"),
		() => new Error("private bug"),
	])("preserves unknown, mixed and empty failures as 500 (%#)", async (makeError) => {
		bridge.memongoBridgeGetState.mockRejectedValue(makeError())
		const response = await request()
		expect(response.status).toBe(500)
		expect(await response.json()).toEqual({
			error: {
				code: "STATE_FAILED",
				message: "internal server error (request id: no-request-id)",
			},
		})
		expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain(
			"private",
		)
	})
	it("retains direct supported error mapping", async () => {
		bridge.memongoBridgeGetState.mockRejectedValue(network())
		expect((await request()).status).toBe(503)
	})
	it.each([
		false,
		true,
	])("preserves success response with partial=%s", async (partial) => {
		const state = {
			profile: {},
			blocks: { blocks: [] },
			bundle: {},
			...(partial ? { partial: true } : {}),
		}
		bridge.memongoBridgeGetState.mockResolvedValue(state)
		const response = await request(
			"/v1/state?agentId=agent&scope=workspace&scopeRef=workspace%3Aone",
		)
		expect(response.status).toBe(200)
		expect(await response.json()).toEqual(state)
		expect(bridge.memongoBridgeGetState).toHaveBeenCalledWith({
			agentId: "agent",
			scope: "workspace",
			scopeRef: "workspace:one",
			kbRestricted: undefined,
		})
		expect(console.error).not.toHaveBeenCalled()
	})
	it("rejects missing scope coordinate before invoking bridge", async () => {
		expect((await request("/v1/state?scope=user")).status).toBe(400)
		expect(bridge.memongoBridgeGetState).not.toHaveBeenCalled()
	})
	it("declares the state 503 with the common API envelope", () => {
		expect(
			MEMONGO_API_ROUTES.find((route) => route.path === "/v1/state")
				?.errorStatuses,
		).toEqual([500, 503])
		const paths = openApiSpec.paths as Record<
			string,
			{
				get?: {
					responses?: Record<
						string,
						{
							description?: string
							content?: Record<string, { schema?: unknown }>
						}
					>
				}
			}
		>
		expect(
			paths["/v1/state"]?.get?.responses?.["503"]?.content?.["application/json"]
				?.schema,
		).toEqual({ $ref: API_ERROR_OPENAPI_REF })
	})
})
