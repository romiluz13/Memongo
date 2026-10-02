import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { ModuleKind, ScriptTarget, transpileModule } from "typescript"
import { describe, expect, it, vi } from "vitest"
import { planRetrieval } from "./mongodb-retrieval-planner.js"

describe("queryFailureMeta bounded window matching (F137)", () => {
	it("finishes long and dense echoes in a disposable process", () => {
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
			const queries = [50, 100, 350].map(n => Array.from({length: n}, (_, i) => "word" + String(i).padStart(3, "0")).join(" "));
			queries.push("ab cd ".repeat(175).trim());
			for (const query of queries) {
				const echo = query.toUpperCase().split(" ").join("  ,");
				const meta = queryFailureMeta(query, new Error("failure: " + echo + " / " + echo + " / " + echo));
				const alias = "[query:" + meta.queryDigest + "]";
				if (meta.error !== "failure: " + alias + " / " + alias + " / " + alias) process.exit(1);
			}
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

	it("preserves the original planner error when a long query is echoed", () => {
		const errorLine = vi.spyOn(console, "error").mockImplementation(() => {})
		const query =
			"recent changes " +
			Array.from(
				{ length: 100 },
				(_, i) => `word${String(i).padStart(3, "0")}`,
			).join(" ")
		const boom = new Error(query.toUpperCase().split(" ").join(", "))
		try {
			let caught: unknown
			try {
				planRetrieval(query, {
					availablePaths: new Set(["hybrid", "graph"]),
					laneCoverage: {
						graph: {
							hasData: true,
							count: 1,
							lastUpdated: {
								getTime: () => {
									throw boom
								},
							} as unknown as Date,
						},
					},
				})
			} catch (err) {
				caught = err
			}
			expect(caught).toBe(boom)
			expect(errorLine).toHaveBeenCalledTimes(1)
			const logged = errorLine.mock.calls
				.map((args) => args.join(" "))
				.join("\n")
			expect(logged).toMatch(/"queryDigest":"[0-9a-f]{12}"/)
			expect(logged).toContain(`"queryLength":${query.length}`)
			expect(logged).not.toMatch(/word\d+/i)
		} finally {
			errorLine.mockRestore()
		}
	})
})

// Frozen pre-F137 window builder: the oracle retains alternation ordering and lazy gaps.
function baselineWindowReplace(
	text: string,
	words: string[],
	alias: string,
): string {
	const ECHO_WINDOW_MIN_LENGTH = 8
	const ECHO_SINGLE_WORD_MIN_LENGTH = 6
	const ECHO_MAX_GAP = 32
	function escapeRegExp(text: string): string {
		return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
	}

	/**
	 * A query word as a regex fragment. Word-boundary guards are applied only
	 * on word-character edges so the word never matches inside a longer token
	 * ("how" must not match "however").
	 */
	function wordPattern(token: string): string {
		const escaped = escapeRegExp(token)
		const startsWord = /\w/.test(token[0] ?? "")
		const endsWord = /\w/.test(token[token.length - 1] ?? "")
		return `${startsWord ? "\\b" : ""}${escaped}${endsWord ? "\\b" : ""}`
	}

	/**
	 * Builds an alternation of every eligible window of consecutive query
	 * words, longest first. Each window tolerates up to ECHO_MAX_GAP chars of
	 * separator junk between words and matches case-insensitively, so
	 * case-folded, whitespace-mangled, split, truncated, and middle-fragment
	 * echoes all hit. Longest-first ordering makes the alternation consume the
	 * maximal span, so nested shorter windows never double-replace.
	 */
	function echoWindowRegex(words: string[]): RegExp | null {
		const windows: { source: string; text: string }[] = []
		for (let start = 0; start < words.length; start++) {
			for (let end = words.length; end > start; end--) {
				const run = words.slice(start, end)
				const text = run.join(" ")
				const eligible =
					run.length >= 2
						? text.length >= ECHO_WINDOW_MIN_LENGTH
						: text.length >= ECHO_SINGLE_WORD_MIN_LENGTH
				if (!eligible) continue
				windows.push({
					source: run.map(wordPattern).join(`[\\s\\S]{0,${ECHO_MAX_GAP}}?`),
					text,
				})
			}
		}
		if (windows.length === 0) return null
		const sources = [...new Set(windows)]
			.sort((a, b) => b.text.length - a.text.length)
			.map((window) => window.source)
		return new RegExp(sources.join("|"), "gi")
	}

	const regex = echoWindowRegex(words)
	return regex ? text.replace(regex, alias) : text
}

describe("query window scanner matches the previous replacement language", () => {
	const source = readFileSync(
		new URL("./query-diagnostics.ts", import.meta.url),
		"utf8",
	)
	const compiled = transpileModule(
		source + "\nexport { redactQueryWindows };",
		{
			compilerOptions: {
				module: ModuleKind.CommonJS,
				target: ScriptTarget.ES2022,
			},
		},
	).outputText
	const exposed = {} as {
		redactQueryWindows: (text: string, words: string[], alias: string) => string
	}
	new Function("require", "exports", compiled)(
		createRequire(import.meta.url),
		exposed,
	)

	it.each([
		{ words: ["alpha", "beta"], text: "alpha" + "!".repeat(32) + "beta" },
		{ words: ["alpha", "beta"], text: "alpha" + "!".repeat(33) + "beta" },
		{ words: ["alpha", "beta", "gamma"], text: "alpha beta beta gamma" },
		{
			words: ["alpha", "beta", "gamma"],
			text: "alpha beta" + "!".repeat(29) + "beta gamma",
		},
		{
			words: ["alpha", "beta", "alpha", "gamma"],
			text: "ALPHA beta alpha GAMMA",
		},
		{ words: ["--", "--", "--", "--"], text: "-----------" },
		{
			words: ["straße", "héllo", "--"],
			text: "STRASSE héLLo -- straße HÉLLO --",
		},
		{ words: ["ab", "cd"], text: "ab cd" },
		{ words: ["alpha", "bb", "--", "alpha", "cc"], text: "alpha bb cc" },
		{ words: ["alpha", "bb", "cc", "alpha"], text: "alpha bb cc alpha" },
		{ words: ["abcde", "ab"], text: "abcde ab" },
	])("preserves window ordering and gap boundaries: $words / $text", ({
		words,
		text,
	}) => {
		expect(exposed.redactQueryWindows(text, words, "[Q]")).toBe(
			baselineWindowReplace(text, words, "[Q]"),
		)
	})

	it("matches a seeded oracle over case, punctuation, overlaps and Unicode", () => {
		let seed = 20261001
		const random = () => {
			seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
			return seed / 0x100000000
		}
		const vocabulary = [
			"alpha",
			"Beta",
			"gamma",
			"ab",
			"a-b",
			"x.y",
			"delta9",
			"AB",
			"--",
			"q",
			"token",
			"Alpha",
			"héllo",
			"straße",
			"STRASSE",
			"é",
			"K",
			"ſ",
			"😀",
			"--a--",
		]
		const pick = <T>(items: T[]): T =>
			items[Math.floor(random() * items.length)]
		let matched = 0
		for (let sample = 0; sample < 5000; sample++) {
			const words = Array.from({ length: 1 + Math.floor(random() * 6) }, () =>
				pick(vocabulary),
			)
			let text = ""
			const parts = 2 + Math.floor(random() * 8)
			for (let part = 0; part < parts; part++) {
				text +=
					random() < 0.6
						? pick(words).replace(/./g, (ch) =>
								random() < 0.2 ? ch.toUpperCase() : ch,
							)
						: pick(vocabulary)
				text += pick([
					"",
					" ",
					"  ",
					", ",
					"\n",
					"-",
					".",
					"x".repeat(Math.floor(random() * 40)),
					"_",
				])
			}
			const expected = baselineWindowReplace(text, words, "[Q]")
			if (expected !== text) matched++
			expect(
				exposed.redactQueryWindows(text, words, "[Q]"),
				JSON.stringify({ sample, words, text }),
			).toBe(expected)
		}
		expect(matched).toBeGreaterThan(500)
	})
})
