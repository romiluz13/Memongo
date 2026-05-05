import type { SecretInput } from "./types.js"

function sanitizeSecretString(value: string): string | undefined {
	const normalized = value.replace(/[\r\n]+/g, "").trim()
	return normalized || undefined
}

export function normalizeOptionalSecretInput(
	input: SecretInput | undefined,
): string | undefined {
	if (!input) return undefined
	if (typeof input === "string") return sanitizeSecretString(input)
	if (typeof input === "object" && "secretRef" in input) {
		const envValue = process.env[input.secretRef]
		return typeof envValue === "string"
			? sanitizeSecretString(envValue)
			: undefined
	}
	return undefined
}
