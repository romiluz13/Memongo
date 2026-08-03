# Research: Does memongo's API search have a bug on atlas-managed?

**Verdict: NO BUG.** The API search returning 0 results is correct behavior —
tenant isolation working as designed. My earlier "product bug" claim was wrong.

## TL;DR

- The API search returns 0 because `searchDetailed` **defaults to
  `scope: "agent"`** when no scope is passed (mongodb-manager.ts:3201-3207).
- The 31 chunks in `rom-memory-dev` are all stored under `user`, `workspace`,
  and `tenant` scopes (nanoclaw demo data) — **zero under `scope: "agent"`**.
- Search with the correct scope **works perfectly**: `scope=workspace` → 5
  results, `scope=tenant` → 2 results. Direct `$search` with no filter → 1 hit.
- The index names, the `equals` filter clause, the auto-embed query-time
  embedding, and the `atlas-managed` profile are all working correctly.
- **This is not a bug. It's the multi-tenant isolation floor doing its job:**
  a caller who doesn't specify a scope gets their own agent scope, not
  everyone's data.

## Evidence

### 1. The default-scope behavior (the mechanism)

`packages/memory-engine/src/mongodb-manager.ts:3201-3207`:
```typescript
const searchScope: MemoryScope =
    normalized.scope ??
    (normalized.conversationScope?.sessionKey ? "session" : "agent")
const searchScopeRef =
    normalized.scopeRef ??
    resolveScopeRef({ scope: searchScope, agentId: this.agentId, ... })
```

When no `scope` is passed, it defaults to `"agent"`. `resolveScopeRef`
(`packages/memory-engine/src/mongodb-scope.ts`) then returns
`agent:<agentId>` = `agent:main`.

### 2. The data distribution (why 0 matches)

```
chunks by scope:      tenant, user, workspace   (NO "agent")
chunks with scope=agent: 0
all scopes present:   tenant, user, workspace
```
The 31 chunks are nanoclaw-fable demo data (clinical protocols, patient
escalations) written under `workspace/team:...`, `user/emp:...`, and
`tenant/org:main` scopes — none under `agent:main`.

### 3. Search WITH the correct scope works

```
scope=workspace, scopeRef=team:team-3ee88c00... → 5 results (score 0.355, 0.348, 0.344)
scope=tenant,    scopeRef=org:main              → 2 results
bare $search (no filter)                        → 1 result (score 2.222, "bridge")
```

### 4. The filter clause is correct

`buildSearchFilterClause` (mongodb-search.ts) emits
`{ equals: { path, value } }` for scalar filters. For `token`-type Atlas
Search fields (agentId, scope, scopeRef), `equals` is the **correct**
operator — verified: `equals` on `agentId` returns 1 hit; `text` query on
a `token` field returns 0 (wrong operator). The code is right.

### 5. Atlas Search docs confirm the mechanics

- `$search` does NOT require an explicit `index` field — it defaults to
  `"default"`. memongo always specifies the index name (`${prefix}chunks_text`
  = `memongo_main_chunks_text`), so this is not the issue.
- For auto-embed vector search, MongoDB auto-embeds the query text at query
  time — the client passes a `query` string, not a `queryVector`. memongo's
  `$vectorSearch` uses `autoEmbed` correctly.
- Index `status: READY` means queryable. Both indexes are READY. Not the issue.

### 6. The index names are correct

The search code resolves `textIndexName` to `${this.prefix}chunks_text` =
`memongo_main_chunks_text` (mongodb-manager.ts:2707). The schema creates
exactly this index name (`${prefix}chunks_text`). My direct test with this
index name worked. The API uses the same name. Not the issue.

## What survived rebuttal

- **Hypothesis 1 (missing index name):** Rebutted — the code always passes
  `index: opts.textIndexName`, and the name matches the created index.
- **Hypothesis 2 (equals vs text on token):** Rebutted — `equals` works on
  token fields; the code uses `equals`; verified directly.
- **Hypothesis 3 (index not READY):** Rebutted — both indexes status READY.
- **Hypothesis 4 (auto-embed not working):** Rebutted — vector probe
  `{"ok":true}`, 100% embedding coverage.
- **Hypothesis 5 (default scope filters out all data):** **CONFIRMED.** This
  is the mechanism — and it's correct behavior, not a bug.

## What this means for dogfooding

The Pi extension's `memongo_search` calls the API without a scope (it does
cross-project search). On a fresh database with no `agent`-scoped data, this
returns 0 — which **looks** broken but is the tenant isolation floor working
correctly. Two options:

1. **Save memories with `scope: "agent"`** (or `global`) so the default
   search finds them. The extension's `memongo_save` currently defaults to
   `scope: "workspace"` with `scopeRef=<project>` — those are findable only
   with an explicit `scope=workspace` search.
2. **Have the extension search with `scope: "global"`** or across all scopes
   when the user wants cross-project recall — but this needs an API change
   (the API doesn't expose an "all scopes" search; that would violate tenant
   isolation by design).

The cleanest dogfood path: save durable facts as `scope: "global"` (applies
everywhere) and search with no scope (defaults to agent, which for a
single-user dogfood should find global + agent data). **Verify whether the
search includes `global`-scoped data in the agent-default query** — that's
the next thing to check.

## Sources

- memongo source: `packages/memory-engine/src/mongodb-manager.ts:3185-3207`
- memongo source: `packages/memory-engine/src/mongodb-search.ts` (buildSearchFilterClause, buildTextSearchCompound)
- memongo source: `packages/memory-engine/src/mongodb-scope.ts` (resolveScopeRef)
- memongo source: `packages/memory-bridge/src/memongo-bridge.ts:835-845` (memongoBridgeSearchDetailed)
- MongoDB Atlas Search docs (via /tmp/memory-compare/atlas-search-docs.md):
  $search default index behavior, auto-embed query-time embedding
- Direct Atlas verification: listSearchIndexes (status: READY),
  $search with equals filter (1 hit), scope-filtered API search (5 hits)
