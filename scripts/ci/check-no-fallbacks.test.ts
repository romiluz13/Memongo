import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
	ALLOWLIST,
	type AllowlistEntry,
	checkSources,
	formatReport,
} from "./check-no-fallbacks.js"

let root: string

beforeEach(() => {
	root = mkdtempSync(path.join(tmpdir(), "no-fallback-check-"))
})
afterEach(() => {
	rmSync(root, { recursive: true, force: true })
})

function write(relative: string, content: string) {
	const full = path.join(root, relative)
	mkdirSync(path.dirname(full), { recursive: true })
	writeFileSync(full, content)
}

function rulesFor(
	files: Record<string, string>,
	allowlist: AllowlistEntry[] = [],
) {
	for (const [file, content] of Object.entries(files)) write(file, content)
	return checkSources({ root, allowlist }).violations.map(
		(violation) => violation.rule,
	)
}

const SRC = "packages/memory-engine/src"

describe("each rule fails on a seeded violation", () => {
	it("a $regex operator key", () => {
		expect(
			rulesFor({
				[`${SRC}/a.ts`]: 'export const f = { body: { $regex: "x" } }',
			}),
		).toContain("bson-regex-operator")
	})

	it("a quoted $regex or $options key", () => {
		expect(
			rulesFor({
				[`${SRC}/a.ts`]:
					'export const f = { body: { "$regex": "x", "$options": "i" } }',
			}),
		).toEqual(["bson-regex-operator", "bson-regex-operator"])
	})

	it("a RegExp literal as a filter value", () => {
		expect(
			rulesFor({
				[`${SRC}/a.ts`]: "export const f = { body: /needle/i }",
			}),
		).toContain("regexp-in-query")
	})

	it("a RegExp held in a variable and used as a filter value", () => {
		expect(
			rulesFor({
				[`${SRC}/a.ts`]: [
					"const pattern = new RegExp('needle', 'i')",
					"export const f = { body: pattern }",
				].join("\n"),
			}),
		).toContain("regexp-in-query")
	})

	it("a RegExp held in a variable and used as a shorthand filter value", () => {
		expect(
			rulesFor({
				[`${SRC}/a.ts`]: [
					"const body = new RegExp('needle', 'i')",
					"export const f = { body }",
				].join("\n"),
			}),
		).toContain("regexp-in-query")
	})

	it("a RegExp returned by a typed factory and used as a filter value", () => {
		expect(
			rulesFor({
				[`${SRC}/factory.ts`]:
					"export function contains(q: string): RegExp { return new RegExp('x') }",
				[`${SRC}/a.ts`]:
					"import { contains } from './factory.js'\nexport const f = (q: string) => ({ body: contains(q) })",
			}),
		).toContain("regexp-in-query")
	})

	it("a RegExp inside an $in array", () => {
		expect(
			rulesFor({
				[`${SRC}/a.ts`]: "export const f = { body: { $in: [/a/, /b/] } }",
			}),
		).toContain("regexp-in-query")
	})

	it("a RegExp assigned to a filter property", () => {
		expect(
			rulesFor({
				[`${SRC}/a.ts`]:
					"export function f(filter: Record<string, unknown>) { filter.body = /x/ }",
			}),
		).toContain("regexp-in-query")
	})

	it("a RegExp built at run time from a non-literal pattern", () => {
		expect(
			rulesFor({
				[`${SRC}/a.ts`]:
					"export const f = (q: string) => new RegExp(`\\\\b${q}\\\\b`, 'i').test('x')",
			}),
		).toContain("regexp-construction")
	})

	it("the $text operator as a key and as a string", () => {
		expect(
			rulesFor({
				[`${SRC}/a.ts`]:
					'export const a = { $text: { $search: "x" } }\nexport const b = "$text"',
			}).filter((rule) => rule === "text-operator"),
		).toHaveLength(2)
	})

	it.each([
		"MEMONGO_STRICT_SEARCH_INDEX_READY",
		"MEMONGO_REQUIRE_VECTOR",
		"MEMONGO_RERANK_MIN_SCORE",
		"community-mongot",
		"js-merge",
		"legacySearchFallback",
		"lexicalPrefilter",
		"reranking.voyageApiKey",
	])("the removed configuration %s in a string", (token) => {
		expect(
			rulesFor({
				[`${SRC}/a.ts`]: `export const t = ${JSON.stringify(token)}`,
			}),
		).toContain("removed-config")
	})

	it("a removed key used as an object property or identifier", () => {
		expect(
			rulesFor({
				[`${SRC}/a.ts`]:
					"export const c = { legacySearchFallback: true, lexicalPrefilter: false }",
			}),
		).toEqual(["removed-config", "removed-config"])
	})

	it("a removed reranking.* key under a reranking object", () => {
		expect(
			rulesFor({
				[`${SRC}/a.ts`]:
					"export const c = { reranking: { enabled: false, topN: 20, voyageApiKey: 'k' } }",
			}),
		).toEqual(["removed-config", "removed-config"])
	})

	it.each([
		"hybridSearchJSFallback",
		"mergeHybridResultsMongoDB",
		"classicTextSearch",
		"crossEncoderRerank",
	])("the JS fusion entry point %s", (name) => {
		expect(
			rulesFor({
				[`${SRC}/a.ts`]: `export function ${name}() { return [] }\n${name}()`,
			}).filter((rule) => rule === "js-fusion-entry-point"),
		).toHaveLength(2)
	})

	it("a removed token and $text in a workflow, a shell script and an env example", () => {
		const rules = rulesFor({
			".github/workflows/ci.yml":
				"      # serve from $text when the key is empty",
			"scripts/ci/run.sh": "echo MEMONGO_REQUIRE_VECTOR=1",
			".env.example": "MEMONGO_STRICT_SEARCH_INDEX_READY=1",
		})
		expect(rules).toEqual(
			expect.arrayContaining(["text-operator", "removed-config"]),
		)
		expect(rules).toHaveLength(3)
	})
})

