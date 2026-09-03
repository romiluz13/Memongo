# Secret redaction at every diagnostic boundary

We redact credentials, connection strings, and raw query text at each diagnostic
boundary — the subsystem logger, the error-message formatter, the API error envelope,
the capability table, the client error message, the tools middleware warn, and the
pi-extension diagnostic choke point — using one central classifier instead of
per-site ad-hoc masking.

## Context

The engine's client registry logged the raw MongoDB URI, credentials included, on
close failure, while a fully tested redaction utility
(`packages/lib/src/redact.ts#redactSensitiveText`) was wired to zero production paths
(DDD claim C-002; the security review's secret-exposure finding). Driver error
chains, upstream response bodies, and API error envelopes can all carry credentials
and raw query strings into operator logs, and the pi-extension is published
standalone, so its warns and tool responses form an additional boundary that cannot
import the shared utility.

The claim survived three adversarial refutation rounds, and each round reshaped this
decision. Round 1 demonstrated the registry leak and a downstream error echoing the
verbatim query into engine logs. Round 2 bypassed the classifier with
quoted-space assignments, webhook URLs, `X-Custom-Auth`-style headers, partial
reveals of long passwords, and username-only userinfo. Round 3 found five more
unwired boundaries (the API capability-table render, the client error message, the
API error envelope, the pi lifecycle warn, the pi extension diagnostics) and a
branch-dispatch defect where source-string prefix probing silently dropped both
userinfo branches into a fallback. The post-fix re-probe then surfaced one final
classifier gap: an assignment riding inside a JSON-serialized meta value has its
quotes escaped (`password=\"two words\"`), and the pattern's value alternatives did
not match through the backslashes, so the pair survived raw — plus a probe-methodology
defect (capturing only `console.log` while the error level writes via
`console.error`, which made the logger check vacuously green).

## Considered Options

- **Central classifier plus per-boundary wiring — chosen.** One
  `redactSensitiveText` in `@memongo/lib`, wired at every boundary a diagnostic can
  exit: `formatLine` (message and serialized meta), `formatErrorMessage` /
  `formatUncaughtError` (message and error chain), `apiErrorJson` (envelope message
  and the internalError server log), the capability-table render, the
  `MemongoClientError` message, the tools middleware default warn, and the engine's
  query-echo seam. One place to extend when a new credential shape is found; the
  pinning batteries document every shape the refutation rounds demonstrated.
- **Per-site ad-hoc masking — rejected.** Every site invents its own masking rules
  and they drift; the first refutation round existed precisely because a tested
  utility sat unwired while sites formatted secrets by hand.
- **Structured logging with field-level taints — deferred (negative knowledge).**
  Redacting at a single structured-log sink would remove the boundary enumeration
  problem entirely, but Memongo emits human-readable console lines today;
  introducing a logging framework is a separate change with its own assurance
  burden. The boundary enumeration here is pinned by tests, not by hope.
- **Suppression instead of redaction — rejected.** Dropping whole messages on
  suspicion destroys debuggability (no host, no error class, no correlation).
  Over-redaction only adds stars where the operator can still see structure.

## Consequences

- **Redaction runs after serialization.** `formatLine` redacts the message and the
  `JSON.stringify(meta)` output, so nested values are covered — and this is exactly
  why the classifier must tolerate escaped quotes: serialization escapes inner
  quotes, and a pattern that only matches raw quotes misses
  `password=\"two words\"` inside a meta value.
- **The published pi-extension carries a minimal local classifier.** It cannot
  depend on the private `@memongo/lib`, so `sanitizeDiagnostic` mirrors the shapes
  the lib battery pins; parity drift between the two classifiers is caught by
  mirrored tests rather than by review.
- **Structure is preserved where it aids debugging.** Scheme userinfo keeps
  `scheme://user` + `:***@host:port` (only the password stars); username-only userinfo
  stars the username in full, because in key-as-username schemes the username is
  the credential; webhook URLs truncate to `scheme://host/***`; long tokens keep a
  head/tail reveal for grep-ability. Already-masked `***` output is idempotent
  under re-masking.
- **Pattern dispatch is by identity, not by string probing.** The userinfo and
  URL-truncating patterns are referenced by `indexOf` on the const regex objects,
  so the callback branches cannot silently fall into the fallback when a pattern
  literal is edited (the round-3 defect: an escaped-slash prefix probe failed and
  dropped both branches).
- **Raw query text is aliased, not starred.** Queries are content, not credentials,
  but a downstream error echoing the verbatim query leaks user text into logs; the
  engine replaces every echo with a correlatable `[query:<digest>]` alias and the
  registry logs a `shared-client-<sha256-8>` alias for the URI.
- **The client keeps the raw body programmatic.** `MemongoClientError` messages are
  structural (`Memongo API 502 (non-JSON body, N bytes)`) while the raw body stays
  on `.body` for callers that need it — redaction governs what is *printed*, not
  what code may hold.
- **Negative knowledge.** The classifier is pattern-based and shape-driven: secrets
  outside its shapes (credential-free random tokens, non-JSON serialization
  formats, JSON-in-JSON double escaping) are not caught, and nothing here detects
  novel credential forms. Each refutation round extended the batteries with the
  shape it smuggled through; the batteries are the record of known shapes, not a
  proof of completeness.
- **Probes must prove they captured.** A boundary check that patches only one
  console method can pass vacuously when the boundary writes through another; the
  post-fix probe patches every console method and asserts a non-empty capture —
  the test of the test, learned from the round-3 follow-up.
