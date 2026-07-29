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
	// Both names are honored because the suite grew two of them, and a file
	// reading the one the operator did not set silently falls back to localhost
	// and "passes" against a cluster nobody targeted. That is a gate that lies:
	// an Atlas run reported six files green that had never left the laptop.
	const explicit =
		process.env.MONGODB_TEST_URI?.trim() ||
		process.env.MEMONGO_TEST_MONGODB_URI?.trim()
	if (explicit) {
		return explicit
	}
	const containerName = resolvePreviewContainerName()
	const port = resolvePreviewPort(containerName)
	if (port) {
		return `mongodb://127.0.0.1:${port}/?directConnection=true`
	}
	return fallbackUri
}

/**
 * Embed text with the real provider, batched.
 *
 * Suites that need embeddings used to synthesise them — 1024 uniform random
 * numbers per vector. Measured on the evaluation fixtures, that gives every
 * pair of unrelated statements a cosine of ~0.75 (min 0.719, max 0.788),
 * where the real model puts the same pair at ~0.35. Anything scored off those
 * vectors — novelty above all, which is 40% of the consolidation gate — was
 * being driven by noise rather than by meaning.
 *
 * Endpoint selection follows the same rule the engine uses: Atlas Model keys
 * (`al-...`) are only valid against ai.mongodb.com, direct Voyage keys against
 * api.voyageai.com.
 */
export async function embedTextsForTest(
	texts: string[],
	options?: { apiKey?: string; model?: string; batchSize?: number },
): Promise<number[][]> {
	const apiKey = options?.apiKey ?? resolvePreviewVoyageApiKey()
	if (!apiKey) {
		throw new Error(
			"embedTextsForTest requires a Voyage/Atlas Model API key; guard the suite on resolvePreviewVoyageApiKey()",
		)
	}
	const baseUrl = hasAtlasModelKey(apiKey)
		? "https://ai.mongodb.com/v1"
		: "https://api.voyageai.com/v1"
	const model = options?.model ?? "voyage-4-large"
	const batchSize = options?.batchSize ?? 96
	const out: number[][] = []

	for (let i = 0; i < texts.length; i += batchSize) {
		const batch = texts.slice(i, i + batchSize)
		const response = await fetch(`${baseUrl}/embeddings`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${apiKey}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ model, input: batch }),
		})
		if (!response.ok) {
			const detail = await response.text().catch(() => "")
			throw new Error(
				`embedTextsForTest failed: HTTP ${response.status} ${detail.slice(0, 200)}`,
			)
		}
		const payload = (await response.json()) as {
			data?: Array<{ embedding: number[]; index?: number }>
		}
		if (!payload.data || payload.data.length !== batch.length) {
			throw new Error(
				`embedTextsForTest: expected ${batch.length} vectors, got ${payload.data?.length ?? 0}`,
			)
		}
		// The API documents an `index` field; order defensively rather than
		// trusting response order, since a mis-ordered vector would silently
		// attach the wrong meaning to every downstream assertion.
		const ordered = [...payload.data].sort(
			(a, b) => (a.index ?? 0) - (b.index ?? 0),
		)
		out.push(...ordered.map((entry) => entry.embedding))
	}
	return out
}
