import { Hono } from "hono"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
	apiErrorJson,
	internalError,
	isDependencyUnavailableError,
} from "./errors.js"

afterEach(() => {
	vi.restoreAllMocks()
})

function capturedCalls(spy: { mock: { calls: unknown[][] } }): string {
	return spy.mock.calls
		.map((args) => args.map((a) => String(a)).join(" "))
		.join("\n")
}

describe("internalError (C-002: redacted server-side log, generic client body)", () => {
	it("logs redacted detail and returns a generic 500 envelope", async () => {
		const errorLog = vi.spyOn(console, "error").mockImplementation(() => {})
		const app = new Hono()
		app.get("/boom", (c) => {
			c.set("requestId", "req-c002")
			return internalError(
				c,
				new Error(
					[
						"driver failed: ",
						"mongodb://svc:",
						"dummy-cred-000@",
						"host.example.net:27017",
					].join(""),
				),
				"INTERNAL",
			)
		})

		const res = await app.request("/boom")
		expect(res.status).toBe(500)
		const body = (await res.json()) as {
			error: { code: string; message: string }
		}
		expect(body.error.code).toBe("INTERNAL")
		expect(body.error.message).toContain("req-c002")
		expect(body.error.message).not.toContain("dummy-cred-000")

		const logged = capturedCalls(errorLog)
		expect(logged).toContain("req-c002")
		expect(logged).toContain("INTERNAL")
		expect(logged).not.toContain("dummy-cred-000")
	})

	it("redacts credentials embedded in the logged stack", async () => {
		const errorLog = vi.spyOn(console, "error").mockImplementation(() => {})
		const app = new Hono()
		app.get("/boom", (c) => {
			c.set("requestId", "req-stack")
			const err = new Error("plain failure")
			err.stack = [
				"Error: plain failure\n    at foo (",
				"mongodb://svc:",
				"dummy-cred-000@",
				"h.example.net:27017/x.ts:1:1)",
			].join("")
			return internalError(c, err, "INTERNAL")
		})

		await app.request("/boom")

		const logged = capturedCalls(errorLog)
		expect(logged).toContain("plain failure")
		expect(logged).not.toContain("dummy-cred-000")
	})

	it("redacts non-Error values logged as strings", async () => {
		const errorLog = vi.spyOn(console, "error").mockImplementation(() => {})
		const app = new Hono()
		app.get("/boom", (c) => {
			c.set("requestId", "req-str")
			return internalError(
				c,
				["token=dum", "my-token-", "aaaaaaaaaaaaaaaaaa"].join(""),
				"INTERNAL",
			)
		})

		await app.request("/boom")

		const logged = capturedCalls(errorLog)
		expect(logged).not.toContain("dummy-token-aaaaaaaaaaaaaaaaaa")
	})

	it("maps dependency-unavailable failures to 503 SERVICE_UNAVAILABLE", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {})
		const app = new Hono()
		app.get("/boom", (c) => {
			c.set("requestId", "req-503")
			const err = Object.assign(new Error("selection failed"), {
				name: "MongoServerSelectionError",
			})
			return internalError(c, err, "INTERNAL")
		})

		const res = await app.request("/boom")
		expect(res.status).toBe(503)
		const body = (await res.json()) as {
			error: { code: string; message: string }
		}
		expect(body.error.code).toBe("SERVICE_UNAVAILABLE")
		expect(body.error.message).toContain("req-503")
	})
})

describe("isDependencyUnavailableError", () => {
	it("matches the closed set of driver network names", () => {
		expect(
			isDependencyUnavailableError(
				Object.assign(new Error("x"), { name: "MongoNetworkError" }),
			),
		).toBe(true)
		expect(
			isDependencyUnavailableError(
				Object.assign(new Error("x"), { name: "MongoTimeoutError" }),
			),
		).toBe(false)
	})

	it("walks a bounded cause chain", () => {
		const root = Object.assign(new Error("x"), {
			name: "MongoServerSelectionError",
		})
		const wrapped = new Error("wrapped", { cause: root })
		expect(isDependencyUnavailableError(wrapped)).toBe(true)
	})
})

describe("apiErrorJson (C-002 round 3: envelope boundary)", () => {
	it("redacts credentials in the message before it reaches the wire", () => {
		// Round-3 refutation finding: any route that forwards upstream text
		// into apiErrorJson could smuggle credentials past the envelope.
		const upstreamUri = [
			"mongodb://svc:",
			"dummy-cred-0000000",
			"@mongo.internal:27017/db",
		].join("")
		const envelope = apiErrorJson(
			"BAD_REQUEST",
			`rejected upstream uri ${upstreamUri}`,
		)
		expect(envelope.error.message).not.toContain("dummy-cred-0000000")
		expect(envelope.error.message).toContain(
			["mongodb:/", "/svc:***@", "mongo.internal:27017/db"].join(""),
		)
	})

	it("is idempotent and leaves ordinary route messages untouched", () => {
		const envelope = apiErrorJson(
			"BAD_REQUEST",
			"scope is required (request id: req-1)",
		)
		expect(envelope.error.message).toBe("scope is required (request id: req-1)")
		expect(envelope.error.code).toBe("BAD_REQUEST")
	})
})
