import { requireApiKey, type SsrFPolicy } from "@memongo/lib"
import type { EmbeddingProviderOptions } from "./embeddings.js"
import { buildRemoteBaseUrlPolicy } from "./remote-http.js"
import { resolveMemorySecretInputString } from "./secret-input.js"

export type RemoteEmbeddingProviderId = "openai" | "voyage" | "mistral"

export async function resolveRemoteEmbeddingBearerClient(params: {
	provider: RemoteEmbeddingProviderId
	options: EmbeddingProviderOptions
	defaultBaseUrl: string
	/**
	 * Lets a provider pick its default endpoint from the resolved key, for
	 * services that route different key types to different hosts. Explicit
	 * configuration still wins, and the SSRF policy is computed from whatever
	 * URL this ends up selecting.
	 */
	resolveDefaultBaseUrl?: (apiKey: string) => string
}): Promise<{
	baseUrl: string
	headers: Record<string, string>
	ssrfPolicy?: SsrFPolicy
}> {
	const remote = params.options.remote
	const remoteApiKey = resolveMemorySecretInputString({
		value: remote?.apiKey,
		path: "agents.*.memorySearch.remote.apiKey",
	})
	const remoteBaseUrl = remote?.baseUrl?.trim()
	const providerConfig =
		params.options.config.models?.providers?.[params.provider]
	const apiKey = remoteApiKey ?? requireApiKey(params.provider)
	const baseUrl =
		remoteBaseUrl ||
		providerConfig?.baseUrl?.trim() ||
		params.resolveDefaultBaseUrl?.(apiKey) ||
		params.defaultBaseUrl
	const headerOverrides = Object.assign(
		{},
		providerConfig?.headers,
		remote?.headers,
	)
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
		Authorization: `Bearer ${apiKey}`,
		...headerOverrides,
	}
	return { baseUrl, headers, ssrfPolicy: buildRemoteBaseUrlPolicy(baseUrl) }
}
