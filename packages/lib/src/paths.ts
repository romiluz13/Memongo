import os from "node:os"
import path from "node:path"

export function resolveUserPath(p: string): string {
	if (p.startsWith("~/") || p === "~") {
		return path.join(os.homedir(), p.slice(1))
	}
	if (p.startsWith("~")) {
		return path.join(os.homedir(), p.slice(1))
	}
	return path.resolve(p)
}

export function memongoDataDir(): string {
	return resolveUserPath("~/.memongo")
}

export function memongoAgentDir(agentId: string): string {
	return path.join(memongoDataDir(), "agents", agentId)
}

export function ensureTrailingSlash(dir: string): string {
	return dir.endsWith(path.sep) ? dir : `${dir}${path.sep}`
}
