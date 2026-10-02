import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { ModuleKind, ScriptTarget, transpileModule } from "typescript"
import { describe, expect, it } from "vitest"
import { sanitizeDiagnostic } from "../../pi-extension/extensions/diagnostics.js"
import { redactSensitiveText } from "./redact.js"

const classifiers = [
	{
		name: "lib",
		run: redactSensitiveText,
		source: new URL("./redact.ts", import.meta.url),
		exported: "redactSensitiveText",
		password: /[a-z][a-z0-9+.-]*:\/\/[^\s:@/]*:([^@\s/]+)@/dgi,
	},
	{
		name: "Pi",
		run: sanitizeDiagnostic,
		source: new URL(
			"../../pi-extension/extensions/diagnostics.ts",
			import.meta.url,
		),
		exported: "sanitizeDiagnostic",
		password: /[a-z][a-z0-9+.-]*:\/\/[^\s:@/]*:([^@\s]+)@/dgi,
	},
]

function oldUserinfo(text: string, password: RegExp): string {
	let output = text
	for (const pattern of [password, /[a-z][a-z0-9+.-]*:\/\/([^:@/\s"]+)@/dgi]) {
		output = output.replace(pattern, (...args: unknown[]) => {
			const match = args[0] as string
			const captured = args[1] as string
			const credentialStart = match.lastIndexOf(captured + "@")
			return (
				match.slice(0, credentialStart) +
				"***" +
				match.slice(credentialStart + captured.length)
			)
		})
	}
	return output
}

describe.each(classifiers)("$name userinfo scheme runs", (classifier) => {
	it("finishes long scheme near-misses in a disposable process", () => {
		const compiled = transpileModule(readFileSync(classifier.source, "utf8"), {
			compilerOptions: {
				module: ModuleKind.ESNext,
				target: ScriptTarget.ES2022,
			},
		}).outputText
		const probe = `
			for (const input of ["a".repeat(64000), "0".repeat(64000) + "a"]) {
				if (${classifier.exported}(input) !== input) process.exit(1);
			}
			console.log("completed");
		`
		const result = spawnSync(
			process.execPath,
			["--input-type=module", "-e", compiled + probe],
			{
				encoding: "utf8",
				timeout: 1500,
				killSignal: "SIGKILL",
			},
		)
		expect(result.error).toBeUndefined()
		expect(result.status, result.stderr).toBe(0)
		expect(result.stdout.trim()).toBe("completed")
	})

	it.each([
		"09.-+",
		"Z",
		"K",
		"é",
		"_",
	])("retains credentials after prefix %s", (prefix) => {
		expect(classifier.run(`${prefix}redis://user:private@host`)).toBe(
			`${prefix}redis://user:***@host`,
		)
		expect(classifier.run(`${prefix}redis://private@host`)).toBe(
			`${prefix}redis://***@host`,
		)
	})

	it("preserves baseline userinfo masking over a seeded corpus", () => {
		let seed = 41
		const pieces = [
			"a",
			"Z",
			"0",
			"9",
			"+",
			".",
			"-",
			":",
			"/",
			"@",
			" ",
			"K",
			"é",
			"*",
			"_",
			"x://u:p@host",
			"redis://user@host",
		]
		const next = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0)
		for (let n = 0; n < 2000; n++) {
			let input = ""
			const count = next() % 15
			for (let i = 0; i < count; i++) input += pieces[next() % pieces.length]
			expect(classifier.run(input), input).toBe(
				oldUserinfo(input, classifier.password),
			)
		}
	})
})
