import { createSubsystemLogger } from "@memongo/lib"
import { MongoClient, type MongoClientOptions } from "mongodb"

const log = createSubsystemLogger("memory:mongodb-client-registry")

/**
 * Process-level shared MongoClient registry (P2.1). When MEMONGO_SHARED_CLIENT
 * is enabled, all memory managers for the same MongoDB URI share one client —
 * and therefore one connection pool — instead of opening a client per agent.
 * The registry owns the clients: managers must never close a shared client
 * directly; they release their reference and the registry closes the client
 * when the last reference is released or at process shutdown via
 * closeAllSharedMongoClients().
 */
type RegistryEntry = {
	uri: string
	refs: number
	ready: Promise<MongoClient>
}

export type SharedMongoClientConnect = (
	uri: string,
	options: MongoClientOptions,
) => Promise<MongoClient>

const REGISTRY = new Map<string, RegistryEntry>()

async function defaultSharedMongoClientConnect(
	uri: string,
	options: MongoClientOptions,
): Promise<MongoClient> {
	const client = new MongoClient(uri, options)
	try {
		await client.connect()
		// Verify the connection actually works with a ping
		await client.db("admin").command({ ping: 1 })
	} catch (err) {
		try {
			await client.close()
		} catch {
			// Ignore close errors during failed connect
		}
		throw err
	}
	return client
}

let connectImpl: SharedMongoClientConnect = defaultSharedMongoClientConnect

export function isSharedMongoClientEnabled(): boolean {
	const raw = process.env.MEMONGO_SHARED_CLIENT?.trim().toLowerCase()
	return raw === "1" || raw === "true" || raw === "yes" || raw === "on"
}

/**
 * Acquire the shared client for a URI, connecting on first use. Concurrent
 * acquires for the same URI dedupe on a single in-flight connect. Each
 * successful acquire must be balanced by exactly one releaseSharedMongoClient.
 */
export async function acquireSharedMongoClient(params: {
	uri: string
	options?: MongoClientOptions
}): Promise<MongoClient> {
	const key = params.uri
	let entry = REGISTRY.get(key)
	if (!entry) {
		const ready = connectImpl(params.uri, params.options ?? {})
		entry = { uri: params.uri, refs: 0, ready }
		REGISTRY.set(key, entry)
		const captured = entry
		ready.catch(() => {
			// Failed connect: drop the entry so the next acquire retries fresh.
			if (REGISTRY.get(key) === captured) {
				REGISTRY.delete(key)
			}
		})
	}
	entry.refs += 1
	try {
		return await entry.ready
	} catch (err) {
		entry.refs -= 1
		throw err
	}
}

/**
 * Release one reference to the shared client for a URI. When the last
 * reference is released the client is closed in the background and removed
 * from the registry, so a later acquire reconnects fresh.
 */
export function releaseSharedMongoClient(uri: string): void {
	const entry = REGISTRY.get(uri)
	if (!entry) {
		return
	}
	entry.refs -= 1
	if (entry.refs > 0) {
		return
	}
	REGISTRY.delete(uri)
	void entry.ready
		.then((client) => client.close())
		.catch((err) => {
			log.warn(`failed to close released shared MongoDB client: ${String(err)}`)
		})
}

/** Close every registered shared client. Called at process shutdown. */
export async function closeAllSharedMongoClients(): Promise<void> {
	const entries = Array.from(REGISTRY.values())
	REGISTRY.clear()
	for (const entry of entries) {
		try {
			const client = await entry.ready
			await client.close()
		} catch (err) {
			log.warn(
				`failed to close shared MongoDB client (${entry.uri}): ${String(err)}`,
			)
		}
	}
}

/** Test hook: replace the connect implementation (e.g. with a fake). */
export function setSharedMongoClientConnectForTests(
	connect: SharedMongoClientConnect,
): void {
	connectImpl = connect
}

/** Test hook: close all clients and restore the default connect. */
export async function resetSharedMongoClientRegistryForTests(): Promise<void> {
	await closeAllSharedMongoClients()
	connectImpl = defaultSharedMongoClientConnect
}
