import {
	collectSecretValues,
	createSanitizer,
	type Sanitizer,
} from "./sanitize.ts"

export type Sink = { write(chunk: string): unknown }
export type OutputSinks = { stdout: Sink; stderr: Sink }

export type EvidenceWriter = {
	record(kind: string, payload: unknown): void
	note(message: string): void
}

export function createEvidenceWriter(options: {
	stdout: Sink
	stderr: Sink
	sanitizer: Sanitizer
}): EvidenceWriter {
	const { sanitizer } = options
	return {
		record(kind, payload) {
			const body = sanitizer.value(payload)
			const line = JSON.stringify({
				kind,
				payload: body,
				redactions: sanitizer.redactionCount(),
			})
			options.stdout.write(`${sanitizer.text(line)}\n`)
		},
		note(message) {
			options.stderr.write(`${sanitizer.text(message)}\n`)
		},
	}
}

const FATAL_CONSTANT =
	"fatal: probe runner failed before its output could be sanitized; details withheld\n"

export function reportFatal(
	error: unknown,
	env: Record<string, string | undefined>,
	sinks: OutputSinks,
): void {
	try {
		const sanitizer = createSanitizer({
			secretValues: collectSecretValues(env),
		})
		const message = error instanceof Error ? error.message : String(error)
		sinks.stderr.write(`${sanitizer.text(`fatal: ${message}`)}\n`)
	} catch {
		sinks.stderr.write(FATAL_CONSTANT)
	}
}

export function createWriterForEnv(
	env: Record<string, string | undefined>,
	sinks: OutputSinks,
): EvidenceWriter {
	return createEvidenceWriter({
		...sinks,
		sanitizer: createSanitizer({ secretValues: collectSecretValues(env) }),
	})
}
