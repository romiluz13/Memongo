import { existsSync } from "node:fs"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"

const LOCAL_WORKFLOW_ARTIFACT_SEGMENTS = [
	".claude",
	"cc10x",
	"v10",
	"workflows",
	"memongo-memory-hardening",
	"artifacts",
] as const

export function getDefaultProofArtifactDir(cwd = process.cwd()): string {
	return path.join(cwd, ...LOCAL_WORKFLOW_ARTIFACT_SEGMENTS)
}

export function resolveProofArtifactDir(params?: {
	cwd?: string
	env?: NodeJS.ProcessEnv
}): string | null {
	const cwd = params?.cwd ?? process.cwd()
	const env = params?.env ?? process.env
	const configuredDir = env.MEMONGO_PROOF_ARTIFACT_DIR?.trim()
	if (configuredDir) {
		return path.isAbsolute(configuredDir)
			? configuredDir
			: path.resolve(cwd, configuredDir)
	}

	const defaultDir = getDefaultProofArtifactDir(cwd)
	return existsSync(defaultDir) ? defaultDir : null
}

function sanitizeSuiteName(suite: string): string {
	const normalized = suite
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9-]+/g, "-")
	return normalized.replace(/^-+|-+$/g, "") || "proof"
}

export async function writeProofArtifact(params: {
	suite: string
	payload: unknown
	cwd?: string
	env?: NodeJS.ProcessEnv
	now?: Date
}): Promise<string | null> {
	const dir = resolveProofArtifactDir({ cwd: params.cwd, env: params.env })
	if (!dir) {
		return null
	}

	const suite = sanitizeSuiteName(params.suite)
	const fileName = `${(params.now ?? new Date()).toISOString().replace(/[:.]/g, "-")}.json`
	const targetDir = path.join(dir, suite)
	const filePath = path.join(targetDir, fileName)

	await mkdir(targetDir, { recursive: true })
	await writeFile(filePath, JSON.stringify(params.payload, null, 2), "utf8")

	return filePath
}
