import { createHash } from "node:crypto"
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

const query = "private-recall-query-marker"
const document = {
	eventId: "event1",
	agentId: "a1",
	role: "user",
	body: "fallback evidence",
	timestamp: new Date("2026-01-01T00:00:00Z"),
}
const capabilities = {
	vectorSearch: true,
	textSearch: true,
	rankFusion: true,
	scoreFusion: false,
	storedSource: false,
	vectorIndexMethod: false,
}

function collection(
	hybrid: unknown,
	semantic: unknown,
	healthy?: "hybrid" | "semantic",
) {
	const find = vi.fn(() => ({
		sort: vi.fn(() => ({
			limit: vi.fn(() => ({ toArray: vi.fn(async () => [document]) })),
		})),
	}))
	const aggregate = vi.fn((pipeline: Document[]) => ({
		toArray: vi.fn(async () => {
			const lane =
				"$vectorSearch" in (pipeline[0] ?? {}) ? "semantic" : "hybrid"
			if (lane === healthy) return [document]
			throw lane === "semantic" ? semantic : hybrid
		}),
	}))
	vi.mocked(eventsCollection).mockReturnValue({
		find,
		aggregate,
	} as unknown as Collection)
	return { find, aggregate }
}

function recall(onLaneFailure = vi.fn(), selectedCapabilities = capabilities) {
	return recallConversation({
		db: {} as Db,
		prefix: "test_",
		request: { agentId: "a1", query, limit: 10 },
		capabilities: selectedCapabilities,
		onLaneFailure,
	})
}

function expectedMeta(code?: number) {
	return {
		...(code === undefined ? {} : { code }),
		queryLength: query.length,
		queryDigest: createHash("sha256").update(query).digest("hex").slice(0, 12),
	}
}

describe("recall waterfall structural failure diagnostics", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		retry.passthrough = true
		resetSearchAdmissionForTests(Date.now())
	})
	it("preserves the real retry classifier's one read and original driver errors", async () => {
		retry.passthrough = false
		const hybrid = new MongoServerError({ errmsg: query, code: 8 })
		const messageRead = vi.fn(() => `semantic failed ${query}`)
		const semantic = Object.defineProperty(new Error("hidden"), "message", {
			get: messageRead,
		})
		collection(hybrid, semantic)
		const callback = vi.fn()
		const response = await recall(callback)
		expect(callback.mock.calls[0]?.[1]).toBe(hybrid)
		expect(callback.mock.calls[1]?.[1]).toBe(semantic)
		expect(response.metadata.searchMethod).toBe("standard")
		expect(response.results[0]?.citation.eventId).toBe("event1")
		expect(warn.mock.calls).toEqual([
			["hybrid conversation recall failed, falling back", expectedMeta(8)],
			["semantic conversation recall failed, falling back", expectedMeta()],
		])
		expect(JSON.stringify(warn.mock.calls)).not.toContain(query)
		// The shared warmup classifier still reads message before recall catches it.
		expect(messageRead).toHaveBeenCalledTimes(1)
	})
	it("omits driver error/query text and preserves both errors and standard results", async () => {
		const hybrid = new MongoServerError({
			errmsg: `hybrid failed ${query}`,
			code: 2,
			errInfo: { private: query },
		})
		const semantic = new MongoServerError({
			errmsg: `semantic failed ${query}`,
			code: 3,
			errInfo: { private: query },
		})
		const col = collection(hybrid, semantic)
		const callback = vi.fn()
		const response = await recall(callback)
		expect(col.aggregate).toHaveBeenCalledTimes(2)
		expect(callback.mock.calls).toEqual([
			["recall:hybrid", hybrid],
			["recall:semantic", semantic],
		])
		expect(response.metadata.searchMethod).toBe("standard")
		expect(response.results[0]?.citation.eventId).toBe("event1")
		expect(warn.mock.calls).toEqual([
			["hybrid conversation recall failed, falling back", expectedMeta(2)],
			["semantic conversation recall failed, falling back", expectedMeta(3)],
		])
		expect(JSON.stringify(warn.mock.calls)).not.toContain(query)
	})
	it.each([
		"hybrid",
		"semantic",
	] as const)("does not stringify a %s error at the catch seam", async (lane) => {
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
		collection(error, error)
		const callback = vi.fn()
		const response = await recall(
			callback,
			lane === "semantic"
				? { ...capabilities, rankFusion: false }
				: capabilities,
		)
		expect(response.metadata.searchMethod).toBe("standard")
		expect(callback.mock.calls[0]).toEqual([`recall:${lane}`, error])
		expect(messageRead).not.toHaveBeenCalled()
		expect(stringify).not.toHaveBeenCalled()
		expect(toJSON).not.toHaveBeenCalled()
	})
	it.each([
		"hybrid",
		"semantic",
	] as const)("preserves healthy %s results without warnings", async (lane) => {
		const col = collection(
			new Error("hybrid failed"),
			new Error("semantic failed"),
			lane,
		)
		const response = await recall(
			vi.fn(),
			lane === "semantic"
				? { ...capabilities, rankFusion: false }
				: capabilities,
		)
		expect(response.metadata.searchMethod).toBe(lane)
		expect(response.results[0]?.citation.eventId).toBe("event1")
		expect(col.find).not.toHaveBeenCalled()
		expect(warn).not.toHaveBeenCalled()
	})
	it("preserves the existing callback-throw behavior", async () => {
		collection(new Error("hybrid failed"), new Error("semantic failed"))
		const callbackError = new Error("callback failed")
		await expect(
			recall(
				vi.fn(() => {
					throw callbackError
				}),
			),
		).rejects.toBe(callbackError)
	})
})
