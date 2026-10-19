// F1 (review 1232): the 180 s startup deadline bounds the work. A fake clock
// that only moves when `sleep` is called cannot prove that: these tests make
// the fake operations themselves slow or never answer, and the fake ignores
// `timeoutMS` the way an unresponsive server would, so only the contract's own
// bound can end them.
import { afterEach, describe, expect, it, vi } from "vitest"
import {
	type BootContractOptions,
	enforceBootContract,
} from "./mongodb-boot-contract.js"
import { MemongoBootError } from "./mongodb-boot-errors.js"
import { buildRequiredIndexManifest } from "./mongodb-required-index-manifest.js"
import {
	type FakeSearchDbOperation,
	type FakeSearchDbOptions,
	type FakeSearchIndex,
	createFakeSearchDb,
	readyIndex,
	writeCalls,
} from "./test-helpers/fake-search-db.js"

const PREFIX = "t_"
const ENV = {} as NodeJS.ProcessEnv
const DEADLINE_MS = 180_000
const manifest = buildRequiredIndexManifest({
	prefix: PREFIX,
	serverVersionArray: [8, 3, 0, 0],
	env: ENV,
})

function servingIndexes(): Record<string, FakeSearchIndex[]> {
	const byCollection: Record<string, FakeSearchIndex[]> = {}
	for (const entry of manifest) {
		byCollection[entry.collectionName] = [
			...(byCollection[entry.collectionName] ?? []),
			readyIndex(entry.name, entry.type, entry.definition),
		]
	}
	return byCollection
}

type Settled = { result?: unknown; error?: unknown }

const never = (): Promise<void> => new Promise(() => {})
const takes = (ms: number) => (): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, ms))

function boot(fake: FakeSearchDbOptions, extra?: Partial<BootContractOptions>) {
	const created = createFakeSearchDb(fake)
	const settled = enforceBootContract(created.db, {
		prefix: PREFIX,
		env: ENV,
		mode: "repair",
		deadlineMs: DEADLINE_MS,
		...extra,
	}).then(
		(result): Settled => ({ result }),
		(error: unknown): Settled => ({ error }),
	)
	return { ...created, settled }
}

async function deadlineFailure(
	settled: Promise<Settled>,
): Promise<MemongoBootError> {
	await vi.advanceTimersByTimeAsync(DEADLINE_MS + 1)
	const outcome = await settled
	expect(outcome.error).toBeInstanceOf(MemongoBootError)
	const err = outcome.error as MemongoBootError
	expect(err.code).toBe("boot-deadline-exceeded")
	expect(err.message).toContain("180 s startup deadline expired")
	return err
}

afterEach(() => {
	vi.useRealTimers()
})

