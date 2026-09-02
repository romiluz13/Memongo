# Dual static bearer credentials for the MCP HTTP transport

We authenticate every request to the MCP streamable HTTP transport with a dedicated
client credential instead of treating upstream `MEMONGO_API_KEY` presence as endpoint
authentication.

## Context

The transport served every MCP tool to any caller who could reach the port. The bind
guard (`refuseToServeOpen`) treated upstream `MEMONGO_API_KEY` presence as its auth
signal, so a non-loopback bind with the API key configured exposed the full tool
surface, including admin tools when `MEMONGO_MCP_ADMIN=1`, to unauthenticated network
callers (DDD claim C-001; ranked the integration review's single P0, with the security
review independently flagging the missing spec-level authorization). The MCP
authorization guidance requires rejecting unauthenticated callers with 401 and
`WWW-Authenticate`, and validating Host and Origin headers against the bind before any
handler work.

## Considered Options

- **Dual static bearer tokens — chosen.** `MEMONGO_MCP_AUTH_TOKEN` gates the
  transport; an optional second `MEMONGO_MCP_ADMIN_TOKEN` carries the admin tool
  scope. No new infrastructure, additive environment variables, reversible by
  unsetting them. Comparison is timing-safe and shared with the API server through
  `packages/lib/src/bearer-auth.ts` so only one constant-time comparison exists in
  the codebase.
- **OAuth 2.1 with an authorization server — deferred (negative knowledge).** The
  spec-blessed model, but Memongo has no authorization server: standing one up
  (issuer, token issuance, introspection, client registry) adds a security-critical
  surface larger than the exposure being remediated. Revisit when an authorization
  server exists in the deployment environment.
- **Partial conformance — rejected.** A token check on some requests but not others
  reads as authenticated to operators while leaving bypass routes; misleading partial
  conformance is worse than an explicit local-trust model.
- **Reusing `MEMONGO_API_KEY` as the transport credential — rejected.** That key
  authenticates this server to the upstream API, a different trust boundary; its
  presence says nothing about who may call this endpoint, and reuse would couple two
  blast radii to one secret.

## Consequences

- **Fail closed on bind.** A non-loopback bind without `MEMONGO_MCP_AUTH_TOKEN`
  refuses to start — the same startup-refusal posture as ADR 0002, reusing the shared
  `refuseToServeOpen` helper from `@memongo/lib`, keyed on this transport's own
  credential. Loopback without a token stays in local-trust mode with a startup
  warning, matching the stdio transport's trust model.
- **Credential scope, not env flag, decides admin exposure.** When auth is active,
  the matched token carries the scope: the standard scope filters admin-category
  tools even when `MEMONGO_MCP_ADMIN=1`; `MEMONGO_MCP_ADMIN=1` without
  `MEMONGO_MCP_ADMIN_TOKEN` leaves admin tools unreachable over HTTP (fail closed,
  with a startup warning). Local-trust mode preserves the env-flag gating of the
  stdio server.
- **Host/Origin validation precedes all handler work.** The Host header must be
  present and, port-stripped and normalized, a member of the allowed set: the
  loopback family (`localhost`, `127.0.0.1`, `::1`) for loopback binds, the bind host
  literal for specific binds, and nothing implicit for wildcard binds — public
  deployments declare their names via `MEMONGO_MCP_ALLOWED_HOSTS` (reverse proxies
  that rewrite Host). A browser Origin, when present, must resolve to an allowed
  name; non-browser clients send no Origin and skip that half. Mismatches return 403
  on every path, not just `/mcp`.
- **401 challenges follow RFC 6750.** Missing credentials get
  `WWW-Authenticate: Bearer`; a presented-but-invalid token gets
  `Bearer error="invalid_token"`.
- **Error envelopes are sanitized at this boundary.** Handler failures log full
  detail to the server log only and return a generic 500 body, so internals never
  reach callers.
- **Interim posture.** Static bearer tokens have no rotation, audience, or expiry.
  The OAuth 2.1 deferral record above governs the upgrade path when an authorization
  server exists.
