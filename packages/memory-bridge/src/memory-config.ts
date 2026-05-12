import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type { MemoryConfig, MemongoConfig } from "@memongo/lib"

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
): { memory?: MemoryConfig; agents?: MemongoConfig["agents"] } | undefined {
	try {
		if (!fs.existsSync(filePath)) {
			return undefined
		}
		const raw = fs.readFileSync(filePath, "utf-8")
		const parsed = JSON.parse(raw) as unknown
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			return undefined
		}
		return parsed as { memory?: MemoryConfig; agents?: MemongoConfig["agents"] }
	} catch {
		return undefined
	}
}

export function buildMemongoConfig(
	env: NodeJS.ProcessEnv = process.env,
): MemongoConfig {
	const filePath = resolveMemongoConfigFilePath(env)
	const fromFile = readMemongoJsonFile(filePath)

	const uriFromEnv =
		env.MEMONGO_MONGODB_URI?.trim() || env.MEMONGO_FORCE_MONGODB_URI?.trim()
	const uriFromFile = fromFile?.memory?.mongodb?.uri?.trim()
	const uri = uriFromEnv || uriFromFile
	const collectionPrefixFromEnv = env.MEMONGO_MONGODB_COLLECTION_PREFIX?.trim()

	const mergedMongo: MemoryConfig["mongodb"] = {
		...fromFile?.memory?.mongodb,
		...(uri ? { uri } : {}),
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
