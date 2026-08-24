# Pi extension

Active contributors: Rom Iluz

`packages/pi-extension` (`@memongo/pi-extension`) is an extension for the [Pi coding agent](https://pi.dev) that adds Memongo's durable, cross-project, MongoDB-backed semantic memory as new tools. Per `packages/pi-extension/README.md`, it is explicitly **additive**: it sits alongside Pi's own `pi-hermes-memory` (local SQLite FTS5) and `pi-observational-memory`, and does not replace either. It is the one package in this repo that is an agent-side plugin rather than a Memongo product surface — it never touches MongoDB or the engine directly; it calls the HTTP API exclusively through `@memongo/client`, the same SDK used by `packages/tools` and `apps/mcp`. See [`../overview/architecture.md`](../overview/architecture.md) for where the HTTP API sits relative to its callers.

## What it ships

`packages/pi-extension/extensions/index.ts` registers three tools and one slash command against Pi's `ExtensionAPI`:

- `memongo_search` — hybrid vector + full-text + graph search over durable memory, for semantic or cross-project/cross-session recall that Pi's local FTS5 tool can't do.
- `memongo_save` — persists a durable structured memory (fact, decision, preference, instruction, problem, person, project, or architecture note).
- `memongo_status` — probes API health and vector-search availability.
- `/memongo` — a slash command wrapping the same status probe for a quick manual check.

All three tools degrade to a clean error message (not a crash) when the Memongo API is unreachable, and the extension's guidance nudges the agent to fall back to Pi's local `memory_search` tool in that case.

One configuration knob, `MEMONGO_PI_MEMORY_SCOPE` (default `"global"`), drives both `memongo_save`'s default scope and `memongo_search`'s query scope, so a default-scope save is always found by a default-scope search — an earlier version let save default to `"workspace"` while search hardcoded `"global"`, splitting the two directions.

`resolveApiKey()` in `extensions/index.ts` will only fall back to a baked `local-dev-secret` credential when the configured `MEMONGO_API_URL` resolves to a loopback address (`127.0.0.1`, `localhost`, `::1`); for any non-loopback API URL it refuses to start without an explicit `MEMONGO_API_KEY`, so a shared local-dev default can never authenticate against a remote deployment.

## Lifecycle hooks

`packages/pi-extension/extensions/lifecycle.ts` is what the tools alone can't do: since an LLM rarely calls `memongo_save`/`memongo_search` unprompted, the extension hooks Pi's event lifecycle to nudge memory in and out at the prompt layer:

- **Session-start injection** — on `session_start`, it prefetches the agent's profile plus a bounded recent-memories search at the configured scope, then injects the rendered result once per session via `before_agent_start` as a persistent `customType: "memongo-context"` message (not shown to the user, `display: false`).
- **Turn-end auto-capture** — on `turn_end` (and the preceding `message_start`/`agent_start`), it buffers user and assistant turn text and writes it to Memongo via `writeEvent` (`/v1/write-event`), batched/debounced (flush every 4 buffered events or 5s, whichever comes first) so a long session doesn't fire one HTTP call per turn. Idempotency keys are derived from `(sessionId, agentRunIndex, turnIndex, role)` via `captureIdempotencyKey()`, so a retried capture of the same turn dedupes server-side instead of double-writing.

Both behaviors are controlled independently (`MEMONGO_PI_AUTO_CAPTURE`, `MEMONGO_PI_SESSION_INJECTION`, both default on) and both fail silently with at most one `warn` log — a down Memongo API must never break a Pi session.

## How it differs from the other apps

Every other Memongo surface (`apps/api`, `apps/mcp`, `apps/web`) ships or exposes Memongo itself as a product. `packages/pi-extension` is the reverse: it is packaged for and loaded by a third-party host (Pi, via `pi.extensions` in `packages/pi-extension/package.json`, pointing at `./extensions`), and its only job is to call into an already-running Memongo deployment as a client. It has a single runtime dependency, `@memongo/client`, and peer dependencies on Pi's own packages (`@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, `typebox`) rather than on any other Memongo workspace package.

## Integration points

- Calls `@memongo/client`'s `MemongoClient` directly (`status`, `searchDetailed`, `writeStructured`, `writeEvent`, `profile`, `probeVector`) — see [`packages/client.md`](client.md).
- Talks to `apps/api`'s `/v1/*` HTTP routes over the network; it does not import `packages/memory-engine`, `packages/memory-bridge`, or `packages/lib`.
- Tests (`packages/pi-extension/index.test.ts`, `packages/pi-extension/lifecycle.test.ts`) mock `@memongo/client` entirely, confirming the extension's only integration surface is that client.

## Key source files

| File | Role |
|---|---|
| `packages/pi-extension/README.md` | Positioning ("additive"), setup instructions, config table, architecture diagram |
| `packages/pi-extension/extensions/index.ts` | Tool registration (`memongo_search`, `memongo_save`, `memongo_status`), `/memongo` command, loopback-aware API key resolution |
| `packages/pi-extension/extensions/lifecycle.ts` | Session-start context injection and turn-end auto-capture hooks, idempotency key derivation |
| `packages/pi-extension/index.test.ts` | Tests for loopback detection, API key resolution, and save/search scope consistency |
| `packages/pi-extension/lifecycle.test.ts` | Tests for lifecycle config parsing, injection, capture batching/dedup, and bounded key eviction |
| `packages/pi-extension/package.json` | `pi.extensions` entry point, `@memongo/client` dependency, Pi peer dependencies |
