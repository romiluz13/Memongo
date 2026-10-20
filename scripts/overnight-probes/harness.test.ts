import { describe, expect, it } from "vitest"
import { fixture, SENTINELS, URI, VOYAGE } from "./fake-harness.ts"
import {
	buildChildEnv,
	generateAgentId,
	generateDatabaseName,
	HarnessRefusal,
	isOwnedDatabaseName,
	startHarness,
	withAppName,
} from "./harness.ts"

const START = {
	mongoUri: URI,
	voyageKey: VOYAGE,
	baseEnv: { PATH: "/usr/bin" },
}

async function refusal(promise: Promise<unknown>): Promise<HarnessRefusal> {
	try {
		await promise
	} catch (error) {
		if (error instanceof HarnessRefusal) return error
		throw error
	}
	throw new Error("expected a HarnessRefusal")
}

describe("generated identities", () => {
	it("builds memongo_probe_ plus eight hex characters and probe-uuid agent ids", () => {
		expect(generateDatabaseName(() => "0a1b2c3d")).toBe(
			"memongo_probe_0a1b2c3d",
		)
		expect(generateAgentId(() => "abc")).toBe("probe-abc")
	})

	it("recognizes only generated names as owned", () => {
		expect(isOwnedDatabaseName("memongo_probe_0a1b2c3d")).toBe(true)
		for (const name of [
			"memongo",
			"memongo_probe_0a1b2c3",
			"memongo_probe_0a1b2c3d0",
			"memongo_probe_0A1B2C3D",
			"admin",
			"xmemongo_probe_0a1b2c3d",
			"memongo_probe_0a1b2c3d;",
			"",
		]) {
			expect(isOwnedDatabaseName(name)).toBe(false)
		}
	})

	it("refuses to use a generator that returns a malformed name", () => {
		expect(() => generateDatabaseName(() => "../../etc")).toThrow(
			HarnessRefusal,
		)
	})
})

describe("generated API key", () => {
	it("is registered with the sanitizer so no later output can carry it", async () => {
		const { deps } = fixture()
		const harness = await startHarness(deps, START)
		const leaked = `request failed for ${harness.apiKey} twice ${harness.apiKey}`
		expect(deps.sanitizer.text(leaked)).not.toContain(harness.apiKey)
		expect(
			JSON.stringify(deps.sanitizer.value({ note: leaked })),
		).not.toContain(harness.apiKey)
	})
})

