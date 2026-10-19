import {
	MongoServerError,
	type Collection,
	type Db,
	type Document,
} from "mongodb"
import { beforeEach, describe, expect, it, vi } from "vitest"

const { warn, retry } = vi.hoisted(() => ({
	warn: vi.fn(),
	retry: { passthrough: true },
}))
vi.mock("@memongo/lib", () => ({
	createSubsystemLogger: () => ({
		warn,
		info: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	}),
}))
vi.mock("./mongodb-schema.js", () => ({ eventsCollection: vi.fn() }))
vi.mock("./mongodb-search.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./mongodb-search.js")>()
	return {
		...actual,
		runSearchAggregateWithRetry: vi.fn(
			(...args: Parameters<typeof actual.runSearchAggregateWithRetry>) =>
				retry.passthrough
					? args[0].aggregate(args[1]).toArray()
					: actual.runSearchAggregateWithRetry(...args),
		),
	}
})
import { recallConversation } from "./mongodb-conversation-recall.js"
import { eventsCollection } from "./mongodb-schema.js"
import { resetSearchAdmissionForTests } from "./mongodb-search-admission.js"
import { SearchLaneError } from "./search-outcomes.js"

const query = "private-recall-query-marker"
const document = {
	eventId: "event1",
	agentId: "a1",
	role: "user",
	body: "fallback evidence",
	timestamp: new Date("2026-01-01T00:00:00Z"),
}
function collection(hybrid: unknown, healthy = false) {
	const find = vi.fn(() => ({
		sort: vi.fn(() => ({
			limit: vi.fn(() => ({ toArray: vi.fn(async () => [document]) })),
		})),
	}))
	const aggregate = vi.fn((_pipeline: Document[]) => ({
		toArray: vi.fn(async () => {
			if (healthy) return [document]
			throw hybrid
		}),
	}))
	vi.mocked(eventsCollection).mockReturnValue({
		find,
		aggregate,
	} as unknown as Collection)
	return { find, aggregate }
}

function recall() {
	return recallConversation({
		db: {} as Db,
		prefix: "test_",
		request: { agentId: "a1", query, limit: 10 },
	})
}

describe("recall lane structural failure diagnostics", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		retry.passthrough = true
		resetSearchAdmissionForTests(Date.now())
	})
	it("preserves the real retry classifier's one read and the original driver error", async () => {
		retry.passthrough = false
		const messageRead = vi.fn(() => `hybrid failed ${query}`)
		const hybrid = Object.defineProperty(new Error("hidden"), "message", {
			get: messageRead,
		})
		const col = collection(hybrid)
		const failure = await recall().catch((error: unknown) => error)
		// The shared warmup classifier still reads message before recall types it.
		expect(messageRead).toHaveBeenCalledTimes(1)
		expect(failure).toBeInstanceOf(SearchLaneError)
		expect((failure as SearchLaneError).lane).toBe("recall")
		expect((failure as SearchLaneError).reason).toBe("internal-error")
		expect((failure as Error).message).not.toContain(query)
		expect(col.find).not.toHaveBeenCalled()
		expect(warn).not.toHaveBeenCalled()
	})
	it("types a driver error by code without carrying driver or query text", async () => {
		const hybrid = new MongoServerError({
			errmsg: `hybrid failed ${query}`,
			code: 2,
			errInfo: { private: query },
		})
		const col = collection(hybrid)
		const failure = await recall().catch((error: unknown) => error)
		expect(failure).toMatchObject({
			name: "SearchLaneError",
			lane: "recall",
			stage: "rank-fusion",
			reason: "query-error",
		})
		expect((failure as Error).message).not.toContain(query)
		expect(col.aggregate).toHaveBeenCalledTimes(1)
		expect(col.find).not.toHaveBeenCalled()
		expect(warn).not.toHaveBeenCalled()
	})
	it("does not stringify the error at the catch seam", async () => {
		const messageRead = vi.fn(() => {
			throw new Error("message accessor invoked")
		})
		const stringify = vi.fn(() => {
			throw new Error("string conversion invoked")
		})
		const toJSON = vi.fn(() => {
			throw new Error("serialization invoked")
		})
		const error = Object.defineProperties(new Error("hidden"), {
			message: { get: messageRead },
			toString: { value: stringify },
			toJSON: { value: toJSON },
			code: { value: 7 },
		})
		collection(error)
		const failure = await recall().catch((caught: unknown) => caught)
		expect(failure).toBeInstanceOf(SearchLaneError)
		expect(messageRead).not.toHaveBeenCalled()
		expect(stringify).not.toHaveBeenCalled()
		expect(toJSON).not.toHaveBeenCalled()
	})
	it("preserves healthy hybrid results without warnings", async () => {
		const col = collection(new Error("unused"), true)
		const response = await recall()
		expect(response.metadata.searchMethod).toBe("hybrid")
		expect(response.results[0]?.citation.eventId).toBe("event1")
		expect(col.find).not.toHaveBeenCalled()
		expect(warn).not.toHaveBeenCalled()
	})
})
