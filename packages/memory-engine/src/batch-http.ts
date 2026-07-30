import { type SsrFPolicy, retryAsync } from "@memongo/lib"
import { postJson } from "./post-json.js"

export function isTransientBatchHttpError(err: unknown): boolean {
	const status = (err as { status?: number }).status
	return status === 429 || (typeof status === "number" && status >= 500)
}

/**
 * Fleet audit P1-5: retry/backoff used to cover only batch creation, so one
 * transient 429 on status polling or file download destroyed a batch hours
 * into its 12 h window. The Atlas AI API sends no Retry-After header, so this
 * backoff is the only protection. Callers must attach `status` to thrown
 * errors for the transient check to see it.
 */
export async function withBatchTransientRetry<T>(
	fn: () => Promise<T>,
): Promise<T> {
	return await retryAsync(fn, {
		attempts: 3,
		minDelayMs: 300,
		maxDelayMs: 2000,
		jitter: 0.2,
		shouldRetry: isTransientBatchHttpError,
	})
}

export async function postJsonWithRetry<T>(params: {
	url: string
	headers: Record<string, string>
	ssrfPolicy?: SsrFPolicy
	body: unknown
	errorPrefix: string
}): Promise<T> {
	return await retryAsync(
		async () => {
			return await postJson<T>({
				url: params.url,
				headers: params.headers,
				ssrfPolicy: params.ssrfPolicy,
				body: params.body,
				errorPrefix: params.errorPrefix,
				attachStatus: true,
				parse: async (payload) => payload as T,
			})
		},
		{
			attempts: 3,
			minDelayMs: 300,
			maxDelayMs: 2000,
			jitter: 0.2,
			shouldRetry: (err) => {
				const status = (err as { status?: number }).status
				return status === 429 || (typeof status === "number" && status >= 500)
			},
		},
	)
}
