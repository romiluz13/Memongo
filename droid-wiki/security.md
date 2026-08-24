# Security

Active contributors: Rom Iluz

Memongo stores long-term agent memory, so the API's threat model treats every network boundary as untrusted by default: authentication is fail-closed, outbound fetches are SSRF-guarded, secrets never round-trip through logs or errors, and writes are screened for prompt-injection shape before they reach consolidation. This page covers the mechanisms; `features/multi-tenancy-and-scopes.md` covers the tenant/scope model those mechanisms enforce, and `how-to-contribute/patterns-and-conventions.md` covers the canonical error envelope referenced below.

## Authentication and API-key scoping

`apps/api/src/app.ts` gates every `/v1/*` route behind a bearer token, compared with `timingSafeBearerEquals` — a constant-time comparison over SHA-256 digests of both sides, so a mismatched token cannot leak its correct prefix via response timing, and empty bearers are always rejected outright.

Two credential shapes:

- `MEMONGO_API_KEY` — one admin token, full access.
- `MEMONGO_API_SCOPED_KEYS` — a JSON policy list binding a token to explicit `agentId` / `scope` / `scopeRef` constraints, validated fail-closed at startup (`parseScopedApiKeyPolicies` / `requireValidScopedPolicies`): invalid JSON, an empty policy list, an unconstrained policy, a non-canonical scope value, or a `"*"` mixed with concrete values all abort startup rather than silently under-scoping a key.

Neither configured means every `/v1/*` request gets `401 AUTH_NOT_CONFIGURED`, unless the operator explicitly opts into `MEMONGO_ALLOW_INSECURE_NO_AUTH` (logged once as a warning) for local development only.

The full scope enum, how a scoped key's `agentIds`/`scopes`/`scopeRefs` constraints are enforced per request, and why agent-global routes (status, stats, jobs, admin analytics, self-edit) reject any scope-constrained key outright, are covered in `features/multi-tenancy-and-scopes.md`.

## Network hardening

Configured in `apps/api/src/app.ts`, applied to `/v1/*` in this order: rate limit, then body-size cap, then auth.

