import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { afterEach, describe, expect, it, vi } from "vitest"

const hoisted = vi.hoisted(() => ({ clients: [] as unknown[] }))

vi.mock("@memongo/client", () => {
	class MemongoClientError extends Error {
		status: number
		body: string
		constructor(status: number, body: string) {
			super(`HTTP ${status}: ${body}`)
			this.status = status
			this.body = body
		}
	}
	class MemongoClient {
		status = vi.fn(async () => ({ backend: "mock", provider: "mock" }))
		profile = vi.fn(async () => null)
		searchDetailed = vi.fn(async () => ({ results: [] }))
		writeStructured = vi.fn(async () => ({ id: "m-1", upserted: true }))
		writeEvent = vi.fn(async () => ({ eventId: "e-1" }))
		probeVector = vi.fn(async () => ({ ok: true }))
		constructor() {
			hoisted.clients.push(this)
		}
	}
	return { MemongoClient, MemongoClientError }
})

import memongoExtension, {
	isLoopbackApiUrl,
	resolveApiKey,
} from "./extensions/index.js"

describe("isLoopbackApiUrl", () => {
	it("treats 127.0.0.1 as loopback", () => {
		expect(isLoopbackApiUrl("http://127.0.0.1:3847")).toBe(true)
	})
	it("treats localhost as loopback", () => {
		expect(isLoopbackApiUrl("http://localhost:3847")).toBe(true)
	})
	it("treats ::1 as loopback", () => {
		expect(isLoopbackApiUrl("http://[::1]:3847")).toBe(true)
	})
	it("treats a remote host as non-loopback", () => {
		expect(isLoopbackApiUrl("https://memongo.example.com")).toBe(false)
	})
	it("treats an unparseable URL as non-loopback", () => {
		expect(isLoopbackApiUrl("not-a-url")).toBe(false)
	})
})

describe("resolveApiKey", () => {
	it("loopback + no explicit key -> uses baked local-dev default", () => {
		expect(resolveApiKey(undefined, "http://127.0.0.1:3847")).toBe(
			"local-dev-secret",
		)
	})
	it("loopback + explicit key -> explicit key wins", () => {
		expect(resolveApiKey("my-real-key", "http://127.0.0.1:3847")).toBe(
			"my-real-key",
		)
	})
	it("non-loopback + no explicit key -> throws naming MEMONGO_API_KEY", () => {
		expect(() =>
			resolveApiKey(undefined, "https://memongo.example.com"),
		).toThrow(/MEMONGO_API_KEY/)
	})
	it("non-loopback + explicit key -> works", () => {
		expect(resolveApiKey("my-real-key", "https://memongo.example.com")).toBe(
			"my-real-key",
		)
	})
})

// ---------------------------------------------------------------------------
// P2.3 scope identity unification: the extension's save path and search path
// must resolve the SAME scope by default, so memongo can always find its own
// default-scope saves. One knob: MEMONGO_PI_MEMORY_SCOPE (default "global").
// ---------------------------------------------------------------------------

type ToolExecute = (
	id: string,
	params: never,
	signal: unknown,
	onUpdate: unknown,
	ctx: unknown,
) => Promise<unknown>

function createFakePi() {
	const tools = new Map<string, { execute: ToolExecute }>()
	const pi = {
		on: () => {},
		registerTool: (def: { name: string; execute: ToolExecute }) => {
			tools.set(def.name, def)
		},
		registerCommand: () => {},
	} as unknown as ExtensionAPI
	return { pi, tools }
}

async function saveAndSearchScopes(env: Record<string, string | undefined>) {
	const saved: Record<string, string | undefined> = {}
	for (const key of ["MEMONGO_PI_MEMORY_SCOPE"]) {
		saved[key] = process.env[key]
		if (env[key] === undefined) delete process.env[key]
		else process.env[key] = env[key]
	}
	try {
		hoisted.clients.length = 0
		const { pi, tools } = createFakePi()
		await memongoExtension(pi)
		const client = hoisted.clients[0] as {
			writeStructured: ReturnType<typeof vi.fn>
			searchDetailed: ReturnType<typeof vi.fn>
		}
		const ctx = { cwd: "/tmp" }
		await tools
			.get("memongo_save")
			?.execute(
				"1",
				{ type: "fact", key: "k", value: "v" } as never,
				undefined,
				undefined,
				ctx,
			)
		await tools
			.get("memongo_search")
			?.execute("2", { query: "k" } as never, undefined, undefined, ctx)
		return {
			saveScope: client.writeStructured.mock.calls[0]?.[0]?.entry?.scope as
				| string
				| undefined,
			searchScope: client.searchDetailed.mock.calls[0]?.[0]?.scope as
				| string
				| undefined,
		}
	} finally {
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[key]
			else process.env[key] = value
		}
	}
}

describe("P2.3 save/search scope self-consistency", () => {
	afterEach(() => {
		vi.restoreAllMocks()
	})

	it("save and search hit the same scope by default (global)", async () => {
		const { saveScope, searchScope } = await saveAndSearchScopes({})
		expect(saveScope).toBe("global")
		expect(searchScope).toBe("global")
	})

	it("MEMONGO_PI_MEMORY_SCOPE drives BOTH directions", async () => {
		const { saveScope, searchScope } = await saveAndSearchScopes({
			MEMONGO_PI_MEMORY_SCOPE: "workspace",
		})
		expect(saveScope).toBe("workspace")
		expect(searchScope).toBe("workspace")
	})
})
