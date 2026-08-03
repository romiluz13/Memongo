import { buildMemongoConfig } from "@memongo/memory-bridge"

/**
 * P1.7 boot validation. Fails fast — before the port is bound — when no
 * MongoDB URI is resolvable, instead of surfacing the misconfiguration
 * lazily as per-request 500s.
 *
 * The message intentionally mirrors the engine's own error
 * (packages/memory-engine/src/backend-config.ts, resolveMemoryBackendConfig)
 * so operators see one canonical message regardless of where the failure
 * surfaces. Config resolution goes through the bridge's buildMemongoConfig
 * (env vars first, then ~/.memongo/memongo.json), so deployments configured
 * via file — without MEMONGO_MONGODB_URI in the environment — still boot.
 */
export const MISSING_MONGODB_URI_MESSAGE = [
	"MongoDB URI required for Memongo.",
	"Set `memory.mongodb.uri` in config or `MEMONGO_MONGODB_URI` in the environment.",
	"Use `MEMONGO_FORCE_MONGODB_URI` to override a file URI (for example memongo-api or CI).",
].join(" ")

export function validateBootEnv(env: NodeJS.ProcessEnv = process.env): void {
	const cfg = buildMemongoConfig(env)
	const uri = cfg.memory?.mongodb?.uri?.trim()
	if (!uri) {
		throw new Error(MISSING_MONGODB_URI_MESSAGE)
	}
}