describe("enforceBootContract: the total deadline bounds every operation", () => {
	const stalledOps: Array<[string, (op: FakeSearchDbOperation) => boolean]> = [
		["buildInfo", (op) => op.kind === "buildInfo"],
		["connectionStatus", (op) => op.kind === "connectionStatus"],
		["the first $listSearchIndexes", (op) => op.kind === "listSearchIndexes"],
	]

	it.each(
		stalledOps,
	)("fails typed at the deadline when %s never answers", async (_name, isStalled) => {
		vi.useFakeTimers()
		const started = Date.now()
		const { settled } = boot({
			indexes: servingIndexes(),
			before: (op) => (isStalled(op) ? never() : undefined),
		})
		const err = await deadlineFailure(settled)
		expect(Date.now() - started).toBeLessThanOrEqual(DEADLINE_MS + 1)
		expect(err.failures).toHaveLength(1)
	})

	it("fails typed at the deadline on slow metadata that would finish long after it", async () => {
		vi.useFakeTimers()
		const { calls, settled } = boot({
			indexes: servingIndexes(),
			before: (op) =>
				op.kind === "listSearchIndexes" ? takes(10 * DEADLINE_MS)() : undefined,
		})
		const err = await deadlineFailure(settled)
		expect(err.message).toContain("$listSearchIndexes on")
		expect(writeCalls(calls)).toEqual([])
	})

	it("reports the indexes the last poll saw building as index-not-ready when a later poll is cut off by the deadline", async () => {
		vi.useFakeTimers()
		let polled = false
		const { settled } = boot(
			{
				indexes: {},
				onCreate: (_collection, description) => ({
					name: description.name,
					type: description.type,
					status: "BUILDING",
					queryable: false,
					latestDefinition: description.definition,
				}),
				// Every listing after the first readiness poll hangs past the deadline.
				before: (op) =>
					polled && op.kind === "listSearchIndexes" ? never() : undefined,
			},
			{
				sleep: (ms: number) => {
					polled = true
					return new Promise((resolve) => setTimeout(resolve, ms))
				},
			},
		)
		await vi.advanceTimersByTimeAsync(DEADLINE_MS + 1)
		const outcome = await settled
		expect(outcome.error).toBeInstanceOf(MemongoBootError)
		const err = outcome.error as MemongoBootError
		expect(err.code).toBe("index-not-ready")
		expect(err.failures).toHaveLength(manifest.length)
		expect(err.failures.every((f) => f.code === "index-not-ready")).toBe(true)
		expect(err.message).toContain("readiness deadline")
	})

	it("fails typed at the deadline when a repair create never answers, and starts no further repair", async () => {
		vi.useFakeTimers()
		const { calls, settled } = boot({
			indexes: {},
			before: (op) => (op.kind === "createSearchIndex" ? never() : undefined),
		})
		const err = await deadlineFailure(settled)
		expect(err.message).toContain("createSearchIndex")
		expect(
			calls.filter((call) => call.op === "createSearchIndex"),
		).toHaveLength(1)
	})

	it("fails typed at the deadline when a repair update never answers", async () => {
		vi.useFakeTimers()
		const drifted = servingIndexes()
		drifted.t_events = [
			readyIndex("t_events_text", "search", { mappings: { dynamic: true } }),
			...(drifted.t_events ?? []).filter(
				(index) => index.name !== "t_events_text",
			),
		]
		const { settled } = boot({
			indexes: drifted,
			before: (op) => (op.kind === "updateSearchIndex" ? never() : undefined),
		})
		const err = await deadlineFailure(settled)
		expect(err.message).toContain("updateSearchIndex t_events_text")
	})

	it("fails typed at the deadline when beforeRepair never settles", async () => {
		vi.useFakeTimers()
		const { calls, settled } = boot({ indexes: {} }, { beforeRepair: never })
		const err = await deadlineFailure(settled)
		expect(err.message).toContain("beforeRepair")
		expect(writeCalls(calls)).toEqual([])
	})

	it("stops starting repairs once the deadline has passed", async () => {
		vi.useFakeTimers()
		const { calls, settled } = boot({
			indexes: {},
			before: (op) =>
				op.kind === "createSearchIndex" ? takes(60_000)() : undefined,
		})
		await deadlineFailure(settled)
		const creates = calls.filter(
			(call) => call.op === "createSearchIndex",
		).length
		expect(creates).toBeGreaterThanOrEqual(3)
		expect(creates).toBeLessThanOrEqual(4)
		expect(creates).toBeLessThan(manifest.length)
	})

	it("fails at a small real-time deadline without a fake clock", async () => {
		const started = Date.now()
		const { settled } = boot(
			{
				indexes: servingIndexes(),
				before: (op) => (op.kind === "listSearchIndexes" ? never() : undefined),
			},
			{ deadlineMs: 100 },
		)
		const outcome = await settled
		expect((outcome.error as MemongoBootError).code).toBe(
			"boot-deadline-exceeded",
		)
		expect(Date.now() - started).toBeLessThan(3_000)
	})
})