describe("what the check leaves alone", () => {
	it("mentions in comments", () => {
		expect(
			rulesFor({
				[`${SRC}/a.ts`]: [
					"// no $text, no $regex, no js-merge, no legacySearchFallback",
					"/* hybridSearchJSFallback was removed */",
					"export const ok = 1",
				].join("\n"),
			}),
		).toEqual([])
	})

	it("test files, test helpers and documentation", () => {
		expect(
			rulesFor({
				[`${SRC}/a.test.ts`]: "export const t = { $text: 1, body: /x/ }",
				[`${SRC}/b.e2e.test.ts`]: 'export const t = "js-merge"',
				[`${SRC}/test-helpers/fake.ts`]: "export const t = { $regex: 'x' }",
				"docs/guide.md": "legacySearchFallback and $text were removed",
				"apps/docs/guide.mdx": "js-merge",
			}),
		).toEqual([])
	})

	it("a RegExp used for parsing, not placed in an object", () => {
		expect(
			rulesFor({
				[`${SRC}/a.ts`]: [
					"export const parse = (s: string) => /^(\\d+)-(\\d+)$/.exec(s)",
					"export const clean = (s: string) => ({ name: s.replace(/\\s+/g, ' ') })",
					"export const exact = () => new RegExp('^a+$').test('aaa')",
				].join("\n"),
			}),
		).toEqual([])
	})

	it("a clean tree passes", () => {
		write(`${SRC}/a.ts`, "export const ok = { body: 'plain', limit: 3 }")
		const result = checkSources({ root, allowlist: [] })
		expect(result.violations).toEqual([])
		expect(formatReport(result)).toContain("passed")
	})
})

describe("the allowlist", () => {
	const entry = (
		file: string,
		rules: AllowlistEntry["rules"],
	): AllowlistEntry => ({ file, rules, reason: "fixture" })

	it("suppresses only the listed rules in the listed file", () => {
		write(`${SRC}/parser.ts`, "export const t = { body: /x/, k: 'js-merge' }")
		write(`${SRC}/other.ts`, "export const t = { body: /x/ }")
		const result = checkSources({
			root,
			allowlist: [entry(`${SRC}/parser.ts`, ["regexp-in-query"])],
		})
		expect(result.violations.map((v) => `${v.file} ${v.rule}`)).toEqual([
			`${SRC}/other.ts regexp-in-query`,
			`${SRC}/parser.ts removed-config`,
		])
	})

	it("fails when a listed file does not exist, so a rename leaves no silent hole", () => {
		write(`${SRC}/a.ts`, "export const ok = 1")
		const result = checkSources({
			root,
			allowlist: [entry(`${SRC}/renamed-away.ts`, ["regexp-in-query"])],
		})
		expect(result.missingAllowlistFiles).toEqual([`${SRC}/renamed-away.ts`])
		expect(formatReport(result)).toContain("FAILED")
	})

	it("reports an entry that suppresses nothing as a note, not a failure", () => {
		write(`${SRC}/a.ts`, "export const ok = 1")
		const result = checkSources({
			root,
			allowlist: [entry(`${SRC}/a.ts`, ["regexp-in-query"])],
		})
		expect(result.unusedAllowlistEntries).toHaveLength(1)
		expect(result.violations).toEqual([])
		expect(formatReport(result)).toContain("passed")
	})

	it("gives every entry a reason", () => {
		for (const item of ALLOWLIST) {
			expect(item.reason.trim().length).toBeGreaterThan(20)
		}
	})
})

describe("this repository", () => {
	it("has no fallback: the check passes on the working tree", () => {
		const repo = path.resolve(
			path.dirname(fileURLToPath(import.meta.url)),
			"../..",
		)
		const result = checkSources({ root: repo })
		expect(formatReport(result)).toContain("passed")
		expect(result.violations).toEqual([])
		expect(result.missingAllowlistFiles).toEqual([])
	})
})
