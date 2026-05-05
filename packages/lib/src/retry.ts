export type RetryConfig = {
	attempts?: number
	minDelayMs?: number
	maxDelayMs?: number
	jitter?: number
}

export type RetryInfo = {
	attempt: number
	maxAttempts: number
	delayMs: number
	err: unknown
	label?: string
}

export type RetryOptions = RetryConfig & {
	label?: string
	shouldRetry?: (err: unknown, attempt: number) => boolean
	retryAfterMs?: (err: unknown) => number | undefined
	onRetry?: (info: RetryInfo) => void
}

const DEFAULT_RETRY_CONFIG: Required<RetryConfig> = {
	attempts: 3,
	minDelayMs: 300,
	maxDelayMs: 30_000,
	jitter: 0,
}

function clamp(
	value: number | undefined,
	fallback: number,
	min: number,
	max: number,
): number {
	const v =
		typeof value === "number" && Number.isFinite(value) ? value : fallback
	return Math.min(Math.max(v, min), max)
}

export function resolveRetryConfig(
	defaults: Required<RetryConfig> = DEFAULT_RETRY_CONFIG,
	overrides?: RetryConfig,
): Required<RetryConfig> {
	const attempts = Math.max(
		1,
		Math.round(clamp(overrides?.attempts, defaults.attempts, 1, 100)),
	)
	const minDelayMs = Math.max(
		0,
		Math.round(clamp(overrides?.minDelayMs, defaults.minDelayMs, 0, 300_000)),
	)
	const maxDelayMs = Math.max(
		minDelayMs,
		Math.round(clamp(overrides?.maxDelayMs, defaults.maxDelayMs, 0, 600_000)),
	)
	const jitter = clamp(overrides?.jitter, defaults.jitter, 0, 1)
	return { attempts, minDelayMs, maxDelayMs, jitter }
}

function applyJitter(delayMs: number, jitter: number): number {
	if (jitter <= 0) return delayMs
	const offset = (Math.random() * 2 - 1) * jitter
	return Math.max(0, Math.round(delayMs * (1 + offset)))
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function retryAsync<T>(
	fn: () => Promise<T>,
	attemptsOrOptions: number | RetryOptions = 3,
	initialDelayMs = 300,
): Promise<T> {
	if (typeof attemptsOrOptions === "number") {
		const attempts = Math.max(1, Math.round(attemptsOrOptions))
		let lastErr: unknown
		for (let i = 0; i < attempts; i += 1) {
			try {
				return await fn()
			} catch (err) {
				lastErr = err
				if (i === attempts - 1) break
				await sleep(initialDelayMs * 2 ** i)
			}
		}
		throw lastErr ?? new Error("Retry failed")
	}

	const options = attemptsOrOptions
	const resolved = resolveRetryConfig(DEFAULT_RETRY_CONFIG, options)
	const { attempts: maxAttempts, minDelayMs, maxDelayMs, jitter } = resolved
	const shouldRetry = options.shouldRetry ?? (() => true)
	let lastErr: unknown

	for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
		try {
			return await fn()
		} catch (err) {
			lastErr = err
			if (attempt >= maxAttempts || !shouldRetry(err, attempt)) break

			const retryAfterMs = options.retryAfterMs?.(err)
			const hasRetryAfter =
				typeof retryAfterMs === "number" && Number.isFinite(retryAfterMs)
			const baseDelay = hasRetryAfter
				? Math.max(retryAfterMs, minDelayMs)
				: minDelayMs * 2 ** (attempt - 1)
			let delay = Math.min(baseDelay, maxDelayMs)
			delay = applyJitter(delay, jitter)
			delay = Math.min(Math.max(delay, minDelayMs), maxDelayMs)

			options.onRetry?.({
				attempt,
				maxAttempts,
				delayMs: delay,
				err,
				label: options.label,
			})
			await sleep(delay)
		}
	}

	throw lastErr ?? new Error("Retry failed")
}
