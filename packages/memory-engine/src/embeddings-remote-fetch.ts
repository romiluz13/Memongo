import { type SsrFPolicy, retryAsync } from "@memongo/lib"
import { sanitizeAndNormalizeEmbedding } from "./embedding-vectors.js"
import { postJson } from "./post-json.js"

// Bounded like the reranker (mongodb-reranker.ts) rather than undici's ~300 s
// default; generous because document batches legitimately take longer than a
// single rerank call.
const EMBED_TIMEOUT_MS = 30_000

export async function fetchRemoteEmbeddingVectors(params: {
	url: string
	headers: Record<string, string>
	ssrfPolicy?: SsrFPolicy
	body: unknown
	errorPrefix: string
	timeoutMs?: number
}): Promise<number[][]> {
	return await retryAsync(
		async () => {
			return await postJson({
				url: params.url,
				headers: params.headers,
				ssrfPolicy: params.ssrfPolicy,
				body: params.body,
				errorPrefix: params.errorPrefix,
				attachStatus: true,
				timeoutMs: params.timeoutMs ?? EMBED_TIMEOUT_MS,
				parse: (payload) => {
					const typedPayload = payload as {
						data?: Array<{ embedding?: number[] }>
					}
					const data = typedPayload.data ?? []
					// Same sanitize+normalize contract as the Gemini/Ollama/local
					// providers: a NaN or Infinity from the provider must never
					// reach a stored document or a $vectorSearch query.
					return data.map((entry) =>
						sanitizeAndNormalizeEmbedding(entry.embedding ?? []),
					)
				},
			})
		},
		{
			attempts: 3,
			minDelayMs: 300,
			maxDelayMs: 2000,
			jitter: 0.2,
			shouldRetry: (err) => {
				const status = (err as { status?: number }).status
				if (status === 429 || (typeof status === "number" && status >= 500)) {
					return true
				}
				// AbortSignal.timeout rejections carry no HTTP status.
				return err instanceof Error && err.name === "TimeoutError"
			},
		},
	)
}
