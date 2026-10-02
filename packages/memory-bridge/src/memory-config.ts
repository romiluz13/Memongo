import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
	type MemoryConfig,
	type MemongoConfig,
	applyMongoDbForceUriOverride,
} from "@memongo/lib"

export const MEMONGO_CONFIG_FILENAME = path.join(".memongo", "memongo.json")

export function resolveMemongoStandaloneWorkspaceDir(
	env: NodeJS.ProcessEnv = process.env,
): string {
	const explicit = env.MEMONGO_WORKSPACE_DIR?.trim()
	if (explicit) {
		return path.resolve(explicit)
	}
	return path.join(os.homedir(), ".memongo", "workspace")
}

export function resolveMemongoConfigFilePath(
	env: NodeJS.ProcessEnv = process.env,
): string {
	const fromEnv = env.MEMONGO_CONFIG_PATH?.trim()
	if (fromEnv) {
		return path.resolve(fromEnv)
	}
	return path.join(os.homedir(), MEMONGO_CONFIG_FILENAME)
}

function readMemongoJsonFile(
	filePath: string,
	explicit: boolean,
): { memory?: MemoryConfig; agents?: MemongoConfig["agents"] } | undefined {
	// The default config path is optional: absent means "no file config".
	// Everything else fails clearly instead of silently reverting file-only
	// settings (for example retention) to defaults — an explicitly selected
	// missing file, an unreadable existing file, malformed JSON, or a
	// non-object top level all indicate operator intent that must not be
	// dropped before connecting and mutating.
	let raw: string
	try {
		raw = fs.readFileSync(filePath, "utf-8")
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code
		if (code === "ENOENT" && !explicit) {
			return undefined
		}
		if (code === "ENOENT") {
			throw new Error(
				`Memongo config file not found at "${filePath}" (selected via MEMONGO_CONFIG_PATH). Create it or unset MEMONGO_CONFIG_PATH.`,
			)
		}
		// fs error messages carry the path and error code only — no content.
		throw new Error(
			`Memongo config file at "${filePath}" could not be read (${code ?? "unknown error"}).`,
			{ cause: error },
		)
	}
	let parsed: unknown
	try {
		parsed = JSON.parse(raw)
	} catch {
		// JSON.parse error messages echo source text on some supported Node
		// versions; the file may contain credentials, so the parse error and
		// its cause are deliberately excluded.
		throw new Error(
			`Memongo config file at "${filePath}" is not valid JSON. Fix or remove the file.`,
		)
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error(
			`Memongo config file at "${filePath}" must contain a JSON object at the top level.`,
		)
	}
	return parsed as { memory?: MemoryConfig; agents?: MemongoConfig["agents"] }
}

export function buildMemongoConfig(
	env: NodeJS.ProcessEnv = process.env,
): MemongoConfig {
	const filePath = resolveMemongoConfigFilePath(env)
	const fromFile = readMemongoJsonFile(
		filePath,
		env.MEMONGO_CONFIG_PATH?.trim() !== undefined &&
			env.MEMONGO_CONFIG_PATH.trim().length > 0,
	)

	// P2.6: one URI precedence rule, shared with the engine via
	// applyMongoDbForceUriOverride (@memongo/lib): MEMONGO_FORCE_MONGODB_URI
	// wins over every other URI source, in every layer. Among the non-force
	// sources the bridge is env-first (plain env URI beats the file URI).
	const uriFromEnv = env.MEMONGO_MONGODB_URI?.trim()
	const uriFromFile = fromFile?.memory?.mongodb?.uri?.trim()
	const uri = applyMongoDbForceUriOverride(
		env.MEMONGO_FORCE_MONGODB_URI,
		uriFromEnv || uriFromFile,
	)
	const collectionPrefixFromEnv = env.MEMONGO_MONGODB_COLLECTION_PREFIX?.trim()
	const databaseFromEnv = env.MEMONGO_MONGODB_DATABASE?.trim()

	const mergedMongo: MemoryConfig["mongodb"] = {
		...fromFile?.memory?.mongodb,
		...(uri ? { uri } : {}),
		...(databaseFromEnv ? { database: databaseFromEnv } : {}),
		...(collectionPrefixFromEnv
			? { collectionPrefix: collectionPrefixFromEnv }
			: {}),
	}

	const memory: MemoryConfig = {
		backend: "mongodb",
		citations: fromFile?.memory?.citations ?? "auto",
		sources: fromFile?.memory?.sources,
		mongodb: mergedMongo,
	}

	const workspace = resolveMemongoStandaloneWorkspaceDir(env)

	return {
		memory,
		agents: {
			...fromFile?.agents,
			defaults: {
				...fromFile?.agents?.defaults,
				workspace,
			},
		},
	}
}

export function resolveBridgeConfig(): MemongoConfig {
	return buildMemongoConfig()
}
