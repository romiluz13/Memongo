#!/usr/bin/env node
/**
 * Memongo TTL retention-hold helper.
 *
 * One narrow responsibility: the inventory/persist/pause/restore lifecycle of
 * ordinary single-field TTL indexes around a maintenance-window migration.
 * No framework, no background process, no server-wide toggles, no collection
 * creation (a dropped or missing namespace is NEVER recreated by this tool).
 *
 * Supported policy boundary: only the three normal Memongo TTL forms pass
 * inventory, enforced by explicit VALUE checks, not option-name whitelisting:
 *   A) partial:  key {<field>:1}, integer expireAfterSeconds in
 *      0..2147483647, partialFilterExpression EXACTLY
 *      {<same field>: {$exists: true}}
 *   B) seconds:  key {<field>:1}, integer expireAfterSeconds in
 *      0..2147483647, no partialFilterExpression
 *   C) quarantine: key {<field>:1}, integer expireAfterSeconds in
 *      0..2147483647, partialFilterExpression EXACTLY
 *      {status: {$in: ["pending-review", "promoting"]}}
 *      (the shipped default,
 *      packages/memory-engine/src/mongodb-schema-standard-indexes-operations.ts:444-452;
 *      the $in values are checked as an explicit set — no general $in parsing;
 *      the legacy single-value form {status:"pending-review"} is NOT admitted)
 * Any form may additionally carry collation EXACTLY {"locale":"simple"}:
 * MongoDB 9 emits that shape on every default TTL index. It is preserved
 * verbatim in the hold and replayed on restore. Arbitrary locale/option
 * collations are rejected.
 * Every recorded value must be JSON-native (no Date/ObjectId/Long/...), so
 * the pause file is a faithful copy of the policy, not a lossy projection.
 * Unique/compound/custom/BSON-valued policies are rejected at inventory with
 * exit 3 BEFORE any mutation; they need manual DBA handling.
 *
 * Lifecycle invariants (each pinned by the unit and e2e suites):
 *   - pending is uncertain progress, not proof of an intact policy: restore
 *     shares ONE identity-checked restoration path across pending, paused,
 *     and restored states; missing recorded indexes are recreated in all of
 *     them (an interrupted removal before a crash is repaired, not reported
 *     as an unsalvageable mismatch).
 *   - full live-policy revalidation before ANY mutation: a live same-name
 *     index must conform to the recorded spec COMPLETELY — every policy
 *     field (key, name, expireAfterSeconds, partialFilterExpression,
 *     collation) equal and no option outside the allowed set — before pause
 *     drops it or restore accepts it. A changed same-name policy (e.g. an
 *     added unique constraint) is never dropped or replaced; it stays live
 *     and the namespace is reported/refused as unresolved.
 *   - pause validates BEFORE it mutates: pass 1 re-verifies identity, state,
 *     complete live policy shape, and the absence of unrecorded TTL indexes
 *     for EVERY held namespace with zero writes; only a fully validated hold
 *     enters pass 2, which re-reads and re-validates each same-name index
 *     immediately before dropping it. A refusal anywhere in pass 1 leaves
 *     every collection's policy untouched.
 *   - an unrecorded live TTL index makes a namespace UNRESOLVED instead of
 *     hold-usable: inspect reports it (consistent:false, holdUsable:false)
 *     and restore records the namespace unresolved, retains the hold, and
 *     exits 4 — the index itself is never dropped by this tool.
 *   - an unresolved hold is never auto-closed: closing it and taking a new
 *     inventory would silently replace the restore source of truth. The
 *     operator reconciles the live policy explicitly, then re-runs restore.
 *
 * Connection-string safety: the URI is read ONLY from the environment
 * (MEMONGO_MONGODB_URI, trimmed); a --uri argument is rejected with exit 2,
 * and no output ever echoes the URI or its credentials — error text is
 * redacted before printing, except connection-string parse failures,
 * which render a static diagnostic (parser messages can quote a
 * standalone credential fragment no URI-shaped redaction rule can see).
 *
 * Usage:
 *   MEMONGO_MONGODB_URI=<uri> node scripts/mongodb-ttl-retention-hold.mjs \
 *       --db DB --file HOLDFILE inspect
 *   ... inventory NS [NS...]     preflight + persist original policies/identity
 *   ... pause                    verify ALL identities, drop recorded TTL indexes
 *   ... mark-source-dropped NS   record verified source absence after the
 *                                migration CLI dropped the namespace
 *   ... restore                  per-namespace independent restore; closes hold
 *                                only when every namespace is terminal
 *
 * The loaded hold is bound to --db and to hold format version 3: a hold file
 * recorded for another database, or by another helper version, is refused by
 * every command (exit 5).
 *
 * Exit codes: 0 ok | 2 usage (including any --uri argument) | 3 unsupported
 *             policy (preflight, zero mutation) | 4 identity/integrity
 *             mismatch or unresolved restore | 5 unexpected state | 1 other
 *             error. JSON on stdout.
 */
