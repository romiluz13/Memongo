/**
 * Process-surface unit tests for the public TTL retention-hold helper.
 *
 * Every case spawns the real helper under `node` — the runtime the public
 * guide documents — with controlled argv and environment, so the suite also
 * proves the driver import resolves under Node. No MongoDB deployment is
 * used or required: usage and argument errors exit before any connection is
 * attempted, and the two connection-failure cases point at a closed loopback
 * port and an invalid scheme, so nothing is reachable to mutate.
 *
 * The non-echo contract is pinned with credential-bearing URIs passed ONLY
 * through the environment: stdout and stderr of every spawned run are
 * asserted to never contain the URI value, its userinfo fragment, or any
 * standalone credential fragment (a parser message can quote a lone
 * username). (The invalid-scheme driver message quotes the literal scheme
 * names "mongodb://" / "mongodb+srv://", so assertions target the URI value
 * and its credentials, not the scheme literal.)
 *
 * Server-requiring behavior — the inventory/pause/mark-source-dropped/
 * restore state machine, hold-file binding, version guard — lives in the
 * gated live suite (mongodb-ttl-retention-hold.e2e.test.ts).
 */
import { spawnSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterAll, describe, expect, it } from "vitest"

const SCRIPT = fileURLToPath(
	new URL("./mongodb-ttl-retention-hold.mjs", import.meta.url),
)

// The child environment never inherits an ambient MEMONGO_MONGODB_URI: each
// case sets exactly the URI surface it exercises.
const BASE_ENV = Object.fromEntries(
	Object.entries(process.env).filter(([key]) => key !== "MEMONGO_MONGODB_URI"),
) as NodeJS.ProcessEnv

// A reliably closed loopback endpoint: port 1 has no listener, so the driver
// fails server selection without touching any deployment.
const REFUSED_URI =
	"mongodb://holduser:holdpass@127.0.0.1:1/?directConnection=true"

interface RunResult {
	status: number | null
	signal: string | null
	stdout: string
	stderr: string
}

function runHelper(
	argv: string[],
	env: Record<string, string> = {},
): RunResult {
	const result = spawnSync("node", [SCRIPT, ...argv], {
		env: { ...BASE_ENV, ...env },
		encoding: "utf8",
		// External timeout: a hung child must not hang the suite.
		timeout: 30_000,
	})
	return {
		status: result.status,
		signal: result.signal,
		stdout: result.stdout,
		stderr: result.stderr,
	}
}

function parseOutput(stdout: string): { ok: boolean; error: string } {
	return JSON.parse(stdout) as { ok: boolean; error: string }
}

/** The public non-echo contract: neither channel may carry the URI value,
 *  its userinfo fragment (credentials and separator), or any standalone
 *  credential fragment the failing layer might quote. */
function expectNoUriEcho(
	result: RunResult,
	uri: string,
	fragments: string[] = [],
) {
	const schemeAt = uri.indexOf("://")
	const userinfo = uri.includes("@")
		? uri.slice(schemeAt + 3, uri.indexOf("@") + 1)
		: ""
	for (const channel of [result.stdout, result.stderr]) {
		expect(channel).not.toContain(uri)
		if (userinfo !== "") expect(channel).not.toContain(userinfo)
		for (const fragment of fragments) {
			expect(channel).not.toContain(fragment)
		}
	}
}

