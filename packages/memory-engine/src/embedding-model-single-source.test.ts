import { describe, expect, it } from "vitest"
import { readdirSync, readFileSync } from "node:fs"
import { basename, join, relative } from "node:path"
import { fileURLToPath } from "node:url"

// C-007 (EL-002 F2): INDEX_AUTOEMBED_MODEL (mongodb-schema-search-definitions)
// is the single configuration point for the autoEmbed embedding model. Every
// query-side default and $vectorSearch stage derives from it; nothing may
// reintroduce a bare "voyage-4-large" fallback literal that could silently
// diverge when the index model changes.
//
// Allowed survivors of the literal (registry forms, not defaults):
// - mongodb-schema-search-definitions.ts — the source of truth itself
// - backend-config.ts — the KNOWN_MODEL_DIMENSIONS object key and the
//   resolveQueryEmbeddingModel allow-list comparison / error text
// - tests and test-helpers, which pin behavior with the literal

const SRC_DIR = fileURLToPath(new URL(".", import.meta.url))

const FORBIDDEN_FALLBACK_PATTERNS: ReadonlyArray<{
	pattern: RegExp
	form: string
}> = [
	{
		pattern: /\?\?\s*"voyage-4-large"/,
		form: 'nullish default `?? "voyage-4-large"`',
	},
	{
		pattern: /model:\s*"voyage-4-large"/,
		form: 'stage property `model: "voyage-4-large"`',
	},
	{
		// Any assignment or declaration of the bare literal, typed or not.
		// The (?<![=!]) lookbehind excludes comparison operators (the
		// resolveQueryEmbeddingModel allow-list `value === "voyage-4-large"`),
		// while still catching the round-1 refutation gap: a typed const
		// (`const X: SomeType = "voyage-4-large"`) evades a naive
		// `const \w+ =` pattern but not this one.
		pattern: /(?<![=!])=\s*"voyage-4-large"/,
		form: 'assignment or declaration `= "voyage-4-large"`',
	},
]

const SOURCE_OF_TRUTH_FILE = "mongodb-schema-search-definitions.ts"
const SKIPPED_DIRS = new Set(["dist", "node_modules", "test-helpers"])

function listProductionSourceFiles(dir: string): string[] {
	const out: string[] = []
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name)
		if (entry.isDirectory()) {
			if (SKIPPED_DIRS.has(entry.name)) {
				continue
			}
			out.push(...listProductionSourceFiles(full))
		} else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
			out.push(full)
		}
	}
	return out
}

describe("autoEmbed model single source (C-007 / EL-002 F2)", () => {
	it("keeps every default and stage model derived from INDEX_AUTOEMBED_MODEL", () => {
		const violations: string[] = []
		for (const file of listProductionSourceFiles(SRC_DIR)) {
			if (basename(file) === SOURCE_OF_TRUTH_FILE) {
				continue
			}
			const text = readFileSync(file, "utf8")
			for (const { pattern, form } of FORBIDDEN_FALLBACK_PATTERNS) {
				if (pattern.test(text)) {
					violations.push(`${relative(SRC_DIR, file)}: ${form}`)
				}
			}
		}
		expect(violations).toEqual([])
	})

	it("pins the single source of truth in the definitions module", () => {
		const text = readFileSync(join(SRC_DIR, SOURCE_OF_TRUTH_FILE), "utf8")
		expect(text).toContain(
			'export const INDEX_AUTOEMBED_MODEL = "voyage-4-large"',
		)
	})
})
