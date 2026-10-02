import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { ModuleKind, ScriptTarget, transpileModule } from "typescript"
import { createHash } from "node:crypto"
import type { Db } from "mongodb"
import { MongoServerError } from "mongodb"
import { afterEach, describe, expect, it, vi } from "vitest"
import { buildContextBundle } from "./mongodb-context-bundle.js"
import { buildDiscoveryProjection } from "./mongodb-discovery-projections.js"

import { settledFailureMeta } from "./query-diagnostics.js"

const QUERY = "violet launch detail SECRETTAIL"

function failingDb(error: unknown): Db {
	const terminal = new Set([
		"toArray",
		"next",
		"findOne",
		"countDocuments",
		"distinct",
		"estimatedDocumentCount",
	])
	const chain: object = new Proxy(
		{},
		{
			get: (_target, key) =>
				key === "then"
					? undefined
					: terminal.has(String(key))
						? async () => {
								throw error
							}
						: () => chain,
		},
	)
	return { collection: () => chain } as unknown as Db
}

function captureLogs(): string[] {
	const lines: string[] = []
	for (const method of ["log", "info", "warn", "error", "debug"] as const) {
		vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
			lines.push(args.join(" "))
		})
	}
	return lines
}

function assertPrivate(lines: string[], privateText: string) {
	expect(lines.length).toBeGreaterThan(0)
	const output = lines.join("\n")
	for (const forbidden of [
		privateText,
		"SECRETTAIL",
		"errorResponse",
		"errmsg",
		"BadValue",
	]) {
		expect(output).not.toContain(forbidden)
	}
}

afterEach(() => vi.restoreAllMocks())

describe("settled diagnostic privacy with real modules and driver errors", () => {
	it("keeps bundle response semantics while protecting all three settled helpers", async () => {
		const error = new MongoServerError({
			ok: 0,
			errmsg: `bad regex ${QUERY}`,
			code: 2,
			codeName: "BadValue",
		})
		const lines = captureLogs()
		const bundle = await buildContextBundle({
			db: failingDb(error),
			prefix: "test_",
			agentId: "agent-1",
			scope: "agent",
			scopeRef: "agent:agent-1",
			request: {
				query: QUERY,
				discoveryKind: "topic-brief",
				includeDiscoveryProjection: true,
			},
			search: async () => {
				throw error
			},
		})
		assertPrivate(lines, QUERY)
		expect(bundle.query).toBe(QUERY)
		expect(bundle.metadata.partial).toBe(true)
		expect(bundle.metadata.pathsExecuted).toEqual([
			"active-slate",
			"discovery-projection",
		])
		const warnings = lines.filter((line) => line.includes(" query failed"))
		expect(warnings).toHaveLength(10)
		for (const subsystem of [
			"buildContextBundle:",
			"buildDiscoveryProjection:",
			"hydrateActiveSlate:",
		]) {
			const entries = warnings.filter((line) => line.includes(subsystem))
			expect(entries.length).toBeGreaterThan(0)
			for (const line of entries) expect(line).toContain('"code":2')
		}
		const digest = createHash("sha256").update(QUERY).digest("hex").slice(0, 12)
		for (const label of [
			"query-evidence",
			"episode-summary",
			"topic-brief.episodes",
			"topic-brief.structured",
			"topic-brief.procedures",
		]) {
			const line = warnings.find((line) =>
				line.includes(`${label} query failed`),
			)
			expect(line).toContain(`"queryLength":${QUERY.length}`)
			expect(line).toContain(`"queryDigest":"${digest}"`)
		}
		for (const line of warnings.filter(
			(line) =>
				line.includes("hydrateActiveSlate:") ||
				line.includes("recent-events query failed"),
		)) {
			expect(line).not.toContain("queryDigest")
			expect(line).not.toContain("queryLength")
		}
	})

	it("logs an arbitrary search closure without serializing string identifiers", async () => {
		const error = Object.assign(new Error(QUERY), {
			code: `SECRET-${QUERY}`,
			codeName: QUERY,
			name: QUERY,
		})
		const lines = captureLogs()
		await buildContextBundle({
			db: failingDb(new Error("unavailable")),
			prefix: "test_",
			agentId: "agent-1",
			scope: "agent",
			scopeRef: "agent:agent-1",
			request: { query: QUERY },
			search: async () => {
				throw error
			},
		})
		assertPrivate(lines, QUERY)
		const line = lines.find((line) =>
			line.includes("query-evidence query failed"),
		)
		expect(line).toContain("queryDigest")
		expect(line).not.toContain('"code"')
	})

	it.each([
		"entity-brief",
		"topic-brief",
		"what-changed",
		"contradiction-report",
	] as const)("protects direct %s discovery failures", async (kind) => {
		const error = new MongoServerError({
			errmsg: `bad ${QUERY}`,
			code: 2,
			codeName: "BadValue",
		})
		const lines = captureLogs()
		const projection = await buildDiscoveryProjection({
			db: failingDb(error),
			prefix: "test_",
			agentId: "agent-1",
			scope: "agent",
			scopeRef: "agent:agent-1",
			kind,
			query: QUERY,
		})
		assertPrivate(lines, QUERY)
		expect(projection.query).toBe(QUERY)
		expect(projection.metadata.partial).toBe(true)
		for (const line of lines.filter((line) => line.includes(" query failed"))) {
			expect(line).toContain('"code":2')
			expect(line).toContain('"queryDigest":')
		}
	})

	it("keeps query-free discovery warnings structural", async () => {
		const lines = captureLogs()
		const projection = await buildDiscoveryProjection({
			db: failingDb(new MongoServerError({ errmsg: QUERY, code: 2 })),
			prefix: "test_",
			agentId: "agent-1",
			scope: "agent",
			scopeRef: "agent:agent-1",
			kind: "what-changed",
		})
		assertPrivate(lines, QUERY)
		expect(projection.query).toBeUndefined()
		for (const line of lines.filter((line) => line.includes(" query failed"))) {
			expect(line).toContain('"code":2')
			expect(line).not.toContain("queryDigest")
		}
	})
})

