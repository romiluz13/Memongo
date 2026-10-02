import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { ModuleKind, ScriptTarget, transpileModule } from "typescript"
import { describe, expect, it } from "vitest"
import { redactSensitiveText } from "./redact.js"

describe("redact: bounded credential-path matching", () => {
	it("finishes delimiter-heavy near-misses in a disposable process", () => {
		const source = readFileSync(new URL("./redact.ts", import.meta.url), "utf8")
		const compiled = transpileModule(source, {
			compilerOptions: {
				module: ModuleKind.ESNext,
				target: ScriptTarget.ES2022,
			},
		}).outputText
		const probe = `
			const paths = ["-".repeat(40) + "tokenx", "._".repeat(40) + "x", "-".repeat(40) + "token?", "._".repeat(20000) + "x"];
			for (const path of paths) {
				const url = "https://example.test/" + path;
				if (redactSensitiveText(url) !== url) process.exit(1);
			}
			console.log("completed");
		`
		const result = spawnSync(
			process.execPath,
			["--input-type=module", "-e", compiled + probe],
			{ encoding: "utf8", timeout: 2000, killSignal: "SIGKILL" },
		)
		expect(result.error).toBeUndefined()
		expect(result.status, result.stderr).toBe(0)
		expect(result.stdout.trim()).toBe("completed")
	})

	it.each([
		"token",
		"secret",
		"credentials",
		"passwd",
		"password",
	])("masks %s after mixed path delimiters and preserves the query", (word) => {
		const text = `see https://example.test/a.b_c-d/api-${word}/dummy-value?q=1 end`
		const expected = "see https://example.test/***?q=1 end"
		expect(redactSensitiveText(text)).toBe(expected)
		expect(redactSensitiveText(expected)).toBe(expected)
	})

	it.each([
		"token",
		"secrets",
		"credentials",
		"passwd",
		"password",
	])("masks a credential word at the beginning and end of the path: %s", (word) => {
		expect(redactSensitiveText(`https://example.test/${word}`)).toBe(
			"https://example.test/***",
		)
	})

	it.each([
		"tokenization/intro",
		"atoken/value",
		"token?view=1",
		"a#token/value",
	])("preserves non-credential path boundaries: %s", (path) => {
		const text = `https://example.test/${path}`
		expect(redactSensitiveText(text)).toBe(text)
	})
})