describe("mongodb-ttl-retention-hold process surface (serverless)", () => {
	const workDir = mkdtempSync(join(tmpdir(), "hold-unit-"))
	const holdFile = () => join(workDir, `hold-${randomUUID().slice(0, 8)}.json`)

	afterAll(() => {
		rmSync(workDir, { recursive: true, force: true })
	})

	it("rejects a --uri argument with exit 2 and never echoes its value", () => {
		const file = holdFile()
		const rejectedValue =
			"mongodb://sentinel-user:sentinel-pass@127.0.0.1:27017/?directConnection=true"
		const result = runHelper(
			["--uri", rejectedValue, "--db", "unit", "--file", file, "inspect"],
			{ MEMONGO_MONGODB_URI: REFUSED_URI },
		)
		expect(result.status).toBe(2)
		expect(result.signal).toBeNull()
		expect(result.stderr).toBe("")
		expect(parseOutput(result.stdout)).toEqual({
			ok: false,
			error:
				"--uri is not accepted; set MEMONGO_MONGODB_URI in the environment instead",
		})
		expectNoUriEcho(result, rejectedValue)
		expectNoUriEcho(result, REFUSED_URI)
		// A usage failure never persists anything.
		expect(existsSync(file)).toBe(false)
	})

	it("rejects the --uri=<value> form with exit 2", () => {
		const file = holdFile()
		const rejectedValue =
			"mongodb://sentinel-user:sentinel-pass@127.0.0.1:27017"
		const result = runHelper(
			[
				"--uri=mongodb://sentinel-user:sentinel-pass@127.0.0.1:27017",
				"--db",
				"unit",
				"--file",
				file,
				"inspect",
			],
			{ MEMONGO_MONGODB_URI: REFUSED_URI },
		)
		expect(result.status).toBe(2)
		expect(parseOutput(result.stdout).error).toBe(
			"--uri is not accepted; set MEMONGO_MONGODB_URI in the environment instead",
		)
		expectNoUriEcho(result, rejectedValue)
	})

	it("rejects --uri before any other argument error (precedence)", () => {
		const result = runHelper(["--uri", "mongodb://sentinel@127.0.0.1:27017"])
		expect(result.status).toBe(2)
		expect(parseOutput(result.stdout).error).toBe(
			"--uri is not accepted; set MEMONGO_MONGODB_URI in the environment instead",
		)
	})

	it("requires MEMONGO_MONGODB_URI in the environment (exit 2 usage)", () => {
		const file = holdFile()
		const result = runHelper(["--db", "unit", "--file", file, "inspect"])
		expect(result.status).toBe(2)
		expect(result.stderr).toBe("")
		const parsed = parseOutput(result.stdout)
		expect(parsed.ok).toBe(false)
		// The usage line must name the env var, both flags, and every command.
		expect(parsed.error).toBe(
			"usage: MEMONGO_MONGODB_URI=<uri> (env) --db DB --file HOLDFILE <inspect|inventory|pause|mark-source-dropped|restore> [NS...]",
		)
		expect(existsSync(file)).toBe(false)
	})

	it("treats a whitespace-only MEMONGO_MONGODB_URI as missing (trim pin)", () => {
		const file = holdFile()
		const result = runHelper(["--db", "unit", "--file", file, "inspect"], {
			MEMONGO_MONGODB_URI: "   ",
		})
		expect(result.status).toBe(2)
		expect(parseOutput(result.stdout).error).toContain("usage:")
	})

	it("rejects a missing --db (exit 2 usage)", () => {
		const file = holdFile()
		const result = runHelper(["--file", file, "inspect"], {
			MEMONGO_MONGODB_URI: REFUSED_URI,
		})
		expect(result.status).toBe(2)
		expect(parseOutput(result.stdout).error).toContain("usage:")
	})

	it("rejects a missing --file (exit 2 usage)", () => {
		const result = runHelper(["--db", "unit", "inspect"], {
			MEMONGO_MONGODB_URI: REFUSED_URI,
		})
		expect(result.status).toBe(2)
		expect(parseOutput(result.stdout).error).toContain("usage:")
	})

	it("rejects a missing command (exit 2 usage)", () => {
		const file = holdFile()
		const result = runHelper(["--db", "unit", "--file", file], {
			MEMONGO_MONGODB_URI: REFUSED_URI,
		})
		expect(result.status).toBe(2)
		expect(parseOutput(result.stdout).error).toContain("usage:")
	})

	it("rejects a trailing flag with no value, --db or --file (exit 2 usage)", () => {
		const file = holdFile()
		const missingDb = runHelper(["--file", file, "inspect", "--db"], {
			MEMONGO_MONGODB_URI: REFUSED_URI,
		})
		expect(missingDb.status).toBe(2)
		expect(parseOutput(missingDb.stdout).error).toContain("usage:")

		const missingFile = runHelper(["--db", "unit", "inspect", "--file"], {
			MEMONGO_MONGODB_URI: REFUSED_URI,
		})
		expect(missingFile.status).toBe(2)
		expect(parseOutput(missingFile.stdout).error).toContain("usage:")
	})

	it("fails closed on an unreachable URI with exit 1 and no credential echo", () => {
		const file = holdFile()
		const result = runHelper(["--db", "unit", "--file", file, "inspect"], {
			MEMONGO_MONGODB_URI: REFUSED_URI,
		})
		expect(result.status).toBe(1)
		expect(result.signal).toBeNull()
		const parsed = parseOutput(result.stdout)
		expect(parsed.ok).toBe(false)
		expect(typeof parsed.error).toBe("string")
		expect(parsed.error.length).toBeGreaterThan(0)
		expectNoUriEcho(result, REFUSED_URI)
		// A failed run never persists anything.
		expect(existsSync(file)).toBe(false)
	})

	it("fails closed on an invalid-scheme URI with exit 1 and no credential echo", () => {
		const file = holdFile()
		const badScheme = "mongodb2://schemeuser:schemepass@host.invalid/unit"
		const result = runHelper(["--db", "unit", "--file", file, "inspect"], {
			MEMONGO_MONGODB_URI: badScheme,
		})
		expect(result.status).toBe(1)
		const parsed = parseOutput(result.stdout)
		expect(parsed.ok).toBe(false)
		expectNoUriEcho(result, badScheme)
		expect(existsSync(file)).toBe(false)
	})

	it("prints exactly one JSON object with ok/error on stdout for failures", () => {
		const file = holdFile()
		const result = runHelper(["--db", "unit", "--file", file, "inspect"])
		// One JSON document on stdout, nothing on stderr.
		expect(result.stderr).toBe("")
		const lines = result.stdout.trim().split("\n")
		expect(lines).toHaveLength(1)
		const parsed = JSON.parse(lines[0]) as Record<string, unknown>
		expect(Object.keys(parsed).sort()).toEqual(["error", "ok"])
	})
})

