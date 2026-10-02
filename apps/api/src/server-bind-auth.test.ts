import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const seams = vi.hoisted(() => ({
	serve: vi.fn(() => ({ close: vi.fn() })),
	shutdown: vi.fn(),
	capabilities: vi.fn(async () => ({})),
}))
vi.mock("@hono/node-server", () => ({ serve: seams.serve }))
vi.mock("@memongo/memory-bridge", () => ({
	memongoBridgeCapabilities: seams.capabilities,
	memongoBridgeShutdown: vi.fn(),
}))
vi.mock("./lib/boot-env.js", () => ({ validateBootEnv: vi.fn() }))
vi.mock("./lib/capabilities.js", () => ({
	probeBootCapabilities: vi.fn(async () => ({
		lanes: {},
		probeError: undefined,
	})),
	logCapabilityTable: vi.fn(),
	isRequireVectorEnabled: () => false,
}))
vi.mock("./lib/readiness.js", () => ({ checkReadiness: vi.fn() }))
vi.mock("./routes/v1.js", async () => {
	const { Hono } = await import("hono")
	return { createV1Router: () => new Hono().get("/probe", (c) => c.text("ok")) }
})
vi.mock("./app.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("./app.js")>()),
	registerGracefulShutdown: seams.shutdown,
}))

beforeEach(() => {
	vi.resetModules()
	vi.clearAllMocks()
	for (const key of [
		"MEMONGO_API_KEY",
		"MEMONGO_API_SCOPED_KEYS",
		"MEMONGO_ALLOW_INSECURE_REMOTE",
		"MEMONGO_CORS_ORIGINS",
		"MEMONGO_REQUIRE_VECTOR",
	])
		vi.stubEnv(key, "")
	vi.stubEnv("MEMONGO_API_HOST", "0.0.0.0")
	vi.stubEnv("MEMONGO_API_PORT", "3847")
	vi.stubEnv("MEMONGO_ALLOW_INSECURE_NO_AUTH", "true")
	vi.spyOn(console, "log").mockImplementation(() => undefined)
	vi.spyOn(console, "warn").mockImplementation(() => undefined)
})
afterEach(() => {
	vi.unstubAllEnvs()
	vi.restoreAllMocks()
})

const whitespace = ["", " ", "\t\r\n", "\u00a0\ufeff"]

describe("server bind authentication parity", () => {
	it.each(
		whitespace,
	)("rejects blank legacy key %j on a routable bind", async (value) => {
		vi.stubEnv("MEMONGO_API_KEY", value)
		await expect(import("./server.js")).rejects.toThrow(
			"Refusing to bind 0.0.0.0",
		)
		expect(seams.serve).not.toHaveBeenCalled()
		expect(seams.shutdown).not.toHaveBeenCalled()
	})
	it.each(
		whitespace,
	)("rejects blank scoped keys %j on a routable bind", async (value) => {
		vi.stubEnv("MEMONGO_API_SCOPED_KEYS", value)
		await expect(import("./server.js")).rejects.toThrow(
			"Refusing to bind 0.0.0.0",
		)
		expect(seams.serve).not.toHaveBeenCalled()
	})
	it("rejects both whitespace keys together", async () => {
		vi.stubEnv("MEMONGO_API_KEY", " ")
		vi.stubEnv("MEMONGO_API_SCOPED_KEYS", "\t")
		await expect(import("./server.js")).rejects.toThrow(
			"Refusing to bind 0.0.0.0",
		)
		expect(seams.serve).not.toHaveBeenCalled()
	})
	it("rejects whitespace authentication without the no-auth flag", async () => {
		vi.stubEnv("MEMONGO_API_KEY", " ")
		vi.stubEnv("MEMONGO_ALLOW_INSECURE_NO_AUTH", "")
		await expect(import("./server.js")).rejects.toThrow(
			"Refusing to bind 0.0.0.0",
		)
		expect(seams.serve).not.toHaveBeenCalled()
	})
	it("retains nonempty legacy-key auth and server options", async () => {
		vi.stubEnv("MEMONGO_API_KEY", " secret ")
		await import("./server.js")
		expect(seams.serve).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({
				port: 3847,
				hostname: "0.0.0.0",
				fetch: expect.any(Function),
			}),
			expect.any(Function),
		)
		const app = await import("./app.js")
		const response = await app.createApp().request("/v1/probe")
		expect(response.status).toBe(401)
		expect(seams.shutdown).toHaveBeenCalledOnce()
	})
	it("retains valid scoped-policy auth", async () => {
		vi.stubEnv(
			"MEMONGO_API_SCOPED_KEYS",
			JSON.stringify([{ token: "secret", agentIds: ["agent-1"] }]),
		)
		await import("./server.js")
		expect(seams.serve).toHaveBeenCalledOnce()
		const app = await import("./app.js")
		expect((await app.createApp().request("/v1/probe")).status).toBe(401)
	})
	it("retains loopback no-auth development", async () => {
		vi.stubEnv("MEMONGO_API_HOST", "127.0.0.1")
		vi.stubEnv("MEMONGO_API_KEY", " ")
		await import("./server.js")
		expect(seams.serve).toHaveBeenCalledOnce()
		const app = await import("./app.js")
		expect((await app.createApp().request("/v1/probe")).status).toBe(200)
	})
	it("retains the explicit dual-flag remote override", async () => {
		vi.stubEnv("MEMONGO_API_KEY", " ")
		vi.stubEnv("MEMONGO_API_SCOPED_KEYS", "\t")
		vi.stubEnv("MEMONGO_ALLOW_INSECURE_REMOTE", "true")
		await import("./server.js")
		expect(seams.serve).toHaveBeenCalledOnce()
		const app = await import("./app.js")
		expect((await app.createApp().request("/v1/probe")).status).toBe(200)
		expect(console.warn).toHaveBeenCalledWith(
			expect.stringContaining("Serving UNAUTHENTICATED"),
		)
	})
	it.each([
		"[]",
		"{",
		"{}",
	])("retains startup rejection for invalid scoped config %j", async (value) => {
		vi.stubEnv("MEMONGO_API_SCOPED_KEYS", value)
		await expect(import("./server.js")).rejects.toThrow(
			"MEMONGO_API_SCOPED_KEYS",
		)
		expect(seams.serve).not.toHaveBeenCalled()
	})
})
