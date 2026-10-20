import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import path from "node:path"
import type { MongoClient } from "mongodb"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { AdminDenied } from "./context.ts"
import {
	createLiveHarnessDeps,
	createLiveMongoAdmin,
	toAdminError,
} from "./harness-live.ts"
import type { HarnessDeps, OwnershipMarker } from "./harness.ts"
import { createSanitizer } from "./sanitize.ts"

type Call = { db: string; op: string; arg?: unknown }

function fakeClient(options: {
	collections?: string[]
	stored?: unknown
	failWith?: unknown
	operations?: unknown[]
}) {
	const calls: Call[] = []
	let closed = 0
	const fail = () => {
		if (options.failWith) throw options.failWith
	}
	const client = {
		db: (name: string) => ({
			listCollections: (_filter: unknown, listOptions: unknown) => ({
				toArray: async () => {
					calls.push({ db: name, op: "listCollections", arg: listOptions })
					return (options.collections ?? []).map((entry) => ({ name: entry }))
				},
			}),
			collection: (collection: string) => ({
				insertOne: async (doc: unknown) => {
					calls.push({ db: name, op: `insert:${collection}`, arg: doc })
				},
				findOne: async (filter: unknown) => {
					calls.push({ db: name, op: `find:${collection}`, arg: filter })
					return options.stored ?? null
				},
			}),
			dropDatabase: async () => {
				calls.push({ db: name, op: "dropDatabase" })
			},
			aggregate: (pipeline: unknown) => ({
				toArray: async () => {
					calls.push({ db: name, op: "aggregate", arg: pipeline })
					fail()
					return options.operations ?? []
				},
			}),
			command: async (command: unknown) => {
				calls.push({ db: name, op: "command", arg: command })
				fail()
				return { ok: 1 }
			},
		}),
		close: async () => {
			closed += 1
		},
	}
	return {
		admin: createLiveMongoAdmin(client as unknown as MongoClient),
		calls,
		closed: () => closed,
	}
}

const MARKER: OwnershipMarker = {
	runId: "run-1",
	database: "memongo_probe_0a1b2c3d",
	createdAt: "2026-10-20T00:00:00.000Z",
	tool: "overnight-probes",
}

describe("toAdminError", () => {
	it("maps authorization and unsupported-command failures to a denial that keeps the server text", () => {
		for (const error of [
			{
				code: 13,
				codeName: "Unauthorized",
				message: "not authorized on admin",
			},
			{ code: 8000, codeName: "AtlasError", message: "user is not allowed" },
			{ code: 115, message: "command not supported" },
			{ codeName: "CommandNotFound", message: "no such command" },
			{ message: "user is not allowed to do action [killOp] on [admin]" },
		]) {
			const mapped = toAdminError(error)
			expect(mapped).toBeInstanceOf(AdminDenied)
			expect((mapped as Error).message).toContain(error.message)
		}
	})

	it("leaves every other failure untouched", () => {
		const timeout = {
			code: 89,
			codeName: "NetworkTimeout",
			message: "timed out",
		}
		expect(toAdminError(timeout)).toBe(timeout)
		expect(toAdminError("plain")).toBe("plain")
		expect(toAdminError(undefined)).toBeUndefined()
	})
})

