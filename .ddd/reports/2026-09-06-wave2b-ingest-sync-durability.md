# Wave 2b — ingest/sync durability (W07, W14, W15)

Date: 2026-09-06
Scope: second landing of the write-durability wave (DDD v0.7.1). Three
findings in the ingest/sync core: duplicate chunk identities for long lines
(W07), transient source-read failure interpreted as deletion (W14), and the
"atomic" file replacement that commits the delete before the replacement
(W15). W07 lands first — W15's single-transaction design depends on
collision-free chunk identities (an upsert in a transaction does not retry on
duplicate key, EL-024 §8.1).

## Findings (docs/audits/2026-09-05-independent/logic_write.md)

- **W07 (P1)**: `chunkMarkdown` (internal.ts) splits a line longer than the
  chunk budget into `maxChars` segments that all share one `lineNo`, so every
  segment of that line flushes with the same `{startLine, endLine}`. Chunk
  identity is `storageId:startLine:endLine` (`buildChunkId`,
  mongodb-sync.ts) and the KB upsert filter is
  `{scopeRef, path, startLine, endLine}` behind unique index
  `uq_kbchunks_scope_path_lines`: colliding upserts are last-write-wins
  (EL-025: an updateOne applies to the first matching document), silently
  dropping every earlier segment while file metadata advances the source
  hash, so the loss is never retried. `carryOverlap` carries whole entries,
  letting one 1600-char segment drag a 1600-char overlap into the next chunk
  (3201 chars against a 1600 target). Audit evidence: a 10,000-char line
  produced seven chunks, every range `[1,1]`, one storage identity. The
  markdown sync, session sync, and KB ingest paths all share this defect;
  event-projected chunks (`events/{eventId}`, one per event) are unaffected.
- **W14 (P2)**: `listMemoryFiles`/`listLegacyMarkdownMemoryFiles`
  (internal.ts) and `listSessionFilesForAgent` (session-files.ts) swallow
  every enumeration error with `catch {}`/`catch { return [] }`. Per EL-026,
  `fsPromises.readdir` fulfills with the complete array or rejects — there is
  no partial-result mode — so a swallowed rejection is indistinguishable from
  an empty source at the call site. A transient EACCES then yields
  `validPaths = ∅` and the stale cleanup deletes every stored chunk and file
  metadata row for the namespace. Per-file `buildFileEntry` throws (only on
  non-ENOENT — ENOENT returns null) are logged and dropped from `validPaths`,
  so one unreadable file loses its indexed data too; neither the memory nor
  session per-file catch increments `filesFailed`, and `runSync`
  (mongodb-manager-sync.ts) sets `dirty = false` unconditionally.
- **W15 (P2)**: `syncFileAtomically`/`syncSessionFileAtomically`
  (mongodb-sync.ts) commit the chunk delete in one small transaction, then
  upsert chunks in separate batched transactions, then write metadata. A crash
  after the delete commit leaves the file's chunks gone while stored metadata
  still shows the old (equal) hash, so the next non-forced sync skips the file
  and the loss is permanent — worst on a forced reindex of unchanged source.
  The standalone/non-transactional path has the same sequential window. KB
  re-ingestion (`reIngestAtomically`) already wraps delete+insert in ONE
  transaction and needs no change.

## Documentation basis

Grounded for Wave 2b (captured 2026-09-06, digests in `.ddd/evidence.lock`
EL-024..EL-026, full reliance analysis in `.ddd/cache/`):