describe("child environment", () => {
	const inherited = {
		PATH: "/usr/bin",
		HOME: "/home/x",
		MEMONGO_API_URL: "https://prod.example",
		MEMONGO_MONGODB_DATABASE: "production",
		MEMONGO_ENRICHMENT_API_KEY: "enrich-SENTINEL",
		MEMONGO_API_SCOPED_KEYS: "scoped-SENTINEL",
		MEMONGO_API_KEY: "outer-key-SENTINEL",
		MEMONGO_SEARCH_ADMISSION_RPM: "1",
		MEMONGO_LLM_ENRICHMENT_MODE: "enabled",
		MEMONGO_MONGODB_URI: "mongodb://outer",
		VOYAGE_API_QUERY_KEY: "al-query-key-SENTINEL-00000",
	}
	const env = buildChildEnv(inherited, {
		database: "memongo_probe_0a1b2c3d",
		port: 51234,
		apiKey: "run-key-SENTINEL-000000",
		mongoUri: URI,
		voyageKey: VOYAGE,
		configPath: "/scratch/config.json",
	})

	it("pins database, loopback host, port, key, URI and an empty config file", () => {
		expect(env.MEMONGO_MONGODB_DATABASE).toBe("memongo_probe_0a1b2c3d")
		expect(env.MEMONGO_API_HOST).toBe("127.0.0.1")
		expect(env.MEMONGO_API_PORT).toBe("51234")
		expect(env.MEMONGO_API_KEY).toBe("run-key-SENTINEL-000000")
		expect(env.MEMONGO_FORCE_MONGODB_URI).toBe(URI)
		expect(env.MEMONGO_CONFIG_PATH).toBe("/scratch/config.json")
		expect(env.VOYAGE_API_KEY).toBe(VOYAGE)
	})

	it("does not inherit overrides, enrichment, scoped keys or tuning from the parent", () => {
		expect(env.MEMONGO_API_URL).toBeUndefined()
		expect(env.MEMONGO_ENRICHMENT_API_KEY).toBeUndefined()
		expect(env.MEMONGO_API_SCOPED_KEYS).toBeUndefined()
		expect(env.MEMONGO_SEARCH_ADMISSION_RPM).toBeUndefined()
		expect(env.MEMONGO_MONGODB_URI).toBeUndefined()
		expect(env.MEMONGO_LLM_ENRICHMENT_MODE).toBeUndefined()
		expect(env.PATH).toBe("/usr/bin")
	})

	it("turns LLM extraction off and disables the HTTP rate limiter for the data-path probes", () => {
		expect(env.MEMONGO_EXTRACTION_LLM).toBe("off")
		expect(env.MEMONGO_API_RATE_LIMIT).toBe("0")
	})

	it("passes the MongoDB network settings through only when the parent sets them", () => {
		const tuned = buildChildEnv(
			{
				...inherited,
				MEMONGO_MONGODB_NETWORK_FAMILY: "4",
				MEMONGO_MONGODB_SOCKET_TIMEOUT_MS: "20000",
				MEMONGO_MONGODB_MAX_IDLE_TIME_MS: "60000",
			},
			{
				database: "memongo_probe_0a1b2c3d",
				port: 51234,
				apiKey: "run-key-SENTINEL-000000",
				mongoUri: URI,
				voyageKey: VOYAGE,
				configPath: "/scratch/config.json",
			},
		)
		expect(tuned.MEMONGO_MONGODB_NETWORK_FAMILY).toBe("4")
		expect(tuned.MEMONGO_MONGODB_SOCKET_TIMEOUT_MS).toBe("20000")
		expect(tuned.MEMONGO_MONGODB_MAX_IDLE_TIME_MS).toBe("60000")
		expect(env.MEMONGO_MONGODB_NETWORK_FAMILY).toBeUndefined()
		expect(env.MEMONGO_MONGODB_SOCKET_TIMEOUT_MS).toBeUndefined()
		expect(env.MEMONGO_MONGODB_MAX_IDLE_TIME_MS).toBeUndefined()
	})

	it("passes only Voyage query and indexing keys when the parent has them", () => {
		expect(env.VOYAGE_API_QUERY_KEY).toBe("al-query-key-SENTINEL-00000")
		expect(env.VOYAGE_API_INDEXING_KEY).toBeUndefined()
	})
})

describe("withAppName", () => {
	it("adds the client name as a query parameter, inserting the path slash a bare host needs", () => {
		expect(withAppName("mongodb://u:p@h1:27017,h2:27017", "probe-x")).toBe(
			"mongodb://u:p@h1:27017,h2:27017/?appName=probe-x",
		)
		expect(withAppName("mongodb+srv://u:p@cluster.example/", "probe-x")).toBe(
			"mongodb+srv://u:p@cluster.example/?appName=probe-x",
		)
	})

	it("keeps existing options and replaces an existing client name in any letter case", () => {
		expect(
			withAppName(
				"mongodb://h/db?retryWrites=true&APPNAME=other&w=majority",
				"n",
			),
		).toBe("mongodb://h/db?retryWrites=true&w=majority&appName=n")
	})
})

