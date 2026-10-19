/**
 * Search visibility barrier against a real mongot (#101, decision 17).
 *
 * The unit suites fake the probe. Three things only a real server proves:
 *
 *   - the witness: `$search equals` on the token-mapped searchWriteToken
 *     finds the stamped version, and a fresh token finds nothing;
 *   - the barrier write: through the real manager, either a pre-write
 *     BARRIER_UNSUPPORTED with nothing written (tier A has no model key, so
 *     no autoEmbed vector index exists) or a committed barrier outcome;
 *   - the barrier's own `exact: true` autoEmbed vector probe: its count or
 *     its error is recorded, and an error must surface as probe-failed.
 *
 * Setup builds only the two text indexes the witness and barrier probe need,
 * from their required-index manifest rows. Keyless mongot refuses every
 * autoEmbed definition, so the full manifest boot (ensureSearchIndexes) is a
 * typed refusal here; the keyed proof-pack job boots the full manifest.
 *
 * Each case prints one bounded JSON line (no token, body or query text) so a
 * run records the observed behavior. With a model key and an autoEmbed
 * index, the vector probe is one paid query embedding per call.
 *
 * Run: bun run --filter @memongo/memory-engine test:e2e:tier-a
 */
import { randomUUID } from "node:crypto"
import { type Db, MongoClient } from "mongodb"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
	reconcileRequiredIndex,
	verifyServerVersion,
} from "./mongodb-boot-contract.js"
import { writeEvent } from "./mongodb-events.js"
import { MongoDBMemoryManager } from "./mongodb-manager.js"
import { buildRequiredIndexManifest } from "./mongodb-required-index-manifest.js"
import {
	chunksCollection,
	ensureCollections,
	eventsCollection,
} from "./mongodb-schema.js"
import {
	awaitSearchBarrier,
	createSearchBarrierProbe,
	isSearchBarrierUnsupportedError,
	mintSearchWriteToken,
	type SearchBarrierTarget,
	searchBarrierTargets,
} from "./mongodb-search-barrier.js"
import { resolvePreviewMongoTestUri } from "./test-helpers/preview-env.js"
import { waitForSearchIndexesQueryable } from "./test-helpers/search-index-wait.js"

const TEST_URI = resolvePreviewMongoTestUri(
	"mongodb://127.0.0.1:27019/?directConnection=true",
)
const DB_NAME = `memongo_search_barrier_${randomUUID().slice(0, 8)}`
const PREFIX = "barrier_"
const AGENT_ID = "synthetic-barrier-agent"
const TIMEOUT = 180_000

let client: MongoClient
let db: Db

function target(index: string): SearchBarrierTarget {
	const found = searchBarrierTargets("event").find(
		(candidate) => candidate.index === index,
	)
	if (!found) throw new Error(`no barrier target ${index}`)
	return found
}

function boundedError(err: unknown): Record<string, unknown> {
	const record = (err ?? {}) as Record<string, unknown>
	return {
		name: err instanceof Error ? err.name : typeof err,
		code: record.code,
		codeName: record.codeName,
		message: (err instanceof Error ? err.message : String(err)).slice(0, 160),
	}
}

function record(caseName: string, outcome: Record<string, unknown>): void {
	console.log(
		JSON.stringify({ suite: "search-barrier-e2e", case: caseName, ...outcome }),
	)
}

function makeManager(): MongoDBMemoryManager {
	return Reflect.construct(MongoDBMemoryManager, [
		{
			client,
			db,
			prefix: PREFIX,
			agentId: AGENT_ID,
			workspaceDir: "/tmp/memongo-search-barrier-e2e",
			capabilities: {},
			nativeBitemporalVectorPrefilter: false,
			config: {
				mongodb: {
					embeddingMode: "automated",
					episodes: { enabled: false, minEventsForEpisode: 6 },
				},
			},
			ownsClient: false,
		},
	]) as MongoDBMemoryManager
}

async function probeUntilFound(
	probe: ReturnType<typeof createSearchBarrierProbe>,
	probeTarget: SearchBarrierTarget,
	token: string,
	timeoutMs: number,
): Promise<{ count: number; elapsedMs: number }> {
	const started = Date.now()
	let count = 0
	while (Date.now() - started < timeoutMs) {
		count = await probe(probeTarget, token)
		if (count > 0) break
		await new Promise((resolve) => setTimeout(resolve, 500))
	}
	return { count, elapsedMs: Date.now() - started }
}

