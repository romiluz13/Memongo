import { createHash } from "node:crypto"
import { createSubsystemLogger, formatErrorMessage } from "@memongo/lib"
import { MongoClient, type MongoClientOptions } from "mongodb"

const log = createSubsystemLogger("memory:mongodb-client-registry")

/**
 * Process-level shared MongoClient registry (P2.1). The shared runtime is the
 * DEFAULT (C-009): all memory managers for the same MongoDB URI share one
 * client — and therefore one connection pool — instead of opening a client
 * per agent. Opt out with MEMONGO_SHARED_CLIENT=0 (or an explicit false/no/off)
 * to restore the legacy per-agent clients. The registry owns the clients:
 * managers must never close a shared client directly; they release their
 * reference and the registry closes the client when the last reference is
 * released or at process shutdown via closeAllSharedMongoClients().
 */
type RegistryEntry = {
	uri: string
	refs: number
	ready: Promise<MongoClient>
	/**
	 * C-009: options snapshot from the first acquirer. The registry is keyed
	 * by URI, so the first-resolved options fix the shared pool; later
	 * acquirers with different options are warned, not silently ignored.
	 */
	options: MongoClientOptions
	/** C-009-R2: diverging-signature warns already emitted (dedupe re-inits). */
	warnedSignatures: Set<string>
}

export type SharedMongoClientConnect = (
	uri: string,
	options: MongoClientOptions,
) => Promise<MongoClient>

const REGISTRY = new Map<string, RegistryEntry>()

/**
 * C-002: stable non-secret alias for a registered URI. Registry diagnostics
 * must never carry the raw connection string; the hash lets an operator
 * correlate log lines across the same client without exposing credentials.
 */
function uriAlias(uri: string): string {
	return `shared-client-${createHash("sha256").update(uri).digest("hex").slice(0, 8)}`
}

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

/**
 * C-009: keys whose values differ between two option objects (or that exist
 * in only one of them). Key NAMES only — option values are never compared
 * into log output, and the raw URI never appears (C-002 alias instead).
 */
function divergingOptionKeys(
	a: MongoClientOptions,
	b: MongoClientOptions,
): string[] {
	const keys = new Set([...Object.keys(a), ...Object.keys(b)])
	const diverging: string[] = []
	for (const key of keys) {
		const av = (a as Record<string, unknown>)[key]
		const bv = (b as Record<string, unknown>)[key]
		const as = typeof av === "function" ? String(av) : JSON.stringify(av)
		const bs = typeof bv === "function" ? String(bv) : JSON.stringify(bv)
		if (as !== bs) {
			diverging.push(key)
		}
	}
	return diverging
}

/**
 * C-009 (EL-009 R1): the shared-client runtime is the default. Only an
 * explicit opt-out value (0/false/no/off) restores the legacy per-agent
 * client mode; unset, empty, or unrecognized values keep the safe default.
 */
export function isSharedMongoClientEnabled(): boolean {
	const raw = process.env.MEMONGO_SHARED_CLIENT?.trim().toLowerCase()
	return !(raw === "0" || raw === "false" || raw === "no" || raw === "off")
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
	const options = params.options ?? {}
	let entry = REGISTRY.get(key)
	if (!entry) {
		const ready = connectImpl(params.uri, options)
		entry = {
			uri: params.uri,
			refs: 0,
			ready,
			options,
			warnedSignatures: new Set(),
		}
		REGISTRY.set(key, entry)
		const captured = entry
		ready.catch(() => {
			// Failed connect: drop the entry so the next acquire retries fresh.
			if (REGISTRY.get(key) === captured) {
				REGISTRY.delete(key)
			}
		})
	} else {
		// C-009: one pool per URI means the first-resolved options win. A
		// caller whose options diverge (e.g. per-agent pool tuning) must hear
		// about it instead of running on settings it never asked for. The
		// warn fires once per diverging signature per registered client so
		// post-eviction re-inits of the same divergent config stay quiet.
		const diverging = divergingOptionKeys(entry.options, options)
		if (diverging.length > 0) {
			const signature = diverging.join(",")
			if (!entry.warnedSignatures.has(signature)) {
				entry.warnedSignatures.add(signature)
				log.warn(
					`shared MongoDB client already registered with different options (${uriAlias(
						key,
					)}); first-resolved options win, ignoring: ${diverging.join(", ")}`,
				)
			}
		}
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
			// C-002: alias + redacted error detail — the raw URI never appears.
			log.warn(
				`failed to close released shared MongoDB client (${uriAlias(
					entry.uri,
				)}): ${formatErrorMessage(err)}`,
			)
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
			// C-002: alias + redacted error detail — the raw URI never appears.
			log.warn(
				`failed to close shared MongoDB client (${uriAlias(
					entry.uri,
				)}): ${formatErrorMessage(err)}`,
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
