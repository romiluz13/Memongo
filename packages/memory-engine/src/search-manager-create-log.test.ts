// M2 review fix R6, creation: a driver or boot error raised while the manager
// is created can quote the connection string. getMemorySearchManager scrubs
// it before it logs or returns it.
import type { MemongoConfig } from "@memongo/lib"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { getMemorySearchManager } from "./search-manager.js"

const SENTINEL_URI =
	"mongodb://sentinel-user:sentinel-secret@private-host.example:27017/tenant-db"

const manager = vi.hoisted(() => ({ create: vi.fn() }))

vi.mock("./mongodb-manager.js", () => ({
	MongoDBMemoryManager: manager,
	buildMongoClientOptions: vi.fn(() => ({})),
}))

const CFG = {
	memory: {
		backend: "mongodb",
		mongodb: { uri: "mongodb://create-log-unit:27017/db" },
	},
} as MemongoConfig

const SENTINELS = [
	"mongodb://",
	"private-host.example",
	"tenant-db",
	"sentinel-secret",
	"sentinel-user",
]

describe("getMemorySearchManager creation failure", () => {
	let lines: string[]

	beforeEach(() => {
		lines = []
		vi.stubEnv("MEMONGO_SHARED_CLIENT", "0")
		vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
			lines.push(args.map(String).join(" "))
		})
	})

	afterEach(() => {
		vi.restoreAllMocks()
		vi.unstubAllEnvs()
	})

	it("returns and logs a creation failure with the URI, host and database removed", async () => {
		manager.create.mockRejectedValue(
			new Error(`connect failed for ${SENTINEL_URI}`),
		)

		const result = await getMemorySearchManager({
			cfg: CFG,
			agentId: "create-log",
			ownership: "owned",
		})

		expect(result.manager).toBeNull()
		expect(result.error).toContain("mongodb memory unavailable")
		const everything = `${result.error}\n${lines.join("\n")}`
		for (const sentinel of SENTINELS) {
			expect(everything, `leaked ${sentinel}`).not.toContain(sentinel)
		}
	})
})
