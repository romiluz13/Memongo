import { type ChildProcess, spawn } from "node:child_process"
import { randomBytes, randomUUID } from "node:crypto"
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import path from "node:path"
import { createInterface } from "node:readline"
import { fileURLToPath } from "node:url"
import { MongoClient } from "mongodb"
import { resolveBenchmarkAnswerProvider } from "../benchmark/benchmark-answer-provider.ts"
import type { Io } from "./cli.ts"
import { AdminDenied, type AnswerPort } from "./context.ts"
import { EnvRefusal } from "./env.ts"
import {
	type ApiProcess,
	HarnessRefusal,
	type HarnessDeps,
	isOwnedDatabaseName,
	type MongoAdmin,
	OWNER_COLLECTION,
	type OwnershipMarker,
	startHarness,
} from "./harness.ts"
import { createProbeApi } from "./probe-api.ts"
import { isRecord } from "./rows.ts"
import type { Sanitizer } from "./sanitize.ts"

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url))
const OWNER_ID = "owner"
const ADMIN_CLIENT_NAME = "memongo-probe-admin"
const SERVER_SELECTION_MS = 15_000
const STATUS_TIMEOUT_MS = 5_000
const DENIED_CODES: ReadonlySet<number> = new Set([13, 59, 115, 8000])
const DENIED_NAMES: ReadonlySet<string> = new Set([
	"Unauthorized",
	"CommandNotFound",
	"CommandNotSupported",
	"AtlasError",
])
const DENIED_TEXT =
	/not authorized|not allowed|unauthorized|requires authentication/i
const ANSWER_ENV = [
	"MEMONGO_BENCHMARK_ANSWER_API_KEY",
	"MEMONGO_BENCHMARK_ANSWER_BASE_URL",
	"MEMONGO_BENCHMARK_ANSWER_MODEL",
	"MEMONGO_BENCHMARK_ANSWER_PROVIDER",
	"MEMONGO_BENCHMARK_ANSWER_AUTH_STYLE",
	"MEMONGO_BENCHMARK_ANSWER_TOKEN_PARAM",
	"MEMONGO_BENCHMARK_ANSWER_ALLOW_PRIVATE_NETWORK",
] as const

export function toAdminError(error: unknown): unknown {
	if (!isRecord(error)) return error
	const code = typeof error.code === "number" ? error.code : undefined
	const codeName = typeof error.codeName === "string" ? error.codeName : ""
	const message = typeof error.message === "string" ? error.message : ""
	const denied =
		(code !== undefined && DENIED_CODES.has(code)) ||
		DENIED_NAMES.has(codeName) ||
		DENIED_TEXT.test(message)
	if (!denied) return error
	const label = codeName || (code === undefined ? "denied" : String(code))
	return new AdminDenied(`${label}: ${message}`)
}

function asMarker(value: unknown): OwnershipMarker | undefined {
	if (!isRecord(value)) return undefined
	const { runId, database, createdAt, tool } = value
	if (
		typeof runId !== "string" ||
		typeof database !== "string" ||
		typeof createdAt !== "string" ||
		tool !== "overnight-probes"
	) {
		return undefined
	}
	return { runId, database, createdAt, tool }
}

export function createLiveMongoAdmin(client: MongoClient): MongoAdmin {
	async function collectionNames(name: string): Promise<string[]> {
		const listed = await client
			.db(name)
			.listCollections({}, { nameOnly: true })
			.toArray()
		return listed.map((entry) => entry.name)
	}
	return {
		databaseExists: async (name) => (await collectionNames(name)).length > 0,
		writeMarker: async (name, marker) => {
			await client
				.db(name)
				.collection<{ _id: string }>(OWNER_COLLECTION)
				.insertOne({ _id: OWNER_ID, ...marker })
		},
		readMarker: async (name) =>
			asMarker(
				await client
					.db(name)
					.collection<{ _id: string }>(OWNER_COLLECTION)
					.findOne({ _id: OWNER_ID }),
			),
		listCollections: collectionNames,
		dropDatabase: async (name) => {
			if (!isOwnedDatabaseName(name)) {
				throw new Error("refusing to drop a database this run did not generate")
			}
			await client.db(name).dropDatabase()
		},
		listOperations: async () => {
			try {
				return await client
					.db("admin")
					.aggregate([
						{ $currentOp: { allUsers: false, idleConnections: false } },
					])
					.toArray()
			} catch (error) {
				throw toAdminError(error)
			}
		},
		killOperation: async (opid) => {
			try {
				await client.db("admin").command({ killOp: 1, op: opid })
			} catch (error) {
				throw toAdminError(error)
			}
		},
		close: () => client.close(),
	}
}

export async function connectLiveMongo(uri: string): Promise<MongoAdmin> {
	const client = new MongoClient(uri, {
		appName: ADMIN_CLIENT_NAME,
		serverSelectionTimeoutMS: SERVER_SELECTION_MS,
	})
	await client.connect()
	return createLiveMongoAdmin(client)
}

