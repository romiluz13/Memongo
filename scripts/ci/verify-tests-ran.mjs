import fs from "node:fs"

// Skip-green guard: fails CI when a "green" test run did not actually run
// tests. Three failure modes it catches:
//
//   1. A suite gated on env (describe.skipIf(!provider)) silently skips when
//      the env is missing, and Vitest still exits 0 — the run reports green
//      while the gated suite tested nothing.
//   2. A package loses its test script or its test files, so `turbo run test`
//      skips it silently and nothing notices the coverage vanished.
//   3. JUnit emission itself breaks (config removed, output path changed),
//      which would blind this guard.
//
// Usage:
//   bun scripts/ci/verify-tests-ran.mjs \
//     --expect <junit-file> [--expect <junit-file> ...] \
//     [--min-executed <N>]         (default 1, per expected file)
//     [--require-suite <substr> ...]  (a testcase/testsuite matching <substr>
//                                      must have executed in some expected
//                                      file; matching-but-all-skipped fails)

const USAGE = `usage: bun scripts/ci/verify-tests-ran.mjs --expect <junit.xml> [--expect ...]
                  [--min-executed <N>] [--require-suite <substring> ...]`

function fail(message) {
	console.error(`verify-tests-ran: FAIL — ${message}`)
	process.exit(1)
}

const args = process.argv.slice(2)
const expectPaths = []
const requiredSuites = []
let minExecuted = 1
for (let i = 0; i < args.length; i++) {
	const arg = args[i]
	const value = args[i + 1]
	if (arg === "--expect" && value) {
		expectPaths.push(value)
		i++
	} else if (arg === "--require-suite" && value) {
		requiredSuites.push(value)
		i++
	} else if (arg === "--min-executed" && value) {
		const parsed = Number.parseInt(value, 10)
		if (!Number.isInteger(parsed) || parsed < 0) {
			fail(`--min-executed expects a non-negative integer, got "${value}"`)
		}
		minExecuted = parsed
		i++
	} else if (arg === "--help" || arg === "-h") {
		console.log(USAGE)
		process.exit(0)
	} else {
		fail(`unknown or incomplete argument "${arg}"\n${USAGE}`)
	}
}
if (expectPaths.length === 0) {
	fail(`at least one --expect <junit.xml> is required\n${USAGE}`)
}

function decodeEntities(value) {
	return value
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&amp;/g, "&")
}

function parseAttributes(tag) {
	const attrs = {}
	for (const match of tag.matchAll(/([\w:-]+)="([^"]*)"/g)) {
		attrs[match[1]] = decodeEntities(match[2])
	}
	return attrs
}

function parseJunit(xml) {
	const suites = []
	for (const match of xml.matchAll(/<testsuite\b([^>]*)>/g)) {
		const attrs = parseAttributes(match[1])
		const tests = Number.parseInt(attrs.tests ?? "0", 10) || 0
		const skipped = Number.parseInt(attrs.skipped ?? "0", 10) || 0
		suites.push({
			name: attrs.name ?? "(unnamed testsuite)",
			tests,
			skipped,
			failures: Number.parseInt(attrs.failures ?? "0", 10) || 0,
			errors: Number.parseInt(attrs.errors ?? "0", 10) || 0,
			executed: Math.max(tests - skipped, 0),
		})
	}
	const testcases = []
	for (const match of xml.matchAll(
		/<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g,
	)) {
		const attrs = parseAttributes(match[1])
		const body = match[2] ?? ""
		testcases.push({
			name: attrs.name ?? "",
			classname: attrs.classname ?? "",
			// <skipped/> children mark skipped entries; <failure>/<error>
			// children mark failed ones. <system-err> is console noise, not a
			// verdict, and must not match the failure probe.
			skipped: /<skipped[\s/>]/.test(body),
			failed: /<(?:failure|error)[\s/>]/.test(body),
		})
	}
	return { suites, testcases }
}

function loadReport(path) {
	if (!fs.existsSync(path)) {
		return { missing: true, suites: [], testcases: [] }
	}
	const xml = fs.readFileSync(path, "utf8")
	const parsed = parseJunit(xml)
	// Prefer counting from testcase entries (ground truth); fall back to
	// testsuite attributes only if the file carries no testcases at all.
	const fromCases = parsed.testcases.length
		? {
				tests: parsed.testcases.length,
				skipped: parsed.testcases.filter((tc) => tc.skipped).length,
				failed: parsed.testcases.filter((tc) => tc.failed).length,
			}
		: parsed.suites.reduce(
				(acc, s) => ({
					tests: acc.tests + s.tests,
					skipped: acc.skipped + s.skipped,
					failed: acc.failed + s.failures + s.errors,
				}),
				{ tests: 0, skipped: 0, failed: 0 },
			)
	return { missing: false, ...parsed, ...fromCases }
}

const reports = expectPaths.map((p) => ({ path: p, report: loadReport(p) }))

const violations = []
let totalTests = 0
let totalSkipped = 0
let totalExecuted = 0
let totalFailed = 0

for (const { path, report } of reports) {
	if (report.missing) {
		violations.push(
			`missing junit: ${path} (reporter not configured, package lost its tests, or the run never happened)`,
		)
		continue
	}
	const executed = report.tests - report.skipped
	totalTests += report.tests
	totalSkipped += report.skipped
	totalExecuted += executed
	totalFailed += report.failed
	console.log(
		`verify-tests-ran: ${path}: ${report.tests} tests, ${report.skipped} skipped, ${executed} executed, ${report.failed} failed`,
	)
	if (executed < minExecuted) {
		violations.push(
			`no executed tests: ${path} (${report.tests} tests, ${report.skipped} skipped — suites silently skipped or empty run)`,
		)
	}
	if (report.failed > 0) {
		violations.push(
			`failures reported in junit: ${path} (${report.failed}) — Vitest should have failed first; investigate`,
		)
	}
}

for (const substr of requiredSuites) {
	let matched = false
	let ran = false
	for (const { report } of reports) {
		for (const tc of report.testcases) {
			if (tc.name.includes(substr) || tc.classname.includes(substr)) {
				matched = true
				if (!tc.skipped) {
					ran = true
				}
			}
		}
		for (const suite of report.suites) {
			if (suite.name.includes(substr)) {
				matched = true
				if (suite.executed > 0) {
					ran = true
				}
			}
		}
	}
	if (!matched) {
		violations.push(
			`required suite absent: "${substr}" (no testsuite or testcase matches it in any expected file)`,
		)
	} else if (!ran) {
		violations.push(
			`required suite all-skipped: "${substr}" (matched but every entry is skipped — its gate env is missing)`,
		)
	}
}

if (violations.length > 0) {
	console.error("verify-tests-ran: violations:")
	for (const violation of violations) {
		console.error(`  - ${violation}`)
	}
	process.exit(1)
}

console.log(
	`verify-tests-ran: OK — ${reports.length} files, ${totalTests} tests, ${totalSkipped} skipped, ${totalExecuted} executed, ${totalFailed} failed; ${requiredSuites.length} required suites all ran`,
)
