// M2 startup contract: one total deadline shared by every contract operation
// (spec "Readiness deadline"). Each operation starts only while time remains,
// receives the remaining time as the driver `timeoutMS` (which the driver also
// sends to the server as maxTimeMS), is raced against the same deadline for
// operations the driver gives no option to (createSearchIndex and
// updateSearchIndex take none in mongodb 7.7) and is failed when it completes
// after the deadline. Expiry is always the typed `boot-deadline-exceeded`.
import { MemongoBootError } from "./mongodb-boot-errors.js"

export type BootBudget = {
	/**
	 * Run one operation inside the remaining deadline. `operation` receives
	 * the remaining milliseconds (at least 1: a `timeoutMS` of 0 means no
	 * timeout in the driver) for its `timeoutMS` option.
	 */
	run<T>(
		phase: string,
		operation: (timeoutMS: number) => Promise<T>,
	): Promise<T>
	/** Throws the typed deadline failure when no time remains. */
	assertLive(phase: string): void
}

export type BootBudgetOptions = {
	deadlineMs: number
	now?: () => number
}

export function bootDeadlineError(
	phase: string,
	deadlineMs: number,
): MemongoBootError {
	const seconds = Math.round(deadlineMs / 1000)
	return new MemongoBootError(
		{
			code: "boot-deadline-exceeded",
			requirement: `the startup contract completes within ${seconds} s`,
		},
		`boot refused: the ${seconds} s startup deadline expired during ${phase}`,
	)
}

/** A client `timeoutMS` expiry or a server `maxTimeMS` expiry. */
function isOperationTimeout(err: unknown): boolean {
	const named = err as { name?: unknown; code?: unknown; codeName?: unknown }
	return (
		named?.name === "MongoOperationTimeoutError" ||
		named?.codeName === "MaxTimeMSExpired" ||
		named?.code === 50
	)
}

export function createBootBudget(options: BootBudgetOptions): BootBudget {
	const now = options.now ?? Date.now
	const deadlineAt = now() + options.deadlineMs
	const expired = (phase: string) =>
		bootDeadlineError(phase, options.deadlineMs)
	return {
		assertLive(phase) {
			if (deadlineAt - now() <= 0) throw expired(phase)
		},
		async run(phase, operation) {
			const remaining = deadlineAt - now()
			if (remaining <= 0) throw expired(phase)
			let timer: ReturnType<typeof setTimeout> | undefined
			const deadline = new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => reject(expired(phase)), Math.ceil(remaining))
			})
			try {
				const result = await Promise.race([
					operation(Math.max(1, Math.ceil(remaining))),
					deadline,
				])
				if (deadlineAt - now() <= 0) throw expired(phase)
				return result
			} catch (err) {
				throw isOperationTimeout(err) ? expired(phase) : err
			} finally {
				clearTimeout(timer)
			}
		},
	}
}

/** Run `operation` inside `budget`, or directly when the caller has none. */
export function runBounded<T>(
	budget: BootBudget | undefined,
	phase: string,
	operation: (timeoutMS: number | undefined) => Promise<T>,
): Promise<T> {
	return budget ? budget.run(phase, operation) : operation(undefined)
}
