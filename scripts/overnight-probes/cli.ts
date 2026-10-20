import { ArgsRefusal, type ParsedArgs, parseArgs } from "./args.ts"
import { BudgetRefusal, createBudget, HARD_CEILING_USD } from "./budget.ts"
import type { AnswerPort, Clock } from "./context.ts"
import { EnvRefusal, resolveEnvironment } from "./env.ts"
import {
	type CleanupReport,
	generateAgentId,
	type Harness,
	HarnessRefusal,
} from "./harness.ts"
import {
	createEvidenceWriter,
	type EvidenceWriter,
	reportFatal,
	type Sink,
} from "./output.ts"
import type { ProbeApi } from "./probe-api.ts"
import {
	adminPortFor,
	type InvocationReport,
	planInvocation,
	type Registry,
	runInvocation,
} from "./runner.ts"
import {
	collectSecretValues,
	createSanitizer,
	type Sanitizer,
} from "./sanitize.ts"
import { EXIT_CODES } from "./types.ts"
import { exitCodeFor } from "./verdict.ts"

type Env = Readonly<Record<string, string | undefined>>

export type Io = {
	stdout: Sink
	stderr: Sink
	clock: Clock
	randomHex(chars: number): string
	randomUuid(): string
	startHarness(input: {
		mongoUri: string
		voyageKey: string
		baseEnv: Env
		sanitizer: Sanitizer
		note(line: string): void
	}): Promise<Harness>
	createApi(input: { baseUrl: string; apiKey: string }): ProbeApi
	createAnswer(env: Env): AnswerPort
	onTerminate(handler: () => Promise<void>): () => void
	registry?: Registry
}

const USAGE = "usage: overnight-probes [--probes A,B,...] [--runs N] [--json]"
const TOKEN_HEX_CHARS = 12
const REASONS_SHOWN = 3
const REASON_CHARS = 160

function describeError(error: unknown): string {
	return error instanceof Error ? `${error.name}: ${error.message}` : "error"
}

function summaryLines(report: InvocationReport, exit: number): string[] {
	const lines = report.probes.map((item) => {
		const labels = [
			...item.reproduction.reproduced.map(
				(entry) => `reproduced ${entry.caseId} [${entry.predicate}]`,
			),
			...item.reproduction.singleRun.map(
				(entry) => `single-run ${entry.caseId} [${entry.predicate}]`,
			),
		]
		const suffix = labels.length > 0 ? `; ${labels.join("; ")}` : ""
		const why = item.reasons
			.slice(0, REASONS_SHOWN)
			.map((reason) => reason.slice(0, REASON_CHARS))
		const detail = why.length > 0 ? ` | ${why.join(" | ")}` : ""
		return `probe ${item.probe}: ${item.outcome} (${item.runs} runs)${suffix}${detail}`
	})
	lines.push(`overall: ${report.outcome} (exit ${exit})`)
	return lines
}

type State = { harness?: Harness; cleaned?: CleanupReport }

async function cleanup(
	state: State,
	writer: EvidenceWriter,
	exit: number,
): Promise<number> {
	if (!state.harness) return exit
	let report: CleanupReport
	try {
		report = await state.harness.stop()
	} catch (error) {
		writer.note(`cleanup failed: ${describeError(error)}`)
		return EXIT_CODES.crash
	}
	state.cleaned = report
	writer.record("cleanup", report)
	if (report.cleanupFailed) {
		writer.note(
			`cleanup incomplete: database ${report.database} may still exist and needs manual removal`,
		)
		return EXIT_CODES.crash
	}
	if (!report.stopped) {
		writer.note("cleanup incomplete: the spawned API process did not exit")
		return EXIT_CODES.crash
	}
	return exit
}

