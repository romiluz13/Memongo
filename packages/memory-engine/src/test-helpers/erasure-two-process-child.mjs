import { tsImport } from "../../../../node_modules/tsx/dist/esm/api/index.mjs"

const [uri, name, agentId, mode] = process.argv.slice(2)
if (
	new URL(uri).hostname !== "127.0.0.1" ||
	new URL(uri).port !== "27218" ||
	!/^memongo_e134_[a-f0-9]{32}$/.test(name)
)
	throw new Error("E134 owned local MongoDB only")
const imports = []
const {
	Collection,
	MongoClient,
	projectChunksFromEvents,
	MongoDBManagerWriteOps,
	isErasureGateConflictError,
} = await tsImport("./erasure-two-process-entry.ts", {
	parentURL: import.meta.url,
	onImport: (url) => imports.push(url),
})
const client = new MongoClient(uri),
	db = client.db(name),
	prefix = "test_"
function send(message) {
	return new Promise((resolve, reject) =>
		process.send(message, (error) => (error ? reject(error) : resolve())),
	)
}
const released = new Promise((resolve) => {
	process.once("message", (message) => {
		if (message?.kind !== "release") throw new Error("unexpected command")
		resolve()
	})
})
let hit = false
async function barrier(sourceCount) {
	hit = true
	await send({ kind: "paused", pid: process.pid, mode, sourceCount })
	await released
	await send({ kind: "ack-release", pid: process.pid })
}
async function outcome(fn) {
	try {
		return { status: "fulfilled", value: await fn() }
	} catch (error) {
		return {
			status: "rejected",
			conflict: isErasureGateConflictError(error),
			error: { name: error.name, code: error.code, message: error.message },
		}
	}
}
async function awaitFresh(stale) {
	const ready = new Promise((resolve) =>
		process.once("message", (message) => {
			if (message?.kind !== "fresh") throw new Error("unexpected fresh command")
			resolve()
		}),
	)
	await send({ kind: "stale", stale, hit })
	await ready
}
try {
	await client.connect()
	let stale, fresh
	if (mode === "repair") {
		const find = Collection.prototype.find
		Collection.prototype.find = function (filter, options) {
			const cursor = find.call(this, filter, options)
			if (
				!hit &&
				this.collectionName === `${prefix}events` &&
				Object.hasOwn(filter ?? {}, "projectedAt")
			) {
				const read = cursor.toArray.bind(cursor)
				cursor.toArray = async () => {
					const source = await read()
					await barrier(source.length)
					return source
				}
			}
			return cursor
		}
		try {
			stale = await outcome(() =>
				projectChunksFromEvents({ db, prefix, agentId }),
			)
		} finally {
			Collection.prototype.find = find
		}
		await awaitFresh(stale)
		fresh = await projectChunksFromEvents({ db, prefix, agentId })
	} else if (mode === "public") {
		let releaseQueue
		const host = {
			db,
			prefix,
			client,
			agentId,
			closed: false,
			config: { mongodb: { embeddingMode: "manual" } },
			workspaceDir: "/tmp/memongo-e134-no-files",
			writeQueue: new Promise((resolve) => {
				releaseQueue = resolve
			}),
			writeQueueDepth: 0,
			chunkCount: 0,
			dirty: true,
			memoryJobWorkerStopped: true,
			memoryJobOperationContexts: new Map(),
			shouldRunPostWriteDerivedWork: () => false,
			schedulePostWriteDerivations: async () => {},
			scheduleQueryCacheInvalidation: () => {},
			startMemoryJobWorker: () => {},
			wakeMemoryJobWorker: () => {},
		}
		const capture = Collection.prototype.findOneAndUpdate
		Collection.prototype.findOneAndUpdate = async function (
			filter,
			update,
			options,
		) {
			const result = await capture.call(this, filter, update, options)
			if (
				!hit &&
				this.collectionName === `${prefix}meta` &&
				update.$setOnInsert?.agentId === agentId &&
				!options?.session
			) {
				await barrier(0)
				releaseQueue()
			}
			return result
		}
		const ops = new MongoDBManagerWriteOps(host)
		try {
			stale = await outcome(() =>
				ops.writeConversationEvent({
					role: "user",
					body: "Old queued content",
					scope: "agent",
				}),
			)
		} finally {
			Collection.prototype.findOneAndUpdate = capture
		}
		await awaitFresh(stale)
		fresh = await ops.writeConversationEvent({
			role: "user",
			body: "Fresh public content",
			scope: "agent",
		})
	} else throw new Error("unknown fixture mode")
	await send({ kind: "result", pid: process.pid, hit, fresh, imports })
} catch (error) {
	process.exitCode = 1
	await send({
		kind: "fatal",
		error: { name: error.name, message: error.message },
	})
} finally {
	await client.close()
	process.disconnect()
}
