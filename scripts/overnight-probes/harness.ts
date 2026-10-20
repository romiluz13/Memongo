import type { Sanitizer } from "./sanitize.ts"

export const DATABASE_PREFIX = "memongo_probe_"
export const OWNER_COLLECTION = "__probe_owner"
export const BOOT_DEADLINE_MS = 300_000
const POLL_MS = 1000
const STOP_GRACE_MS = 15_000
const API_ENTRY = "apps/api/dist/server.js"
const TAIL_LINES = 40
const TAIL_LINE_CHARS = 300
const HEX8 = /^[0-9a-f]{8}$/
const OWNED_NAME = /^memongo_probe_[0-9a-f]{8}$/

export type HarnessRefusalReason =
	| "collision"
	| "port-occupied"
	| "api-not-built"
	| "marker-failed"
	| "spawn-failed"
	| "child-exited"
	| "boot-timeout"
	| "target-mismatch"
	| "target-unverified"
	| "bad-identity"
	| "startup-failed"

export class HarnessRefusal extends Error {
	override name = "HarnessRefusal"
	constructor(
		readonly reason: HarnessRefusalReason,
		message: string,
		readonly tail: string[] = [],
		readonly cleanupFailed = false,
	) {
		super(message)
	}
}

export type OwnershipMarker = {
	runId: string
	database: string
	createdAt: string
	tool: "overnight-probes"
}

export type MongoAdmin = {
	databaseExists(name: string): Promise<boolean>
	writeMarker(name: string, marker: OwnershipMarker): Promise<void>
	readMarker(name: string): Promise<OwnershipMarker | undefined>
	listCollections(name: string): Promise<string[]>
	dropDatabase(name: string): Promise<void>
	listOperations(): Promise<unknown[]>
	killOperation(opid: number | string): Promise<void>
	close(): Promise<void>
}

export type ApiProcess = {
	readonly pid: number | undefined
	readonly exited: boolean
	onLine(cb: (stream: "stdout" | "stderr", line: string) => void): void
	onExit(cb: (code: number | null, signal: string | null) => void): void
	kill(signal: "SIGTERM" | "SIGKILL"): void
}

export type HarnessDeps = {
	mongo: MongoAdmin
	sanitizer: Sanitizer
	fileExists(path: string): boolean
	allocatePort(): Promise<number>
	isPortFree(port: number): Promise<boolean>
	spawnApi(env: Record<string, string>, entry: string): ApiProcess
	fetchJson(
		url: string,
		headers: Record<string, string>,
	): Promise<{ status: number; body: unknown }>
	sleep(ms: number): Promise<void>
	now(): number
	randomHex(chars: number): string
	randomUuid(): string
	withConfigFile(contents: string): { path: string; remove(): void }
	note(line: string): void
}

export function isOwnedDatabaseName(name: string): boolean {
	return OWNED_NAME.test(name)
}

export function generateDatabaseName(
	randomHex: (chars: number) => string,
): string {
	const suffix = randomHex(8)
	const name = `${DATABASE_PREFIX}${suffix}`
	if (!HEX8.test(suffix) || !isOwnedDatabaseName(name)) {
		throw new HarnessRefusal(
			"bad-identity",
			"generated database name is malformed",
		)
	}
	return name
}

export function generateAgentId(randomUuid: () => string): string {
	return `probe-${randomUuid()}`
}

export const APP_NAME_PREFIX = "memongo-probe-api-"

export function withAppName(uri: string, appName: string): string {
	const queryAt = uri.indexOf("?")
	const base = queryAt === -1 ? uri : uri.slice(0, queryAt)
	const query = queryAt === -1 ? "" : uri.slice(queryAt + 1)
	const params = query
		.split("&")
		.filter((part) => part !== "" && !part.toLowerCase().startsWith("appname="))
	params.push(`appName=${appName}`)
	const hostStart = base.indexOf("://") + 3
	const path = base.indexOf("/", hostStart) === -1 ? "/" : ""
	return `${base}${path}?${params.join("&")}`
}

