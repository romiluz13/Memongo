import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { ScriptTarget, transpileModule } from "typescript"
import { describe, expect, it } from "vitest"
import { matchPatterns } from "./mongodb-consolidator.js"

const source = readFileSync(
	new URL("./mongodb-consolidator.ts", import.meta.url),
	"utf8",
)
const start = source.indexOf("type CategoryPattern = {")
const end = source.indexOf("// Similarity threshold constants")
if (start < 0 || end <= start) throw new Error("matcher source not found")
const compiled = transpileModule(
	source.slice(start, end).replace("export function", "function"),
	{ compilerOptions: { target: ScriptTarget.ES2022 } },
).outputText
const patterns = new Function(`${compiled}\nreturn CATEGORY_PATTERNS;`)() as {
	type: string
	pattern: RegExp
}[]
const currentTodo = patterns.find(({ type }) => type === "todo")?.pattern
if (!currentTodo) throw new Error("todo pattern not found")
const baselineTodo =
	/\b(?:TODO|FIXME|need\s+to|have\s+to|must|should)\s*:?\s+(.+)/i

function baselineMatch(body: string) {
	for (const { type, pattern } of patterns) {
		const match = (type === "todo" ? baselineTodo : pattern).exec(body)
		if (match?.[1]) {
			return { type, key: match[1].trim().slice(0, 120), value: body }
		}
	}
	return null
}

describe("todo extraction whitespace backtracking (F170)", () => {
	it("finishes large line-terminator near misses in a disposable process", () => {
		const probe = `
			for (const body of ["must" + "\\n".repeat(200000), "should " + "\\u2028".repeat(200000)]) {
				if (matchPatterns(body) !== null) process.exit(1);
			}
			console.log("completed");
		`
		const result = spawnSync(process.execPath, ["-e", compiled + probe], {
			encoding: "utf8",
			timeout: 5000,
			killSignal: "SIGKILL",
		})
		expect(result.error).toBeUndefined()
		expect(result.status, result.stderr).toBe(0)
		expect(result.stdout.trim()).toBe("completed")
	})

	it.each([
		["TODO: fix it", "todo", "fix it"],
		["must :x", "todo", ":x"],
		["should\n\nfoo", "todo", "foo"],
		["must\n\n\n ", "todo", ""],
		["TODO :\r\n", "todo", ":"],
		["need \t to deploy", "todo", "deploy"],
		["have\n to: ship", "todo", "ship"],
		["mustard x", null, null],
		["I decided must x", "decision", "must x"],
		["must TODO: first\nshould second", "todo", "TODO: first"],
		["TODO", null, null],
		["TODO:fix", null, null],
	] as const)("preserves extraction for %j", (body, type, key) => {
		expect(matchPatterns(body)).toEqual(
			type === null ? null : { type, key, value: body },
		)
	})

	it.each([
		0x0009, 0x000a, 0x000b, 0x000c, 0x000d, 0x0020, 0x00a0, 0x1680, 0x2000,
		0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009,
		0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff,
	])("preserves whitespace code point %i", (codePoint) => {
		const space = String.fromCodePoint(codePoint)
		for (const body of [
			`TODO${space}: ${space}fix`,
			`must${space}${space}fix`,
			`should${space}:`,
			`TODO${space}`,
			`TODO${space}:\r\n`,
		]) {
			expect(matchPatterns(body), body).toEqual(baselineMatch(body))
		}
	})

	it("preserves match positions, captures and output against a seeded baseline", () => {
		const tokens = [
			"TODO",
			"fixme",
			"need",
			"have",
			"to",
			"must",
			"should",
			"MuSt",
			"mustard",
			"I decided",
			":",
			" :",
			": ",
			" ",
			"\t",
			"\n",
			"\r",
			"\r\n",
			"\u2028",
			"\u2029",
			"\u00a0",
			"\v",
			"\f",
			"\ufeff",
			"\u3000",
			"x",
			".",
			"-",
			"😀",
			"é",
		]
		let seed = 23
		const random = (limit: number) => {
			seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
			return seed % limit
		}
		let matched = 0
		for (let i = 0; i < 10000; i++) {
			const body = Array.from(
				{ length: 1 + random(12) },
				() => tokens[random(tokens.length)],
			).join("")
			const before = baselineTodo.exec(body)
			const after = currentTodo.exec(body)
			if (before) matched++
			expect(after && [after.index, after[0], after[1]], body).toEqual(
				before && [before.index, before[0], before[1]],
			)
			expect(matchPatterns(body), body).toEqual(baselineMatch(body))
		}
		expect(matched).toBeGreaterThan(100)
	})
})
