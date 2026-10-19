import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// X-06 control: the real boot path (lib/capabilities.js is NOT mocked) with
// an engine whose startup contract fails. On 5280803 the probe error was
// caught, the lanes logged "unavailable" and the server bound its port
// (warn-and-serve). The API must exit 1 before serve() instead.
const seams = vi.hoisted(() => ({
	serve: vi.fn(() => ({ close: vi.fn() })),
	shutdown: vi.fn(),
	capabilities: vi.fn(),
}))
vi.mock("@hono/node-server", () => ({ serve: seams.serve }))
vi.mock("@memongo/memory-bridge", async (importOriginal) => ({
	...(await importOriginal<typeof import("@memongo/memory-bridge")>()),
	memongoBridgeCapabilities: seams.capabilities,
	memongoBridgeShutdown: vi.fn(),
}))
vi.mock("./lib/boot-env.js", () => ({ validateBootEnv: vi.fn() }))
vi.mock("./lib/readiness.js", () => ({ checkReadiness: vi.fn() }))
vi.mock("./routes/v1.js", async () => {
	const { Hono } = await import("hono")
	return { createV1Router: () => new Hono() }
})
vi.mock("./app.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("./app.js")>()),
	registerGracefulShutdown: seams.shutdown,
}))

class ProcessExit extends Error {
	constructor(readonly code: number | undefined) {
		super(`process.exit(${String(code)})`)
	}
}

beforeEach(() => {
	vi.resetModules()
	vi.clearAllMocks()
	vi.stubEnv("MEMONGO_API_HOST", "127.0.0.1")
	vi.stubEnv("MEMONGO_API_PORT", "3847")
	vi.stubEnv("MEMONGO_ALLOW_INSECURE_NO_AUTH", "true")
	vi.spyOn(console, "log").mockImplementation(() => undefined)
	vi.spyOn(console, "warn").mockImplementation(() => undefined)
	vi.spyOn(console, "error").mockImplementation(() => undefined)
	vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
		throw new ProcessExit(code)
	}) as typeof process.exit)
})
afterEach(() => {
	vi.unstubAllEnvs()
	vi.restoreAllMocks()
})

describe("API boot refuses to serve on a boot failure (X-06)", () => {
	it("exits 1 with the typed reason and never binds when the startup contract fails", async () => {
		const { MemongoBootError } = await import("@memongo/memory-bridge")
		seams.capabilities.mockRejectedValue(
			new MemongoBootError(
				{
					code: "index-not-ready",
					requirement: "READY and serving its manifest definition",
					index: "memongo_chunks_vector",
					collection: "memongo_chunks",
					status: "BUILDING",
				},
				"boot refused after the 180 s readiness deadline: memongo_chunks_vector (memongo_chunks) is not ready",
			),
		)

		await expect(import("./server.js")).rejects.toThrow("process.exit(1)")

		expect(seams.serve).not.toHaveBeenCalled()
		expect(console.error).toHaveBeenCalledWith(
			expect.stringContaining("boot failure index-not-ready"),
		)
	})

	it("serves once the startup contract passes", async () => {
		seams.capabilities.mockResolvedValue({
			vectorSearch: true,
			textSearch: true,
			scoreFusion: true,
			rankFusion: true,
			storedSource: false,
			vectorIndexMethod: false,
		})

		await import("./server.js")

		expect(seams.serve).toHaveBeenCalledOnce()
		expect(process.exit).not.toHaveBeenCalled()
	})
})