const PASSTHROUGH = [
	"PATH",
	"HOME",
	"TMPDIR",
	"LANG",
	"LC_ALL",
	"TZ",
	"NODE_EXTRA_CA_CERTS",
	"SSL_CERT_FILE",
	"SSL_CERT_DIR",
	"VOYAGE_API_QUERY_KEY",
	"VOYAGE_API_INDEXING_KEY",
] as const

export function buildChildEnv(
	baseEnv: Readonly<Record<string, string | undefined>>,
	target: {
		database: string
		port: number
		apiKey: string
		mongoUri: string
		voyageKey: string
		configPath: string
	},
): Record<string, string> {
	const env: Record<string, string> = {}
	for (const name of PASSTHROUGH) {
		const value = baseEnv[name]
		if (value) env[name] = value
	}
	return {
		...env,
		MEMONGO_API_HOST: "127.0.0.1",
		MEMONGO_API_PORT: String(target.port),
		MEMONGO_API_KEY: target.apiKey,
		MEMONGO_FORCE_MONGODB_URI: target.mongoUri,
		MEMONGO_MONGODB_DATABASE: target.database,
		MEMONGO_CONFIG_PATH: target.configPath,
		VOYAGE_API_KEY: target.voyageKey,
		MEMONGO_EXTRACTION_LLM: "off",
		MEMONGO_API_RATE_LIMIT: "0",
	}
}

export type CleanupReport = {
	stopped: boolean
	dropped: boolean
	cleanupFailed: boolean
	database: string
	detail: string | undefined
}

export type Harness = {
	readonly database: string
	readonly runId: string
	readonly baseUrl: string
	readonly apiKey: string
	readonly appName: string
	readonly pid: number | undefined
	readonly effectiveTarget: { database: string; verified: boolean }
	readonly mongo: MongoAdmin
	stop(): Promise<CleanupReport>
}

