import type { MongoClient } from "mongodb"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
	acquireSharedMongoClient,
	closeAllSharedMongoClients,
	isSharedMongoClientEnabled,
	releaseSharedMongoClient,
	resetSharedMongoClientRegistryForTests,
	setSharedMongoClientConnectForTests,
} from "./mongodb-client-registry.js"

function fakeClient(): MongoClient {
	return {
		close: vi.fn(async () => {}),
	} as unknown as MongoClient
}

afterEach(async () => {
	await resetSharedMongoClientRegistryForTests()
	vi.unstubAllEnvs()
})

describe("isSharedMongoClientEnabled", () => {
	it("is disabled by default", () => {
		expect(isSharedMongoClientEnabled()).toBe(false)
	})

	it("is enabled for truthy env values", () => {
		for (const value of ["1", "true", "yes", "on"]) {
			vi.stubEnv("MEMONGO_SHARED_CLIENT", value)
			expect(isSharedMongoClientEnabled()).toBe(true)
		}
	})

	it("stays disabled for other values", () => {
		vi.stubEnv("MEMONGO_SHARED_CLIENT", "0")
		expect(isSharedMongoClientEnabled()).toBe(false)
		vi.stubEnv("MEMONGO_SHARED_CLIENT", "false")
		expect(isSharedMongoClientEnabled()).toBe(false)
	})
})

describe("acquireSharedMongoClient", () => {
	it("connects once per URI across many acquires (one pool per URI)", async () => {
		const connect = vi.fn(async () => fakeClient())
		setSharedMongoClientConnectForTests(connect)

		const clients = await Promise.all(
			Array.from({ length: 50 }, () =>
				acquireSharedMongoClient({ uri: "mongodb://localhost:27017" }),
			),
		)

		expect(connect).toHaveBeenCalledTimes(1)
		expect(new Set(clients).size).toBe(1)
	})

	it("connects separately per distinct URI", async () => {
		const connect = vi.fn(async () => fakeClient())
		setSharedMongoClientConnectForTests(connect)

		const a = await acquireSharedMongoClient({ uri: "mongodb://a:27017" })
		const b = await acquireSharedMongoClient({ uri: "mongodb://b:27017" })

		expect(connect).toHaveBeenCalledTimes(2)
		expect(a).not.toBe(b)
	})

	it("evicts a failed connect so the next acquire retries", async () => {
		let attempt = 0
		const connect = vi.fn(async () => {
			attempt += 1
			if (attempt === 1) {
				throw new Error("boom")
			}
			return fakeClient()
		})
		setSharedMongoClientConnectForTests(connect)

		await expect(
			acquireSharedMongoClient({ uri: "mongodb://localhost:27017" }),
		).rejects.toThrow("boom")
		const client = await acquireSharedMongoClient({
			uri: "mongodb://localhost:27017",
		})
		expect(connect).toHaveBeenCalledTimes(2)
		expect(client).toBeDefined()
	})
})

describe("releaseSharedMongoClient", () => {
	it("closes the client only when the last reference is released", async () => {
		const client = fakeClient()
		setSharedMongoClientConnectForTests(async () => client)
		const uri = "mongodb://localhost:27017"

		await acquireSharedMongoClient({ uri })
		await acquireSharedMongoClient({ uri })

		releaseSharedMongoClient(uri)
		await vi.waitFor(() => {
			expect(client.close as ReturnType<typeof vi.fn>).not.toHaveBeenCalled()
		})

		releaseSharedMongoClient(uri)
		await vi.waitFor(() => {
			expect(client.close as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(1)
		})
	})

	it("is a no-op for unknown URIs", () => {
		expect(() => releaseSharedMongoClient("mongodb://nope:27017")).not.toThrow()
	})
})

describe("closeAllSharedMongoClients", () => {
	it("closes every registered client regardless of ref count", async () => {
		const clientA = fakeClient()
		const clientB = fakeClient()
		setSharedMongoClientConnectForTests(async (uri) =>
			uri.includes("a:") ? clientA : clientB,
		)

		await acquireSharedMongoClient({ uri: "mongodb://a:27017" })
		await acquireSharedMongoClient({ uri: "mongodb://a:27017" })
		await acquireSharedMongoClient({ uri: "mongodb://b:27017" })

		await closeAllSharedMongoClients()

		expect(clientA.close as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(1)
		expect(clientB.close as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(1)
	})

	it("allows re-acquire after close (fresh connect)", async () => {
		const connect = vi.fn(async () => fakeClient())
		setSharedMongoClientConnectForTests(connect)

		await acquireSharedMongoClient({ uri: "mongodb://localhost:27017" })
		await closeAllSharedMongoClients()
		await acquireSharedMongoClient({ uri: "mongodb://localhost:27017" })

		expect(connect).toHaveBeenCalledTimes(2)
	})
})

describe("registry diagnostics (C-002: raw URI never in logs)", () => {
	const SECRET_URI = [
		"mongodb://svc:",
		"dummy-cred-000@",
		"host.example.net:27017",
	].join("")

	afterEach(() => {
		vi.restoreAllMocks()
	})

	it("warns with a URI alias and redacted detail when a released client fails to close", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
		const client = {
			close: vi.fn(async () => {
				throw new Error(
					[
						"close failed: ",
						"mongodb://svc:",
						"dummy-cred-00@",
						"host.example.net:27017",
					].join(""),
				)
			}),
		} as unknown as MongoClient
		setSharedMongoClientConnectForTests(async () => client)

		await acquireSharedMongoClient({ uri: SECRET_URI })
		releaseSharedMongoClient(SECRET_URI)

		await vi.waitFor(() => {
			expect(warn).toHaveBeenCalledTimes(1)
		})
		const out = warn.mock.calls.map((args) => args.join(" ")).join("\n")
		expect(out).toContain("failed to close released shared MongoDB client")
		expect(out).toContain("shared-client-")
		expect(out).not.toContain("dummy-cred-000")
		expect(out).not.toContain("dummy-cred-00")
	})

	it("warns with a URI alias and redacted detail when closeAll fails", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
		const client = {
			close: vi.fn(async () => {
				throw new Error(
					["topology torn down: ", "token=", "dummy-", "token-0000000"].join(
						"",
					),
				)
			}),
		} as unknown as MongoClient
		setSharedMongoClientConnectForTests(async () => client)

		await acquireSharedMongoClient({ uri: SECRET_URI })
		await closeAllSharedMongoClients()

		expect(warn).toHaveBeenCalledTimes(1)
		const out = warn.mock.calls.map((args) => args.join(" ")).join("\n")
		expect(out).toContain("failed to close shared MongoDB client")
		expect(out).toContain("shared-client-")
		expect(out).not.toContain("dummy-cred-000")
		expect(out).not.toContain("dummy-token-0000000")
	})
})
