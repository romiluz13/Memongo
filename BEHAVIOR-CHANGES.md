# Behavior changes (M2)

Each M2 ticket lists the behavior it removed or changed, under its own heading.

## T1: startup contract (#110)

### Boot refuses instead of degrading

- Boot requires MongoDB 8.3 or later.
  - An older server fails boot with `server-version-unsupported`.
  - An unreadable `buildInfo` fails with `server-version-unreadable`.
  - Previously, an unknown version made boot probe the fusion stages, and a probe error counted as support.
- Boot requires Search index management.
  - A deployment without Search fails with `search-management-unavailable`.
  - Previously, a failed `$listSearchIndexes` probe skipped the Search bootstrap, and the server served with lanes off.
- Boot requires Search index management privileges, read through `connectionStatus`. A user without them fails with `search-privileges-denied` before boot writes anything.
- Boot builds a required-index manifest from the selected profile and the enabled surfaces. Every manifest index must meet these conditions within one total deadline (180 s by default):
  - It is READY with `queryable: true`.
  - It serves its manifest definition, including model, path, filter, token and analyzer mappings.
  - It serves the latest definition generation on every host that `statusDetail` lists.
  - A pending `latestDefinition` does not count.
- Failures are typed:
  - FAILED and STALE indexes fail fast, as `index-failed` and `index-stale`, before any repair write.
  - An index still building at the deadline fails with `index-not-ready`.
  - An index still absent after repair fails with `index-absent`.
  - A same-named index of the wrong type fails with `index-type-mismatch`; boot never drops it.
  - A definition without autoEmbed fails with `autoembed-unavailable`.
  - Unknown or inconsistent metadata fails with `index-metadata-unknown`. This includes the undocumented `ACTIVE` status and a READY index without `queryable: true`.
- Previously, the engine warned and served when indexes were not queryable after the wait (`mongodb-manager.ts:718-826`). That warn-and-serve path is gone.
- Boot repair creates or updates manifest indexes. It never drops an index or a collection.
- Previously, all 17 index-create catches, the `ensureNamedSearchIndex` swallow paths and the capability-probe catches logged and continued. They now fail as `MemongoBootError`.
- `waitForSearchCapabilities` now throws `index-not-ready` on timeout. Previously, it returned its last result.
- A failed bitemporal prefilter readiness probe now propagates, both at boot and at the request-time refresh. Previously, it disabled the prefilter silently.
- `listSearchIndexes` no longer retries a failed `$listSearchIndexes` aggregate through the driver helper.

### Removed

- The boot-time storedSource probe is removed. It was a `$vectorSearch` with `query.text`, which embeds a query: a paid call at every boot.
  - storedSource now comes from the serving index definition plus the version gate.
- Boot no longer creates the `$text` indexes `idx_chunks_text`, `idx_kbchunks_text`, `idx_entities_text` or `idx_episodes_text`.
  - Existing ones are left in place; nothing drops them.
  - The `textFallbackIndexes` option and `shouldEnsureTextFallbackIndexes` are removed.
- `MEMONGO_STRICT_SEARCH_INDEX_READY` and `MEMONGO_REQUIRE_VECTOR` are removed. Strict readiness is the only mode, and setting either fails boot with `config-removed`, naming the setting.
- `isSearchIndexManagementAvailable` is removed. Search management is part of the boot contract.

### Config that now fails boot

Each of these settings now fails boot with `config-invalid`, naming the setting:

| Setting | Rejected value | Previous behavior |
|---|---|---|
| `memory.mongodb.deploymentProfile` | `community-mongot` or any unknown profile | `community-mongot` was rewritten to `atlas-local-preview` |
| `fusionMethod`, from config, a config file or `MEMONGO_MONGODB_FUSION_METHOD` | `js-merge` or any unknown value | The env silently fell back to the config value; the env wins when it is valid |
| `memory.mongodb.ttl.sessionDays` | not a positive number | Fell back to 30 days with a warning |
| `memory.mongodb.memoryTtlDays` | not a non-negative number | Became 0 |
| `MEMONGO_RERANKING_ENABLED` (any env boolean) | an unrecognized value | Used the default |
| `memory.mongodb.numDimensions` | differs from the autoEmbed model's dimension (1024) | Logged an error and was ignored |
| `memory.mongodb.graph.entityExtraction.method` | `llm` | The regex extractor ran silently, because no provider exists |
| `MEMONGO_SEARCH_INDEX_READINESS_TIMEOUT_MS` / `_POLL_MS` | not a positive integer | Fell back to the default; the default is now 180 s for every profile |

### API

- `memongo-api` refuses to serve on any boot failure. It logs `memongo-api refused to start: boot failure <code>: <reason>` and exits 1 before binding the port (X-06).
  - The search-lane table no longer has a classic `$text` lane.
- `/ready` adds a `manifest` lane. It runs a read-only pass over the required-index manifest and returns 503, naming each unmet `<code> <index>` (X-08).
- `memongoBridgeGetManager` rethrows the engine's `MemongoBootError` with its code, index and requirement. It is no longer flattened into a bare `Error` (X-04).
- New `bun run --filter @memongo/api preflight`. It reports every unmet boot requirement as redacted JSON, exits 1 when any is unmet, and writes nothing.

### Deployment

- The `mongodb-atlas-local` image is pinned to `preview@sha256:ff75fd47e918952cc91094e888e8aeb7529aeb70f987b075aeef3944c9bd8014` in CI, the nightly workflow and Docker Compose. The `8.2.6` local override is replaced, because boot requires 8.3. `publish.yml` is unchanged.
