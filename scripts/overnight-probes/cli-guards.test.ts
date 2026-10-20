import { describe, expect, it } from "vitest"
import { main } from "./cli.ts"
import {
	ALL_SENTINELS,
	ENV,
	everything,
	passes,
	records,
	resultOf,
	caseOf,
	setup,
} from "./fake-cli.ts"
import { type Overrides, URI, VOYAGE } from "./fake-harness.ts"

describe("refusals (exit 64) before anything is started", () => {
	async function refused(argv: string[], env = ENV, harness: Overrides = {}) {
		const state = setup(passes, harness)
		const code = await main(argv, env, state.io)
		return { state, code }
	}

	it("refuses an unknown probe letter, a lowercase letter and a duplicated letter", async () => {
		for (const probes of ["Z", "a", "A,A", "A,,B"]) {
			const { state, code } = await refused(["--probes", probes])
			expect(code).toBe(64)
			expect(state.events).toEqual([])
			expect(state.err.join("")).toContain("refused:")
		}
	})

	it("refuses external target overrides given as arguments", async () => {
		for (const flag of [
			"--database=x",
			"--base-url=http://x",
			"--uri",
			"--port=1",
		]) {
			const { state, code } = await refused(["--probes", "A", flag])
			expect(code).toBe(64)
			expect(state.events).toEqual([])
		}
	})

	it("refuses invalid run counts", async () => {
		for (const runs of ["0", "6", "-1", "1.5", "abc"]) {
			expect((await refused(["--runs", runs])).code).toBe(64)
		}
	})

	it("refuses an environment with target overrides without printing their values", async () => {
		const { state, code } = await refused(["--probes", "A"], {
			...ENV,
			MEMONGO_API_URL: "https://prod.sentinel.example",
			MEMONGO_MONGODB_DATABASE: "production-sentinel",
		})
		expect(code).toBe(64)
		expect(state.events).toEqual([])
		expect(everything(state)).toContain("MEMONGO_API_URL")
		expect(everything(state)).not.toContain("prod.sentinel.example")
		expect(everything(state)).not.toContain("production-sentinel")
	})

	it("names missing variables without printing any value", async () => {
		const { MEMONGO_MONGODB_URI: _uri, VOYAGE_API_KEY: _key, ...rest } = ENV
		const { state, code } = await refused(["--probes", "A"], rest)
		expect(code).toBe(64)
		expect(state.err.join("")).toContain("VOYAGE_API_KEY")
		expect(state.err.join("")).toContain("MEMONGO_MONGODB_URI")
		for (const sentinel of ALL_SENTINELS) {
			expect(everything(state)).not.toContain(sentinel)
		}
	})

	it("asks for the answer provider variables and operator prices only when probe B is selected", async () => {
		const {
			MEMONGO_BENCHMARK_ANSWER_API_KEY: _a,
			MEMONGO_PROBE_ANSWER_PRICE_INPUT_USD_PER_MTOK: _p,
			...rest
		} = ENV
		const withB = await refused(["--probes", "B"], rest)
		expect(withB.code).toBe(64)
		expect(withB.state.err.join("")).toContain(
			"MEMONGO_BENCHMARK_ANSWER_API_KEY",
		)
		expect(withB.state.err.join("")).toContain(
			"MEMONGO_PROBE_ANSWER_PRICE_INPUT_USD_PER_MTOK",
		)
		const withoutB = await refused(["--probes", "A"], rest)
		expect(withoutB.code).toBe(0)
	})

	it("refuses an unusable operator price", async () => {
		const { code } = await refused(["--probes", "B"], {
			...ENV,
			MEMONGO_PROBE_ANSWER_PRICE_OUTPUT_USD_PER_MTOK: "-3",
		})
		expect(code).toBe(64)
	})

	it("refuses a colliding database name and leaves nothing behind", async () => {
		const { state, code } = await refused(["--probes", "A"], ENV, {
			existingDatabases: ["memongo_probe_0a1b2c3d"],
		})
		expect(code).toBe(64)
		expect(state.f.calls.spawned).toEqual([])
		expect(state.f.calls.dropped).toEqual([])
		expect(records(state.out).map((item) => item.kind)).toEqual(["plan"])
	})

	it("refuses an occupied port and a missing build", async () => {
		expect(
			(await refused(["--probes", "A"], ENV, { portFree: false })).code,
		).toBe(64)
		expect(
			(await refused(["--probes", "A"], ENV, { apiBuilt: false })).code,
		).toBe(64)
	})

	it("reports a partial startup as a refusal with the sanitized child tail and cleans up", async () => {
		const { state, code } = await refused(["--probes", "A"], ENV, {
			onSpawn: (child) => {
				child.emit(`connecting ${URI} ${VOYAGE}`)
				queueMicrotask(() => child.die(1))
			},
			status: () => ({ status: 503, body: {} }),
		})
		expect(code).toBe(64)
		expect(state.f.calls.dropped).toEqual(["memongo_probe_0a1b2c3d"])
		expect(state.err.join("")).toContain("api: connecting")
		for (const sentinel of ALL_SENTINELS) {
			expect(everything(state)).not.toContain(sentinel)
		}
	})
})

