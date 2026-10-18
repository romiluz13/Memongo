import { describe, expect, it, vi } from "vitest"

const logger = vi.hoisted(() => ({
	trace: vi.fn(),
	debug: vi.fn(),
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
	fatal: vi.fn(),
}))

vi.mock("@memongo/lib", async (importOriginal) => ({
	...(await importOriginal<typeof import("@memongo/lib")>()),
	createSubsystemLogger: () => logger,
}))

const { runSearchBarrier, searchBarrierTargets } = await import(
	"./mongodb-search-barrier.js"
)

const TOKEN = "65f0c0ffee0000000000beef"
const SECRET = "provider said: secret-provider-text for search barrier probe"

class MongoServerError extends Error {
	readonly code = 31082
	constructor(message: string) {
		super(message)
		this.name = "MongoServerError"
	}
}

function immediateClock() {
	let now = 0
	return {
		now: () => now,
		sleep: (ms: number, signal?: AbortSignal) =>
			new Promise<void>((resolve) => {
				setImmediate(() => {
					if (!signal?.aborted) now += ms
					resolve()
				})
			}),
	}
}

describe("search barrier probe failure log", () => {
	it("logs one bounded warn per failed probe: index, error class and numeric code only", async () => {
		const result = await runSearchBarrier({
			targets: searchBarrierTargets("event"),
			token: TOKEN,
			clock: immediateClock(),
			probe: async (target) => {
				if (target.index === "events_vector") {
					throw new MongoServerError(SECRET)
				}
				if (target.index === "chunks_vector") {
					throw new TypeError(SECRET)
				}
				return 1
			},
		})
		expect(result.reason).toBe("probe-failed")

		const probeWarns = logger.warn.mock.calls.filter(
			([message]) => message === "search barrier probe failed",
		)
		expect(probeWarns).toEqual([
			[
				"search barrier probe failed",
				{ index: "events_vector", errorClass: "MongoServerError", code: 31082 },
			],
			[
				"search barrier probe failed",
				{ index: "chunks_vector", errorClass: "TypeError" },
			],
		])

		const printed = JSON.stringify(logger.warn.mock.calls)
		expect(printed).not.toContain("secret-provider-text")
		expect(printed).not.toContain(TOKEN)
	})
})
