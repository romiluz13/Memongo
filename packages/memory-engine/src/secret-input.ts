import { normalizeOptionalSecretInput, type SecretInput } from "@memongo/lib"

export function hasConfiguredMemorySecretInput(value: unknown): boolean {
	if (!value) return false
	if (typeof value === "string") return value.trim().length > 0
	if (typeof value === "object" && value !== null && "secretRef" in value)
		return true
	return false
}

export function resolveMemorySecretInputString(params: {
	value: unknown
	path: string
}): string | undefined {
	const normalized = normalizeOptionalSecretInput(
		params.value as SecretInput | undefined,
	)
	if (
		typeof params.value === "object" &&
		params.value !== null &&
		"secretRef" in params.value &&
		typeof (params.value as { secretRef?: unknown }).secretRef === "string" &&
		!normalized
	) {
		throw new Error(
			`${params.path}: unresolved SecretRef "${(params.value as { secretRef: string }).secretRef}"`,
		)
	}
	return normalized
}