beforeAll(async () => {
	client = new MongoClient(TEST_URI)
	await client.connect()
	db = client.db(DB_NAME)
	await ensureCollections(db, PREFIX)
	const textIndexes = new Set([`${PREFIX}events_text`, `${PREFIX}chunks_text`])
	const manifest = buildRequiredIndexManifest({
		prefix: PREFIX,
		serverVersionArray: await verifyServerVersion(db),
	}).filter((entry) => textIndexes.has(entry.name))
	expect(manifest.map((entry) => entry.name).sort()).toEqual(
		[...textIndexes].sort(),
	)
	const ensured: Record<string, string> = {}
	for (const entry of manifest) {
		ensured[entry.name] = await reconcileRequiredIndex(
			db.collection(entry.collectionName),
			entry,
		)
	}
	const eventsText = await waitForSearchIndexesQueryable(
		eventsCollection(db, PREFIX),
		{ indexNames: [`${PREFIX}events_text`], timeoutMs: 120_000 },
	)
	const chunksText = await waitForSearchIndexesQueryable(
		chunksCollection(db, PREFIX),
		{ indexNames: [`${PREFIX}chunks_text`], timeoutMs: 120_000 },
	)
	record("setup", {
		ensured,
		eventsTextReady: eventsText.ready,
		chunksTextReady: chunksText.ready,
	})
	expect(eventsText.ready).toBe(true)
	expect(chunksText.ready).toBe(true)
}, TIMEOUT)

afterAll(async () => {
	try {
		await db?.dropDatabase()
	} finally {
		await client?.close()
	}
}, TIMEOUT)

describe("search barrier on a real mongot", () => {
	it(
		"finds the stamped version by token on the text index and nothing for a fresh token",
		async () => {
			const token = mintSearchWriteToken()
			await writeEvent({
				db,
				prefix: PREFIX,
				event: {
					eventId: `barrier-witness-${randomUUID()}`,
					agentId: AGENT_ID,
					role: "user",
					body: "synthetic barrier witness",
					scope: "agent",
					searchWriteToken: token,
				},
			})
			const probe = createSearchBarrierProbe(db, PREFIX)
			const found = await probeUntilFound(
				probe,
				target("events_text"),
				token,
				60_000,
			)
			const fresh = await probe(target("events_text"), mintSearchWriteToken())
			record("text-witness", { ...found, freshTokenCount: fresh })
			expect(found.count).toBe(1)
			expect(fresh).toBe(0)
		},
		TIMEOUT,
	)

	it(
		"a barrier write is rejected before the write or returns a committed outcome",
		async () => {
			const manager = makeManager()
			const before = await eventsCollection(db, PREFIX).countDocuments({
				agentId: AGENT_ID,
			})
			let outcome: Record<string, unknown>
			try {
				const receipt = await manager.writeConversationEvent(
					{ role: "user", body: "synthetic barrier write", scope: "agent" },
					undefined,
					{ searchBarrier: { timeoutMs: 10_000 } },
				)
				const barrier = receipt.searchBarrier
				outcome = { kind: "committed", barrier }
				expect(barrier?.committed).toBe(true)
				expect(["searchable", "not-yet-searchable"]).toContain(barrier?.status)
				if (barrier?.status === "searchable") {
					expect(
						barrier.targets.every((entry) => entry.status === "confirmed"),
					).toBe(true)
				}
			} catch (err) {
				expect(isSearchBarrierUnsupportedError(err)).toBe(true)
				const after = await eventsCollection(db, PREFIX).countDocuments({
					agentId: AGENT_ID,
				})
				outcome = {
					kind: "rejected-before-write",
					reason: (err as { reason?: string }).reason,
					eventsWritten: after - before,
				}
				expect(after).toBe(before)
			}
			record("barrier-write", outcome)
		},
		TIMEOUT,
	)

	it(
		"records the barrier's own exact:true vector probe and maps an error to probe-failed",
		async () => {
			const token = mintSearchWriteToken()
			const probe = createSearchBarrierProbe(db, PREFIX)
			let direct: Record<string, unknown>
			try {
				direct = {
					kind: "count",
					count: await probe(target("chunks_vector"), token),
				}
			} catch (err) {
				direct = { kind: "error", error: boundedError(err) }
			}
			const barrier = await awaitSearchBarrier({
				db,
				prefix: PREFIX,
				family: "event",
				token,
				request: { timeoutMs: 1_000 },
			})
			record("vector-exact-probe", {
				direct,
				barrierStatus: barrier.status,
				barrierReason: barrier.reason,
				targets: barrier.targets,
			})
			expect(barrier.committed).toBe(true)
			if (direct.kind === "error") {
				expect(barrier.status).toBe("not-yet-searchable")
				expect(barrier.reason).toBe("probe-failed")
			}
			// Nothing carries this token, so no probe may report it searchable.
			expect(barrier.status).not.toBe("searchable")
		},
		TIMEOUT,
	)
})
