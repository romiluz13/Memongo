export function isTruthyEnvValue(value?: string): boolean {
	if (!value) return false
	const lower = value.trim().toLowerCase()
	return lower === "1" || lower === "true" || lower === "yes" || lower === "on"
}

export function isFalsyEnvValue(value?: string): boolean {
	if (!value) return true
	const lower = value.trim().toLowerCase()
	return (
		lower === "" ||
		lower === "0" ||
		lower === "false" ||
		lower === "no" ||
		lower === "off"
	)
}

export function resolveEnv(key: string, fallback?: string): string | undefined {
	return process.env[key]?.trim() || fallback
}

export function resolveEnvCascade(
	keys: string[],
	fallback?: string,
): string | undefined {
	for (const key of keys) {
		const val = process.env[key]?.trim()
		if (val) return val
	}
	return fallback
}