- **CORS** — `MEMONGO_CORS_ORIGINS` must list explicit origins; `parseCorsOrigins` throws at startup if the value contains `*`, so wildcard CORS cannot be configured even by mistake. With no env set, the API falls back to two dev-only origins (`http://127.0.0.1:3040`, `http://localhost:3040` — the web console's dev port) rather than opening broadly.
- **Rate limiting** — a fixed-window in-memory limiter, default `600` requests per `60_000` ms window (`MEMONGO_API_RATE_LIMIT`, `MEMONGO_API_RATE_WINDOW_MS`; set the limit to `0` to disable). Identity for the bucket key is the caller's matched credential (hashed), or — only when `MEMONGO_TRUST_PROXY` is set — the first `X-Forwarded-For` IP, or one shared `anonymous` bucket otherwise; an invalid/unrecognized bearer can never mint its own bucket key, so attacker-chosen tokens can't be used to evade or exhaust the limiter. A hard ceiling of `RATE_LIMIT_MAX_BUCKETS = 100_000` distinct buckets makes the limiter fail closed (`429 RATE_LIMITED`) for any *new* identity once saturated, rather than growing the bucket map without bound under a key-rotation attack.
- **Body-size cap** — default `1_000_000` bytes (`MEMONGO_API_MAX_BODY_BYTES`, `0` disables), enforced by `hono/body-limit` *before* JSON parsing, so an oversized payload is rejected (`413 PAYLOAD_TOO_LARGE`) without ever being buffered or parsed.
- **Secure headers** — `hono/secure-headers()` is applied globally, first in the middleware chain.

## SSRF protection

`packages/lib/src/ssrf.ts` guards any outbound fetch the platform makes to a caller-influenced URL. `assertAllowedHostOrIp` rejects a fixed blocklist of hostnames (`localhost`, `localhost.localdomain`, `metadata.google.internal`, and any `.localhost`/`.local`/`.internal` suffix) and any private/loopback/link-local IPv4 or IPv6 literal (RFC 1918 ranges, `127.0.0.0/8`, `169.254.0.0/16`, `::1`, `fc00::/7`, `fe80::/10`, IPv4-mapped IPv6). `assertPublicHostname` goes further and resolves DNS, rejecting the hostname if *any* resolved address is private — closing the DNS-rebinding gap where a public-looking hostname resolves to an internal IP. The default policy (`defaultSsrfPolicy`) has no exceptions; a caller opts a specific host in via an explicit `allowPrivateNetwork` or hostname-allowlist policy, never globally.

## Secret handling and redaction

- **`packages/lib/src/secrets.ts`** defines `SecretInput` handling: a caller can pass a secret as a literal string or as `{ secretRef: "ENV_VAR_NAME" }`, which is resolved from `process.env` at use time (`normalizeOptionalSecretInput`) rather than accepted as a literal that could end up persisted or logged. `packages/memory-engine/src/secret-input.ts` builds on this for engine-side config (`hasConfiguredMemorySecretInput`, `resolveMemorySecretInputString`), throwing a clear error if a `secretRef` points at an unset env var instead of silently treating it as configured.
- **`packages/lib/src/redact.ts`** provides `redactSensitiveText` (aliased `redactSecrets`), a pattern-based scrubber applied to any text that might reach a log or diagnostic surface. It matches `KEY=`/`TOKEN:`/`PASSWORD` style assignments, `Authorization: Bearer ...` headers, PEM private key blocks, and vendor-specific token shapes (`sk-`, `ghp_`, `github_pat_`, Slack `xox*`/`xapp-`, `gsk_`, Google `AIza...`, `pplx-`, `npm_`, Telegram bot tokens, MongoDB connection-string passwords). A matched token longer than 18 characters is partially masked (first 6 / last 4 characters kept); shorter matches are fully replaced with `***`.

## Prompt-injection classification on writes

`packages/memory-engine/src/mongodb-injection-classifier.ts` runs a synchronous, deterministic tier-1 classifier (`classifyInjection`) against every candidate memory at consolidation write time, matching a frozen, code-reviewed catalogue of regex patterns (`INJECTION_PATTERNS`) for role-override attempts ("ignore previous instructions", "act as unfiltered/admin/root"), prompt-leak requests ("reveal your instructions... verbatim"), and bracketed/angle role-injection tokens (`[SYSTEM]...`, `<|system|>`). Content classified `injection-likely` is routed to a `memory_quarantine` collection with `status: "pending-review"` instead of entering the canonical consolidation pipeline; matched pattern ids are recorded for observability. A tier-2 LLM classifier is stubbed (`tier: "llm"`, gated behind an opt-in switch) but not wired — today every verdict is `tier: "pattern"`. `POST /v1/self-edit` (`api/index.md`) applies the same screen: content that fails it is rejected with `422 SELF_EDIT_REJECTED` rather than silently poisoning the agent's own persona/instructions.

## Error envelope: never leaking raw driver errors

`apps/api/src/lib/errors.ts` centralizes every unexpected failure through `internalError`, which logs the real error (name, message, stack) server-side under the request id, and returns the client only `{"error":{"code":"...","message":"internal server error (request id: ...)"}}` — raw MongoDB driver messages, hostnames, and stack traces never reach the client. A closed set of driver error names (`MongoNetworkError`, `MongoNetworkTimeoutError`, `MongoServerSelectionError`, walked through up to 4 levels of `cause` chaining) maps to a `503 SERVICE_UNAVAILABLE` so a retry means something; anything else is a generic `500`. Deliberate route-level errors (validation, not-found, forbidden) bypass this and return their specific code directly via `jsonError`. The full envelope shape and code catalogue are documented in `api/index.md`; the pattern itself — one canonical shape, deliberate codes on the route, everything else centrally mapped — is one of the conventions in `how-to-contribute/patterns-and-conventions.md`.

## Reporting a vulnerability

Per the root `SECURITY.md`: do not open a public issue. Use [GitHub private vulnerability reporting](https://github.com/romiluz13/memongo/security/advisories/new) for this repository, or contact the maintainer via their GitHub profile if that channel is unavailable. Include the affected package/app, reproduction steps, impact, and whether secrets or memory data may be exposed. Valid reports are acknowledged within 7 business days; security fixes are provided for the latest released `@memongo/*` package versions and current `main`.
