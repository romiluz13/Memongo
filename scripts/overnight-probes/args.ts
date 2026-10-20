import { MAX_RUNS } from "./budget.ts"
import { PROBE_LETTERS, type ProbeLetter } from "./types.ts"

export class ArgsRefusal extends Error {
	override name = "ArgsRefusal"
}

export type ParsedArgs = {
	probes: ProbeLetter[]
	runs: number
	json: boolean
}

export const DEFAULT_RUNS = 2

const TARGET_OVERRIDE_FLAGS: ReadonlySet<string> = new Set([
	"--base-url",
	"--api-url",
	"--url",
	"--database",
	"--db",
	"--uri",
	"--port",
	"--host",
	"--api-key",
])

const RUNS_PATTERN = /^[0-9]+$/

function isProbeLetter(value: string): value is ProbeLetter {
	return (PROBE_LETTERS as readonly string[]).includes(value)
}

function parseProbes(raw: string | undefined): ProbeLetter[] {
	if (raw === undefined || raw === "") {
		throw new ArgsRefusal(
			"--probes needs a comma-separated list of probe letters",
		)
	}
	const letters: ProbeLetter[] = []
	for (const part of raw.split(",")) {
		if (!isProbeLetter(part)) {
			throw new ArgsRefusal(
				`unknown probe letter in --probes; valid letters are ${PROBE_LETTERS.join(",")} (uppercase)`,
			)
		}
		if (letters.includes(part)) {
			throw new ArgsRefusal("duplicate probe letter in --probes")
		}
		letters.push(part)
	}
	return letters
}

function parseRuns(raw: string | undefined): number {
	if (raw === undefined || !RUNS_PATTERN.test(raw)) {
		throw new ArgsRefusal("--runs must be a positive integer")
	}
	const runs = Number(raw)
	if (!Number.isSafeInteger(runs) || runs < 1 || runs > MAX_RUNS) {
		throw new ArgsRefusal(`--runs must be between 1 and ${MAX_RUNS}`)
	}
	return runs
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
	let probes: ProbeLetter[] = [...PROBE_LETTERS]
	let runs = DEFAULT_RUNS
	let json = false
	for (let i = 0; i < argv.length; i += 1) {
		const token = argv[i] as string
		const eq = token.indexOf("=")
		const flag = eq === -1 ? token : token.slice(0, eq)
		const inline = eq === -1 ? undefined : token.slice(eq + 1)
		if (TARGET_OVERRIDE_FLAGS.has(flag)) {
			throw new ArgsRefusal(
				`${flag} is refused: the runner owns its API and database, external target overrides are not accepted`,
			)
		}
		if (flag === "--json") {
			json = true
			continue
		}
		if (flag === "--probes" || flag === "--runs") {
			let value = inline
			if (value === undefined) {
				value = argv[i + 1]
				i += 1
			}
			if (flag === "--probes") probes = parseProbes(value)
			else runs = parseRuns(value)
			continue
		}
		throw new ArgsRefusal(`unknown argument ${flag.slice(0, 24)}`)
	}
	return { probes, runs, json }
}