describe("enforceBootContract: a command that completes after the deadline fails", () => {
	function clock() {
		let at = 0
		return {
			now: () => at,
			advance: (ms: number) => {
				at += ms
			},
		}
	}

	it("rejects a healthy answer that arrives after the deadline, and accepts the same answer in time", async () => {
		for (const [elapsedMs, passes] of [
			[6_000, false],
			[1, true],
		] as const) {
			const time = clock()
			const { db } = createFakeSearchDb({
				indexes: servingIndexes(),
				before: (op) => {
					if (op.kind === "listSearchIndexes") time.advance(elapsedMs)
				},
			})
			const run = enforceBootContract(db, {
				prefix: PREFIX,
				env: ENV,
				mode: "repair",
				deadlineMs: 5_000,
				now: time.now,
				sleep: async () => {},
			})
			if (passes) {
				await expect(run).resolves.toBeDefined()
			} else {
				await expect(run).rejects.toMatchObject({
					code: "boot-deadline-exceeded",
				})
			}
		}
	})

	it("rejects a create that completes after the deadline even though every index is then READY", async () => {
		const time = clock()
		const { db, indexes } = createFakeSearchDb({
			indexes: {},
			before: (op) => {
				if (op.kind === "createSearchIndex") time.advance(6_000)
			},
		})
		await expect(
			enforceBootContract(db, {
				prefix: PREFIX,
				env: ENV,
				mode: "repair",
				deadlineMs: 5_000,
				now: time.now,
				sleep: async () => {},
			}),
		).rejects.toMatchObject({ code: "boot-deadline-exceeded" })
		expect(Object.keys(indexes).length).toBeGreaterThan(0)
	})
})

describe("enforceBootContract: the remaining budget reaches the driver", () => {
	it("passes a shrinking timeoutMS to buildInfo, connectionStatus and every listing", async () => {
		let at = 0
		const { db, calls } = createFakeSearchDb({
			indexes: servingIndexes(),
			before: (op) => {
				if (op.kind === "buildInfo" || op.kind === "connectionStatus") {
					at += 1_000
				}
			},
		})
		await enforceBootContract(db, {
			prefix: PREFIX,
			env: ENV,
			mode: "verify",
			deadlineMs: 5_000,
			now: () => at,
			sleep: async () => {},
		})
		const commands = calls.flatMap((call) =>
			call.op === "command" ? [call.timeoutMS] : [],
		)
		expect(commands).toEqual([5_000, 4_000])
		const listings = calls.flatMap((call) =>
			call.op === "aggregate" ? [call.timeoutMS] : [],
		)
		expect(listings.length).toBeGreaterThan(0)
		for (const timeoutMS of listings) expect(timeoutMS).toBe(3_000)
	})

	it("never passes a timeoutMS of 0, which the driver reads as no timeout", async () => {
		const { db, calls } = createFakeSearchDb({ indexes: servingIndexes() })
		await enforceBootContract(db, {
			prefix: PREFIX,
			env: ENV,
			mode: "verify",
			deadlineMs: 1,
			now: () => 0,
			sleep: async () => {},
		})
		const budgets = calls.flatMap((call) =>
			call.op === "command" || call.op === "aggregate" ? [call.timeoutMS] : [],
		)
		expect(budgets.length).toBeGreaterThan(0)
		for (const timeoutMS of budgets) expect(timeoutMS).toBeGreaterThanOrEqual(1)
	})
})

describe("enforceBootContract: the deadline bound leaks no timer", () => {
	it("leaves no timer behind after a healthy boot", async () => {
		vi.useFakeTimers()
		const { settled } = boot({ indexes: servingIndexes() })
		expect(await settled).toHaveProperty("result")
		expect(vi.getTimerCount()).toBe(0)
	})

	it("leaves no timer behind after a boot that fails on a typed error", async () => {
		vi.useFakeTimers()
		const { settled } = boot({ versionArray: [8, 2, 6, 0] })
		expect(await settled).toHaveProperty("error")
		expect(vi.getTimerCount()).toBe(0)
	})

	it("leaves no timer behind after a boot that fails at the deadline", async () => {
		vi.useFakeTimers()
		const { settled } = boot({
			before: (op) => (op.kind === "buildInfo" ? never() : undefined),
		})
		await deadlineFailure(settled)
		expect(vi.getTimerCount()).toBe(0)
	})
})