import { MongoClient } from "mongodb"
import {
	closeSync,
	existsSync,
	fsyncSync,
	openSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs"
import { dirname } from "node:path"

const ALLOWED_SPEC_KEYS = new Set([
	"v",
	"ns",
	"key",
	"name",
	"expireAfterSeconds",
	"partialFilterExpression",
	"collation",
])
const POLICY_FIELDS = [
	"key",
	"name",
	"expireAfterSeconds",
	"partialFilterExpression",
	"collation",
]
const MAX_EXPIRE_SECONDS = 2147483647 // official TTL upper bound (collMod reference)
const HOLD_VERSION = 3
const QUARANTINE_PFE_FIELD = "status"
const QUARANTINE_PFE_VALUES = ["pending-review", "promoting"] // explicit set, checked sorted

function canon(v) {
	if (Array.isArray(v)) return v.map(canon)
	if (v && typeof v === "object") {
		return Object.fromEntries(
			Object.keys(v)
				.sort()
				.map((k) => [k, canon(v[k])]),
		)
	}
	return v
}
// eq is faithful here because inventory admits only JSON-native values.
const eq = (a, b) => JSON.stringify(canon(a)) === JSON.stringify(canon(b))
const uuidHex = (u) => Buffer.from(u.buffer ?? u).toString("hex")

/** Redact connection strings from any text before it is printed: the exact
 *  environment value first, then any mongodb:// or mongodb+srv:// string.
 *  The URI and its credentials never appear in helper output. */
function redact(text) {
	let out = text
	const uriEnv = process.env.MEMONGO_MONGODB_URI?.trim()
	if (uriEnv) out = out.split(uriEnv).join("[redacted-uri]")
	return out.replace(/mongodb(\+srv)?:\/\/[^\s"']+/g, "[redacted-uri]")
}

function fail(code, msg, extra = {}) {
	console.log(JSON.stringify({ ok: false, error: redact(msg), ...extra }))
	process.exit(code)
}

/** Static diagnostic for connection-string parse failures: parser and
 *  driver messages quote the offending URI (whole or fragment — including
 *  a standalone username no URI-shaped redaction rule can see), so no part
 *  of such a message is safe to render. Wording matches the migration
 *  CLI's funnel (migrate-to-shared-prefix.ts PARSE_FAILURE) so both tools
 *  diagnose identically. */
const PARSE_FAILURE =
	"MEMONGO_MONGODB_URI is not a valid MongoDB connection string (MongoParseError); the value is never echoed"

function atomicWrite(file, data) {
	const tmp = `${file}.tmp-${process.pid}`
	writeFileSync(tmp, data)
	const fd = openSync(tmp, "r")
	fsyncSync(fd)
	closeSync(fd)
	renameSync(tmp, file)
	const dfd = openSync(dirname(file), "r")
	fsyncSync(dfd)
	closeSync(dfd)
}
function loadHold(file) {
	if (!existsSync(file)) return null
	const hold = JSON.parse(readFileSync(file, "utf8"))
	if (hold?.version !== HOLD_VERSION) {
		fail(
			5,
			`hold file version ${hold?.version ?? "unknown"} is not supported by this helper (hold format ${HOLD_VERSION}); resolve it with the helper version that created it`,
		)
	}
	return hold
}
function saveHold(file, hold) {
	atomicWrite(file, `${JSON.stringify(hold, null, 2)}\n`)
}
function bindDb(hold, dbName) {
	if (hold.db !== dbName) {
		fail(
			5,
			`hold file belongs to db "${hold.db}"; refusing to act on db "${dbName}"`,
		)
	}
}

/** Defense-in-depth: every recorded spec value must be a JSON-native value,
 *  so JSON persistence/replay cannot silently change the policy (a BSON Date
 *  would persist as a string and restore as a string — rejected here instead). */
function assertJsonNative(v, path) {
	if (v === null) return
	const t = typeof v
	if (t === "string" || t === "boolean") return
	if (t === "number") {
		if (!Number.isFinite(v)) throw new Error(`non-finite number at ${path}`)
		return
	}
	if (Array.isArray(v)) {
		for (let i = 0; i < v.length; i++) assertJsonNative(v[i], `${path}[${i}]`)
		return
	}
	if (
		t === "object" &&
		(v.constructor === Object || Object.getPrototypeOf(v) === null)
	) {
		for (const k of Object.keys(v)) assertJsonNative(v[k], `${path}.${k}`)
		return
	}
	throw new Error(
		`non-JSON-native value (${v?.constructor?.name ?? t}) at ${path}`,
	)
}

/** Explicit value checks for the three supported normal Memongo TTL forms
 *  plus the optional exact simple collation. Returns an error string, or
 *  null when the spec is supported. */
function unsupportedSpecReason(spec) {
	if (typeof spec.name !== "string" || spec.name.length === 0) {
		return "index name must be a non-empty string"
	}
	const keyKeys =
		spec.key && typeof spec.key === "object" ? Object.keys(spec.key) : []
	if (keyKeys.length !== 1) {
		return `TTL key must be exactly one field (got ${keyKeys.length}); compound TTL is unsupported`
	}
	if (spec.key[keyKeys[0]] !== 1) {
		return `TTL key value must be 1 (ascending) on field "${keyKeys[0]}"`
	}
	const eas = spec.expireAfterSeconds
	if (
		typeof eas !== "number" ||
		!Number.isInteger(eas) ||
		eas < 0 ||
		eas > MAX_EXPIRE_SECONDS
	) {
		return `expireAfterSeconds must be an integer in 0..${MAX_EXPIRE_SECONDS} (got ${JSON.stringify(eas)})`
	}
	const col = spec.collation
	if (col !== undefined) {
		// Only the exact MongoDB 9 default shape: {"locale":"simple"}. Any other
		// locale or any additional collation option is unsupported.
		const colKeys =
			col && typeof col === "object" && !Array.isArray(col)
				? Object.keys(col)
				: []
		if (
			colKeys.length !== 1 ||
			colKeys[0] !== "locale" ||
			col.locale !== "simple"
		) {
			return `collation must be exactly {"locale":"simple"} (got ${JSON.stringify(col)}); arbitrary locale/option collations are unsupported`
		}
	}
	const pfe = spec.partialFilterExpression
	if (pfe !== undefined) {
		const pfeKeys =
			pfe && typeof pfe === "object" && !Array.isArray(pfe)
				? Object.keys(pfe)
				: []
		if (pfeKeys.length !== 1) {
			return `partialFilterExpression must have exactly one top-level field (got ${pfeKeys.length}); multi-field/custom filters are unsupported`
		}
		const field = pfeKeys[0]
		const cond = pfe[field]
		const condKeys =
			cond && typeof cond === "object" && !Array.isArray(cond)
				? Object.keys(cond)
				: []
		// Form A: {<indexed field>: {$exists: true}}
		const isExistsForm =
			field === keyKeys[0] &&
			condKeys.length === 1 &&
			condKeys[0] === "$exists" &&
			cond.$exists === true
		// Form C (quarantine default): {status: {$in: ["pending-review","promoting"]}}
		// with the values checked as an explicit string set; no general $in parsing.
		const inVals =
			condKeys.length === 1 && condKeys[0] === "$in" && Array.isArray(cond.$in)
				? cond.$in
				: null
		const isQuarantineForm =
			field === QUARANTINE_PFE_FIELD &&
			inVals !== null &&
			inVals.length === QUARANTINE_PFE_VALUES.length &&
			inVals.every((v) => typeof v === "string") &&
			JSON.stringify([...inVals].sort()) ===
				JSON.stringify([...QUARANTINE_PFE_VALUES].sort())
		if (!isExistsForm && !isQuarantineForm) {
			return `partialFilterExpression must be exactly {"${keyKeys[0]}":{"$exists":true}} or the quarantine default {"${QUARANTINE_PFE_FIELD}":{"$in":${JSON.stringify(QUARANTINE_PFE_VALUES)}}}; custom/BSON-valued filters (e.g. $gt with a Date) and the legacy single-value form are unsupported`
		}
	}
	try {
		assertJsonNative(spec, "spec")
	} catch (e) {
		return e.message
	}
	return null
}

const args = process.argv.slice(2)
function opt(flag) {
	const i = args.indexOf(flag)
	return i >= 0 ? args[i + 1] : undefined
}
// The connection string is never accepted on the command line.
if (args.includes("--uri") || args.some((a) => a.startsWith("--uri="))) {
	fail(
		2,
		"--uri is not accepted; set MEMONGO_MONGODB_URI in the environment instead",
	)
}
const uri = process.env.MEMONGO_MONGODB_URI?.trim()
const dbName = opt("--db")
const file = opt("--file")
const positional = args.filter(
	(a, i) =>
		!a.startsWith("--") && args[i - 1] !== "--db" && args[i - 1] !== "--file",
)
const command = positional[0]
const namespaces = positional.slice(1)
if (!uri || !dbName || !file || !command) {
	fail(
		2,
		"usage: MEMONGO_MONGODB_URI=<uri> (env) --db DB --file HOLDFILE <inspect|inventory|pause|mark-source-dropped|restore> [NS...]",
	)
}

let client
try {
	client = new MongoClient(uri, {
		serverSelectionTimeoutMS: 5000,
		socketTimeoutMS: 15_000,
		maxPoolSize: 2,
	})
	await client.connect()
	const db = client.db(dbName)

	async function collInfo(ns) {
		const arr = await db.listCollections({ name: ns }).toArray()
		return arr[0] ?? null
	}
	async function listIndexes(ns) {
		return db.collection(ns).listIndexes().toArray()
	}
	async function ttlIndexes(ns) {
		return (await listIndexes(ns)).filter(
			(i) => i.expireAfterSeconds !== undefined,
		)
	}
	/** Full live-policy revalidation: a live index conforms to a recorded spec
	 *  only when it carries NO option outside the allowed set and EVERY policy
	 *  field is equal. Returns an error string, or null when conforming. This
	 *  is the check performed before ANY mutation or acceptance, so a changed
	 *  same-name policy (e.g. an added unique constraint, an arbitrary
	 *  collation, a drifted filter) is never dropped or replaced. */
	function nonConformingLiveReason(cur, spec) {
		const extra = Object.keys(cur).filter((k) => !ALLOWED_SPEC_KEYS.has(k))
		if (extra.length) {
			return `unexpected option(s) ${extra.join(",")} on live index ${cur.name}`
		}
		if (cur.expireAfterSeconds === undefined) {
			return `index ${cur.name} is no longer a TTL index`
		}
		for (const f of POLICY_FIELDS) {
			if (!eq(cur[f], spec[f])) {
				return `field ${f} of live index ${cur.name} differs from the recorded policy`
			}
		}
		return null
	}
	/** Do all recorded specs have a conforming live same-name index? */
	function specsMatchLive(specs, live) {
		return specs.every((spec) => {
			const cur = live.find((i) => i.name === spec.name)
			return !!cur && !nonConformingLiveReason(cur, spec)
		})
	}
	/** Live TTL indexes no recorded spec accounts for. Never dropped by this
	 *  tool; their presence makes the namespace unresolved, not hold-usable. */
	function extraTtlIndexes(specs, live) {
		return live.filter(
			(i) =>
				i.expireAfterSeconds !== undefined &&
				!specs.some((s) => s.name === i.name),
		)
	}

	if (command === "inspect") {
		const hold = loadHold(file)
		if (hold) bindDb(hold, dbName)
		const hello = await db.admin().command({ hello: 1 })
		const live = {}
		let holdUsable = true
		for (const e of hold?.namespaces ?? []) {
			const info = await collInfo(e.collection)
			const idx = info ? await listIndexes(e.collection) : []
			const liveTtls = idx.filter((i) => i.expireAfterSeconds !== undefined)
			const uuidMatches = info ? uuidHex(info.info.uuid) === e.uuid : false
			const extras = info
				? extraTtlIndexes(e.ttlIndexes, idx).map((i) => i.name)
				: []
			let consistent
			if (e.state === "source-dropped") consistent = !info
			else if (e.state === "paused") {
				consistent = !!info && uuidMatches && liveTtls.length === 0
			} else {
				// pending | restored: every recorded spec live-conforming AND no
				// unrecorded live TTL index (extras make the namespace unresolved —
				// the hold is not usable while unaccounted retention is live; the
				// extra indexes themselves are never dropped here).
				consistent =
					!!info &&
					uuidMatches &&
					specsMatchLive(e.ttlIndexes, idx) &&
					extras.length === 0
			}
			if (!consistent) holdUsable = false
			live[e.collection] = {
				state: e.state,
				exists: !!info,
				uuidMatches,
				currentTtlIndexes: liveTtls.map((i) => i.name),
				...(extras.length ? { unrecordedTtlIndexes: extras } : {}),
				consistent,
			}
		}
		console.log(
			JSON.stringify(
				{
					ok: true,
					hold: hold ?? "none",
					holdUsable: hold ? holdUsable : null,
					live,
					topology: {
						setName: hello.setName ?? null,
						isWritablePrimary: hello.isWritablePrimary === true,
					},
				},
				null,
				2,
			),
		)
	} else if (command === "inventory") {
		if (namespaces.length === 0) fail(2, "inventory requires namespaces")
		if (existsSync(file)) {
			fail(
				5,
				"pause file already exists; run inspect and resolve the active hold first",
			)
		}
		const hello = await db.admin().command({ hello: 1 })
		const out = []
		for (const ns of namespaces) {
			const info = await collInfo(ns)
			if (!info) fail(3, `namespace not found: ${ns}`)
			if (info.type !== "collection") {
				fail(
					3,
					`not an ordinary collection (type=${info.type}): ${ns}; time-series retention is out of scope`,
				)
			}
			if (info.options?.expireAfterSeconds !== undefined) {
				fail(
					3,
					`collection-level expireAfterSeconds on ${ns}; time-series retention is out of scope`,
				)
			}
			const ttls = await ttlIndexes(ns)
			const specs = []
			for (const idx of ttls) {
				const extra = Object.keys(idx).filter((k) => !ALLOWED_SPEC_KEYS.has(k))
				if (extra.length) {
					fail(
						3,
						`unsupported option(s) ${extra.join(",")} on TTL index ${idx.name} (${ns}); unique/custom policies need manual DBA handling; zero mutation performed`,
					)
				}
				const spec = {
					key: idx.key,
					name: idx.name,
					expireAfterSeconds: idx.expireAfterSeconds,
				}
				if (idx.partialFilterExpression !== undefined) {
					spec.partialFilterExpression = idx.partialFilterExpression
				}
				if (idx.collation !== undefined) spec.collation = idx.collation
				const reason = unsupportedSpecReason(spec)
				if (reason) {
					fail(
						3,
						`unsupported TTL policy on ${idx.name} (${ns}): ${reason}; zero mutation performed`,
					)
				}
				specs.push(spec)
			}
			out.push({
				collection: ns,
				uuid: uuidHex(info.info.uuid),
				state: "pending",
				ttlIndexes: specs,
			})
		}
		const hold = {
			version: HOLD_VERSION,
			savedAt: new Date().toISOString(),
			db: dbName,
			topology: {
				setName: hello.setName ?? null,
				isWritablePrimary: hello.isWritablePrimary === true,
			},
			namespaces: out,
		}
		atomicWrite(file, `${JSON.stringify(hold, null, 2)}\n`)
		console.log(
			JSON.stringify(
				{
					ok: true,
					persisted: file,
					namespaces: out.map((e) => ({
						collection: e.collection,
						uuid: e.uuid,
						ttl: e.ttlIndexes.map((s) => s.name),
					})),
				},
				null,
				2,
			),
		)
	} else if (command === "pause") {
		const hold = loadHold(file) ?? fail(5, "no pause file; nothing to pause")
		bindDb(hold, dbName)
		const verified = []
		const paused = []
		// Pass 1 (read-only): validate EVERY held namespace BEFORE any mutation
		// anywhere in the hold; a refusal here leaves every collection's policy
		// untouched (an interleaved validate-and-drop design could refuse a
		// later namespace's drift only after an earlier namespace had already
		// lost its TTL policy).
		for (const e of hold.namespaces) {
			const info = await collInfo(e.collection)
			// Identity verification applies to EVERY held namespace on every entry,
			// including already-paused ones: re-entry must not return ok after
			// namespace replacement or TTL recreation.
			if (e.state === "source-dropped") {
				if (info) {
					fail(
						4,
						`namespace ${e.collection} reappeared after recorded migration drop; refusing to declare the hold usable`,
					)
				}
				verified.push({
					collection: e.collection,
					state: e.state,
					detail: "absent as recorded",
				})
				continue
			}
			if (e.state === "restored") {
				fail(
					5,
					`namespace ${e.collection} is already restored; resolve the hold via restore, not pause`,
				)
			}
			if (!info) {
				fail(
					4,
					`namespace missing before pause: ${e.collection} (state ${e.state})`,
				)
			}
			const liveUuid = uuidHex(info.info.uuid)
			if (liveUuid !== e.uuid) {
				fail(
					4,
					`UUID mismatch (foreign namespace reuse?) on ${e.collection}: recorded ${e.uuid}, live ${liveUuid}; refusing to declare the hold usable`,
				)
			}
			const live = await listIndexes(e.collection)
			const liveTtls = live.filter((i) => i.expireAfterSeconds !== undefined)
			if (e.state === "paused") {
				if (liveTtls.length) {
					fail(
						4,
						`TTL index(es) present on already-paused ${e.collection}: ${liveTtls.map((i) => i.name).join(",")}; hold compromised — investigate; unrecorded indexes are never dropped by this tool`,
					)
				}
				verified.push({
					collection: e.collection,
					state: e.state,
					detail: "identity and zero-TTL re-verified",
				})
				continue
			}
			// state pending: full live-policy revalidation of each recorded policy
			// against the live same-name index; a changed same-name policy (e.g.
			// an added unique constraint) is never dropped.
			for (const spec of e.ttlIndexes) {
				const cur = live.find((i) => i.name === spec.name)
				if (!cur) continue // interrupted-removal residue: tolerated, handled in pass 2
				const reason = nonConformingLiveReason(cur, spec)
				if (reason) {
					fail(
						4,
						`policy drift on ${e.collection}.${spec.name}: ${reason}; refusing to drop a changed same-name policy`,
					)
				}
			}
			// Unrecorded live TTL indexes refuse the pause BEFORE any mutation:
			// unrecorded indexes are never dropped by this tool.
			const extras = extraTtlIndexes(e.ttlIndexes, live)
			if (extras.length) {
				fail(
					4,
					`unrecorded TTL index(es) on ${e.collection}: ${extras.map((i) => i.name).join(",")}; not in the recorded policy — refusing to drop them; resolve manually`,
				)
			}
			verified.push({
				collection: e.collection,
				state: e.state,
				detail: "identity, policy shape, and TTL inventory validated",
			})
		}
		// Pass 2 (mutation): the whole hold validated. Drop each recorded policy,
		// re-reading live shape and re-validating each same-name index
		// immediately before its drop, so drift between the passes is still
		// never dropped. Per-namespace pausedAt/saveHold ordering is preserved:
		// a crash mid-pass leaves pending namespaces as uncertain progress that
		// restore repairs.
		for (const e of hold.namespaces) {
			if (e.state !== "pending") continue
			const live = await listIndexes(e.collection)
			const dropped = []
			const alreadyAbsent = []
			for (const spec of e.ttlIndexes) {
				const cur = live.find((i) => i.name === spec.name)
				if (!cur) {
					alreadyAbsent.push(spec.name) // interrupted removal resume: drop happened before the crash
					continue
				}
				const reason = nonConformingLiveReason(cur, spec)
				if (reason) {
					fail(
						4,
						`policy drift on ${e.collection}.${spec.name}: ${reason}; refusing to drop a changed same-name policy`,
					)
				}
				await db.collection(e.collection).dropIndex(spec.name)
				dropped.push(spec.name)
			}
			const remaining = await ttlIndexes(e.collection)
			if (remaining.length) {
				fail(
					4,
					`unrecorded TTL index(es) on ${e.collection}: ${remaining.map((i) => i.name).join(",")}; not in the recorded policy — refusing to drop them; resolve manually`,
				)
			}
			e.state = "paused"
			e.pausedAt = new Date().toISOString()
			saveHold(file, hold)
			paused.push({ collection: e.collection, dropped, alreadyAbsent })
		}
		console.log(JSON.stringify({ ok: true, verified, paused }))
	} else if (command === "mark-source-dropped") {
		const hold = loadHold(file) ?? fail(5, "no pause file")
		bindDb(hold, dbName)
		const ns =
			namespaces[0] ?? fail(2, "mark-source-dropped requires a namespace")
		const e =
			hold.namespaces.find((n) => n.collection === ns) ??
			fail(2, `namespace not in hold: ${ns}`)
		const info = await collInfo(ns)
		if (e.state === "source-dropped") {
			// Safe repeat after an uncertain mark response: reaffirm only if still absent.
			if (info) {
				fail(
					4,
					`namespace ${ns} reappeared after recorded migration drop; refusing to reaffirm the mark`,
				)
			}
			console.log(
				JSON.stringify({ ok: true, alreadyMarked: ns, verifiedAbsent: true }),
			)
		} else {
			if (e.state !== "paused") {
				fail(
					5,
					`mark-source-dropped requires paused state: ${ns} is ${e.state}`,
				)
			}
			if (info) {
				const liveUuid = uuidHex(info.info.uuid)
				if (liveUuid !== e.uuid) {
					fail(
						4,
						`foreign namespace reuse on ${ns}: recorded ${e.uuid}, live ${liveUuid}; refusing to mark`,
					)
				}
				fail(
					5,
					`source ${ns} is still present (UUID matches recorded policy); the migration --drop did not complete or its receipt is uncertain — refusing to mark`,
				)
			}
			e.state = "source-dropped"
			e.droppedAt = new Date().toISOString()
			saveHold(file, hold)
			console.log(
				JSON.stringify({ ok: true, marked: ns, verifiedAbsent: true }),
			)
		}
	} else if (command === "restore") {
		const hold = loadHold(file) ?? fail(5, "no pause file; nothing to restore")
		bindDb(hold, dbName)
		const results = []
		const unresolved = []
		// Every namespace is handled independently: a missing/unresolved identity
		// never blocks the recovery of later healthy namespaces. The hold file is
		// retained and the exit is unsuccessful while any namespace is unresolved.
		for (const e of hold.namespaces) {
			const info = await collInfo(e.collection)
			if (e.state === "source-dropped") {
				if (info) {
					unresolved.push(e.collection)
					results.push({
						collection: e.collection,
						status: "unresolved",
						reason:
							"namespace reappeared after recorded migration drop; refusing to touch it",
					})
					continue
				}
				results.push({
					collection: e.collection,
					status: "terminal",
					detail: "dropped by migration; never recreated",
				})
				continue
			}
			if (!info) {
				unresolved.push(e.collection)
				results.push({
					collection: e.collection,
					status: "unresolved",
					reason: `namespace missing in state ${e.state}; NOT recreating it — investigate, then mark-source-dropped (only if the migration --drop receipt is confirmed) or restore the collection manually`,
				})
				continue
			}
			const liveUuid = uuidHex(info.info.uuid)
			if (liveUuid !== e.uuid) {
				unresolved.push(e.collection)
				results.push({
					collection: e.collection,
					status: "unresolved",
					reason: `UUID mismatch (foreign namespace reuse?): recorded ${e.uuid}, live ${liveUuid}; refusing to restore`,
				})
				continue
			}
			// Shared identity-checked restoration for pending, paused, and restored
			// states: pending is uncertain progress, not proof of an intact
			// policy — an interrupted removal may already have dropped the index
			// before the crash. Missing recorded indexes are recreated identically
			// in all three states. A changed same-name live policy is never
			// replaced: it stays live and the namespace is reported unresolved.
			const prior = e.state
			const problems = []
			const recreated = []
			for (const spec of e.ttlIndexes) {
				const cur = (await listIndexes(e.collection)).find(
					(i) => i.name === spec.name,
				)
				if (cur) {
					const reason = nonConformingLiveReason(cur, spec)
					if (reason) problems.push(`${spec.name}: ${reason}`)
					continue // conforming policy already live; incompatible policy preserved
				}
				const create = {
					key: spec.key,
					name: spec.name,
					expireAfterSeconds: spec.expireAfterSeconds,
				}
				if (spec.partialFilterExpression !== undefined) {
					create.partialFilterExpression = spec.partialFilterExpression
				}
				if (spec.collation !== undefined) create.collation = spec.collation
				await db.collection(e.collection).createIndexes([create])
				const after = (await listIndexes(e.collection)).find(
					(i) => i.name === spec.name,
				)
				if (!after) {
					problems.push(
						`${spec.name}: recreated index not visible in listIndexes`,
					)
					continue
				}
				const reason = nonConformingLiveReason(after, spec)
				if (reason)
					problems.push(
						`${spec.name}: round-trip mismatch after recreation (${reason})`,
					)
				else recreated.push(spec.name)
			}
			if (problems.length) {
				unresolved.push(e.collection)
				results.push({
					collection: e.collection,
					status: "unresolved",
					reason: `recorded policy not live-conforming: ${problems.join("; ")}; incompatible existing policies preserved — manual resolution required`,
				})
				continue
			}
			// An unrecorded live TTL index makes the namespace UNRESOLVED — it is
			// never dropped by this tool, and the hold must not close while
			// retention the hold never accounted for is live. The recorded policy
			// above was still restored/verified — per-namespace convergence is
			// safe and idempotent — only hold closure is refused. The recorded
			// state is intentionally left unchanged so a later restore re-runs
			// the full identity-checked path after the operator resolves the
			// extra index.
			const extraTtl = extraTtlIndexes(
				e.ttlIndexes,
				await listIndexes(e.collection),
			).map((i) => i.name)
			if (extraTtl.length) {
				unresolved.push(e.collection)
				results.push({
					collection: e.collection,
					status: "unresolved",
					reason: `unrecorded TTL index(es) live, left untouched: ${extraTtl.join(",")}; the hold never accounted for this retention — preserve the hold and its recorded policy, explicitly reconcile the live policy, then re-run restore`,
					...(recreated.length ? { restored: recreated } : {}),
				})
				continue
			}
			e.state = "restored"
			e.restoredAt = new Date().toISOString()
			saveHold(file, hold)
			const detail = recreated.length
				? `${prior === "pending" ? "missing recorded index(es) recreated after interrupted removal" : "missing recorded index(es) recreated"}: ${recreated.join(",")}`
				: prior === "pending"
					? "policy verified intact (never paused)"
					: prior === "restored"
						? "verified still restored"
						: "recorded policy already live"
			results.push({
				collection: e.collection,
				status: "terminal",
				detail,
				...(recreated.length ? { restored: recreated } : {}),
			})
		}
		if (unresolved.length === 0) {
			unlinkSync(file)
			console.log(JSON.stringify({ ok: true, results, holdClosed: true }))
		} else {
			saveHold(file, hold)
			console.log(
				JSON.stringify(
					{ ok: false, results, unresolved, holdRetained: file },
					null,
					2,
				),
			)
			process.exit(4)
		}
	} else {
		fail(2, `unknown command: ${command}`)
	}
} catch (e) {
	if (e instanceof Error && e.name === "MongoParseError") {
		// Both MongoParseError classes (connection-string parser and
		// driver) are thrown while interpreting MEMONGO_MONGODB_URI, before
		// any connection attempt — detection is name-based because the two
		// are distinct classes. The static diagnostic replaces the parser's
		// message, which can quote a standalone credential fragment.
		fail(1, PARSE_FAILURE)
	}
	if (e?.codeName) fail(1, `server error ${e.codeName}: ${e.message}`)
	if (typeof e?.message === "string") fail(1, e.message)
	throw e
} finally {
	await client?.close().catch(() => {})
}