describe("startHarness", () => {
	it("hands the child a connection whose client name identifies this run and exposes the same name", async () => {
		const f = fixture()
		const harness = await startHarness(f.deps, START)
		expect(harness.appName).toBe("memongo-probe-api-0a1b2c3d")
		expect(f.calls.spawned[0]?.MEMONGO_FORCE_MONGODB_URI).toContain(
			"appName=memongo-probe-api-0a1b2c3d",
		)
	})

	it("starts the API on the generated database, verifies the effective target and exposes a run-scoped base URL", async () => {
		const f = fixture()
		const harness = await startHarness(f.deps, START)
		expect(harness.database).toBe("memongo_probe_0a1b2c3d")
		expect(harness.baseUrl).toBe("http://127.0.0.1:51234")
		expect(f.calls.spawned).toHaveLength(1)
		expect(f.calls.spawned[0]?.MEMONGO_MONGODB_DATABASE).toBe(harness.database)
		expect(f.calls.markers.get(harness.database)?.database).toBe(
			harness.database,
		)
		expect(harness.effectiveTarget).toEqual({
			database: harness.database,
			verified: true,
		})
	})

	it("refuses a colliding database name before touching anything", async () => {
		const f = fixture({ existingDatabases: ["memongo_probe_0a1b2c3d"] })
		const error = await refusal(startHarness(f.deps, START))
		expect(error.reason).toBe("collision")
		expect(f.calls.spawned).toHaveLength(0)
		expect(f.calls.dropped).toEqual([])
		expect(f.calls.markers.size).toBe(0)
	})

	it("refuses an occupied port without spawning or leaving a database", async () => {
		const f = fixture({ portFree: false })
		const error = await refusal(startHarness(f.deps, START))
		expect(error.reason).toBe("port-occupied")
		expect(f.calls.spawned).toHaveLength(0)
		expect(f.calls.dropped).toEqual([])
	})

	it("refuses when the API build output is missing", async () => {
		const f = fixture({ apiBuilt: false })
		const error = await refusal(startHarness(f.deps, START))
		expect(error.reason).toBe("api-not-built")
		expect(f.calls.spawned).toHaveLength(0)
	})

	it("does not drop a database whose ownership marker could not be written", async () => {
		const f = fixture({ markerWriteFails: true })
		const error = await refusal(startHarness(f.deps, START))
		expect(error.reason).toBe("marker-failed")
		expect(f.calls.dropped).toEqual([])
		expect(f.calls.spawned).toHaveLength(0)
		for (const s of SENTINELS) expect(error.message).not.toContain(s)
	})

	it("cleans up after a failed spawn: drops the verified database only", async () => {
		const f = fixture({ spawnThrows: true })
		const error = await refusal(startHarness(f.deps, START))
		expect(error.reason).toBe("spawn-failed")
		expect(f.calls.dropped).toEqual(["memongo_probe_0a1b2c3d"])
		expect(f.calls.killed).toEqual([])
		for (const s of SENTINELS) expect(error.message).not.toContain(s)
	})

	it("flags a refusal whose cleanup could not drop the database and names that database", async () => {
		const failed = fixture({ spawnThrows: true, dropFails: true })
		const error = await refusal(startHarness(failed.deps, START))
		expect(error.cleanupFailed).toBe(true)
		expect(error.message).toContain(
			"cleanup incomplete for database memongo_probe_0a1b2c3d",
		)
		for (const s of SENTINELS) expect(error.message).not.toContain(s)
		const clean = await refusal(
			startHarness(fixture({ spawnThrows: true }).deps, START),
		)
		expect(clean.cleanupFailed).toBe(false)
	})

	it("turns an unexpected failure after the API is ready into a refusal that stops the child and drops the database", async () => {
		const f = fixture({ listThrows: true })
		const error = await refusal(startHarness(f.deps, START))
		expect(error.reason).toBe("startup-failed")
		expect(f.calls.killed.length).toBeGreaterThan(0)
		expect(f.calls.dropped).toEqual(["memongo_probe_0a1b2c3d"])
		expect(f.calls.closed).toBe(1)
		for (const s of SENTINELS) expect(error.message).not.toContain(s)
	})

	it("drops the marked database when preparing the child configuration fails", async () => {
		const f = fixture({ configThrows: true })
		const error = await refusal(startHarness(f.deps, START))
		expect(error.reason).toBe("startup-failed")
		expect(f.calls.spawned).toHaveLength(0)
		expect(f.calls.dropped).toEqual(["memongo_probe_0a1b2c3d"])
	})

	it("closes the connection and drops nothing when the collision lookup itself fails", async () => {
		const f = fixture({ existsThrows: true })
		const error = await refusal(startHarness(f.deps, START))
		expect(error.reason).toBe("startup-failed")
		expect(f.calls.dropped).toEqual([])
		expect(f.calls.markers.size).toBe(0)
		expect(f.calls.closed).toBe(1)
		for (const s of SENTINELS) expect(error.message).not.toContain(s)
	})

	it("treats an early child exit as a partial startup and cleans up", async () => {
		const f = fixture({
			onSpawn: (child) => queueMicrotask(() => child.die(1)),
			status: () => ({ status: 503, body: {} }),
		})
		const error = await refusal(startHarness(f.deps, START))
		expect(error.reason).toBe("child-exited")
		expect(f.calls.dropped).toEqual(["memongo_probe_0a1b2c3d"])
		expect(f.calls.pathsRemoved).toBe(1)
		expect(f.calls.closed).toBe(1)
	})

	it("kills only the spawned pid and drops the database when the boot deadline passes", async () => {
		const f = fixture({ status: () => ({ status: 503, body: {} }) })
		const error = await refusal(startHarness(f.deps, START))
		expect(error.reason).toBe("boot-timeout")
		expect(f.calls.killed.length).toBeGreaterThan(0)
		expect(new Set(f.calls.killed.map((k) => k.pid))).toEqual(new Set([4242]))
		expect(f.calls.dropped).toEqual(["memongo_probe_0a1b2c3d"])
	})

	it("refuses an API that reports a different database than the generated one", async () => {
		const f = fixture({
			status: () => ({
				status: 200,
				body: { custom: { database: "memongo" } },
			}),
		})
		const error = await refusal(startHarness(f.deps, START))
		expect(error.reason).toBe("target-mismatch")
		expect(f.calls.killed.length).toBeGreaterThan(0)
		expect(f.calls.dropped).toEqual(["memongo_probe_0a1b2c3d"])
	})

	it("refuses an API whose status does not report the database at all", async () => {
		const f = fixture({
			status: () => ({ status: 200, body: { backend: "mongodb" } }),
		})
		const error = await refusal(startHarness(f.deps, START))
		expect(error.reason).toBe("target-unverified")
	})

	it("refuses when the API created nothing in the generated database", async () => {
		const f = fixture({ collections: ["__probe_owner"] })
		const error = await refusal(startHarness(f.deps, START))
		expect(error.reason).toBe("target-unverified")
		expect(f.calls.dropped).toEqual(["memongo_probe_0a1b2c3d"])
	})

	it("never lets child output reach notes or errors unsanitized", async () => {
		const f = fixture({
			onSpawn: (child) => {
				child.emit(`boot connecting to ${URI} with key ${VOYAGE}`)
				queueMicrotask(() => child.die(1))
			},
			status: () => ({ status: 503, body: {} }),
		})
		const error = await refusal(startHarness(f.deps, START))
		const everything = [
			...f.calls.notes,
			error.message,
			error.tail.join("\n"),
		].join("\n")
		for (const s of SENTINELS) expect(everything).not.toContain(s)
		expect(error.tail.join("\n")).toContain("boot connecting")
	})

	it("waits through a slow boot before declaring ready", async () => {
		const f = fixture({ readyAfter: 3 })
		const harness = await startHarness(f.deps, START)
		expect(harness.effectiveTarget.verified).toBe(true)
	})
})

