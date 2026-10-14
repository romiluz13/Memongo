import {
	type ResolvedMongoDBConfig,
	resolveMemoryBackendConfig,
} from "../packages/memory-engine/src/backend-config.ts"
import { buildMemongoConfig } from "../packages/memory-bridge/src/memory-config.ts"

/**
 * A conflict between operator inputs and the configured target. Entrypoints
 * print its message (setting names and a remedy, never values) and exit
 * nonzero before creating a client or calling fetch.
 */
export class MongoTargetRefusal extends Error {
	override name = "MongoTargetRefusal"
}

/**
 * The configured application MongoDB config, resolved once through the same
 * path the benchmark runner and application bootstrap use (bridge
 * buildMemongoConfig -> engine resolveMemoryBackendConfig). It reads
 * process.env only: the engine reads MEMONGO_FORCE_MONGODB_URI, the database
 * and the prefix from process.env, so an env parameter could not be hermetic.
 */
export function resolveConfiguredMongoDB(): ResolvedMongoDBConfig {
	// The resolver requires an agentId; MongoDB collections are shared across
	// agents, so the value does not affect the target.
	const mongo = resolveMemoryBackendConfig({
		cfg: buildMemongoConfig(process.env),
		agentId: "mongodb-target",
	}).mongodb
	if (!mongo) {
		throw new Error("MongoDB backend resolution returned no mongodb config")
	}
	return mongo
}
