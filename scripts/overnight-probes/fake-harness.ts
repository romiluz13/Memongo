import type {
	ApiProcess,
	HarnessDeps,
	MongoAdmin,
	OwnershipMarker,
} from "./harness.ts"
import { collectSecretValues, createSanitizer } from "./sanitize.ts"

export const URI = "mongodb://dbuser:dbpass-SENTINEL@cluster.sentinel.example/"
export const VOYAGE = "al-SENTINEL-voyage-harness-0001"
export const SENTINELS = ["dbpass-SENTINEL", VOYAGE, "cluster.sentinel.example"]

export type Calls = {
	dropped: string[]
	killed: Array<{ pid: number; signal: string }>
	spawned: Array<Record<string, string>>
	notes: string[]
	markers: Map<string, OwnershipMarker>
	closed: number
	pathsRemoved: number
}

export class FakeChild implements ApiProcess {
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

export type Overrides = {
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
	existsThrows?: boolean
	listThrows?: boolean
	configThrows?: boolean
}

export function fixture(overrides: Overrides = {}) {
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
		databaseExists: async (name) => {
			if (overrides.existsThrows) throw new Error(`lookup failed ${URI}`)
			return (overrides.existingDatabases ?? []).includes(name)
		},
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
		listCollections: async () => {
			if (overrides.listThrows) throw new Error(`listing failed ${URI}`)
			return overrides.collections ?? ["__probe_owner", "memongo_events"]
		},
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
		withConfigFile: () => {
			if (overrides.configThrows) throw new Error(`config failed ${URI}`)
			return {
				path: "/scratch/config.json",
				remove: () => {
					calls.pathsRemoved += 1
				},
			}
		},
		note: (line) => calls.notes.push(line),
	}
	return { deps, calls, child: () => child }
}
