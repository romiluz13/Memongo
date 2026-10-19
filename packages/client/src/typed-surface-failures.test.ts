import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import ts from "typescript"
import { afterEach, describe, expect, it, vi } from "vitest"
import { MemongoClient, MemongoClientError } from "./client.js"

// M2 T10 (ticket #119): the SDK carries the typed erasure refusal on readFile,
// the per-section state failure rows, and no longer offers js-merge.

function stubResponse(status: number, body: unknown) {
	vi.stubGlobal(
		"fetch",
		vi.fn(
			async () =>
				new Response(JSON.stringify(body), {
					status,
					headers: { "Content-Type": "application/json" },
				}),
		),
	)
}

const erasureBody = {
	error: {
		code: "ERASURE_IN_PROGRESS",
		message: "read refused: an erasure is in progress for this agent",
	},
}

const options = { baseUrl: "http://127.0.0.1:3100", maxRetries: 0 }

afterEach(() => vi.unstubAllGlobals())

describe("readFile erasure refusal (G2-69)", () => {
	it("rejects with a typed 409 error instead of an empty read", async () => {
		stubResponse(409, erasureBody)

		await expect(
			new MemongoClient(options).readFile({ relPath: "notes/a.md" }),
		).rejects.toMatchObject({
			name: "MemongoClientError",
			status: 409,
			code: "ERASURE_IN_PROGRESS",
		})
	})

	it("silent mode keeps the code on the degradation marker", async () => {
		stubResponse(409, erasureBody)

		await expect(
			new MemongoClient({ ...options, silent: true }).readFile({
				relPath: "notes/a.md",
			}),
		).resolves.toEqual({
			text: "",
			path: "notes/a.md",
			degradation: {
				kind: "unavailable",
				status: 409,
				code: "ERASURE_IN_PROGRESS",
			},
		})
	})

	it("parses the code from the 409 body", () => {
		const err = new MemongoClientError(409, JSON.stringify(erasureBody))

		expect(err.code).toBe("ERASURE_IN_PROGRESS")
	})
})

describe("state failure rows (G3-75)", () => {
	it("passes the partial flag and the failure rows through", async () => {
		const state = {
			bundle: { sections: [] },
			partial: true,
			failures: [
				{ section: "profile", reason: "dependency-unavailable" },
				{ section: "blocks", reason: "erasure-in-progress" },
			],
		}
		stubResponse(200, state)

		const out = await new MemongoClient(options).state({ agentId: "a" })

		expect(out.failures).toEqual(state.failures)
		expect(out.partial).toBe(true)
		expect(out.profile).toBeUndefined()
	})
})

describe("js-merge is not an accepted fusionMethod (X-05)", () => {
	const dir = dirname(fileURLToPath(import.meta.url))
	const probe = join(dir, "fusion-method-probe.ts")

	function diagnose(source: string): string[] {
		const host = ts.createCompilerHost({})
		const readFile = host.readFile.bind(host)
		const fileExists = host.fileExists.bind(host)
		const getSourceFile = host.getSourceFile.bind(host)
		host.fileExists = (name) => name === probe || fileExists(name)
		host.readFile = (name) => (name === probe ? source : readFile(name))
		host.getSourceFile = (name, languageVersion, onError, shouldCreate) =>
			name === probe
				? ts.createSourceFile(name, source, languageVersion)
				: getSourceFile(name, languageVersion, onError, shouldCreate)
		const program = ts.createProgram(
			[probe],
			{
				target: ts.ScriptTarget.ES2023,
				module: ts.ModuleKind.NodeNext,
				moduleResolution: ts.ModuleResolutionKind.NodeNext,
				strict: true,
				skipLibCheck: true,
				noEmit: true,
			},
			host,
		)
		return ts
			.getPreEmitDiagnostics(program, program.getSourceFile(probe))
			.map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"))
	}

	it("accepts the native modes on the search config and on searchKB", () => {
		expect(
			diagnose(`
import type { SearchConfig } from "./types.js"
import type { MemongoClient } from "./client.js"
export const a: SearchConfig = { fusionMethod: "scoreFusion" }
export const b: SearchConfig = { fusionMethod: "rankFusion" }
type KB = Parameters<MemongoClient["searchKB"]>[0]
export const c: KB = { query: "q", fusionMethod: "rankFusion" }
`),
		).toEqual([])
	})

	it("rejects js-merge on the search config, searchKB and the resolved config", () => {
		const messages = diagnose(`
import type { SearchConfig } from "./types.js"
import type { MemongoClient, MemongoSearchDetailedMetadata } from "./client.js"
export const a: SearchConfig = { fusionMethod: "js-merge" }
type KB = Parameters<MemongoClient["searchKB"]>[0]
export const b: KB = { query: "q", fusionMethod: "js-merge" }
type Resolved = NonNullable<MemongoSearchDetailedMetadata["resolvedSearchConfig"]>
export const c: Resolved["fusionMethod"] = "js-merge"
`)

		expect(messages).toHaveLength(3)
		for (const message of messages) expect(message).toContain("js-merge")
	})
})