describe("mongodb-ttl-retention-hold parse-failure rendering (serverless)", () => {
	// The one leak class this helper had: a MongoParseError whose message
	// quotes a standalone credential fragment (an unescaped username) —
	// invisible to redact()'s URI-shaped rules, which match the whole URI
	// or a mongodb(srv):// string, never a lone username. Parse failures
	// therefore render a static diagnostic naming MEMONGO_MONGODB_URI and
	// never its value (wording identical to the migration CLI's funnel);
	// non-parse failures keep the redacted path. None of the URIs below
	// reaches a deployment: parse errors fire in new MongoClient(), before
	// any connection is attempted.
	const workDir = mkdtempSync(join(tmpdir(), "hold-unit-"))
	const holdFile = () => join(workDir, `hold-${randomUUID().slice(0, 8)}.json`)

	const PARSE_FAILURE =
		"MEMONGO_MONGODB_URI is not a valid MongoDB connection string (MongoParseError); the value is never echoed"

	afterAll(() => {
		rmSync(workDir, { recursive: true, force: true })
	})

	it("never echoes a standalone username with unescaped characters", () => {
		const file = holdFile()
		const uri = "mongodb://syn/user:synthetic-w16-password@127.0.0.1:1"
		const result = runHelper(["--db", "unit", "--file", file, "inspect"], {
			MEMONGO_MONGODB_URI: uri,
		})
		expect(result.status).toBe(1)
		expect(result.signal).toBeNull()
		expect(result.stderr).toBe("")
		expect(parseOutput(result.stdout)).toEqual({
			ok: false,
			error: PARSE_FAILURE,
		})
		// The parser failure quotes only the offending username, not the
		// whole URI, so the fragment list carries it explicitly.
		expectNoUriEcho(result, uri, ["syn/user", "synthetic-w16-password"])
		// A failed run never persists anything.
		expect(existsSync(file)).toBe(false)
	})

	it("renders the static parse diagnostic for full-URI parser messages", () => {
		// Empty-host classes whose parser message interpolates the whole
		// URI: layer-1 redaction made them safe before, but the rendered
		// text was still the parser's own message.
		const parseUris = [
			// Empty host.
			"mongodb://synthetic-w16-user:synthetic-w16-password@",
			// Empty host with an encoded password.
			"mongodb://synthetic-w16-user:synthetic%40w16%2Fpassword@",
			// Whitespace in the password with an empty host.
			"mongodb://synthetic-w16-user:synthetic w16-password@",
		]
		for (const uri of parseUris) {
			const file = holdFile()
			const result = runHelper(["--db", "unit", "--file", file, "inspect"], {
				MEMONGO_MONGODB_URI: uri,
			})
			expect(result.status, uri).toBe(1)
			expect(result.stderr, uri).toBe("")
			expect(parseOutput(result.stdout)).toEqual({
				ok: false,
				error: PARSE_FAILURE,
			})
			expectNoUriEcho(result, uri)
			expect(existsSync(file), uri).toBe(false)
		}
	})

	it("stays credential-free when the parser message is static", () => {
		// Classes whose parser message never interpolates the URI (invalid
		// percent-encoding, +srv with a multiple-host list): safe with or
		// without the static diagnostic, so the pin is the non-echo
		// contract itself.
		const parseUris = [
			"mongodb://synthetic-w16-user:synthetic-w16-password%@127.0.0.1:1",
			"mongodb+srv://synthetic-w16-user:synthetic-w16-password@host-a.invalid,host-b.invalid",
		]
		for (const uri of parseUris) {
			const file = holdFile()
			const result = runHelper(["--db", "unit", "--file", file, "inspect"], {
				MEMONGO_MONGODB_URI: uri,
			})
			expect(result.status, uri).toBe(1)
			expect(result.stderr, uri).toBe("")
			const parsed = parseOutput(result.stdout)
			expect(parsed.ok, uri).toBe(false)
			expectNoUriEcho(result, uri)
			expect(existsSync(file), uri).toBe(false)
		}
	})

	it("still surfaces credential-free host diagnostics on a refused connection", () => {
		// A non-parse failure keeps the redacted path: redaction must not
		// swallow the host-only diagnostic.
		const file = holdFile()
		const result = runHelper(["--db", "unit", "--file", file, "inspect"], {
			MEMONGO_MONGODB_URI: REFUSED_URI,
		})
		expect(result.status).toBe(1)
		expectNoUriEcho(result, REFUSED_URI)
		expect(parseOutput(result.stdout).error).toContain("ECONNREFUSED")
	})
})
