import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import type { Db } from "mongodb"
import { ModuleKind, ScriptTarget, transpileModule } from "typescript"
import { afterEach, describe, expect, it, vi } from "vitest"
import { getLaneCoverage } from "./mongodb-lane-coverage.js"
import { planRetrieval } from "./mongodb-retrieval-planner.js"
import { searchV2 } from "./mongodb-search-v2.js"

vi.mock("./mongodb-lane-coverage.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("./mongodb-lane-coverage.js")>()),
	getLaneCoverage: vi.fn(),
}))

afterEach(() => vi.restoreAllMocks())

function poisonedError(query: string) {
	const messageRead = vi.fn(() => {
		throw new Error("diagnostic message accessor was invoked")
	})
	const serialized = vi.fn(() => {
		throw new Error("diagnostic serialization was invoked")
	})
	const error = Object.defineProperties(new Error("hidden"), {
		message: { get: messageRead },
		code: { value: 2 },
		errorResponse: { value: { errmsg: query }, enumerable: true },
		toJSON: { value: serialized },
	})
	return { error, messageRead, serialized }
}

function poisonedCoverage(error: Error) {
	return {
		graph: {
			hasData: true,
			count: 1,
			lastUpdated: {
				getTime: () => {
					throw error
				},
			} as unknown as Date,
		},
	}
}

function assertStructural(logged: string, query: string) {
	expect(logged).toContain('"code":2')
	expect(logged).toContain(`"queryLength":${query.length}`)
	expect(logged).toContain(
		'"queryDigest":"' +
			createHash("sha256").update(query).digest("hex").slice(0, 12) +
			'"',
	)
	expect(logged).not.toContain(query)
	expect(logged).not.toContain("errorResponse")
	expect(logged).not.toContain("errmsg")
}

describe("query failure logs use structural metadata", () => {
	it("planner preserves the original error without reading or serializing it", () => {
		const query = "SEARCH-PRIVATE-NEEDLE recent changes"
		const failure = poisonedError(query)
		const logs = vi.spyOn(console, "error").mockImplementation(() => {})
		let caught: unknown
		try {
			planRetrieval(query, {
				availablePaths: new Set(["hybrid", "graph"]),
				laneCoverage: poisonedCoverage(failure.error),
			})
		} catch (err) {
			caught = err
		}
		expect(caught).toBe(failure.error)
		expect(failure.messageRead).not.toHaveBeenCalled()
		expect(failure.serialized).not.toHaveBeenCalled()
		expect(logs).toHaveBeenCalledTimes(1)
		assertStructural(logs.mock.calls.flat().join(" "), query)
	})

	it("search outer catch preserves the planner error without formatting it", async () => {
		const query = "SEARCH-PRIVATE-NEEDLE recent changes"
		const failure = poisonedError(query)
		vi.mocked(getLaneCoverage).mockResolvedValue({
			agentId: "agent-1",
			updatedAt: new Date(),
			lanes: poisonedCoverage(failure.error),
		})
		const logs = vi.spyOn(console, "error").mockImplementation(() => {})
		await expect(
			searchV2({} as Db, "memongo", query, "agent-1", {
				availablePaths: new Set(["hybrid", "graph"]),
			}),
		).rejects.toBe(failure.error)
		expect(failure.messageRead).not.toHaveBeenCalled()
		expect(failure.serialized).not.toHaveBeenCalled()
		const logged = logs.mock.calls.flat().join(" ")
		expect(logged).toContain("planRetrieval failed")
		expect(logged).toContain("searchV2 failed")
		assertStructural(logged, query)
	})

	it("coverage warnings keep their fallback without reading the failed error", async () => {
		const query = "SEARCH-PRIVATE-NEEDLE coverage miss"
		const failure = poisonedError(query)
		vi.mocked(getLaneCoverage).mockRejectedValue(failure.error)
		const warning = vi.spyOn(console, "warn").mockImplementation(() => {})
		vi.spyOn(console, "error").mockImplementation(() => {})
		await searchV2({} as Db, "memongo", query, "agent-1", {
			availablePaths: new Set(["raw-window"]),
		}).catch(() => {})
		expect(failure.messageRead).not.toHaveBeenCalled()
		expect(failure.serialized).not.toHaveBeenCalled()
		expect(warning).toHaveBeenCalledTimes(1)
		assertStructural(warning.mock.calls.flat().join(" "), query)
	})

	it("planner retains the error for million-character and dense uppercase echoes in a killed child", () => {
		const compile = (name: string) =>
			transpileModule(readFileSync(new URL(name, import.meta.url), "utf8"), {
				compilerOptions: {
					module: ModuleKind.CommonJS,
					target: ScriptTarget.ES2022,
				},
			}).outputText
		const diagnostics = compile("./query-diagnostics.ts")
		const planner = compile("./mongodb-retrieval-planner.ts")
		const script = `
			const baseRequire = require;
			const diagnostics = {};
			new Function("require", "exports", ${JSON.stringify(diagnostics)})(baseRequire, diagnostics);
			const planner = {};
			new Function("require", "exports", ${JSON.stringify(planner)})((name) => name === "./query-diagnostics.js" ? diagnostics : baseRequire(name), planner);
			const { strict: assert } = require("node:assert");
			const lines = [];
			console.error = (...args) => lines.push(args.join(" "));
			for (const query of ["recent changes " + "word ".repeat(200000).trim(), "recent changes " + "ab cd ".repeat(3334).trim()]) {
				const boom = new Error(query.toUpperCase());
				let caught;
				try { planner.planRetrieval(query, {
					availablePaths: new Set(["hybrid", "graph"]),
					laneCoverage: {graph: {hasData: true, count: 1, lastUpdated: {getTime() {throw boom;}}}}
				}); } catch (error) { caught = error; }
				assert.equal(caught === boom, true, "logging replaced the original error");
				assert.equal(lines.length, 1);
				assert.match(lines[0], /"queryDigest":"[0-9a-f]{12}"/);
				assert.equal(lines[0].includes(query.toUpperCase()), false);
				lines.length = 0;
			}
			process.stdout.write("completed");
		`
		const result = spawnSync(process.execPath, ["-e", script], {
			cwd: new URL("..", import.meta.url),
			encoding: "utf8",
			timeout: 5000,
			killSignal: "SIGKILL",
		})
		expect(result.error).toBeUndefined()
		expect(result.status, result.stderr).toBe(0)
		expect(result.stdout).toBe("completed")
	})
})