describe("harness stop", () => {
	it("stops the spawned pid, drops exactly the verified database and closes the connection", async () => {
		const f = fixture()
		const harness = await startHarness(f.deps, START)
		const report = await harness.stop()
		expect(f.calls.killed).toEqual([{ pid: 4242, signal: "SIGTERM" }])
		expect(f.calls.dropped).toEqual([harness.database])
		expect(report).toEqual({
			stopped: true,
			dropped: true,
			cleanupFailed: false,
			database: harness.database,
			detail: undefined,
		})
		expect(f.calls.closed).toBe(1)
		expect(f.calls.pathsRemoved).toBe(1)
	})

	it("escalates to SIGKILL on the same pid when the child ignores SIGTERM", async () => {
		const f = fixture({
			onSpawn: (child) => {
				const original = child.kill.bind(child)
				child.kill = (signal) => {
					if (signal === "SIGTERM") {
						f.calls.killed.push({ pid: child.pid, signal })
						return
					}
					original(signal)
				}
			},
		})
		const harness = await startHarness(f.deps, START)
		await harness.stop()
		expect(f.calls.killed.map((k) => k.signal)).toEqual(["SIGTERM", "SIGKILL"])
		expect(new Set(f.calls.killed.map((k) => k.pid))).toEqual(new Set([4242]))
	})

	it("refuses to drop when the ownership marker does not match this run", async () => {
		const f = fixture({ markerTamper: true })
		const harness = await startHarness(f.deps, START)
		const report = await harness.stop()
		expect(f.calls.dropped).toEqual([])
		expect(report.dropped).toBe(false)
		expect(report.cleanupFailed).toBe(true)
		expect(report.detail).toMatch(/ownership/i)
	})

	it("reports a cleanup failure without leaking secrets and still stops the child", async () => {
		const f = fixture({ dropFails: true })
		const harness = await startHarness(f.deps, START)
		const report = await harness.stop()
		expect(report.cleanupFailed).toBe(true)
		expect(report.dropped).toBe(false)
		expect(report.stopped).toBe(true)
		expect(report.database).toBe(harness.database)
		for (const s of SENTINELS) expect(JSON.stringify(report)).not.toContain(s)
	})

	it("is idempotent", async () => {
		const f = fixture()
		const harness = await startHarness(f.deps, START)
		await harness.stop()
		await harness.stop()
		expect(f.calls.dropped).toHaveLength(1)
		expect(f.calls.killed).toHaveLength(1)
	})
})