describe("live MongoDB administration", () => {
	it("treats a database as existing only when it holds collections, asking that database and nothing cluster-wide", async () => {
		const present = fakeClient({ collections: ["events"] })
		expect(await present.admin.databaseExists("memongo_probe_0a1b2c3d")).toBe(
			true,
		)
		expect(present.calls).toEqual([
			{
				db: "memongo_probe_0a1b2c3d",
				op: "listCollections",
				arg: { nameOnly: true },
			},
		])
		const absent = fakeClient({ collections: [] })
		expect(await absent.admin.databaseExists("memongo_probe_0a1b2c3d")).toBe(
			false,
		)
	})

	it("writes the ownership marker into the generated database and reads it back validated", async () => {
		const writer = fakeClient({})
		await writer.admin.writeMarker(MARKER.database, MARKER)
		expect(writer.calls[0]).toEqual({
			db: MARKER.database,
			op: "insert:__probe_owner",
			arg: { _id: "owner", ...MARKER },
		})
		const reader = fakeClient({ stored: { _id: "owner", ...MARKER } })
		expect(await reader.admin.readMarker(MARKER.database)).toEqual(MARKER)
		const foreign = fakeClient({ stored: { _id: "owner", runId: 1 } })
		expect(await foreign.admin.readMarker(MARKER.database)).toBeUndefined()
		const empty = fakeClient({})
		expect(await empty.admin.readMarker(MARKER.database)).toBeUndefined()
	})

	it("drops only a database whose name this tool generates", async () => {
		const live = fakeClient({})
		for (const name of [
			"admin",
			"memongo",
			"memongo_probe_XYZ",
			"memongo_probe_0a1b2c3d0",
			"",
		]) {
			await expect(live.admin.dropDatabase(name)).rejects.toThrow(
				/did not generate/,
			)
		}
		expect(live.calls).toEqual([])
		await live.admin.dropDatabase("memongo_probe_0a1b2c3d")
		expect(live.calls).toEqual([
			{ db: "memongo_probe_0a1b2c3d", op: "dropDatabase" },
		])
	})

	it("lists the current user's operations with a currentOp stage on the admin database", async () => {
		const live = fakeClient({ operations: [{ opid: 7, ns: "x.y" }] })
		expect(await live.admin.listOperations()).toEqual([{ opid: 7, ns: "x.y" }])
		expect(live.calls).toEqual([
			{
				db: "admin",
				op: "aggregate",
				arg: [{ $currentOp: { allUsers: false, idleConnections: false } }],
			},
		])
	})

	it("issues killOp for the given operation id on the admin database", async () => {
		const live = fakeClient({})
		await live.admin.killOperation(4242)
		expect(live.calls).toEqual([
			{ db: "admin", op: "command", arg: { killOp: 1, op: 4242 } },
		])
	})

	it("reports a server denial of listing or killing as AdminDenied", async () => {
		const denied = {
			code: 13,
			codeName: "Unauthorized",
			message: "not authorized on admin to execute command",
		}
		const live = fakeClient({ failWith: denied })
		await expect(live.admin.listOperations()).rejects.toBeInstanceOf(
			AdminDenied,
		)
		await expect(live.admin.killOperation(1)).rejects.toBeInstanceOf(
			AdminDenied,
		)
	})

	it("passes other administration failures through unchanged and closes the client on request", async () => {
		const boom = new Error("socket closed")
		const live = fakeClient({ failWith: boom })
		await expect(live.admin.killOperation(1)).rejects.toBe(boom)
		await live.admin.close()
		expect(live.closed()).toBe(1)
	})
})

