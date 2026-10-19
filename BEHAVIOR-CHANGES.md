# Behavior Changes

Each entry is a behavior that was removed or changed on purpose. The rule behind all of them: no fallback, fail loudly. A failure is never relabeled as an empty or default success.

## T9

Write decisions, LLM extraction, background jobs, transactions and the change stream (#118).

### Write decisions never default

- Consolidator similarity probe: a failed `$vectorSearch` similarity probe used to read as "nothing similar" and the candidate was ADDed. It now throws a typed `SearchLaneError` and the run fails.
- Contradiction detection (`detectContradictions`, `invalidateContradictedFacts`): a provider failure, malformed JSON or a response with no `contradictions` list used to return "no conflict" (`[]` / `0`). It now throws the provider's typed error or `EnrichmentParseError`. An empty list is a verdict only when the model returned one.
- Conflicted-candidate adjudication: with no admission token, failures used to log and return "unresolved" (the old skip). They now throw with or without admission.
- Dedup adjudication: a provider failure, malformed JSON, an unknown verdict or a MERGE without union text used to become `NO_MERGE`. Each now throws `EnrichmentParseError` or the provider error. `NO_MERGE` is a verdict only when the model said so.
- Consolidation reasoning: a provider or parse failure used to return an empty list. It now throws.
- Novelty scan (`scanNovelty`): a failed scan used to return `{ events: [], error: "mongot_unavailable" }`. It now throws a typed `SearchLaneError`. `NoveltyReport.error` is deprecated and never set. Events outside a successful scan's cap still carry the `UNSCORED_NOVELTY` value (0.5); that value means "not scanned", not "scan failed".
- Provider resolution: a configured provider (API key set) that cannot resolve used to become `null`, which read as the no-provider mode. It now throws `EnrichmentConfigError`. No API key stays the declared deterministic-only mode and returns `null`.
- The affected unit is marked failed with retry state and the run row is failed; phase failures in prune, dedup and reasoning leave their events unacknowledged and rethrow instead of being swallowed.

### LLM extraction failures are typed

- Derived-memory extraction: a configured provider whose call fails used to fall back to regex-only candidates. The derivation now fails and the job is retried. Deterministic-only extraction remains when no provider is configured.
- Temporal extraction: a provider failure, a wrong response shape or an unparseable date used to return the event-timestamp baseline. They now throw. The event timestamp is used only when the model answers `validFrom: null` (the text states no date). Both `validFrom` and `validTo` keys are required in the response.
- Relation extraction: a response with no `relations` list used to return `[]`. It now throws `EnrichmentParseError`.
- Entity extraction (`LLMEntityExtractor`): the regex fallback on LLM failure is gone; a failure throws.
- Session enrichment: `extractSessionEnrichment` no longer takes a `strict` option. It always throws parse errors (`strictJson` is removed with it; one argument deleted in `scripts/benchmark/mongodb-manager-benchmark.ts`).

### Consolidator entity filter

- `entitySet` used to scan a batch and regex-filter it afterwards. It now selects the batch with one Atlas Search `$search` `text` query on the events index, with the batch window (`agentId`, `scope`, `scopeRef`, `timestamp` range) in `compound.filter`. The text query is analyzed per term and ORed, so it matches a word, not a regex substring. A failed `$search` throws a typed `SearchLaneError`; it is never an empty batch.

### One ledger per job

- A consolidation run now opens one search ledger and records its snapshot on the `consolidation_runs` row. Inside a background job it joins the job's ledger instead of opening a second one. The exported `consolidationSearchBudgetLimits(maxEvents)` sizes it. Work past the limit throws `SearchBudgetDeniedError`.

### Transactions are required

- Every "transaction unsupported, write without one" fallback is deleted (structured memory, procedures, graph, KB, sync). A deployment that cannot run a transaction now throws `TransactionUnsupportedError` (`code: "TRANSACTION_UNSUPPORTED"`) from `typedTransactionError`. The `TransactionTooLargeForCache` split-and-retry stays; it is a retry, not a downgrade.

### Background jobs are durable

- A job with no event id or a corrupt admission epoch is dead-lettered instead of left `running`.
- A failure in a job's preamble (provider resolution, epoch read, prefetch) or completion write now marks the row `failed` with `error`, `retryAt`, and `deadLetterAt` after the attempt cap. The row used to stay `running` until its lease expired.
- A session-batched prefetch failure fails every job in that session group with the typed error. It no longer runs those jobs one event at a time.
- A failure to write the failure record itself is logged and counted, and the row falls back to lease-expiry reclaim.
- The tenant epoch read before claiming a consolidation job now throws instead of defaulting.
- The auto-episode trigger records a failed `episodes` projection run row when it fails.
- `countPendingMemoryJobs` throws on a failed read instead of returning zero.

### Declared best-effort bookkeeping

- Worker sweeps (chunk projection repair, idempotency fingerprint prune, expired-lease dead-letter), the backlog gauge and auto-consolidation staging are declared best-effort through `best-effort.ts`: a failure logs a line and increments a per-label counter (`getBestEffortFailureCounts()`), and the round continues. An erasure-gate conflict still aborts the sweep.
- Audit and telemetry writes (entity, relation, structured-memory and procedure audit rows; projection-run rows; consolidation cache invalidation; coverage telemetry) use the same helper. None of them sits on a retrieval or write-decision path.

### Change stream

- `MongoDBChangeStreamWatcher.start()` no longer returns `false` and falls back to a "file watcher only" mode. It throws `ChangeStreamUnavailableError`, and the manager factory surfaces it. The "retry from latest after a failed resume" branch is removed because it skipped events without a re-scan.
