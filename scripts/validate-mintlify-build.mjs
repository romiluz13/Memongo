import { spawnSync } from "node:child_process"

const cwd = new URL("../apps/docs/", import.meta.url)
const result = spawnSync("mintlify", ["validate"], {
	cwd,
	encoding: "utf8",
	shell: true,
})

const stdout = result.stdout ?? ""
const stderr = result.stderr ?? ""

if (stdout) {
	process.stdout.write(stdout)
}

if (stderr) {
	process.stderr.write(stderr)
}

const combined = `${stdout}\n${stderr}`
const suspiciousPatterns = [
	/Invalid hook call/i,
	/Cannot read properties of null \(reading 'useState'\)/i,
	/(^|\n)\s*ERROR\s{2,}/i,
]

const hasRuntimeError = suspiciousPatterns.some((pattern) =>
	pattern.test(combined),
)

if ((result.status ?? 1) !== 0 || hasRuntimeError) {
	if (hasRuntimeError && (result.status ?? 0) === 0) {
		console.error(
			"Mintlify validate exited successfully but emitted runtime errors; failing the docs build to keep the release gate honest.",
		)
	}
	process.exit((result.status ?? 1) || 1)
}
