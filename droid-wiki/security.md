# Security

Memongo's security posture is **fail closed**: no auth configured means 401, not open access; an unknown rate-limit identity is throttled, not trusted; an outbound fetch to a private network is blocked unless explicitly allowed. This page traces each control to its implementation.

## Authentication (`apps/api/src/app.ts`)

### Bearer keys with constant-time comparison

`timingSafeBearerEquals` (`apps/api/src/app.ts:179`) hashes both bearer and configured key with SHA-256 before `crypto.timingSafeEqual`, so a plain `===` short-circuit cannot leak the token prefix via response timing, and differing raw lengths cannot bypass the comparison. Empty bearers always reject.

### Scoped API keys

`MEMONGO_API_SCOPED_KEYS` accepts a JSON array or object of policies constraining `agentIds`, `scopes`, and/or `scopeRefs` (`apps/api/src/app.ts:285`). Validation is strict at config load:

- Every policy must constrain at least one field with a concrete (non-wildcard) value.
- `"*"` must be the only value when used.
- Policy scopes must be canonical (`session|user|agent|workspace|tenant|global`) — a non-canonical scope would let authorization and execution disagree (issue #57), so the config **fails closed** at boot.
- `/v1/search-kb` additionally requires a concrete `scopeRefs` constraint (`apps/api/src/app.ts:287`).

Two route-level deny-lists apply to scoped keys:

- `ADMIN_ONLY_V1_PATHS` (`/v1/read-file`, `/v1/import/conversations`) — server-file routes are never reachable with a scoped key (`apps/api/src/app.ts:401`).
- `AGENT_GLOBAL_V1_PATHS` (status, stats, sync, probes, self-edit, `/v1/admin/*`, `/v1/jobs*`) — a *scope-constrained* key is rejected from agent-global routes because those routes have no tenant boundary to enforce ("Class-G" guard, `apps/api/src/app.ts:376`).

### Fail-closed default

When neither `MEMONGO_API_KEY` nor scoped keys are set, every `/v1` request gets `401 AUTH_NOT_CONFIGURED`. The only escape is `MEMONGO_ALLOW_INSECURE_NO_AUTH=1`, which logs a loud warning once (`apps/api/src/app.ts:613`).

### One identity for auth and execution

`apps/api/src/scope-identity.ts` resolves `agentId`/`scope`/`scopeRef` from the merged request input (query overlaid by JSON body) and is shared by the auth middleware and the route layer, so a request cannot pass auth under one identity while writing under another.

## Network hardening (`apps/api/src/app.ts`)

- **Rate limiting** — fixed-window in-memory limiter, default 600 requests/60s (`MEMONGO_API_RATE_LIMIT`, `MEMONGO_API_RATE_WINDOW_MS`). Identity is a SHA-256 hash of a *valid* credential; invalid/missing bearers share the trusted-proxy IP bucket (or one anonymous bucket), so attacker-chosen tokens cannot evade the limiter or exhaust the bucket map. Beyond 100,000 distinct buckets (`RATE_LIMIT_MAX_BUCKETS`) the limiter fails closed for new identities (`apps/api/src/app.ts:99`).
- **Body limit** — 1 MB default (`MEMONGO_API_MAX_BODY_BYTES`), enforced *before* JSON parsing so oversized payloads are never buffered.
- **CORS** — explicit origins only; a wildcard in `MEMONGO_CORS_ORIGINS` is a boot error. Unset falls back to dev defaults for the web console on port 3040 (`apps/api/src/app.ts:71`).
- **Error envelope** — unexpected errors return a generic `INTERNAL` 500 with a request id; raw driver internals never reach the client (`apps/api/src/app.ts:567`).

## SSRF guard (`packages/lib/src/ssrf.ts`)

All outbound fetches (remote embedding providers, enrichment, URL ingestion) pass a default-deny guard:

- **Blocked hostnames:** `localhost`, `*.localhost`, `*.local`, `*.internal`, `metadata.google.internal`.
- **Blocked IPs:** private/loopback/link-local IPv4 (10/8, 127/8, 169.254/16, 172.16–31, 192.168/16, 0/8) and IPv6 (`::1`, `fe80:`, `fc`/`fd`, v4-mapped).
- **DNS rebinding check:** `assertPublicHostname` resolves the hostname and rejects if *any* answer is private.
- **Opt-in only:** private endpoints require an explicit `allowPrivateNetwork`/`dangerouslyAllowPrivateNetwork` policy or a hostname allowlist; `defaultSsrfPolicy` is empty (`packages/lib/src/ssrf.ts:145`).

Violations throw `SsrFBlockedError`.

## Input validation

- Route bodies validate through zod schemas and helpers in `apps/api/src/lib/validation.ts` (`validateWithSchema`, `structuredEntrySchema`, `procedureEntrySchema`, `kbFilterSchema`, `validateMetadata`); malformed JSON is a 400 `INVALID_JSON` before any handler runs.
- Collection sizes are capped server-side (`MAX_WRITE_EVENTS_BATCH = 500`, `MAX_LIST_LIMIT = 100`, `apps/api/src/routes/v1.ts:69`).
- MongoDB enforces `$jsonSchema` validators on write with `validationLevel: "moderate"`; on MongoDB 8.1+ `validationAction: "errorAndLog"` also records rejections server-side (`packages/memory-engine/src/mongodb-schema.ts:1518`).

## Redaction (`packages/lib/src/redact.ts`)

`redactSensitiveText` (alias `redactSecrets`) strips secrets from anything headed to logs: `KEY=…`/`TOKEN=…` assignments, JSON `"apiKey": "…"` fields, `Authorization: Bearer …` headers, PEM private-key blocks, and provider token shapes (`sk-`, `ghp_`, `github_pat_`, `xox*`, `gsk_`, `AIza`, `pplx-`, `npm_`, Telegram bot tokens), plus passwords inside `mongodb(+srv)://` URIs. Tokens are masked keeping 6 leading and 4 trailing characters for correlation.

## Secrets handling

- **Provider keys** resolve from environment only, via `resolveApiKeyForProvider` (`packages/lib/src/auth.ts`) with per-provider mappings (OpenAI, Anthropic, Google/Gemini, Voyage, Mistral, Groq, DeepSeek, Together, Fireworks, Perplexity, Cohere, xAI) and a generic `<PROVIDER>_API_KEY` / `MEMONGO_<PROVIDER>_API_KEY` fallback. `ApiKeyRotation` supports comma-separated multi-key env vars.
- **Secret references:** engine config accepts `{ secretRef: "ENV_NAME" }` instead of inline secrets; `normalizeOptionalSecretInput` resolves the env var at runtime (`packages/lib/src/secrets.ts`).
- **No secrets in images:** the API container requires `MEMONGO_API_KEY` at runtime (`${MEMONGO_API_KEY:?}` in `docker/compose.yaml`); the Dockerfile bakes no defaults and runs as the non-root `node` user (`apps/api/Dockerfile`).

## Deployment posture

Loopback-only port publishing in all compose files, unauthenticated `/health` and `/ready` probes with sanitized payloads (`apps/api/src/lib/readiness.ts`), and boot-time capability logging round out the operator-facing controls. See [Deployment](deployment.md).

## Related pages

- [API app](apps/api/index.md)
- [Reference: Configuration](reference/configuration.md) — every security-relevant env var
- [Deployment](deployment.md)
