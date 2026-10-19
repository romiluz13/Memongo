// M2 review fix R6, safety net: whatever a configuration resolver throws,
// getMemorySearchManager scrubs the message before it logs it or returns it,
// so a future resolver that echoes a value still cannot leak a URI.
import type { MemongoConfig } from "@memongo/lib"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { getMemorySearchManager } from "./search-manager.js"

const SENTINEL_URI =
	"mongodb://sentinel-user:sentinel-secret@private-host.example:27017/tenant-db"

vi.mock("./mongodb-manager.js", () => ({
	MongoDBMemoryManager: { create: vi.fn() },
	buildMongoClientOptions: vi.fn(() => ({})),
}))

vi.mock("./backend-config.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("./backend-config.js")>()),
	resolveMemoryBackendConfig: () => {
		throw new Error(`rejected setting "${SENTINEL_URI}" is not supported`)
	},
}))

describe("getMemorySearchManager configuration refusal", () => {
	let lines: string[]

	beforeEach(() => {
		lines = []
		vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
			lines.push(args.map(String).join(" "))
		})
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	it("returns and logs the refusal with the URI, host and database removed", async () => {
		const result = await getMemorySearchManager({
			cfg: {} as MemongoConfig,
			agentId: "main",
		})

		expect(result.manager).toBeNull()
		expect(result.error).toContain("is not supported")
		const everything = `${result.error}\n${lines.join("\n")}`
		for (const sentinel of [
			"mongodb://",
			"private-host.example",
			"tenant-db",
			"sentinel-secret",
			"sentinel-user",
		]) {
			expect(everything, `leaked ${sentinel}`).not.toContain(sentinel)
		}
		expect(lines.join("\n")).toContain("memory backend resolution failed")
	})
})
