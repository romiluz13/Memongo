import { describe, expect, it } from "vitest"
import {
	buildChildEnv,
	generateAgentId,
	generateDatabaseName,
	HarnessRefusal,
	isOwnedDatabaseName,
	type ApiProcess,
	type HarnessDeps,
	type MongoAdmin,
	type OwnershipMarker,
	startHarness,
} from "./harness.ts"
import { collectSecretValues, createSanitizer } from "./sanitize.ts"

const URI = "mongodb://dbuser:dbpass-SENTINEL@cluster.sentinel.example/"
const VOYAGE = "al-SENTINEL-voyage-harness-0001"
const SENTINELS = ["dbpass-SENTINEL", VOYAGE, "cluster.sentinel.example"]

type Calls = {
	dropped: string[]
	killed: Array<{ pid: number; signal: string }>
	spawned: Array<Record<string, string>>
	notes: string[]
	markers: Map<string, OwnershipMarker>
	closed: number
	pathsRemoved: number
}

class FakeChild implements ApiProcess {
	pid = 4242
	exited = false
	private lineCb?: (s: "stdout" | "stderr", l: string) => void
	private buffered: string[] = []
	private exitCb: (c: number | null, s: string | null) => void = () => {}
	constructor(private readonly calls: Calls) {}
	onLine(cb: (s: "stdout" | "stderr", l: string) => void) {
		this.lineCb = cb
		for (const line of this.buffered) cb("stderr", line)
		this.buffered = []
	}
	onExit(cb: (c: number | null, s: string | null) => void) {
		this.exitCb = cb
	}
	kill(signal: "SIGTERM" | "SIGKILL") {
		this.calls.killed.push({ pid: this.pid, signal })
		this.exited = true
		this.exitCb(null, signal)
	}
	emit(line: string) {
		if (this.lineCb) this.lineCb("stderr", line)
		else this.buffered.push(line)
	}
	die(code: number) {
		this.exited = true
		this.exitCb(code, null)
	}
}

type Overrides = {
	existingDatabases?: string[]
	portFree?: boolean
	spawnThrows?: boolean
	markerWriteFails?: boolean
	dropFails?: boolean
	status?: (calls: Calls) => { status: number; body: unknown }
	onSpawn?: (child: FakeChild) => void
	collections?: string[]
	apiBuilt?: boolean
	markerTamper?: boolean
	readyAfter?: number
}

function fixture(overrides: Overrides = {}) {
	const calls: Calls = {
		dropped: [],
		killed: [],
		spawned: [],
		notes: [],
		markers: new Map(),
		closed: 0,
		pathsRemoved: 0,
	}
	let fetches = 0
	let clock = 0
	const mongo: MongoAdmin = {
		databaseExists: async (name) =>
			(overrides.existingDatabases ?? []).includes(name),
		writeMarker: async (name, marker) => {
			if (overrides.markerWriteFails) throw new Error(`marker failed ${URI}`)
			calls.markers.set(name, marker)
		},
		readMarker: async (name) => {
			const marker = calls.markers.get(name)
			if (overrides.markerTamper && marker) {
				return { ...marker, runId: "someone-else" }
			}
			return marker
		},
		listCollections: async () =>
			overrides.collections ?? ["__probe_owner", "memongo_events"],
		dropDatabase: async (name) => {
			if (overrides.dropFails) throw new Error(`drop failed for ${URI}`)
			calls.dropped.push(name)
		},
		listOperations: async () => [],
		killOperation: async () => {},
		close: async () => {
			calls.closed += 1
		},
	}
	let child: FakeChild | undefined
	const deps: HarnessDeps = {
		mongo,
		sanitizer: createSanitizer({
			secretValues: collectSecretValues({
				MEMONGO_MONGODB_URI: URI,
				VOYAGE_API_KEY: VOYAGE,
			}),
		}),
		fileExists: () => overrides.apiBuilt ?? true,
		allocatePort: async () => 51234,
		isPortFree: async () => overrides.portFree ?? true,
		spawnApi: (env) => {
			if (overrides.spawnThrows) throw new Error(`spawn failed ${URI}`)
			calls.spawned.push(env)
			child = new FakeChild(calls)
			overrides.onSpawn?.(child)
			return child
		},
		fetchJson: async (_url, _headers) => {
			fetches += 1
			if (overrides.readyAfter && fetches <= overrides.readyAfter) {
				return { status: 503, body: {} }
			}
			if (overrides.status) return overrides.status(calls)
			const database = [...calls.markers.keys()][0]
			return {
				status: 200,
				body: { backend: "mongodb", custom: { database } },
			}
		},
		sleep: async (ms) => {
			clock += ms
		},
		now: () => clock,
		randomHex: () => "0a1b2c3d",
		randomUuid: () => "11111111-2222-4333-8444-555555555555",
		withConfigFile: () => ({
			path: "/scratch/config.json",
			remove: () => {
				calls.pathsRemoved += 1
			},
		}),
		note: (line) => calls.notes.push(line),
	}
	return { deps, calls, child: () => child }
}

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

	it("passes only Voyage query and indexing keys when the parent has them", () => {
		expect(env.VOYAGE_API_QUERY_KEY).toBe("al-query-key-SENTINEL-00000")
		expect(env.VOYAGE_API_INDEXING_KEY).toBeUndefined()
	})
})

describe("startHarness", () => {
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
