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

/**
 * P2.6: The single MongoDB URI precedence rule shared by every Memongo
 * layer: `MEMONGO_FORCE_MONGODB_URI` always wins.
 *
 * Both the bridge (`memory-config.ts`) and the engine (`backend-config.ts`)
 * resolve a MongoDB URI and both read the environment, so without a shared
 * rule the two layers could resolve DIFFERENT URIs when
 * `MEMONGO_MONGODB_URI` and `MEMONGO_FORCE_MONGODB_URI` are both set (the
 * bridge previously let the plain URI win; the engine let FORCE win).
 *
 * `MEMONGO_FORCE_MONGODB_URI` exists to override file-config URIs in
 * deployments where the config file is shared but the target database is
 * not (for example memongo-api containers or CI), so it must outrank every
 * other source in every layer. Callers pass their already-resolved
 * non-force candidate as `resolvedUri`; the relative order of non-force
 * sources is a per-layer concern (the bridge is env-first; the engine
 * treats an explicit `memory.mongodb.uri` as intentional) and is
 * deliberately NOT part of this rule.
 */
export function applyMongoDbForceUriOverride(
	forceUri: string | undefined,
	resolvedUri: string | undefined,
): string | undefined {
	const force = forceUri?.trim()
	if (force) {
		return force
	}
	return resolvedUri?.trim() || undefined
}
