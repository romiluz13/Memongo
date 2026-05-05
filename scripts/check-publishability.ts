import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

type NpmPackFile = {
	path: string
	size: number
	mode: number
}

type NpmPackDryRunResult = {
	name: string
	version: string
	files: NpmPackFile[]
}

type NpmPackResult = {
	name: string
	version: string
	filename: string
}

type PublishablePackage = {
	dir: string
	name: string
	supportedSurface: boolean
}

const rootDir = process.cwd()
const publishablePackages: PublishablePackage[] = [
	{
		dir: "packages/lib",
		name: "@memongo/lib",
		supportedSurface: false,
	},
	{
		dir: "packages/memory-engine",
		name: "@memongo/memory-engine",
		supportedSurface: true,
	},
	{
		dir: "packages/memory-bridge",
		name: "@memongo/memory-bridge",
		supportedSurface: true,
	},
	{
		dir: "packages/memongo-memory",
		name: "@memongo/memory",
		supportedSurface: true,
	},
	{
		dir: "packages/client",
		name: "@memongo/client",
		supportedSurface: true,
	},
	{
		dir: "packages/tools",
		name: "@memongo/tools",
		supportedSurface: true,
	},
] as const

const removedPaths = [
	"apps/browser-extension/package.json",
	"apps/memory-graph-playground/package.json",
	"packages/ai-sdk/package.json",
	"packages/hooks/package.json",
	"packages/memory-graph/package.json",
	"packages/ui/package.json",
	"packages/validation/package.json",
] as const

const requiredMetadata = ["license", "repository", "homepage", "bugs"] as const
const forbiddenTarballPatterns = [
	/^src\//,
	/\.test\.ts$/,
	/\.e2e\.test\.ts$/,
	/\.test-mocks\.ts$/,
	/^test\//,
	/^tsconfig\.json$/,
] as const
const forbiddenPrivateDeps = new Set([
	"@memongo/api",
	"@memongo/mcp",
	"@memongo/web",
	"@memongo/docs",
])

function fail(message: string): never {
	throw new Error(message)
}

function readJson(filePath: string): Record<string, unknown> {
	return JSON.parse(fs.readFileSync(filePath, "utf-8")) as Record<
		string,
		unknown
	>
}

function runJson<T>(cmd: string, args: string[], cwd: string): T {
	const raw = execFileSync(cmd, args, {
		cwd,
		encoding: "utf-8",
		stdio: "pipe",
	})
	return JSON.parse(raw) as T
}

function runNpmPackDryRun(packageDir: string): NpmPackDryRunResult {
	const parsed = runJson<NpmPackDryRunResult[]>(
		"npm",
		["pack", "--dry-run", "--json"],
		packageDir,
	)
	if (!Array.isArray(parsed) || parsed.length !== 1) {
		fail(`unexpected npm pack --dry-run output for ${packageDir}`)
	}
	return parsed[0]
}

function createTarball(packageDir: string, packDir: string): string {
	const parsed = runJson<NpmPackResult[]>(
		"npm",
		["pack", "--json", "--pack-destination", packDir],
		packageDir,
	)
	if (!Array.isArray(parsed) || parsed.length !== 1) {
		fail(`unexpected npm pack output for ${packageDir}`)
	}
	return path.join(packDir, parsed[0].filename)
}

function unpackTarball(tarballPath: string, destDir: string) {
	fs.mkdirSync(destDir, { recursive: true })
	execFileSync("tar", ["-xzf", tarballPath, "-C", destDir], {
		stdio: "pipe",
	})
}

function assertStringField(
	packageJson: Record<string, unknown>,
	field: string,
	packageRelPath: string,
): string {
	const value = packageJson[field]
	if (typeof value !== "string" || value.trim() === "") {
		fail(`missing string field "${field}" in ${packageRelPath}`)
	}
	return value
}

function assertMetadata(
	packageJson: Record<string, unknown>,
	packageRelPath: string,
) {
	for (const field of requiredMetadata) {
		if (!(field in packageJson)) {
			fail(`missing package metadata field "${field}" in ${packageRelPath}`)
		}
	}
}

function assertBuiltEntrypoints(
	packageDir: string,
	packageJson: Record<string, unknown>,
	packageRelPath: string,
) {
	const main = assertStringField(packageJson, "main", packageRelPath)
	const types = assertStringField(packageJson, "types", packageRelPath)

	for (const relPath of [main, types]) {
		if (!relPath.startsWith("./dist/")) {
			fail(`entrypoint must point to dist in ${packageRelPath}: ${relPath}`)
		}
		if (!fs.existsSync(path.join(packageDir, relPath))) {
			fail(`missing built entrypoint in ${packageRelPath}: ${relPath}`)
		}
	}
}

function assertTarballContents(
	packageRelPath: string,
	packageJson: Record<string, unknown>,
	packResult: NpmPackDryRunResult,
) {
	const tarballPaths = new Set(packResult.files.map((file) => file.path))
	if (!tarballPaths.has("README.md")) {
		fail(`package tarball is missing README.md: ${packageRelPath}`)
	}

	const main = assertStringField(packageJson, "main", packageRelPath).replace(
		/^\.\//,
		"",
	)
	const types = assertStringField(packageJson, "types", packageRelPath).replace(
		/^\.\//,
		"",
	)
	for (const requiredFile of [main, types]) {
		if (!tarballPaths.has(requiredFile)) {
			fail(
				`package tarball is missing built entrypoint "${requiredFile}" in ${packageRelPath}`,
			)
		}
	}

	for (const file of packResult.files) {
		for (const pattern of forbiddenTarballPatterns) {
			if (pattern.test(file.path)) {
				fail(
					`forbidden tarball entry "${file.path}" found in ${packageRelPath}`,
				)
			}
		}
	}
}