describe("live process adapters", () => {
	let scratch = ""
	let deps: HarnessDeps
	const children: Array<{ kill(signal: "SIGKILL"): void }> = []

	beforeEach(() => {
		scratch = mkdtempSync(path.join(tmpdir(), "probe-live-test-"))
		process.env.PROBE_PARENT_SENTINEL = "parent-only"
		deps = createLiveHarnessDeps({
			mongo: fakeClient({}).admin,
			sanitizer: createSanitizer({ secretValues: [] }),
			note: () => {},
		})
	})

	afterEach(() => {
		for (const child of children.splice(0)) child.kill("SIGKILL")
		delete process.env.PROBE_PARENT_SENTINEL
		rmSync(scratch, { recursive: true, force: true })
	})

	it("allocates a loopback port and recognizes one that is taken", async () => {
		const port = await deps.allocatePort()
		expect(port).toBeGreaterThan(0)
		expect(await deps.isPortFree(port)).toBe(true)
		const holder = createServer()
		await new Promise<void>((resolve) =>
			holder.listen(port, "127.0.0.1", resolve),
		)
		try {
			expect(await deps.isPortFree(port)).toBe(false)
		} finally {
			await new Promise<void>((resolve) => holder.close(() => resolve()))
		}
	})

	it("writes a private configuration file and removes its directory", () => {
		const file = deps.withConfigFile("{}")
		expect(readFileSync(file.path, "utf8")).toBe("{}")
		expect(statSync(file.path).mode & 0o777).toBe(0o600)
		file.remove()
		expect(existsSync(file.path)).toBe(false)
		expect(existsSync(path.dirname(file.path))).toBe(false)
	})

	it("resolves relative build paths against the repository root", () => {
		expect(deps.fileExists("apps/api/package.json")).toBe(true)
		expect(deps.fileExists("apps/api/dist/does-not-exist.js")).toBe(false)
	})

	it("generates hex and uuid identities of the requested shape", () => {
		expect(deps.randomHex(8)).toMatch(/^[0-9a-f]{8}$/)
		expect(deps.randomHex(7)).toMatch(/^[0-9a-f]{7}$/)
		expect(deps.randomUuid()).toMatch(/^[0-9a-f-]{36}$/)
	})

	it("runs the entry with exactly the given environment, streams its lines, answers authenticated requests and stops on SIGTERM", async () => {
		const entry = path.join(scratch, "fake-api.mjs")
		writeFileSync(
			entry,
			[
				'import { createServer } from "node:http"',
				'console.log("listening-line")',
				'console.error("noise Bearer secret-token-value-123456")',
				"createServer((req, res) => {",
				'  res.setHeader("content-type", "application/json")',
				"  res.end(JSON.stringify({ auth: req.headers.authorization ?? null, keys: Object.keys(process.env) }))",
				'}).listen(Number(process.env.MEMONGO_API_PORT), "127.0.0.1")',
			].join("\n"),
		)
		const port = await deps.allocatePort()
		const child = deps.spawnApi(
			{ MEMONGO_API_PORT: String(port), PATH: process.env.PATH ?? "" },
			entry,
		)
		children.push(child)
		const lines: string[] = []
		const exits: Array<{ code: number | null; signal: string | null }> = []
		child.onLine((_stream, line) => lines.push(line))
		child.onExit((code, signal) => exits.push({ code, signal }))
		expect(child.pid).toBeGreaterThan(0)

		let body: { auth: string | null; keys: string[] } | undefined
		for (let attempt = 0; attempt < 100 && !body; attempt += 1) {
			try {
				const res = await deps.fetchJson(`http://127.0.0.1:${port}/`, {
					Authorization: "Bearer probe-key",
				})
				body = res.body as typeof body
			} catch {
				await deps.sleep(50)
			}
		}
		expect(body?.auth).toBe("Bearer probe-key")
		expect(body?.keys).toContain("MEMONGO_API_PORT")
		expect(body?.keys).not.toContain("PROBE_PARENT_SENTINEL")
		expect(body?.keys).not.toContain("HOME")
		expect(lines).toContain("listening-line")
		expect(lines.some((line) => line.includes("noise"))).toBe(true)

		child.kill("SIGTERM")
		for (let attempt = 0; attempt < 100 && !child.exited; attempt += 1) {
			await deps.sleep(50)
		}
		expect(child.exited).toBe(true)
		expect(exits).toEqual([{ code: null, signal: "SIGTERM" }])
	}, 20_000)

	it("reports an entry that cannot start as an exited process", async () => {
		const child = deps.spawnApi(
			{ PATH: process.env.PATH ?? "" },
			path.join(scratch, "missing.mjs"),
		)
		children.push(child)
		for (let attempt = 0; attempt < 100 && !child.exited; attempt += 1) {
			await deps.sleep(50)
		}
		expect(child.exited).toBe(true)
	}, 20_000)

	it("treats a non-JSON status body as an absent body", async () => {
		const entry = path.join(scratch, "text-api.mjs")
		writeFileSync(
			entry,
			[
				'import { createServer } from "node:http"',
				'createServer((_req, res) => res.end("not json")).listen(Number(process.env.MEMONGO_API_PORT), "127.0.0.1")',
			].join("\n"),
		)
		const port = await deps.allocatePort()
		const child = deps.spawnApi(
			{ MEMONGO_API_PORT: String(port), PATH: process.env.PATH ?? "" },
			entry,
		)
		children.push(child)
		let result: { status: number; body: unknown } | undefined
		for (let attempt = 0; attempt < 100 && !result; attempt += 1) {
			try {
				result = await deps.fetchJson(`http://127.0.0.1:${port}/`, {})
			} catch {
				await deps.sleep(50)
			}
		}
		expect(result).toEqual({ status: 200, body: undefined })
		child.kill("SIGKILL")
	}, 20_000)
})
