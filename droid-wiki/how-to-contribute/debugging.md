# Debugging

Active contributors: Rom Iluz

## Turn on debug logging

The API's logger (`packages/lib/src/logger.ts`) resolves its minimum level from environment variables at call time:

- `MEMONGO_LOG_LEVEL=debug` (or `trace`) — explicit level, checked first.
- `MEMONGO_DEBUG=1` or `DEBUG=1` — shortcut that forces `debug` if `MEMONGO_LOG_LEVEL` is unset.
- Default is `info`.

```bash
MEMONGO_LOG_LEVEL=debug bun run dev
# or
MEMONGO_DEBUG=1 bun run dev
```

Each log line is `HH:MM:SS.mmm [subsystem] level: message {meta}`, written to stdout/stderr via `console.*`. There's no file transport or third-party logging library — `createSubsystemLogger()` in `packages/lib/src/logger.ts` is the whole implementation, so raising the level is enough to see everything a subsystem emits.

## Reading the error envelope

Every API error is `{ error: { code: string, message: string } }` (`apps/api/src/lib/errors.ts`, `ApiErrorBody`). Codes observed across `apps/api/src` (grep for `code: "` in `apps/api/src/app.ts`, `apps/api/src/routes/v1.ts`, and the route files):

| Code | HTTP status | When it fires |
|---|---|---|
| `UNAUTHORIZED` | 401 | Bearer token doesn't match the configured API key or any scoped policy. |
| `FORBIDDEN` | 403 | A scoped API key hit a route, scope, or agent-global path its policy doesn't allow. |
| `AUTH_NOT_CONFIGURED` | 401 | No `MEMONGO_API_KEY` and no scoped policies are set, and insecure-no-auth mode isn't enabled — `apps/api/src/app.ts:666`. |
| `RATE_LIMITED` | 429 | Per-key/IP rate limiter tripped (`apps/api/src/app.ts:147`). |
| `PAYLOAD_TOO_LARGE` | 413 | Request body exceeds `MEMONGO_API_MAX_BODY_BYTES` (`apps/api/src/app.ts:584`). |
| `INVALID_JSON` | 400 | Body parsing failed — malformed JSON on a non-empty body (`apps/api/src/routes/v1.ts:34`). |
| `VALIDATION_ERROR` | 400 | Route-level input validation failed (missing/invalid field); the most common code, thrown per-route across `apps/api/src/routes/*`. |
| `IDEMPOTENCY_CONFLICT` | 409/other | A request reused an idempotency key with a different payload. |
| `SERVICE_UNAVAILABLE` | 503 | A MongoDB network/selection error was caught and classified as a retriable dependency failure (`apps/api/src/lib/errors.ts`, `isDependencyUnavailableError`). |
| generic 500 (route-supplied code) | 500 | Anything else — `internalError()` in `apps/api/src/lib/errors.ts` logs the full error (name, message, stack, request id) server-side and returns only the code plus the request id to the client. |

`internalError()` deliberately never leaks driver messages, hostnames, or stack traces to the client — it logs them under `requestId` and returns `internal server error (request id: ...)`. To see the real cause of a 500, grep the API's stdout for that request id.

## Common local-dev failure modes

- **MongoDB not running, or `MEMONGO_MONGODB_URI` wrong.** `/ready` returns 503 with `lanes.mongo.ok: false` and a sanitized connection error (credentials stripped by `apps/api/src/lib/readiness.ts`). Start the stack with `cd docker && docker compose up` and confirm the URI points at it.
- **`MEMONGO_API_KEY` not set.** Every `/v1/*` request returns 401 `AUTH_NOT_CONFIGURED` unless `MEMONGO_ALLOW_INSECURE_NO_AUTH` is explicitly enabled for trusted local dev (`apps/api/src/app.ts`). Set `MEMONGO_API_KEY` and send `Authorization: Bearer <key>`.
- **Semantic search returns `{"results":[]}`.** `VOYAGE_API_KEY` isn't set, or it's a direct Voyage key (`pa-...`) instead of a MongoDB **Atlas Model API key** (`al-...` prefix). Auto-embedding runs inside `mongot` against the Atlas Model API, not a direct Voyage call, so only the `al-` key works locally — see the warning in `README.md`.
- **A deployment seems stuck / half-up.** Check `/health` first — it's a cheap liveness check (`{ ok: true, service: "memongo-api" }`, no dependency calls) that only confirms the process is alive. Then check `/ready`, which runs three required lanes in parallel (`mongo`, `vector`, `embedding`, see `apps/api/src/lib/readiness.ts`) and returns 503 until all three pass. A 200 `/health` with a 503 `/ready` means the process is up but a dependency (MongoDB, vector search, or the embedding provider) isn't — read `lanes.<name>.message` for the sanitized cause.

## Related pages

- [Testing](testing.md)
- [Patterns and conventions](patterns-and-conventions.md)
- [Architecture](../overview/architecture.md)