- Transactions (EL-024,
  https://www.mongodb.com/docs/manual/core/transactions/): multi-document
  transactions are atomic — "transactions either apply all data changes or
  roll back"; the core API passes a callback to `withTransaction`; a session
  has at most one open transaction; `TransactionTooLargeForCache` (MongoDB
  6.2+, code 388) surfaces to the caller; on 8.1+ an upsert inside a
  transaction is NOT retried on duplicate-key (W07 must land first).
- bulkWrite (EL-025,
  https://www.mongodb.com/docs/manual/reference/method/db.collection.bulkWrite/):
  `updateOne` updates the first matching document; `_id` is unique; inside a
  transaction "the first error in a bulk write causes the entire bulk write to
  fail and aborts the transaction, even if the bulk write is unordered" — the
  one-transaction W15 path is all-or-nothing per the server contract.
- Node fs (EL-026, https://nodejs.org/api/fs.html): `fsPromises.readdir`
  fulfills with the full array of names or rejects; the official example
  wraps it in try/catch. A rejected readdir must therefore be treated as
  "enumeration failed", never as "source is empty" (W14).

Open questions: none.

Final comparison (performed 2026-09-06, post-implementation):

- EL-024 (transactions): `syncSourceFileAtomically` wraps chunk delete +
  chunk bulkWrite + completing metadata in ONE callback-API
  `withTransaction` (mongodb-sync.ts); `TransactionTooLargeForCache` and
  standalone topology both fall back to the invalidation-first
  non-transactional ordering, with `disableTransactions` propagated only
  for standalone (a too-large transaction is per-file). The transaction
  branch has no partial-count handling — per EL-025's in-transaction
  semantics, the first bulkWrite error aborts the whole transaction, which
  is exactly the all-or-nothing replacement W15 requires. Verified live by
  the forced transactional resync (identical 9/9 chunk set) and by the
  mock-injection unit suites for both fallback triggers.
- EL-025 (bulkWrite): `buildChunkId` embeds the emission ordinal, so every
  segment of a long line upserts a distinct `_id` and the updateOne
  first-match collapse cannot occur; KB chunk ops widen filter + doc with
  `ordinal` behind the migrated unique index. The non-transactional
  `upsertChunks` keeps per-op salvage and refuses to advance the stored
  hash while ops still fail. Verified live: a 12,000-char source line
  produced 6 segments with 6 distinct ids, each individually queryable by
  `{path, startLine, endLine, ordinal}`, file ordinals exactly the global
  emission sequence 0..N-1.
- EL-026 (fs.readdir): `walkDir` surfaces readdir rejections (fulfill-all-
  or-reject contract); `listMemoryFiles`, `listLegacyMarkdownMemoryFiles`,
  and `listSessionFilesForAgent` rethrow every non-ENOENT error and skip
  only confirmed-missing paths; `syncToMongoDB` marks the enumeration
  incomplete and skips Phase C stale cleanup; `runSync` keeps the dirty
  flag unless `filesFailed === 0 && enumerationComplete`. Verified live:
  EACCES on the memory dir and EACCES on a single memory file both left
  stored chunks and files rows intact (`enumerationComplete=false`,
  `staleDeleted=0`) while the same probe proved stale cleanup live on a
  healthy sync (a genuinely removed file's chunks deleted).

Corrections from the comparison: none to production code — implementation
matched the documented contracts. Two non-code corrections: Biome format
fixes on this wave's own edits (mongodb-sync.ts import/call wrapping,
mongodb-kb.test.ts formatting), and the live probe's first-attempt
expectations (see validation results).

## Fix design

### W07 — ordinal in chunk identity + character-bounded overlap

1. `MemoryChunk` gains `ordinal: number` — the 0-based emission index of the
   chunk in the chunk list, deterministic for identical content and chunking
   parameters. `chunkMarkdown` assigns it at flush; the single multimodal
   chunk gets `ordinal: 0`.
2. `buildChunkId` widens to `${storageId}:${startLine}:${endLine}:${ordinal}`
   (deterministic segment offset per the audit remedy). `buildChunkOps`
   writes `ordinal` into the `$set` doc; the memory and session paths share
   it. Session truncation (`slice(-maxSessionChunks)`) keeps original
   ordinals — identities stay unique because ordinals are globally distinct
   within a file.
3. KB path: chunk docs and the upsert filter gain `ordinal`; the unique index
   is migrated drop-old/create-new (existing precedent in
   mongodb-schema-standard-indexes-core.ts) from
   `{scopeRef, path, startLine, endLine}` to
   `{scopeRef, path, startLine, endLine, ordinal}` under the new name
   `uq_kbchunks_scope_path_lines_v2`. Legacy kb_chunks docs (missing
   `ordinal`) index under `ordinal: null` and cannot collide with new writes
   (old unique index already enforced one doc per old key); they are removed
   by the repair path below.
4. `carryOverlap` bounds the carried overlap in character space: after
   collecting kept entries (until `acc >= overlapChars`), trim from the front
   so the total carried, counting join newlines, is at most `overlapChars`;
   front-trims are surrogate-pair-safe.
5. One-time healing (`chunkScheme: 2` marker on files metadata and KB
   parents): sync skips a stored file only when the hash matches AND the
   stored `chunkScheme` is current, so every legacy row (including every
   W07-damaged file whose stored hash already equals the source hash) is
   re-chunked once under the new identity. The KB skip gains the same
   condition; a legacy parent takes the repair path, which now deletes the
   parent's old chunks by `docId` before re-upserting (clean replace — old
   identity-width docs must not linger next to the widened identities).

### W14 — enumeration failure is not deletion

1. `listMemoryFiles`/`listLegacyMarkdownMemoryFiles` keep returning
   `string[]` but THROW on non-ENOENT enumeration errors (memoryDir/extraPath
   `lstat`, `walkDir`'s `readdir`); ENOENT stays a legitimate skip (no source
   directory / file confirmed missing). The realpath dedup keeps its raw-path
   fallback (dedup is an optimization; upserts are idempotent).
2. `listSessionFilesForAgent` gets the same contract. `buildSessionEntry`
   rethrows non-ENOENT errors instead of collapsing them into `null`
   (confirmed-missing), so an unreadable session no longer reads as "delete
   its data".
3. `syncToMongoDB` wraps the memory enumeration: on throw it logs, marks
   `enumerationComplete = false`, and skips Phase C (stale chunk + file
   metadata deletion) entirely; a per-file `buildFileEntry` throw does the
   same. `syncSessionFiles` mirrors both guards for its own stale cleanup and
   reports its enumeration state upward.
4. Every per-file catch (memory loop, session loop) increments `filesFailed`;
   a thrown session-stale-cleanup also counts. `SyncResult` gains
   `enumerationComplete`; `runSync` clears `host.dirty` only when
   `filesFailed === 0 && enumerationComplete`, otherwise it logs and keeps
   the dirty flag so the next sync re-attempts.

### W15 — one transaction per file; hash invalidation when atomicity is impossible

1. `syncFileAtomically` and `syncSessionFileAtomically` are unified into one
   `syncSourceFileAtomically` (they were line-for-line duplicates; the
   metadata upserts unify on the shared `{path, hash, mtimeMs, size}` shape).
2. Transactional path: chunk delete + chunk bulkWrite + metadata upsert run
   in ONE callback-API `withTransaction` (EL-024 atomicity; EL-025 in-
   transaction error semantics make the whole file replacement
   all-or-nothing). The E11000-on-upsert caveat (EL-024 §8.1) is safe here:
   identities are collision-free after W07 and a concurrent same-file writer
   aborts one transaction, which `withTransaction` re-runs to a matched
   update.
3. `TransactionTooLargeForCache` (388) fallback: invalidate FIRST — write the
   invalid-hash marker to the stored metadata row (non-transactional,
   committed before any destructive write), then delete in a small
   transaction, `withTransactionBatched` upserts, metadata last. Any crash
   after invalidation leaves a state the next non-forced sync re-attempts.
4. Standalone / no-transaction path: the same invalidation-first ordering
   replaces the current delete-then-upsert. The invalid marker
   (`__invalidated__`) can never collide with a sha256 hex hash (or the
   multimodal chunk hash), and `getStoredFiles` surfaces it as "hash differs"
   so retry selection re-processes the file. A crash after invalidation but
   before completion therefore heals on the next sync — closing the audit's
   "old equal hash while chunks are missing" window.

## Validation plan (native checks)

1. Focused unit battery over every Wave 2b-changed suite (internal,
   mongodb-sync, session-files, kb, schema): unique chunk ids and full source
   reconstruction for long single-line input (the audit's stateful test gap),
   overlap bound in character space, surrogate-safe trims, enumeration-failure
   gating of stale cleanup, `filesFailed`/`enumerationComplete` propagation
   and dirty gating, invalidation-first crash windows, chunkScheme re-chunk
   of legacy rows, KB index migration and clean-replace repair.
2. Live probe on memongo-preview (27019) with production functions and
   indexes on a disposable scratch database: real `uq_kbchunks_*` migration,
   long-line file sync with all segments queryable, legacy re-chunk via
   chunkScheme, forced-reindex invalidation semantics (fail after delete →
   next sync restores), and enumeration-failure no-deletion.
3. Full memory-engine battery on the final tree, repo check-types with
   `--force`, Biome on every touched file.

## Validation results (2026-09-06)

1. Focused unit battery — 288/288 passed (runs/wave2b-unit-suite.log).
2. Live probe on memongo-preview (127.0.0.1:27019, production
   `syncToMongoDB` / `ingestToKB` / `ensureStandardIndexes` / `hashText` on a
   disposable scratch db) — 70/70 passed (runs/w2b-probe.log). Coverage:
   real `uq_kbchunks_scope_path_lines` migration (pre-created old 4-field
   index and ancient global index dropped, `uq_kbchunks_scope_path_lines_v2`
   created on the 5-field key), long-line file sync (12,000-char line → 6
   segments, file ordinals the exact global emission sequence, 9 distinct
   chunk ids, each segment queryable by `{path, startLine, endLine,
   ordinal}`), same-hash skip for current-scheme rows, forced transactional
   resync (identical set), legacy chunkScheme:1 re-chunk (heals last-write-
   wins), W15 sentinel healing (metadata hash `__invalidated__` + all
   chunks deleted → next non-forced sync restores 9/9 + real hash; sentinel
   proven non-hex), W14 unreadable-dir and unreadable-file enumeration
   guards (chunks retained, `enumerationComplete=false`, stale cleanup
   skipped) with stale cleanup itself proven live on a healthy sync, KB
   long-line ingest behind the real v2 unique index, complete-parent skip,
   incomplete-parent repair with clean-replace (injected leftover removed),
   and legacy-scheme parent re-chunk. First attempt (runs/w2b-probe-
   attempt1.log, 62/68) failed six assertions that expected per-line
   0-based ordinals; §W07.1 specifies the global emission index — the probe
   expectations were wrong, production behavior was correct; expectations
   fixed, no production code change resulted, rerun 70/70.
3. Full memory-engine battery — 144 files passed / 4 skipped, 2616 tests
   passed / 10 skipped, exit 0 (includes real-e2e-v2 against the live
   container; runs/wave2b-engine-battery.log).
4. Repo check-types `--force` — 15/15 tasks successful, exit 0
   (runs/wave2b-check-types.log).
5. Biome on the 10 touched files — 0 errors / 15 warnings
   (runs/wave2b-biome-touched.log). Warnings are pre-existing categories
   (noNonNullAssertion, useOptionalChain, noUnusedImports), the same bar as
   landed WS-19; two format errors from this wave's own edits were fixed
   with `biome check --write` (formatting only, first run preserved as
   runs/wave2b-biome-touched-attempt1.log) and both reformatted suites
   re-run green (65/65).

## Status

- [x] Grounding: transactions / bulkWrite / fs.readdir captured (EL-024..EL-026)
- [x] Fix design written (this report)
- [x] Implementation complete (W07 / W14 / W15)
- [x] Focused unit suites green — 288/288 (runs/wave2b-unit-suite.log)
- [x] Live probe on memongo-preview (27019) — 70/70 (runs/w2b-probe.log; first attempt 62/68 in runs/w2b-probe-attempt1.log, probe-expectation errors only)
- [x] Full engine battery + repo check-types + Biome (runs/wave2b-engine-battery.log, runs/wave2b-check-types.log, runs/wave2b-biome-touched.log)
- [x] Claim + validations filed (C-045, V-154..V-157)
- [x] Disposition + landing

## Disposition

**W07, W14, W15: resolved.** Chunk identities embed the emission ordinal
(one unique row per segment behind a widened unique index; a source line
longer than the chunk bound now round-trips completely, and legacy
chunkScheme:1 rows are re-chunked on sight). Enumeration failures are
treated as enumeration-incomplete — stale cleanup skipped, dirty retained —
with only confirmed-missing paths skipped, so a transient readdir failure
can never read as "delete everything". File replacement is one
all-or-nothing `withTransaction` per file, with an invalidation-first
sentinel ordering wherever transactions are unavailable or too large, so a
crash mid-replacement heals on the next non-forced sync.

Verification: focused battery 288/288 (wave2b-unit-suite.log, re-run green
after Biome formatting as wave2b-unit-suite-postformat.log), live probe
70/70 on the real server including the real index migration, sentinel
healing, both W14 enumeration guards, and live stale cleanup
(w2b-probe.log; first attempt 62/68 preserved as w2b-probe-attempt1.log —
all six failures were the probe's own per-line ordinal expectations, not
production behavior), engine battery 144/148 files, 2616/2625 tests, 0
failures (wave2b-engine-battery.log), check-types 15/15 with --force
(wave2b-check-types.log), Biome 0 errors / 15 pre-existing warnings
(wave2b-biome-touched.log + attempt1). Claim C-045, validations
V-154..V-157. Ledger: EL-024..EL-026 with cache captures.

Residual documented (carried forward):

- The invalidation sentinel makes a crash mid-replacement visible to the
  next sync, but the chunks themselves between invalidation and completion
  are still written non-transactionally in the fallback path; the stored
  hash no longer lies about them (it reads "differs"), which is the
  documented-contract-correct state — full per-file atomicity there would
  require a server-side transaction budget the fallback exists to avoid.
- Ordinals are per-file emission indexes, stable only within a chunkScheme
  (2); re-chunk on scheme change rewrites them wholesale, which is why
  old-scheme rows are never partially updated in place.
- The KB unique index migration (uq_kbchunks_scope_path_lines → _v2) runs
  unconditionally in manager init (`ensureStandardIndexes`), so every
  manager-fronted deployment migrates at startup and the re-chunk-on-
  scheme repair heals legacy rows on their next ingest. Direct collection
  writers that bypass the manager are outside this guarantee: against a
  still-unmigrated legacy 4-field unique index, a multi-segment long-line
  write would collide — the documented path to safety is the manager's
  startup ensure, not the raw collection.
- Biome: 15 warnings on touched files, all pre-existing categories
  (noNonNullAssertion / useOptionalChain / noUnusedImports) on lines
  untouched by this wave, same bar as landed WS-19 and Wave 2a (V-156).

Next: Wave 2c (W06, W11, W13, W16, W17), then Waves 3–7, the test-honesty
pass, ledger closure, and re-audit.