function assertPackedManifest(
	packageSpec: PublishablePackage,
	packedManifest: Record<string, unknown>,
) {
	const deps = {
		...(packedManifest.dependencies as Record<string, string> | undefined),
		...(packedManifest.optionalDependencies as
			| Record<string, string>
			| undefined),
	}
	for (const [depName, depVersion] of Object.entries(deps)) {
		if (typeof depVersion !== "string") {
			continue
		}
		if (depVersion.includes("workspace:")) {
			fail(
				`packed manifest still contains workspace dependency "${depName}" in ${packageSpec.dir}`,
			)
		}
		if (forbiddenPrivateDeps.has(depName)) {
			fail(
				`packed manifest depends on private workspace package "${depName}" in ${packageSpec.dir}`,
			)
		}
	}
}

function checkPackage(
	packageSpec: PublishablePackage,
	packDir: string,
): { name: string; tarballPath: string; supportedSurface: boolean } {
	const packageDir = path.join(rootDir, packageSpec.dir)
	const packageJsonPath = path.join(packageDir, "package.json")
	const readmePath = path.join(packageDir, "README.md")

	if (!fs.existsSync(packageJsonPath)) {
		fail(`missing publishable package manifest: ${packageSpec.dir}`)
	}
	if (!fs.existsSync(readmePath)) {
		fail(`missing package README: ${packageSpec.dir}/README.md`)
	}

	const packageJson = readJson(packageJsonPath)
	assertMetadata(packageJson, packageSpec.dir)
	assertBuiltEntrypoints(packageDir, packageJson, packageSpec.dir)

	const dryRun = runNpmPackDryRun(packageDir)
	assertTarballContents(packageSpec.dir, packageJson, dryRun)

	const tarballPath = createTarball(packageDir, packDir)
	const unpackDir = fs.mkdtempSync(path.join(packDir, "unpack-"))
	unpackTarball(tarballPath, unpackDir)
	const packedManifest = readJson(
		path.join(unpackDir, "package", "package.json"),
	)
	assertPackedManifest(packageSpec, packedManifest)

	return {
		name: packageSpec.name,
		tarballPath,
		supportedSurface: packageSpec.supportedSurface,
	}
}

function checkRemovedPaths() {
	for (const removedPath of removedPaths) {
		if (fs.existsSync(path.join(rootDir, removedPath))) {
			fail(`removed path still exists: ${removedPath}`)
		}
	}
}

function checkPublishWorkflow() {
	const publishWorkflowPath = path.join(
		rootDir,
		".github/workflows/publish.yml",
	)
	const publishWorkflow = fs.readFileSync(publishWorkflowPath, "utf-8")
	if (publishWorkflow.includes("|| true")) {
		fail("publish workflow still swallows publish failures with || true")
	}

	const legacyWorkflowPath = path.join(
		rootDir,
		".github/workflows/publish-ai-sdk.yml",
	)
	if (fs.existsSync(legacyWorkflowPath)) {
		fail("legacy AI SDK publish workflow still exists")
	}
}

function installSmoke(
	targetPackage: PublishablePackage,
	tarballsByName: Map<string, string>,
) {
	const installDir = fs.mkdtempSync(
		path.join(os.tmpdir(), "memongo-pack-smoke-"),
	)
	const dependencies = Object.fromEntries(
		Array.from(tarballsByName.entries()).map(([name, tarballPath]) => [
			name,
			`file:${tarballPath}`,
		]),
	)

	if (targetPackage.name === "@memongo/tools") {
		dependencies.ai = "^5.0.0"
	}

	fs.writeFileSync(
		path.join(installDir, "package.json"),
		JSON.stringify(
			{
				name: "memongo-pack-smoke",
				private: true,
				type: "module",
				dependencies,
			},
			null,
			2,
		),
	)

	execFileSync("npm", ["install", "--ignore-scripts", "--no-package-lock"], {
		cwd: installDir,
		stdio: "pipe",
	})
	execFileSync(
		"node",
		[
			"--input-type=module",
			"-e",
			`import(${JSON.stringify(targetPackage.name)}).then(() => process.exit(0))`,
		],
		{
			cwd: installDir,
			stdio: "pipe",
		},
	)
}

function main() {
	checkRemovedPaths()
	checkPublishWorkflow()

	const packDir = fs.mkdtempSync(path.join(os.tmpdir(), "memongo-packs-"))
	const tarballs = publishablePackages.map((packageSpec) =>
		checkPackage(packageSpec, packDir),
	)
	const tarballsByName = new Map(
		tarballs.map((entry) => [entry.name, entry.tarballPath]),
	)

	for (const packageSpec of publishablePackages) {
		installSmoke(packageSpec, tarballsByName)
	}

	const supportedCount = tarballs.filter(
		(entry) => entry.supportedSurface,
	).length
	console.log(
		`Publishability checks passed for ${supportedCount} supported packages and ${publishablePackages.length - supportedCount} runtime support package.`,
	)
}

main()
