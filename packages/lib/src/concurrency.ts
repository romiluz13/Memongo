export type ConcurrencyErrorMode = "continue" | "stop"

export type RunTasksWithConcurrencyParams<T> = {
	tasks: Array<() => Promise<T>>
	limit: number
	errorMode?: ConcurrencyErrorMode
	onTaskError?: (error: unknown, index: number) => void
}

type RunTasksWithConcurrencyResult<T> = {
	results: T[]
	firstError: unknown
	hasError: boolean
}

async function runTasksWithConcurrencyInternal<T>(
	params: RunTasksWithConcurrencyParams<T>,
): Promise<RunTasksWithConcurrencyResult<T>> {
	const { tasks, limit, onTaskError } = params
	const errorMode = params.errorMode ?? "continue"
	if (tasks.length === 0) {
		return { results: [], firstError: undefined, hasError: false }
	}

	const resolvedLimit = Math.max(1, Math.min(limit, tasks.length))
	const results: T[] = Array.from({ length: tasks.length })
	let next = 0
	let firstError: unknown
	let hasError = false

	const workers = Array.from({ length: resolvedLimit }, async () => {
		while (true) {
			if (errorMode === "stop" && hasError) {
				return
			}
			const index = next
			next += 1
			if (index >= tasks.length) {
				return
			}
			try {
				results[index] = await tasks[index]()
			} catch (error) {
				if (!hasError) {
					firstError = error
					hasError = true
				}
				onTaskError?.(error, index)
				if (errorMode === "stop") {
					return
				}
			}
		}
	})

	await Promise.allSettled(workers)
	return { results, firstError, hasError }
}

export function runTasksWithConcurrency<T>(
	params: RunTasksWithConcurrencyParams<T>,
): Promise<RunTasksWithConcurrencyResult<T>>
export function runTasksWithConcurrency<T>(
	tasks: Array<() => Promise<T>>,
	concurrency: number,
): Promise<T[]>
export async function runTasksWithConcurrency<T>(
	arg1: RunTasksWithConcurrencyParams<T> | Array<() => Promise<T>>,
	arg2?: number,
): Promise<RunTasksWithConcurrencyResult<T> | T[]> {
	if (Array.isArray(arg1)) {
		const { results, firstError, hasError } =
			await runTasksWithConcurrencyInternal({
				tasks: arg1,
				limit: arg2 ?? 1,
				errorMode: "stop",
			})
		if (hasError) {
			throw firstError
		}
		return results
	}

	return runTasksWithConcurrencyInternal(arg1)
}