async function execute(
	argv: readonly string[],
	env: Env,
	io: Io,
	context: { writer: EvidenceWriter; sanitizer: Sanitizer },
	state: State,
): Promise<number> {
	const { writer, sanitizer } = context
	let args: ParsedArgs
	try {
		args = parseArgs(argv)
	} catch (error) {
		if (!(error instanceof ArgsRefusal)) throw error
		writer.note(`refused: ${error.message}`)
		writer.note(USAGE)
		return EXIT_CODES.refusal
	}
	let resolved: ReturnType<typeof resolveEnvironment>
	try {
		resolved = resolveEnvironment(env, args.probes)
	} catch (error) {
		if (!(error instanceof EnvRefusal)) throw error
		writer.note(`refused: ${error.message}`)
		return EXIT_CODES.refusal
	}

	let plan: ReturnType<typeof planInvocation>
	let answer: AnswerPort | undefined
	let budget: ReturnType<typeof createBudget>
	try {
		plan = planInvocation(args.probes, args.runs, io.registry)
		budget = createBudget({
			ceilingUsd: HARD_CEILING_USD,
			prices: resolved.answer
				? { [resolved.answer.model]: resolved.answer.price }
				: {},
			caps: plan.caps,
		})
		if (args.probes.includes("B")) answer = io.createAnswer(env)
	} catch (error) {
		if (!(error instanceof BudgetRefusal || error instanceof EnvRefusal)) {
			throw error
		}
		writer.note(`refused: ${error.message}`)
		return EXIT_CODES.refusal
	}

	writer.record("plan", {
		probes: args.probes,
		runs: args.runs,
		perRun: plan.perRun,
		caps: plan.caps,
		ceilingUsd: HARD_CEILING_USD,
		estimate: "counter-enforced estimate, not a provider hard cap",
		pricedModel: resolved.answer
			? { model: resolved.answer.model, source: resolved.answer.price.source }
			: null,
	})

	let harness: Harness
	try {
		harness = await io.startHarness({
			mongoUri: resolved.mongoUri,
			voyageKey: resolved.voyageKey,
			baseEnv: env,
			sanitizer,
			note: (line) => writer.note(line),
		})
	} catch (error) {
		if (!(error instanceof HarnessRefusal)) throw error
		writer.note(`refused: ${error.message}`)
		for (const line of error.tail) writer.note(`api: ${line}`)
		return error.cleanupFailed || error.reason === "startup-failed"
			? EXIT_CODES.crash
			: EXIT_CODES.refusal
	}
	state.harness = harness
	const release = io.onTerminate(async () => {
		await cleanup(state, writer, EXIT_CODES.crash)
	})
	try {
		const report = await runInvocation({
			probes: args.probes,
			runs: args.runs,
			api: io.createApi({ baseUrl: harness.baseUrl, apiKey: harness.apiKey }),
			...(answer ? { answer } : {}),
			...(args.probes.includes("F") ? { admin: adminPortFor(harness) } : {}),
			budget,
			evidence: writer,
			clock: io.clock,
			token: (prefix) => `${prefix}${io.randomHex(TOKEN_HEX_CHARS)}`,
			agentId: () => generateAgentId(io.randomUuid),
			...(io.registry ? { registry: io.registry } : {}),
		})
		const exit = exitCodeFor(report.outcome)
		writer.record("invocation", { ...report, exit })
		if (!args.json) {
			for (const line of summaryLines(report, exit)) writer.note(line)
		}
		return exit
	} finally {
		release()
	}
}

export async function main(
	argv: readonly string[],
	env: Env,
	io: Io,
): Promise<number> {
	const sinks = { stdout: io.stdout, stderr: io.stderr }
	let sanitizer: Sanitizer
	let writer: EvidenceWriter
	try {
		sanitizer = createSanitizer({ secretValues: collectSecretValues(env) })
		writer = createEvidenceWriter({ ...sinks, sanitizer })
	} catch (error) {
		reportFatal(error, env, sinks)
		return EXIT_CODES.crash
	}
	const state: State = {}
	let exit: number
	try {
		exit = await execute(argv, env, io, { writer, sanitizer }, state)
	} catch (error) {
		writer.note(`fatal: ${describeError(error)}`)
		exit = EXIT_CODES.crash
	}
	return state.cleaned ? exit : cleanup(state, writer, exit)
}
