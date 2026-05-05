import { execFileSync } from "node:child_process"

export function hasAtlasModelKey(value: string | undefined): boolean {
	return typeof value === "string" && value.trim().startsWith("al-")
}

function safeExecFile(command: string, args: string[]): string {
	try {
		return execFileSync(command, args, {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim()
	} catch {
		return ""
	}
}

function resolvePreviewContainerName(): string {
	const raw = safeExecFile("docker", [
		"ps",
		"--format",
		"{{.Names}}\t{{.Image}}",
	])
	if (!raw) {
		return ""
	}
	for (const line of raw.split("\n")) {
		const [name, image] = line.split("\t")
		if (image === "mongodb/mongodb-atlas-local:preview") {
			return name ?? ""
		}
	}
	return ""
}

function resolvePreviewPort(containerName: string): string {
	if (!containerName) {
		return ""
	}
	const raw = safeExecFile("docker", ["port", containerName, "27017"])
	if (!raw) {
		return ""
	}
	const firstLine = raw.split("\n")[0] ?? ""
	const match = firstLine.match(/:(\d+)\s*$/)
	return match?.[1] ?? ""
}

function readContainerEnv(containerName: string): Record<string, string> {
	if (!containerName) {
		return {}
	}
	const raw = safeExecFile("docker", [
		"inspect",
		"--format",
		"{{range .Config.Env}}{{println .}}{{end}}",
		containerName,
	])
	if (!raw) {
		return {}
	}
	const entries: Record<string, string> = {}
	for (const line of raw.split("\n")) {
		const idx = line.indexOf("=")
		if (idx <= 0) {
			continue
		}
		entries[line.slice(0, idx)] = line.slice(idx + 1)
	}
	return entries
}

export function resolvePreviewVoyageApiKey(): string {
	const atlasModelKey = (process.env.VOYAGE_API_KEY ?? "").trim()
	if (hasAtlasModelKey(atlasModelKey)) {
		return atlasModelKey
	}

	const envKey =
		process.env.VOYAGE_RERANK_API_KEY?.trim() ||
		atlasModelKey ||
		process.env.VOYAGE_API_QUERY_KEY?.trim() ||
		process.env.VOYAGE_API_INDEXING_KEY?.trim() ||
		""
	if (envKey.trim()) {
		return envKey.trim()
	}

	const containerName = resolvePreviewContainerName()
	const containerEnv = readContainerEnv(containerName)
	const containerAtlasModelKey = (containerEnv.VOYAGE_API_KEY ?? "").trim()
	if (hasAtlasModelKey(containerAtlasModelKey)) {
		return containerAtlasModelKey
	}
	return (
		containerEnv.VOYAGE_RERANK_API_KEY?.trim() ||
		containerAtlasModelKey ||
		containerEnv.VOYAGE_API_QUERY_KEY?.trim() ||
		containerEnv.VOYAGE_API_INDEXING_KEY?.trim() ||
		""
	).trim()
}

export function resolvePreviewMongoTestUri(fallbackUri: string): string {
	if (process.env.MONGODB_TEST_URI?.trim()) {
		return process.env.MONGODB_TEST_URI.trim()
	}
	const containerName = resolvePreviewContainerName()
	const port = resolvePreviewPort(containerName)
	if (port) {
		return `mongodb://127.0.0.1:${port}/?directConnection=true`
	}
	return fallbackUri
}
