import type { Db } from "mongodb"
import { withFencedWrite } from "../../packages/memory-engine/src/mongodb-write-fence.js"
import { MAJORITY_TRANSACTION_OPTIONS } from "../../packages/memory-engine/src/mongodb-transactions.js"

/** Diagnostic core only. Root must supply owned DBs and an admitted, supervised envelope.
 * No credentials, connections, seeding, deletion, release, or server-conflict simulation.
 */
export async function runFenceContentionCase(params: {
	dbs: [Db, Db]
	prefix: string
	agents: [string, string]
	mode: "serial" | "overlap"
	caseId: string
	admitAttempt: (lane: number, attempt: number) => void
}): Promise<{ attempts: [number, number] }> {
	const attempts: [number, number] = [0, 0]
	const barrier = readBarrier()
	async function lane(index: 0 | 1): Promise<void> {
		const db = params.dbs[index]
		const session = db.client.startSession()
		try {
			await session.withTransaction(
				async () => {
					const attempt = ++attempts[index]
					params.admitAttempt(index, attempt)
					const intercepted = afterGateRead(
						db,
						`${params.prefix}meta`,
						async () => {
							if (params.mode === "overlap" && attempt === 1)
								await barrier.arrive()
						},
					)
					await withFencedWrite({
						db: intercepted,
						prefix: params.prefix,
						token: {
							kind: "admission",
							agentId: params.agents[index],
							epoch: 0,
						},
						session,
						fn: async (sameSession) => {
							await db
								.collection<{ _id: string; agentId: string }>(
									`${params.prefix}effects`,
								)
								.insertOne(
									{
										_id: `${params.caseId}:${index}`,
										agentId: params.agents[index],
									},
									{ session: sameSession },
								)
						},
					})
				},
				{ ...MAJORITY_TRANSACTION_OPTIONS, timeoutMS: 10_000 },
			)
		} catch (error) {
			barrier.cancel(error)
			throw error
		} finally {
			await session.endSession()
		}
	}
	try {
		if (params.mode === "serial") {
			await lane(0)
			await lane(1)
		} else {
			const settled = await Promise.allSettled([lane(0), lane(1)])
			const errors = settled.flatMap((r) =>
				r.status === "rejected" ? [r.reason] : [],
			)
			if (errors.length)
				throw new AggregateError(errors, "contention case failed")
		}
		return { attempts }
	} finally {
		barrier.dispose()
	}
}

function afterGateRead(
	db: Db,
	metaName: string,
	afterRead: () => Promise<void>,
): Db {
	return new Proxy(db, {
		get(target, key) {
			if (key === "collection")
				return (name: string) => {
					const collection = target.collection(name)
					if (name !== metaName) return collection
					return new Proxy(collection, {
						get(col, method) {
							if (method === "findOne")
								return async (...args: Parameters<typeof col.findOne>) => {
									const row = await col.findOne(...args)
									await afterRead()
									return row
								}
							const value = Reflect.get(col, method, col)
							return typeof value === "function" ? value.bind(col) : value
						},
					})
				}
			const value = Reflect.get(target, key, target)
			return typeof value === "function" ? value.bind(target) : value
		},
	})
}

function readBarrier() {
	let arrivals = 0
	let timer: ReturnType<typeof setTimeout> | undefined
	let resolve!: () => void
	let reject!: (error: unknown) => void
	const ready = new Promise<void>((yes, no) => {
		resolve = yes
		reject = no
	})
	// Cancellation may precede the other lane's arrival. Keep the rejection observed.
	void ready.catch(() => {})
	return {
		arrive() {
			if (++arrivals === 2) {
				clearTimeout(timer)
				resolve()
			} else if (!timer)
				timer = setTimeout(
					() => reject(new Error("gate-read barrier timeout")),
					5_000,
				)
			return ready
		},
		cancel(error: unknown) {
			clearTimeout(timer)
			reject(error)
		},
		dispose() {
			clearTimeout(timer)
		},
	}
}