export async function startHarness(
	deps: HarnessDeps,
	input: {
		mongoUri: string
		voyageKey: string
		baseEnv?: Readonly<Record<string, string | undefined>>
	},
): Promise<Harness> {
	const safe = (text: string) => deps.sanitizer.text(text)
	const tail: string[] = []
	let child: ApiProcess | undefined
	let configFile: { path: string; remove(): void } | undefined
	let markerWritten = false
	let childExited = false
	let stopReport: CleanupReport | undefined

	const runId = deps.randomUuid()
	const database = generateDatabaseName(deps.randomHex)
	const apiKey = `probe-${deps.randomUuid()}${deps.randomUuid()}`
	deps.sanitizer.register(apiKey)
	const appName = `${APP_NAME_PREFIX}${database.slice(DATABASE_PREFIX.length)}`

	async function stopAll(): Promise<CleanupReport> {
		if (stopReport) return stopReport
		let stopped = true
		const details: string[] = []
		if (child && !childExited) {
			child.kill("SIGTERM")
			const deadline = deps.now() + STOP_GRACE_MS
			while (!child.exited && deps.now() < deadline) await deps.sleep(250)
			if (!child.exited) {
				child.kill("SIGKILL")
				await deps.sleep(250)
				if (!child.exited) {
					stopped = false
					details.push("spawned process did not exit after SIGKILL")
				}
			}
		}
		let dropped = false
		if (markerWritten) {
			try {
				const marker = await deps.mongo.readMarker(database)
				if (
					!isOwnedDatabaseName(database) ||
					marker?.runId !== runId ||
					marker.database !== database
				) {
					details.push("drop refused: ownership marker does not match this run")
				} else {
					await deps.mongo.dropDatabase(database)
					dropped = true
				}
			} catch (error) {
				details.push(
					`drop failed: ${safe(error instanceof Error ? error.message : String(error))}`,
				)
			}
		}
		try {
			await deps.mongo.close()
		} catch (error) {
			details.push(
				`close failed: ${safe(error instanceof Error ? error.message : String(error))}`,
			)
		}
		try {
			configFile?.remove()
		} catch {
			details.push("config file removal failed")
		}
		stopReport = {
			stopped,
			dropped,
			cleanupFailed: markerWritten && !dropped,
			database,
			detail: details.length > 0 ? details.join("; ") : undefined,
		}
		return stopReport
	}

	async function refuse(
		reason: HarnessRefusalReason,
		message: string,
	): Promise<never> {
		const report = await stopAll()
		const suffix = report.cleanupFailed
			? ` (cleanup incomplete for database ${report.database})`
			: ""
		throw new HarnessRefusal(
			reason,
			safe(`${message}${suffix}`),
			[...tail],
			report.cleanupFailed,
		)
	}

	async function boot(): Promise<Harness> {
		if (await deps.mongo.databaseExists(database)) {
			return refuse("collision", "generated database name already exists")
		}
		if (!deps.fileExists(API_ENTRY)) {
			return refuse(
				"api-not-built",
				"API build output is missing; run bun run build",
			)
		}
		const port = await deps.allocatePort()
		if (!(await deps.isPortFree(port))) {
			return refuse("port-occupied", `port ${port} is already in use`)
		}
		try {
			await deps.mongo.writeMarker(database, {
				runId,
				database,
				createdAt: new Date(deps.now()).toISOString(),
				tool: "overnight-probes",
			})
			markerWritten = true
		} catch (error) {
			return refuse(
				"marker-failed",
				`ownership marker could not be written: ${error instanceof Error ? error.message : String(error)}`,
			)
		}

		configFile = deps.withConfigFile("{}")
		const env = buildChildEnv(input.baseEnv ?? {}, {
			database,
			port,
			apiKey,
			mongoUri: withAppName(input.mongoUri, appName),
			voyageKey: input.voyageKey,
			configPath: configFile.path,
		})
		try {
			child = deps.spawnApi(env, API_ENTRY)
		} catch (error) {
			return refuse(
				"spawn-failed",
				`API process could not be started: ${error instanceof Error ? error.message : String(error)}`,
			)
		}
		child.onLine((_stream, line) => {
			tail.push(safe(line).slice(0, TAIL_LINE_CHARS))
			if (tail.length > TAIL_LINES) tail.shift()
		})
		child.onExit(() => {
			childExited = true
		})

		const baseUrl = `http://127.0.0.1:${port}`
		const startedAt = deps.now()
		let status: { status: number; body: unknown } | undefined
		for (;;) {
			if (childExited) {
				return refuse(
					"child-exited",
					"API process exited before it became ready",
				)
			}
			try {
				const res = await deps.fetchJson(`${baseUrl}/v1/status`, {
					Authorization: `Bearer ${apiKey}`,
				})
				if (res.status === 200) {
					status = res
					break
				}
			} catch {
				// not listening yet
			}
			if (deps.now() - startedAt > BOOT_DEADLINE_MS) {
				return refuse(
					"boot-timeout",
					"API did not become ready before the deadline",
				)
			}
			await deps.sleep(POLL_MS)
		}

		const reported = (status.body as { custom?: { database?: unknown } } | null)
			?.custom?.database
		if (typeof reported !== "string") {
			return refuse(
				"target-unverified",
				"API status does not report its database",
			)
		}
		if (reported !== database) {
			return refuse(
				"target-mismatch",
				"API reports a database other than the generated one",
			)
		}
		const collections = await deps.mongo.listCollections(database)
		if (!collections.some((name) => name !== OWNER_COLLECTION)) {
			return refuse(
				"target-unverified",
				"API created no collections in the generated database",
			)
		}

		return {
			database,
			runId,
			baseUrl,
			apiKey,
			appName,
			pid: child.pid,
			effectiveTarget: { database, verified: true },
			mongo: deps.mongo,
			stop: stopAll,
		}
	}

	try {
		return await boot()
	} catch (error) {
		if (error instanceof HarnessRefusal) throw error
		return refuse(
			"startup-failed",
			`startup failed: ${error instanceof Error ? error.message : String(error)}`,
		)
	}
}
