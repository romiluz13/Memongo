import { vi } from "vitest"

type ModelAuthMockModule = {
	resolveApiKeyForProvider: (...args: unknown[]) => unknown
	requireApiKey: (provider: string, env?: NodeJS.ProcessEnv) => string
	resolveEnvApiKey: (
		envKey: string,
		env?: NodeJS.ProcessEnv,
	) => string | undefined
	parseGeminiAuth: (env?: NodeJS.ProcessEnv) => { apiKey?: string }
	ApiKeyRotation: unknown
	resolveApiKeyRotation: (...args: unknown[]) => unknown
}

export function createModelAuthMockModule(): ModelAuthMockModule {
	const resolveApiKeyForProvider = vi.fn(() => undefined) as (
		...args: unknown[]
	) => unknown
	return {
		resolveApiKeyForProvider,
		requireApiKey: vi.fn((provider: string) => {
			const resolved = resolveApiKeyForProvider(provider)
			if (typeof resolved === "string" && resolved.trim()) {
				return resolved.trim()
			}
			throw new Error(`Missing API key for provider "${provider}".`)
		}) as unknown as (provider: string, env?: NodeJS.ProcessEnv) => string,
		resolveEnvApiKey: vi.fn(() => undefined) as (
			envKey: string,
			env?: NodeJS.ProcessEnv,
		) => string | undefined,
		parseGeminiAuth: vi.fn(() => ({})) as (env?: NodeJS.ProcessEnv) => {
			apiKey?: string
		},
		ApiKeyRotation: class {
			next() {
				return ""
			}
			get count() {
				return 0
			}
		},
		resolveApiKeyRotation: vi.fn(() => undefined),
	}
}