function listenOnce(port: number): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = createServer()
		server.once("error", reject)
		server.listen(port, "127.0.0.1", () => {
			const address = server.address()
			const bound = typeof address === "object" && address ? address.port : 0
			server.close(() => resolve(bound))
		})
	})
}

function wrapChild(child: ChildProcess): ApiProcess {
	let exited = false
	const lineListeners: Array<
		(stream: "stdout" | "stderr", line: string) => void
	> = []
	const exitListeners: Array<
		(code: number | null, signal: string | null) => void
	> = []
	const sources = [
		["stdout", child.stdout],
		["stderr", child.stderr],
	] as const
	for (const [stream, source] of sources) {
		if (!source) continue
		createInterface({ input: source }).on("line", (line) => {
			for (const listener of lineListeners) listener(stream, line)
		})
	}
	const finish = (code: number | null, signal: string | null) => {
		if (exited) return
		exited = true
		for (const listener of exitListeners) listener(code, signal)
	}
	child.once("exit", finish)
	child.once("error", () => finish(null, null))
	return {
		get pid() {
			return child.pid
		},
		get exited() {
			return exited
		},
		onLine: (listener) => {
			lineListeners.push(listener)
		},
		onExit: (listener) => {
			exitListeners.push(listener)
		},
		kill: (signal) => {
			child.kill(signal)
		},
	}
}

export function createLiveHarnessDeps(options: {
	mongo: MongoAdmin
	sanitizer: Sanitizer
	note(line: string): void
}): HarnessDeps {
	const nodeBinary = process.versions.bun ? "node" : process.execPath
	return {
		mongo: options.mongo,
		sanitizer: options.sanitizer,
		fileExists: (file) => existsSync(path.resolve(REPO_ROOT, file)),
		allocatePort: () => listenOnce(0),
		isPortFree: (port) =>
			listenOnce(port).then(
				() => true,
				() => false,
			),
		spawnApi: (env, entry) =>
			wrapChild(
				spawn(nodeBinary, [path.resolve(REPO_ROOT, entry)], {
					env,
					cwd: REPO_ROOT,
					stdio: ["ignore", "pipe", "pipe"],
				}),
			),
		fetchJson: async (url, headers) => {
			const response = await fetch(url, {
				headers,
				signal: AbortSignal.timeout(STATUS_TIMEOUT_MS),
			})
			const text = await response.text()
			let body: unknown
			try {
				body = JSON.parse(text)
			} catch {
				body = undefined
			}
			return { status: response.status, body }
		},
		sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
		now: () => Date.now(),
		randomHex: (chars) =>
			randomBytes(Math.ceil(chars / 2))
				.toString("hex")
				.slice(0, chars),
		randomUuid: () => randomUUID(),
		withConfigFile: (contents) => {
			const dir = mkdtempSync(path.join(tmpdir(), "memongo-probe-"))
			const file = path.join(dir, "config.json")
			writeFileSync(file, contents, { mode: 0o600 })
			return {
				path: file,
				remove: () => rmSync(dir, { recursive: true, force: true }),
			}
		},
		note: options.note,
	}
}

export function buildAnswerPort(
	env: Readonly<Record<string, string | undefined>>,
): AnswerPort {
	const subset: Record<string, string | undefined> = {}
	for (const name of ANSWER_ENV) {
		if (env[name]) subset[name] = env[name]
	}
	const provider = resolveBenchmarkAnswerProvider(subset)
	const model = subset.MEMONGO_BENCHMARK_ANSWER_MODEL
	if (!provider || !model) {
		throw new EnvRefusal(["MEMONGO_BENCHMARK_ANSWER_*"], [], [])
	}
	return { provider, model }
}

export function createLiveIo(): Io {
	return {
		stdout: process.stdout,
		stderr: process.stderr,
		clock: {
			now: () => Date.now(),
			mono: () => Math.round(performance.now()),
			sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
		},
		randomHex: (chars) =>
			randomBytes(Math.ceil(chars / 2))
				.toString("hex")
				.slice(0, chars),
		randomUuid: () => randomUUID(),
		startHarness: async (input) => {
			const mongo = await connectLiveMongo(input.mongoUri)
			try {
				return await startHarness(
					createLiveHarnessDeps({
						mongo,
						sanitizer: input.sanitizer,
						note: input.note,
					}),
					{
						mongoUri: input.mongoUri,
						voyageKey: input.voyageKey,
						baseEnv: input.baseEnv,
					},
				)
			} catch (error) {
				if (!(error instanceof HarnessRefusal)) {
					await mongo.close().catch(() => undefined)
				}
				throw error
			}
		},
		createApi: (input) => createProbeApi(input),
		createAnswer: buildAnswerPort,
		onTerminate: (handler) => {
			const exits = { SIGINT: 130, SIGTERM: 143 } as const
			const listeners = (Object.keys(exits) as Array<keyof typeof exits>).map(
				(signal) => {
					const listener = () => {
						void handler().finally(() => process.exit(exits[signal]))
					}
					process.once(signal, listener)
					return [signal, listener] as const
				},
			)
			return () => {
				for (const [signal, listener] of listeners)
					process.off(signal, listener)
			}
		},
	}
}
