import { Hono } from "hono"
import { afterEach, describe, expect, it, vi } from "vitest"
import { internalError } from "./errors.js"

afterEach(() => vi.restoreAllMocks())
async function logError(err: unknown) {
	const log = vi.spyOn(console, "error").mockImplementation(() => {})
	const app = new Hono().get("/synthetic", (c) => {
		c.set("requestId", "synthetic-request")
		return internalError(c, err, "SYNTHETIC_FAILED")
	})
	const res = await app.request("/synthetic")
	expect(log).toHaveBeenCalledTimes(1)
	const output = log.mock.calls[0][0]
	expect(typeof output).toBe("string")
	return {
		res,
		output: String(output),
		record: JSON.parse(String(output)) as Record<string, unknown>,
	}
}
describe("internalError structural logging", () => {
	it("omits semantic content and stack while preserving finite code and request correlation", async () => {
		const err = Object.assign(new Error("synthetic personal memory canary"), {
			code: 2,
		})
		err.stack = "synthetic personal stack canary"
		const { res, output, record } = await logError(err)
		expect(res.status).toBe(500)
		expect(record).toEqual({
			level: "error",
			msg: "request failed",
			requestId: "synthetic-request",
			code: "SYNTHETIC_FAILED",
			method: "GET",
			path: "/synthetic",
			error: { code: 2 },
		})
		expect(output).not.toContain("canary")
		expect(await res.json()).toEqual({
			error: {
				code: "SYNTHETIC_FAILED",
				message: "internal server error (request id: synthetic-request)",
			},
		})
	})
	it("does not inspect huge upstream messages or stacks", async () => {
		const err = new Error("synthetic canary".repeat(100000))
		err.stack = "synthetic stack canary".repeat(100000)
		const { res, output, record } = await logError(err)
		expect(res.status).toBe(500)
		expect(output.length).toBeLessThan(300)
		expect(record.error).toEqual({})
	})
	it("does not read message, stack or code accessors", async () => {
		const err = new Error()
		void err.stack
		const getter = vi.fn(() => {
			throw new Error("must not inspect")
		})
		for (const key of ["message", "stack", "code"])
			Object.defineProperty(err, key, { get: getter })
		const { res, record } = await logError(err)
		expect(res.status).toBe(500)
		expect(record.error).toEqual({})
		expect(getter).not.toHaveBeenCalled()
	})
	it("never stringifies unknown objects or calls their conversion methods", async () => {
		const convert = vi.fn(() => {
			throw new Error("must not convert")
		})
		const err = {
			code: 7,
			toJSON: convert,
			toString: convert,
			[Symbol.toPrimitive]: convert,
		}
		const { res, record } = await logError(err)
		expect(res.status).toBe(500)
		expect(record.error).toEqual({ code: 7 })
		expect(convert).not.toHaveBeenCalled()
	})
	it.each([
		"synthetic content",
		3,
		null,
		undefined,
		true,
		7n,
	])("omits primitive error text for %s", async (err) => {
		const { res, record } = await logError(err)
		expect(res.status).toBe(500)
		expect(record.error).toEqual({})
	})
	it.each([
		Number.NaN,
		Number.POSITIVE_INFINITY,
		Number.NEGATIVE_INFINITY,
		"2",
		7n,
		undefined,
	])("omits nonfinite or nonnumeric code %s", async (code) => {
		const { res, record } = await logError({ code })
		expect(res.status).toBe(500)
		expect(record.error).toEqual({})
	})
	it.each([0, 2, -1, 2.5])("preserves finite numeric code %s", async (code) => {
		const { res, record } = await logError({ code })
		expect(res.status).toBe(500)
		expect(record.error).toEqual({ code })
	})
	it("ignores inherited code without reading it", async () => {
		const read = vi.fn(() => 2)
		const prototype = Object.defineProperty({}, "code", { get: read })
		const { res, record } = await logError(Object.create(prototype))
		expect(res.status).toBe(500)
		expect(record.error).toEqual({})
		expect(read).not.toHaveBeenCalled()
	})
	it("a throwing own-property descriptor trap cannot break this diagnostic", async () => {
		const trap = vi.fn(() => {
			throw new Error("synthetic descriptor trap")
		})
		const err = new Proxy({}, { getOwnPropertyDescriptor: trap })
		const { res, record } = await logError(err)
		expect(res.status).toBe(500)
		expect(record.error).toEqual({})
	})
	it("retains 503 classification through a cause chain without logging cause content", async () => {
		const cause = Object.assign(new Error("synthetic private cause"), {
			name: "MongoNetworkError",
			code: 7,
		})
		const err = new Error("synthetic private wrapper", { cause })
		const { res, output, record } = await logError(err)
		expect(res.status).toBe(503)
		expect(record.error).toEqual({})
		expect(output).not.toContain("private")
		expect(await res.json()).toEqual({
			error: {
				code: "SERVICE_UNAVAILABLE",
				message: "dependency unavailable (request id: synthetic-request)",
			},
		})
	})
})
