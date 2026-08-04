import { execFileSync, spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
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
	piExtension?: boolean
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
	{
		dir: "packages/pi-extension",
		name: "@memongo/pi-extension",
		supportedSurface: false,
		piExtension: true,
	},
	{
		dir: "apps/mcp",
		name: "@memongo/mcp",
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
const requiredNodeEngine = ">=20.19.0"
const forbiddenTarballPatterns = [
	/^src\//,
	/\.test\.ts$/,
	/\.e2e\.test\.ts$/,
	/\.test-mocks\.ts$/,
	/(?:^|\/)[^/]*\.test\.(?:js|d\.ts|js\.map|d\.ts\.map)$/,
	/(?:^|\/)[^/]*\.test-mocks\.(?:js|d\.ts|js\.map|d\.ts\.map)$/,
	/^dist\/(?:benchmark-|mongodb-benchmark-|mongodb-manager-benchmark|mongodb-conversation-recall-benchmark)/,
	/^dist\/(?:fact-extraction-eval|mongodb-e2e-qa)/,
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

export function findForbiddenPackageArtifact(
	artifactPaths: string[],
): string | undefined {
	return artifactPaths.find((artifactPath) =>
		forbiddenTarballPatterns.some((pattern) => pattern.test(artifactPath)),
	)
}

export function assertAlignedInternalDependencies(
	packageJson: Record<string, unknown>,
	publishedVersions: ReadonlyMap<string, string>,
) {
	const packageName = assertStringField(packageJson, "name", "package.json")
	for (const dependencyField of [
		"dependencies",
		"optionalDependencies",
	] as const) {
		const dependencies = packageJson[dependencyField]
		if (typeof dependencies !== "object" || dependencies === null) {
			continue
		}
		for (const [dependencyName, dependencyRange] of Object.entries(
			dependencies as Record<string, unknown>,
		)) {
			const expectedVersion = publishedVersions.get(dependencyName)
			if (!expectedVersion) {
				continue
			}
			const expectedRange = `^${expectedVersion}`
			if (dependencyRange !== expectedRange) {
				fail(
					`${packageName} must depend on ${dependencyName} using "${expectedRange}", found ${JSON.stringify(dependencyRange)}`,
				)
			}
		}
	}
}

type ToolRunResult = { ok: boolean; output: string }

function runCapturing(cmd: string, args: string[], cwd: string): ToolRunResult {
	try {
		execFileSync(cmd, args, {
			cwd,
			encoding: "utf-8",
			stdio: "pipe",
			timeout: 180_000,
		})
		return { ok: true, output: "" }
	} catch (err) {
		const e = err as {
			stdout?: string | Buffer
			stderr?: string | Buffer
			message?: string
		}
		const output = [e.stdout, e.stderr]
			.filter((chunk) => chunk !== undefined && chunk !== null)
			.map((chunk) => String(chunk).trim())
			.filter((chunk) => chunk.length > 0)
			.join("\n")
		return { ok: false, output: output || (e.message ?? "unknown error") }
	}
}

/** Probe whether a bunx-invoked tool can be installed and started. */
function probeTool(binName: string): boolean {
	return runCapturing("bunx", [binName, "--help"], rootDir).ok
}

type ExternalLintAvailability = {
	publint: boolean
	attw: boolean
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

function assertVersionIsUnpublished(packageName: string, version: string) {
	const result = spawnSync(
		"npm",
		["view", `${packageName}@${version}`, "version", "--json"],
		{
			cwd: rootDir,
			encoding: "utf-8",
			stdio: "pipe",
			timeout: 30_000,
		},
	)
	if (result.status === 0 && result.stdout.trim() !== "") {
		fail(`release version already exists on npm: ${packageName}@${version}`)
	}
	const output = `${result.stdout}\n${result.stderr}`
	if (
		result.status === 1 &&
		/(?:E404|is not in this registry|No match found for version)/i.test(output)
	) {
		return
	}
	fail(
		`could not verify npm version availability for ${packageName}@${version}: ${output.trim() || `npm exited ${result.status}`}`,
	)
}

function listFilesRecursively(dir: string): string[] {
	if (!fs.existsSync(dir)) {
		return []
	}
	return fs
		.readdirSync(dir, { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile())
		.map((entry) => path.relative(dir, path.join(entry.parentPath, entry.name)))
		.sort()
}

function hashDirectory(dir: string): string {
	const hash = createHash("sha256")
	for (const relPath of listFilesRecursively(dir)) {
		hash.update(relPath)
		hash.update("\0")
		hash.update(fs.readFileSync(path.join(dir, relPath)))
		hash.update("\0")
	}
	return hash.digest("hex")
}

function assertNoOrphanDistArtifacts(
	packageDir: string,
	packageRelPath: string,
) {
	const distDir = path.join(packageDir, "dist")
	const srcDir = path.join(packageDir, "src")
	for (const relPath of listFilesRecursively(distDir)) {
		const sourceStem = relPath
			.replace(/\.d\.ts\.map$/, "")
			.replace(/\.js\.map$/, "")
			.replace(/\.d\.ts$/, "")
			.replace(/\.js$/, "")
		const candidates = [".ts", ".tsx", ".mts", ".cts"].map((extension) =>
			path.join(srcDir, `${sourceStem}${extension}`),
		)
		if (!candidates.some((candidate) => fs.existsSync(candidate))) {
			fail(`orphan dist artifact "${relPath}" found in ${packageRelPath}`)
		}
	}
}

function assertReproducibleBuild(packageSpec: PublishablePackage) {
	const packageDir = path.join(rootDir, packageSpec.dir)
	const packageJson = readJson(path.join(packageDir, "package.json"))
	const scripts = packageJson["scripts"] as Record<string, unknown> | undefined
	if (typeof scripts?.build !== "string") {
		fail(`missing build script in ${packageSpec.dir}`)
	}

	execFileSync("bun", ["run", "build"], {
		cwd: packageDir,
		stdio: "pipe",
	})
	const cleanHash = hashDirectory(path.join(packageDir, "dist"))

	const staleDir = path.join(packageDir, "dist")
	fs.mkdirSync(staleDir, { recursive: true })
	fs.writeFileSync(
		path.join(staleDir, "__memongo_stale_release_artifact__.test.js"),
		"throw new Error('stale release artifact')\n",
	)
	execFileSync("bun", ["run", "build"], {
		cwd: packageDir,
		stdio: "pipe",
	})
	const dirtyHash = hashDirectory(path.join(packageDir, "dist"))
	if (cleanHash !== dirtyHash) {
		fail(
			`clean and dirty dist builds differ for ${packageSpec.name}: ${cleanHash} != ${dirtyHash}`,
		)
	}
	assertNoOrphanDistArtifacts(packageDir, packageSpec.dir)
}

// npm <=11 emits `npm pack --json` results as a one-element array; npm 12
// emits an object keyed by package name. Accept exactly one result either way.
function singlePackResult<T>(
	parsed: unknown,
	packageDir: string,
	label: string,
): T {
	if (Array.isArray(parsed) && parsed.length === 1) {
		return parsed[0] as T
	}
	if (parsed !== null && typeof parsed === "object") {
		const values = Object.values(parsed as Record<string, T>)
		if (values.length === 1) {
			return values[0]
		}
	}
	fail(`unexpected ${label} output for ${packageDir}`)
}

function runNpmPackDryRun(packageDir: string): NpmPackDryRunResult {
	const parsed = runJson<unknown>(
		"npm",
		["pack", "--dry-run", "--json"],
		packageDir,
	)
	return singlePackResult<NpmPackDryRunResult>(
		parsed,
		packageDir,
		"npm pack --dry-run",
	)
}

function createTarball(packageDir: string, packDir: string): string {
	const parsed = runJson<unknown>(
		"npm",
		["pack", "--json", "--pack-destination", packDir],
		packageDir,
	)
	const result = singlePackResult<NpmPackResult>(parsed, packageDir, "npm pack")
	return path.join(packDir, result.filename)
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

function assertReleaseHygiene(
	packageJson: Record<string, unknown>,
	packageRelPath: string,
) {
	const engines = packageJson["engines"]
	if (
		typeof engines !== "object" ||
		engines === null ||
		(engines as Record<string, unknown>).node !== requiredNodeEngine
	) {
		fail(`missing "engines.node": "${requiredNodeEngine}" in ${packageRelPath}`)
	}

	const scripts = packageJson["scripts"]
	const clean =
		typeof scripts === "object" && scripts !== null
			? (scripts as Record<string, unknown>).clean
			: undefined
	const build =
		typeof scripts === "object" && scripts !== null
			? (scripts as Record<string, unknown>).build
			: undefined
	const prepublishOnly =
		typeof scripts === "object" && scripts !== null
			? (scripts as Record<string, unknown>).prepublishOnly
			: undefined
	if (typeof clean !== "string" || !clean.includes("rmSync('dist'")) {
		fail(`missing package-local dist clean script in ${packageRelPath}`)
	}
	if (typeof build !== "string" || !build.startsWith("bun run clean && ")) {
		fail(`build must run package-local clean first in ${packageRelPath}`)
	}
	if (typeof prepublishOnly !== "string" || prepublishOnly.trim() === "") {
		fail(`missing "prepublishOnly" build script in ${packageRelPath}`)
	}

	for (const depField of [
		"dependencies",
		"peerDependencies",
		"optionalDependencies",
	] as const) {
		const deps = packageJson[depField]
		if (typeof deps !== "object" || deps === null) {
			continue
		}
		const mongodb = (deps as Record<string, unknown>).mongodb
		if (typeof mongodb === "string" && /^\d+\.\d+\.\d+$/.test(mongodb)) {
			fail(
				`"mongodb" must use a semver range (e.g. ^7.2.0), not the exact pin "${mongodb}", in ${packageRelPath}`,
			)
		}
	}
}

function readExportedVersion(filePath: string, exportName: string): string {
	const relPath = path.relative(rootDir, filePath)
	if (!fs.existsSync(filePath)) {
		fail(`missing version source file: ${relPath}`)
	}
	const source = fs.readFileSync(filePath, "utf-8")
	const match = source.match(
		new RegExp(`export const ${exportName} = "([^"]+)"`),
	)
	if (!match) {
		fail(`missing ${exportName} export in ${relPath}`)
	}
	return match[1]
}

function checkVersionConsistency(): Map<string, string> {
	const rootPackageJson = readJson(path.join(rootDir, "package.json"))
	const releaseVersion = assertStringField(
		rootPackageJson,
		"version",
		"package.json",
	)
	const apiVersion = readExportedVersion(
		path.join(rootDir, "apps/api/src/version.ts"),
		"MEMONGO_API_VERSION",
	)
	const mcpVersion = readExportedVersion(
		path.join(rootDir, "apps/mcp/src/version.ts"),
		"MEMONGO_SERVER_VERSION",
	)
	if (apiVersion !== releaseVersion) {
		fail(
			`OpenAPI/version surface drift: apps/api reports ${apiVersion}, workspace release is ${releaseVersion}`,
		)
	}
	if (mcpVersion !== releaseVersion) {
		fail(
			`MCP server version drift: apps/mcp reports ${mcpVersion}, workspace release is ${releaseVersion}`,
		)
	}

	const clientPackageJson = readJson(
		path.join(rootDir, "packages/client/package.json"),
	)
	const clientPackageVersion = assertStringField(
		clientPackageJson,
		"version",
		"packages/client/package.json",
	)
	const clientHeaderVersion = readExportedVersion(
		path.join(rootDir, "packages/client/src/version.ts"),
		"MEMONGO_CLIENT_VERSION",
	)
	if (clientHeaderVersion !== clientPackageVersion) {
		fail(
			`client version header drift: x-memongo-client-version reports ${clientHeaderVersion}, packages/client is ${clientPackageVersion}`,
		)
	}
	const publishedVersions = new Map<string, string>()
	for (const packageSpec of publishablePackages) {
		const packageJson = readJson(
			path.join(rootDir, packageSpec.dir, "package.json"),
		)
		const packageName = assertStringField(
			packageJson,
			"name",
			`${packageSpec.dir}/package.json`,
		)
		const packageVersion = assertStringField(
			packageJson,
			"version",
			`${packageSpec.dir}/package.json`,
		)
		if (!packageSpec.piExtension && packageVersion !== releaseVersion) {
			fail(
				`package version drift: ${packageName} is ${packageVersion}, workspace release is ${releaseVersion}`,
			)
		}
		publishedVersions.set(packageName, packageVersion)
	}
	for (const packageSpec of publishablePackages) {
		const packageJson = readJson(
			path.join(rootDir, packageSpec.dir, "package.json"),
		)
		assertAlignedInternalDependencies(packageJson, publishedVersions)
	}
	console.log(
		`Version surfaces agree: OpenAPI/MCP ${releaseVersion}, client header ${clientHeaderVersion}.`,
	)
	return publishedVersions
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

function assertBinShebangs(
	packageDir: string,
	packageJson: Record<string, unknown>,
	packageRelPath: string,
) {
	const bin = packageJson["bin"]
	if (bin === undefined) {
		return
	}
	const targets =
		typeof bin === "string"
			? [bin]
			: bin !== null && typeof bin === "object"
				? Object.values(bin as Record<string, unknown>)
				: []
	if (targets.length === 0) {
		fail(`"bin" must be a non-empty string or map in ${packageRelPath}`)
	}
	for (const target of targets) {
		if (typeof target !== "string" || target.trim() === "") {
			fail(`"bin" targets must be non-empty strings in ${packageRelPath}`)
		}
		const resolved = path.join(packageDir, target)
		if (!fs.existsSync(resolved)) {
			fail(`missing built bin target in ${packageRelPath}: ${target}`)
		}
		const fd = fs.openSync(resolved, "r")
		const head = Buffer.alloc(19)
		fs.readSync(fd, head, 0, head.length, 0)
		fs.closeSync(fd)
		if (head.toString("utf-8") !== "#!/usr/bin/env node") {
			fail(
				`bin target missing "#!/usr/bin/env node" shebang in ${packageRelPath}: ${target}`,
			)
		}
	}
}

function assertPiExtensions(
	packageDir: string,
	packageJson: Record<string, unknown>,
	packageRelPath: string,
): string[] {
	const pi = packageJson["pi"]
	if (typeof pi !== "object" || pi === null) {
		fail(`missing "pi" manifest in ${packageRelPath}`)
	}
	const ext = (pi as Record<string, unknown>).extensions
	if (!Array.isArray(ext) || ext.length === 0) {
		fail(`"pi.extensions" must be a non-empty array in ${packageRelPath}`)
	}
	const paths: string[] = []
	for (const entry of ext) {
		if (typeof entry !== "string") {
			fail(`"pi.extensions" entries must be strings in ${packageRelPath}`)
		}
		const relPath = entry.replace(/^\.\//, "")
		paths.push(relPath)
		const resolved = path.join(packageDir, relPath)
		if (!fs.existsSync(resolved)) {
			fail(`missing pi extension entrypoint in ${packageRelPath}: ${relPath}`)
		}
	}
	return paths
}

function assertTarballContents(
	packageRelPath: string,
	packageJson: Record<string, unknown>,
	packResult: NpmPackDryRunResult,
	piExtensionPaths?: string[],
) {
	const tarballPaths = new Set(packResult.files.map((file) => file.path))
	if (!tarballPaths.has("README.md")) {
		fail(`package tarball is missing README.md: ${packageRelPath}`)
	}

	if (piExtensionPaths && piExtensionPaths.length > 0) {
		for (const requiredFile of piExtensionPaths) {
			// Entry can be a file or a directory. For directories, npm packs
			// the files inside (e.g. "extensions/index.ts"), not the dir name.
			const found =
				tarballPaths.has(requiredFile) ||
				[...tarballPaths].some((p) => p.startsWith(`${requiredFile}/`))
			if (!found) {
				fail(
					`package tarball is missing pi extension entrypoint "${requiredFile}" in ${packageRelPath}`,
				)
			}
		}
	} else {
		const main = assertStringField(packageJson, "main", packageRelPath).replace(
			/^\.\//,
			"",
		)
		const types = assertStringField(
			packageJson,
			"types",
			packageRelPath,
		).replace(/^\.\//, "")
		for (const requiredFile of [main, types]) {
			if (!tarballPaths.has(requiredFile)) {
				fail(
					`package tarball is missing built entrypoint "${requiredFile}" in ${packageRelPath}`,
				)
			}
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

function runExternalLintChecks(
	packageSpec: PublishablePackage,
	tarballPath: string,
	unpackedPackageDir: string,
	availability: ExternalLintAvailability,
	skips: string[],
) {
	if (packageSpec.piExtension) {
		// Pi extensions ship unbuilt TS loaded by Pi's jiti loader; they have no
		// Node entrypoints for publint/attw to evaluate.
		skips.push(
			`publint/attw: ${packageSpec.name} (pi extension, no JS entrypoints)`,
		)
		return
	}
	if (availability.publint) {
		const result = runCapturing("bunx", ["publint"], unpackedPackageDir)
		if (!result.ok) {
			fail(`publint failed for ${packageSpec.name}:\n${result.output}`)
		}
	} else {
		skips.push(`publint: ${packageSpec.name} (tool unavailable offline)`)
	}
	if (availability.attw) {
		// All publishable packages are deliberately ESM-only
		// (engines.node >= 20.19.0), so the strict profile's node10/CJS-consumer
		// rows do not apply.
		const result = runCapturing(
			"bunx",
			["@arethetypeswrong/cli", "--profile", "esm-only", tarballPath],
			rootDir,
		)
		if (!result.ok) {
			fail(`attw failed for ${packageSpec.name}:\n${result.output}`)
		}
	} else {
		skips.push(`attw: ${packageSpec.name} (tool unavailable offline)`)
	}
}

function checkPackage(
	packageSpec: PublishablePackage,
	packDir: string,
	availability: ExternalLintAvailability,
	skips: string[],
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
	assertReleaseHygiene(packageJson, packageSpec.dir)

	let piExtensionPaths: string[] | undefined
	if (packageSpec.piExtension) {
		piExtensionPaths = assertPiExtensions(
			packageDir,
			packageJson,
			packageSpec.dir,
		)
	} else {
		assertBuiltEntrypoints(packageDir, packageJson, packageSpec.dir)
	}
	assertBinShebangs(packageDir, packageJson, packageSpec.dir)

	const dryRun = runNpmPackDryRun(packageDir)
	assertTarballContents(packageSpec.dir, packageJson, dryRun, piExtensionPaths)

	const tarballPath = createTarball(packageDir, packDir)
	const unpackDir = fs.mkdtempSync(path.join(packDir, "unpack-"))
	unpackTarball(tarballPath, unpackDir)
	const packedManifest = readJson(
		path.join(unpackDir, "package", "package.json"),
	)
	assertPackedManifest(packageSpec, packedManifest)
	runExternalLintChecks(
		packageSpec,
		tarballPath,
		path.join(unpackDir, "package"),
		availability,
		skips,
	)

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
	if (
		publishWorkflow.includes('npm view "$name@$version"') ||
		publishWorkflow.includes("previously published versions") ||
		publishWorkflow.includes("Skipping $name@$version")
	) {
		fail(
			"publish workflow still silently skips packages whose version already exists",
		)
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

	if (targetPackage.piExtension) {
		// Pi extensions are loaded by Pi's jiti loader, not Node module resolution.
		// Verify the pi manifest + extension entrypoints exist in the installed tarball.
		const installedPkg = readJson(
			path.join(installDir, "node_modules", targetPackage.name, "package.json"),
		)
		const pi = installedPkg["pi"]
		if (
			typeof pi !== "object" ||
			pi === null ||
			!Array.isArray((pi as Record<string, unknown>).extensions)
		) {
			fail(
				`installed pi extension missing "pi.extensions" manifest: ${targetPackage.name}`,
			)
		}
		const ext = (pi as Record<string, unknown>).extensions as string[]
		for (const entry of ext) {
			const relPath = entry.replace(/^\.\//, "")
			if (
				!fs.existsSync(
					path.join(installDir, "node_modules", targetPackage.name, relPath),
				)
			) {
				fail(
					`installed pi extension missing entrypoint "${relPath}": ${targetPackage.name}`,
				)
			}
		}
		return
	}

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
	const publishedVersions = checkVersionConsistency()
	for (const [packageName, version] of publishedVersions) {
		assertVersionIsUnpublished(packageName, version)
	}
	for (const packageSpec of publishablePackages) {
		assertReproducibleBuild(packageSpec)
	}

	const availability: ExternalLintAvailability = {
		publint: probeTool("publint"),
		attw: probeTool("@arethetypeswrong/cli"),
	}
	const skips: string[] = []

	const packDir = fs.mkdtempSync(path.join(os.tmpdir(), "memongo-packs-"))
	const tarballs = publishablePackages.map((packageSpec) =>
		checkPackage(packageSpec, packDir, availability, skips),
	)
	const tarballsByName = new Map(
		tarballs.map((entry) => [entry.name, entry.tarballPath]),
	)

	for (const packageSpec of publishablePackages) {
		installSmoke(packageSpec, tarballsByName)
	}

	for (const skip of skips) {
		console.log(`SKIP ${skip}`)
	}
	const supportedCount = tarballs.filter(
		(entry) => entry.supportedSurface,
	).length
	console.log(
		`Publishability checks passed for ${supportedCount} supported packages and ${publishablePackages.length - supportedCount} runtime support package.`,
	)
}

if (import.meta.main) {
	main()
}
