type RetryableError = Error & {
	code?: number
	cause?: unknown
	errorLabels?: string[]
	hasErrorLabel?: (label: string) => boolean
}

const TRANSIENT_MONGO_ERROR_NAMES = new Set([
	"MongoNetworkError",
	"MongoNetworkTimeoutError",
	"MongoPoolClearedError",
	"MongoServerSelectionError",
	"MongoTopologyClosedError",
	"MongoNotConnectedError",
])

const TRANSIENT_MONGO_ERROR_CODES = new Set([
	6, 7, 89, 91, 189, 9001, 11600, 11602, 13435,
])

const TRANSIENT_MONGO_ERROR_LABELS = [
	"RetryableReadError",
	"ResumableChangeStreamError",
] as const

const DIAGNOSTIC_ERROR_NAMES = new Set([
	...TRANSIENT_MONGO_ERROR_NAMES,
	"Error",
	"TypeError",
	"ReferenceError",
	"SyntaxError",
	"RangeError",
	"MongoServerError",
	"MongoOperationTimeoutError",
	"EmbeddingModelMismatchError",
])

const DIAGNOSTIC_OPERATIONS = [
	"benchmark event evidence",
	"event evidence",
	"search convergence",
	"raw-session search",
	"decomposed search",
	"original decomposed search",
	"relevance search",
	"search",
	...["events", "chunks", "session_chunks", "memory_evidence"].flatMap(
		(collection) =>
			[
				"vector convergence source read",
				"vector index readiness",
				"text convergence source read",
				"text index readiness",
			].map((suffix) => `${collection} ${suffix}`),
	),
]

function reportTerminalFailure(
	label: string,
	attempt: number,
	maxAttempts: number,
	error: unknown,
): void {
	// Labels carry case IDs and errors can contain queries or credentials.
	const operation =
		DIAGNOSTIC_OPERATIONS.find(
			(known) => label === known || label.startsWith(`${known} for `),
		) ?? "unknown"
	const errorType =
		error instanceof Error && DIAGNOSTIC_ERROR_NAMES.has(error.name)
			? error.name
			: "UnknownError"
	const convergence =
		error instanceof Error
			? /^benchmark (?:events|chunks|session_chunks|memory_evidence|search convergence) (vector|search) convergence timed out:/.exec(
					error.message,
				)
			: null
	const reason = convergence
		? convergence[1] === "vector"
			? "vector-convergence-timeout"
			: "text-convergence-timeout"
		: "unclassified"
	console.error(
		`[memory:mongodb:benchmark-failure] ${JSON.stringify({
			operation,
			attempt,
			maxAttempts,
			errorType,
			reason,
		})}`,
	)
}

export function isTransientMongoBenchmarkError(
	error: unknown,
	depth = 0,
): boolean {
	if (!(error instanceof Error) || depth > 4) return false
	const mongoError = error as RetryableError
	if (TRANSIENT_MONGO_ERROR_NAMES.has(mongoError.name)) return true
	if (
		typeof mongoError.code === "number" &&
		TRANSIENT_MONGO_ERROR_CODES.has(mongoError.code)
	) {
		return true
	}
	if (
		TRANSIENT_MONGO_ERROR_LABELS.some(
			(label) =>
				mongoError.errorLabels?.includes(label) ||
				mongoError.hasErrorLabel?.(label) === true,
		)
	) {
		return true
	}
	return mongoError.cause
		? isTransientMongoBenchmarkError(mongoError.cause, depth + 1)
		: false
}

function positiveInteger(value: string | undefined, fallback: number): number {
	const parsed = Number(value)
	return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback
}

export async function withMongoBenchmarkRetry<T>(
	label: string,
	operation: () => Promise<T>,
	options: {
		maxAttempts?: number
		baseDelayMs?: number
		maxDelayMs?: number
		sleep?: (delayMs: number) => Promise<void>
		onRetry?: (params: {
			label: string
			attempt: number
			maxAttempts: number
			delayMs: number
			error: unknown
		}) => void
	} = {},
): Promise<T> {
	const maxAttempts = Math.max(
		1,
		options.maxAttempts ??
			positiveInteger(process.env.MEMONGO_BENCHMARK_RETRY_ATTEMPTS, 4),
	)
	const baseDelayMs = Math.max(
		0,
		options.baseDelayMs ??
			positiveInteger(process.env.MEMONGO_BENCHMARK_RETRY_BASE_DELAY_MS, 250),
	)
	const maxDelayMs = Math.max(
		baseDelayMs,
		options.maxDelayMs ??
			positiveInteger(process.env.MEMONGO_BENCHMARK_RETRY_MAX_DELAY_MS, 4_000),
	)
	const sleep =
		options.sleep ??
		(async (delayMs: number) => {
			await new Promise((resolve) => setTimeout(resolve, delayMs))
		})

	for (let attempt = 1; ; attempt++) {
		try {
			return await operation()
		} catch (error) {
			if (attempt >= maxAttempts || !isTransientMongoBenchmarkError(error)) {
				reportTerminalFailure(label, attempt, maxAttempts, error)
				throw error
			}
			const delayMs = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1))
			options.onRetry?.({
				label,
				attempt,
				maxAttempts,
				delayMs,
				error,
			})
			await sleep(delayMs)
		}
	}
}
