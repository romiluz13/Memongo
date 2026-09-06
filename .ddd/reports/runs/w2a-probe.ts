/**
 * Wave 2a live probe — W09 insert-outcome reconciliation + W10 retention
 * aging against the live memongo-preview MongoDB (8.3.8 replica set), using
 * PRODUCTION writeEventsBatch / classifyBulkInsertError / findExistingEventIds
 * / createMemoryJobsBatch / pruneIdempotencyFingerprints + the production
 * ensureStandardIndexes unique indexes, on a disposable scratch database.
 *
 * W09 (events): a keyless E11000 on the eventId unique index is a prior
 * attempt's durable write — read-confirmed and acknowledged (ok + duplicateKey)
 * instead of failed; an unordered batch's sibling survives a per-item E11000
 * (EL-020); a keyed E11000 stays the Stripe winner-replay signal; a REAL
 * server write-concern error (unsatisfiable w + wtimeout on a live set)
 * classifies as uncertain (never per-item) and the doc is still present on
 * read-back (EL-022: MongoDB does not undo applied writes).
 * W09 (jobs): a duplicate jobId insert maps to a per-item duplicate receipt
 * and the sibling job is inserted.
 * W10: pruneIdempotencyFingerprints ages by recordedAt with the legacy
 * timestamp fallback — a fresh import of historical events keeps its replay
 * protection; future-dated events no longer extend retention.
 *
 * W08 (post-commit degradation) is failure-injection territory and is covered
 * by the unit suites (mongodb-events / mongodb-manager-write); it is not
 * live-probeable on a healthy server.
 *
 * Exit 0 = all assertions pass; any failure prints and exits 1.
 */

import { randomUUID } from "node:crypto"
import { MongoClient } from "mongodb"
import { ensureStandardIndexes } from "../../../packages/memory-engine/src/mongodb-schema.ts"
import {
	eventsCollection,
	memoryJobsCollection,
} from "../../../packages/memory-engine/src/mongodb-schema-collections.ts"
import {
	classifyBulkInsertError,
	findExistingEventIds,
	pruneIdempotencyFingerprints,
	writeEventsBatch,
} from "../../../packages/memory-engine/src/mongodb-events.ts"
import { createMemoryJobsBatch } from "../../../packages/memory-engine/src/mongodb-memory-jobs.ts"

const database = `ddd_w2a_${randomUUID().replaceAll("-", "")}`
const PREFIX = "probe_"
const AGENT = "probe-agent"
const URI = "mongodb://127.0.0.1:27019/?directConnection=true"
const client = new MongoClient(URI, { serverSelectionTimeoutMS: 5000 })