describe("cleanup and crashes (exit 70)", () => {
	it("reports a failed cleanup with the database name and exits 70 even when every probe passed", async () => {
		const state = setup(passes, { dropFails: true })
		const code = await main(["--probes", "A"], ENV, state.io)
		expect(code).toBe(70)
		expect(state.err.join("")).toContain("memongo_probe_0a1b2c3d")
		expect(state.err.join("")).toContain("needs manual removal")
		const cleanup = records(state.out).find((item) => item.kind === "cleanup")
		expect(cleanup?.payload.cleanupFailed).toBe(true)
		for (const sentinel of ALL_SENTINELS) {
			expect(everything(state)).not.toContain(sentinel)
		}
	})

	it("exits 70, not 64, when a refused startup could not clean up its database", async () => {
		const state = setup(passes, { spawnThrows: true, dropFails: true })
		const code = await main(["--probes", "A"], ENV, state.io)
		expect(code).toBe(70)
		expect(state.err.join("")).toContain("memongo_probe_0a1b2c3d")
	})

	it("cleans up and exits 70 when setup fails unexpectedly after the harness started", async () => {
		const state = setup(passes, {}, (io) => {
			io.createApi = () => {
				throw new Error(`client failed ${URI} ${VOYAGE}`)
			}
		})
		const code = await main(["--probes", "A"], ENV, state.io)
		expect(code).toBe(70)
		expect(state.f.calls.dropped).toEqual(["memongo_probe_0a1b2c3d"])
		for (const sentinel of ALL_SENTINELS) {
			expect(everything(state)).not.toContain(sentinel)
		}
	})

	it("exits 70 with sanitized output when harness startup fails in an unexpected way", async () => {
		const state = setup(passes, { listThrows: true })
		const code = await main(["--probes", "A"], ENV, state.io)
		expect(code).toBe(70)
		for (const sentinel of ALL_SENTINELS) {
			expect(everything(state)).not.toContain(sentinel)
		}
	})

	it("withholds details when failure happens before the evidence writer can exist", async () => {
		const hostile = new Proxy(
			{},
			{
				ownKeys: () => {
					throw new Error(`env enumeration failed ${URI}`)
				},
			},
		) as Record<string, string | undefined>
		const state = setup(passes)
		const code = await main(["--probes", "A"], hostile, state.io)
		expect(code).toBe(70)
		expect(state.events).toEqual([])
		expect(state.out).toEqual([])
		expect(everything(state)).toContain("details withheld")
		for (const sentinel of ALL_SENTINELS) {
			expect(everything(state)).not.toContain(sentinel)
		}
	})

	it("stops the API and drops the database when the process is told to terminate mid-run", async () => {
		let stopped = 0
		const state = setup(async (letter, ctx) => {
			await state.trigger()
			stopped = state.f.calls.dropped.length
			return resultOf(letter, ctx, "pass", [caseOf("c1", "pass")])
		})
		await main(["--probes", "A", "--runs", "1"], ENV, state.io)
		expect(stopped).toBe(1)
		expect(state.f.calls.dropped).toEqual(["memongo_probe_0a1b2c3d"])
		expect(state.f.calls.killed).toHaveLength(1)
		expect(state.f.calls.closed).toBe(1)
	})
})

describe("entry module", () => {
	it("exports main without starting anything when imported", async () => {
		const entry = await import("../overnight-probes.ts")
		expect(typeof entry.main).toBe("function")
	})
})