describe("settled failure structural metadata", () => {
	it.each([
		NaN,
		Infinity,
		-Infinity,
		"2",
		"SECRETTAIL",
	])("omits unsafe code %s", (code) => {
		expect(settledFailureMeta({ code })).toEqual({})
	})

	it.each([
		null,
		undefined,
		"SECRETTAIL",
		2,
		true,
	])("omits thrown primitive %s", (error) => {
		expect(settledFailureMeta(error)).toEqual({})
	})

	it("reads only own numeric data without invoking accessors or serialization", () => {
		const code = vi.fn(() => {
			throw new Error("getter")
		})
		const toJSON = vi.fn(() => {
			throw new Error("serializer")
		})
		const error = Object.defineProperty({ toJSON }, "code", { get: code })
		expect(settledFailureMeta(error, QUERY)).toEqual({
			queryLength: QUERY.length,
			queryDigest: createHash("sha256")
				.update(QUERY)
				.digest("hex")
				.slice(0, 12),
		})
		expect(code).not.toHaveBeenCalled()
		expect(toJSON).not.toHaveBeenCalled()
		expect(settledFailureMeta(Object.create({ code: 2 }))).toEqual({})
		expect(settledFailureMeta({ code: 0 })).toEqual({ code: 0 })
	})

	it("preserves degradation when a search closure throws a string", async () => {
		const lines = captureLogs()
		const bundle = await buildContextBundle({
			db: failingDb(new Error("unavailable")),
			prefix: "test_",
			agentId: "agent-1",
			scope: "agent",
			scopeRef: "agent:agent-1",
			request: { query: QUERY },
			search: async () => {
				throw QUERY
			},
		})
		assertPrivate(lines, QUERY)
		expect(bundle.metadata.partial).toBe(true)
		expect(
			lines.find((line) => line.includes("query-evidence query failed")),
		).toContain("queryDigest")
	})

	it("preserves the full bundle query on an over-length failed request", async () => {
		const query = "word ".repeat(200000).trim()
		const error = new MongoServerError({ errmsg: query.toUpperCase(), code: 2 })
		const lines = captureLogs()
		const bundle = await buildContextBundle({
			db: failingDb(error),
			prefix: "test_",
			agentId: "agent-1",
			scope: "agent",
			scopeRef: "agent:agent-1",
			request: {
				query,
				includeDiscoveryProjection: true,
				discoveryKind: "topic-brief",
			},
			search: async () => {
				throw error
			},
		})
		assertPrivate(lines, query.toUpperCase())
		expect(bundle.query).toBe(query)
		expect(bundle.metadata.partial).toBe(true)
		const digest = createHash("sha256").update(query).digest("hex").slice(0, 12)
		expect(
			lines.find((line) => line.includes("query-evidence query failed")),
		).toContain(`"queryDigest":"${digest}"`)
	})

	it("handles a million-character query in a bounded disposable process", () => {
		const source = readFileSync(
			new URL("./query-diagnostics.ts", import.meta.url),
			"utf8",
		)
		const compiled = transpileModule(source, {
			compilerOptions: {
				module: ModuleKind.ESNext,
				target: ScriptTarget.ES2022,
			},
		}).outputText
		const probe = `
			const query = "word ".repeat(200000).trim();
			const error = Object.assign(new Error(query.toUpperCase()), {code:2, codeName:query, errorResponse:{errmsg:query}});
			const meta = settledFailureMeta(error, query);
			const expected = {code:2, queryLength:query.length, queryDigest:createHash("sha256").update(query).digest("hex").slice(0,12)};
			if(JSON.stringify(meta)!==JSON.stringify(expected))process.exit(1);
			console.log("completed");
		`
		const result = spawnSync(
			process.execPath,
			["--input-type=module", "-e", compiled + probe],
			{
				cwd: new URL("..", import.meta.url),
				encoding: "utf8",
				timeout: 5000,
				killSignal: "SIGKILL",
			},
		)
		expect(result.error).toBeUndefined()
		expect(result.status, result.stderr).toBe(0)
		expect(result.stdout.trim()).toBe("completed")
	})
})