let failures = 0
let total = 0
function check(label: string, actual: unknown, expected: unknown) {
	total++
	const ok = JSON.stringify(actual) === JSON.stringify(expected)
	if (!ok) {
		failures++
		console.error(
			`FAIL ${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
		)
	} else {
		console.log(`ok   ${label} === ${JSON.stringify(expected)}`)
	}
}
const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000)

async function countEvents(eventId: string) {
	const db = client.db(database)
	return eventsCollection(db, PREFIX).countDocuments({
		agentId: AGENT,
		eventId,
	})
}

try {
	await client.connect()
	const db = client.db(database)
	await ensureStandardIndexes(db, PREFIX)
	console.log(`probe database ${database}; production indexes ensured`)

	// ------------------------------------------------------------------
	// W09 events — keyed duplicate stays the Stripe winner-replay signal
	// ------------------------------------------------------------------
	const keyWinner = `evt-w2a-keyed-${randomUUID().replaceAll("-", "")}`
	const idemKey = `key-w2a-${randomUUID().replaceAll("-", "")}`
	await eventsCollection(db, PREFIX).insertOne({
		eventId: keyWinner,
		agentId: AGENT,
		role: "user",
		body: "original keyed write",
		scope: "agent",
		scopeRef: `agent:${AGENT}`,
		timestamp: new Date(),
		recordedAt: new Date(),
		idempotencyKey: idemKey,
		idempotencyFingerprint: "fp-w2a-keyed",
	})
	const keyedReceipts = await writeEventsBatch({
		db,
		prefix: PREFIX,
		events: [
			{
				eventId: `evt-w2a-keyed-retry-${randomUUID().replaceAll("-", "")}`,
				agentId: AGENT,
				role: "user",
				body: "keyed retry with a fresh eventId",
				scope: "agent",
				idempotencyKey: idemKey,
			},
		],
	})
	check("keyed dup receipt.ok", keyedReceipts[0].ok, false)
	if (!keyedReceipts[0].ok) {
		check("keyed dup receipt.duplicateKey", keyedReceipts[0].duplicateKey, true)
	}
	check(
		"keyed winner untouched (exactly one doc, original body)",
		await eventsCollection(db, PREFIX)
			.find({ eventId: keyWinner }, { projection: { _id: 0, body: 1 } })
			.toArray(),
		[{ body: "original keyed write" }],
	)

	// ------------------------------------------------------------------
	// W09 events — keyless E11000 on eventId = durable-exists (read-confirmed)
	// ------------------------------------------------------------------
	const priorAttempt = `evt-w2a-prior-${randomUUID().replaceAll("-", "")}`
	await eventsCollection(db, PREFIX).insertOne({
		eventId: priorAttempt,
		agentId: AGENT,
		role: "user",
		body: "original from the prior attempt",
		scope: "agent",
		scopeRef: `agent:${AGENT}`,
		timestamp: new Date(),
		recordedAt: new Date(),
	})
	const keylessReceipts = await writeEventsBatch({
		db,
		prefix: PREFIX,
		events: [
			{
				eventId: priorAttempt,
				agentId: AGENT,
				role: "user",
				body: "retry of the same logical write (same eventId)",
				scope: "agent",
			},
		],
	})
	check("keyless dup receipt.ok (durable-exists)", keylessReceipts[0].ok, true)
	if (keylessReceipts[0].ok) {
		check("keyless dup receipt.duplicateKey", keylessReceipts[0].duplicateKey, true)
	}
	check("prior attempt still exactly one doc", await countEvents(priorAttempt), 1)
	check(
		"prior attempt body not overwritten",
		await eventsCollection(db, PREFIX)
			.find({ eventId: priorAttempt }, { projection: { _id: 0, body: 1 } })
			.toArray(),
		[{ body: "original from the prior attempt" }],
	)

	// ------------------------------------------------------------------
	// W09 events — unordered insert continues past E11000 (EL-020): the
	// sibling survives and is acknowledged; the duplicate is read-confirmed
	// ------------------------------------------------------------------
	const batchDup = `evt-w2a-batchdup-${randomUUID().replaceAll("-", "")}`
	await eventsCollection(db, PREFIX).insertOne({
		eventId: batchDup,
		agentId: AGENT,
		role: "user",
		body: "original batch dup seed",
		scope: "agent",
		scopeRef: `agent:${AGENT}`,
		timestamp: new Date(),
		recordedAt: new Date(),
	})
	const sibling = `evt-w2a-sibling-${randomUUID().replaceAll("-", "")}`
	const unorderedReceipts = await writeEventsBatch({
		db,
		prefix: PREFIX,
		events: [
			{
				eventId: batchDup,
				agentId: AGENT,
				role: "user",
				body: "dup item in an unordered batch",
				scope: "agent",
			},
			{
				eventId: sibling,
				agentId: AGENT,
				role: "user",
				body: "fresh sibling in the same batch",
				scope: "agent",
			},
		],
	})
	check("unordered dup receipt.ok (read-confirmed)", unorderedReceipts[0].ok, true)
	if (unorderedReceipts[0].ok) {
		check(
			"unordered dup receipt.duplicateKey",
			unorderedReceipts[0].duplicateKey,
			true,
		)
	}
	check("sibling receipt.ok", unorderedReceipts[1].ok, true)
	if (unorderedReceipts[1].ok) {
		check(
			"sibling receipt carries no duplicateKey",
			"duplicateKey" in unorderedReceipts[1],
			false,
		)
	}
	check("sibling doc present", await countEvents(sibling), 1)
	check("batch dup still exactly one doc", await countEvents(batchDup), 1)

	// ------------------------------------------------------------------
	// W09 — a REAL server write-concern error (unsatisfiable w + wtimeout):
	// uncertain outcome (never per-item), and the doc is still there (EL-022)
	// ------------------------------------------------------------------
	const replStatus = (await client.db("admin").command({
		replSetGetStatus: 1,
	})) as unknown as {
		members: Array<{ stateStr: string }>
	}
	const dataBearing = replStatus.members.filter((m) =>
		["PRIMARY", "SECONDARY"].includes(m.stateStr),
	).length
	console.log(
		`replica set: ${replStatus.members.length} member(s), ${dataBearing} data-bearing`,
	)
	const wcDocId = `evt-w2a-wc-${randomUUID().replaceAll("-", "")}`
	let wcError: unknown = null
	try {
		await eventsCollection(db, PREFIX).insertOne(
			{
				eventId: wcDocId,
				agentId: AGENT,
				role: "user",
				body: "applied on the primary, wtimeout on the acknowledgment",
				scope: "agent",
				scopeRef: `agent:${AGENT}`,
				timestamp: new Date(),
				recordedAt: new Date(),
			},
			{ writeConcern: { w: dataBearing + 1, wtimeout: 250 } },
		)
		wcError = new Error("insertMany unexpectedly succeeded with unsatisfiable w")
	} catch (err) {
		wcError = err
	}
	console.log(
		`write-concern error shape: ${(wcError as { constructor?: { name?: string } })?.constructor?.name}`,
	)
	check(
		"real write-concern error classifies uncertain (never per-item)",
		classifyBulkInsertError(wcError).kind,
		"uncertain",
	)
	check(
		"write-concern doc still present on read-back (EL-022: not undone)",
		(await findExistingEventIds({ db, prefix: PREFIX, eventIds: [wcDocId] }))
			.size,
		1,
	)

	// ------------------------------------------------------------------
	// W09 jobs — duplicate jobId insert maps to a per-item duplicate
	// receipt; the sibling job is inserted
	// ------------------------------------------------------------------
	const dupJobId = `job-w2a-dup-${randomUUID().replaceAll("-", "")}`
	await memoryJobsCollection(db, PREFIX).insertOne({
		jobId: dupJobId,
		agentId: AGENT,
		jobType: "extraction",
		status: "staged",
		createdAt: new Date(),
		attempts: 0,
		payload: { eventId: priorAttempt },
		stagedAt: new Date(),
	})
	const freshJobId = `job-w2a-fresh-${randomUUID().replaceAll("-", "")}`
	const jobReceipts = await createMemoryJobsBatch({
		db,
		prefix: PREFIX,
		jobs: [
			{
				jobId: dupJobId,
				agentId: AGENT,
				jobType: "extraction",
				status: "staged",
				attempts: 0,
				payload: { eventId: priorAttempt },
				stagedAt: new Date(),
			},
			{
				jobId: freshJobId,
				agentId: AGENT,
				jobType: "extraction",
				status: "staged",
				attempts: 0,
				payload: { eventId: sibling },
				stagedAt: new Date(),
			},
		],
	})
	check("dup job receipt.ok", jobReceipts[0].ok, false)
	if (!jobReceipts[0].ok) {
		check("dup job receipt.duplicate", jobReceipts[0].duplicate, true)
	}
	check("fresh job receipt.ok", jobReceipts[1].ok, true)
	check(
		"fresh job doc present",
		await memoryJobsCollection(db, PREFIX).countDocuments({ jobId: freshJobId }),
		1,
	)
	check(
		"dup job still exactly one doc",
		await memoryJobsCollection(db, PREFIX).countDocuments({ jobId: dupJobId }),
		1,
	)

	// ------------------------------------------------------------------
	// W10 — prune ages by recordedAt with the legacy timestamp fallback
	// ------------------------------------------------------------------
	const seedRetention = async (
		eventId: string,
		timestamp: Date,
		recordedAt?: Date,
	) => {
		await eventsCollection(db, PREFIX).insertOne({
			eventId,
			agentId: AGENT,
			role: "user",
			body: `retention seed ${eventId}`,
			scope: "agent",
			scopeRef: `agent:${AGENT}`,
			timestamp,
			...(recordedAt ? { recordedAt } : {}),
			idempotencyKey: `key-${eventId}`,
			idempotencyFingerprint: `fp-${eventId}`,
		})
	}
	const staleAccepted = `evt-w2a-r-stale-${randomUUID().replaceAll("-", "")}` // (a) old recordedAt -> pruned
	const historicalImport = `evt-w2a-r-hist-${randomUUID().replaceAll("-", "")}` // (b) old timestamp, fresh recordedAt -> retained
	const legacyStale = `evt-w2a-r-legstale-${randomUUID().replaceAll("-", "")}` // (c) no recordedAt, old timestamp -> pruned
	const legacyFresh = `evt-w2a-r-legfresh-${randomUUID().replaceAll("-", "")}` // (d) no recordedAt, fresh timestamp -> retained
	const futureDated = `evt-w2a-r-future-${randomUUID().replaceAll("-", "")}` // (e) future timestamp, fresh recordedAt -> retained
	await seedRetention(staleAccepted, daysAgo(0), daysAgo(40))
	await seedRetention(historicalImport, daysAgo(40), daysAgo(0))
	await seedRetention(legacyStale, daysAgo(40))
	await seedRetention(legacyFresh, daysAgo(0))
	await seedRetention(futureDated, daysAgo(-40), daysAgo(0))

	const pruneResult = await pruneIdempotencyFingerprints({
		db,
		prefix: PREFIX,
		agentId: AGENT,
		olderThanDays: 30,
	})
	check("prune modifiedCount (stale accepted + legacy stale only)", pruneResult.pruned, 2)
	const keyPresence = async (eventId: string) =>
		(await eventsCollection(db, PREFIX)
			.find({ eventId }, { projection: { _id: 0, idempotencyKey: 1 } })
			.toArray())[0]?.idempotencyKey
	check("(a) old recordedAt pruned", await keyPresence(staleAccepted), undefined)
	check(
		"(b) historical import RETAINED (ages by acceptance, not event time)",
		await keyPresence(historicalImport),
		`key-${historicalImport}`,
	)
	check("(c) legacy row without recordedAt still pruned by timestamp", await keyPresence(legacyStale), undefined)
	check("(d) legacy fresh row retained", await keyPresence(legacyFresh), `key-${legacyFresh}`)
	check(
		"(e) future-dated event no longer extends retention (retained, not immortal)",
		await keyPresence(futureDated),
		`key-${futureDated}`,
	)

	console.log(
		failures === 0
			? `PASS: ${total}/${total} assertions`
			: `FAIL: ${failures} of ${total} assertions`,
	)
} finally {
	await client.db(database).dropDatabase()
	console.log(`cleanup: dropped scratch database ${database}`)
	await client.close()
}

process.exit(failures === 0 ? 0 : 1)
