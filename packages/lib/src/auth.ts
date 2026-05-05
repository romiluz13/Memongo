const PROVIDER_ENV_MAPPINGS: Record<string, string[]> = {
	openai: ["OPENAI_API_KEY"],
	anthropic: ["ANTHROPIC_API_KEY"],
	google: ["GOOGLE_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "GEMINI_API_KEY"],
	gemini: ["GOOGLE_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "GEMINI_API_KEY"],
	voyage: ["VOYAGE_API_KEY"],
	mistral: ["MISTRAL_API_KEY"],
	groq: ["GROQ_API_KEY"],
	deepseek: ["DEEPSEEK_API_KEY"],
	together: ["TOGETHER_API_KEY", "TOGETHER_AI_API_KEY"],
	fireworks: ["FIREWORKS_API_KEY"],
	perplexity: ["PERPLEXITY_API_KEY", "PPLX_API_KEY"],
	cohere: ["COHERE_API_KEY", "CO_API_KEY"],
	xai: ["XAI_API_KEY"],
}

export function resolveApiKeyForProvider(
	provider: string,
	env: NodeJS.ProcessEnv = process.env,
): string | undefined {
	const lower = provider.toLowerCase().replace(/-/g, "")
	const mappings = PROVIDER_ENV_MAPPINGS[lower]
	if (mappings) {
		for (const key of mappings) {
			const val = env[key]?.trim()
			if (val) return val
		}
	}
	const upper = provider.toUpperCase().replace(/-/g, "_")
	const genericKeys = [`${upper}_API_KEY`, `MEMONGO_${upper}_API_KEY`]
	for (const key of genericKeys) {
		const val = env[key]?.trim()
		if (val) return val
	}
	return undefined
}

export function requireApiKey(
	provider: string,
	env?: NodeJS.ProcessEnv,
): string {
	const key = resolveApiKeyForProvider(provider, env)
	if (!key) {
		const upper = provider.toUpperCase().replace(/-/g, "_")
		throw new Error(
			`Missing API key for provider "${provider}". ` +
				`Set ${upper}_API_KEY or MEMONGO_${upper}_API_KEY in environment.`,
		)
	}
	return key
}

export function resolveEnvApiKey(
	envKey: string,
	env: NodeJS.ProcessEnv = process.env,
): string | undefined {
	return env[envKey]?.trim() || undefined
}

export function parseGeminiAuth(env: NodeJS.ProcessEnv = process.env): {
	apiKey?: string
	projectId?: string
	location?: string
} {
	const apiKey =
		env.GOOGLE_API_KEY?.trim() ||
		env.GOOGLE_GENERATIVE_AI_API_KEY?.trim() ||
		env.GEMINI_API_KEY?.trim()
	return {
		apiKey: apiKey || undefined,
		projectId:
			env.GOOGLE_CLOUD_PROJECT?.trim() ||
			env.GCLOUD_PROJECT?.trim() ||
			undefined,
		location: env.GOOGLE_CLOUD_LOCATION?.trim() || undefined,
	}
}

/** Round-robin key rotation for providers with multiple keys. */
export class ApiKeyRotation {
	private keys: string[]
	private index = 0

	constructor(keys: string[]) {
		this.keys = keys.filter((k) => k.trim().length > 0)
		if (this.keys.length === 0)
			throw new Error("ApiKeyRotation requires at least one key")
	}

	next(): string {
		const key = this.keys[this.index % this.keys.length]
		this.index += 1
		return key
	}

	get count(): number {
		return this.keys.length
	}
}

export function resolveApiKeyRotation(
	provider: string,
	env: NodeJS.ProcessEnv = process.env,
): ApiKeyRotation | undefined {
	const upper = provider.toUpperCase().replace(/-/g, "_")
	const multiKeyEnv = env[`${upper}_API_KEYS`]?.trim()
	if (multiKeyEnv) {
		const keys = multiKeyEnv
			.split(",")
			.map((k) => k.trim())
			.filter(Boolean)
		if (keys.length > 0) return new ApiKeyRotation(keys)
	}
	const single = resolveApiKeyForProvider(provider, env)
	if (single) return new ApiKeyRotation([single])
	return undefined
}
