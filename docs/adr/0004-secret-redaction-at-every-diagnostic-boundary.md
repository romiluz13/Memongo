# Secret redaction at every diagnostic boundary

We redact known credential shapes at the listed diagnostic
boundaries — the subsystem logger, the error-message formatter, the API error envelope,
the capability table, the client error message, the tools middleware warn, and the
pi-extension diagnostic choke point — using one central classifier instead of
per-site ad-hoc masking. Selected engine diagnostics and API unexpected-error logs
omit upstream error text instead. This does not guarantee that arbitrary user
content is absent from every diagnostic path.

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
  and structural metadata in the internalError server log), the capability-table render, the
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
- **Suppression instead of redaction — rejected for ordinary diagnostics.** Dropping whole messages on
  suspicion destroys debuggability (no host, no error class, no correlation).
  Over-redaction only adds stars where the operator can still see structure.
  API unexpected errors are a scoped exception: upstream free text is omitted
  because it can echo user content and feed unbounded input into the redactor.
  Request and route fields plus a finite numeric error code retain correlation.

## Consequences

- **API unexpected-error logs omit upstream text.** `internalError` keeps the
  request ID, route code, method and path, with an optional finite own numeric
  error code. It omits names, messages, stacks, cause text and arbitrary error
  properties without stringifying the thrown value or reading code accessors.
  A throwing code descriptor trap is ignored. The existing 500/503 classifier
  and client envelope are unchanged; its name/cause getters can still throw.
  The logged route code does not distinguish an outgoing 500 from 503 when no
  numeric code identifies the failure. Request/path fields and other API
  diagnostics remain outside this error-content guarantee; no total log-size
  or hostile-object execution bound is established.

- Userinfo matching starts at the beginning of each contiguous scheme-character
  run. Leading digits and punctuation are copied unchanged, preserving the
  former credential output while avoiding repeated scans of a long scheme
  near-miss. `getDefaultRedactPatterns()` exposes the changed pattern strings.
  This is a bounded near-miss repair, not a claim that every redactor pattern
  is linear. The Pi password pattern still permits slashes and repeated
  malformed URL tokens can still cause superlinear scans.

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
- **Credential masking uses captured positions.** Each pass retains its regex
  language and masks the captured UTF-16 span. Searching the matched text for a
  capture value can mask an earlier identical username, scheme or field name
  while leaving the credential visible. The published Pi classifier uses the
  same position rule while retaining its existing full-mask behavior.
- **Raw query text is aliased, not starred.** Queries are content, not credentials,
  but a downstream error echoing the verbatim query leaks user text into logs; the
  engine replaces every echo with a correlatable `[query:<digest>]` alias and the
  registry logs a `shared-client-<sha256-8>` alias for the URI.
- **The client keeps the raw body programmatic.** `MemongoClientError` messages are
  structural (`Memongo API 502 (non-JSON body, N bytes)`) while the raw body stays
  on `.body` for callers that need it — redaction governs what is *printed*, not
  what code may hold.
- **Credential-path matching avoids nested repetition.** The path prefix uses
  one optional delimiter-ending character run, preserving mixed slash, dot,
  underscore and hyphen paths without enumerating exponentially many segment
  partitions on a near miss. Other unanchored patterns can still scale
  superlinearly; this repair does not establish a linear-time redactor.
- **Query and hydration failures use structural diagnostics.** Context-bundle,
  discovery-projection and active-slate warnings, planner/search failure logs and
  lane-coverage warnings keep their fixed operation label and finite own numeric
  error code, adding query length and a digest where a query is available. They
  omit error messages and arbitrary error properties: MongoDB server errors carry
  enumerable response documents that can expose user content, while message
  redaction can stall or throw on unbounded input. These diagnostics lose free-text
  server, network and programming-error details. Planner/search callers retain the
  original error; query inputs, responses and coverage/partial fallbacks retain
  their existing behavior. The legacy echo-redaction utility remains for tests
  only and keeps its documented cost residuals. Other API and lane-failure logging
  paths remain outside this repair; hashing is proportional to query length.
- **Subsystem messages and metadata have redactor input bounds.** Messages over
  4096 UTF-16 code units are omitted before matching, including raw messages.
  Serialized metadata over that limit is omitted; key enumeration, serialization
  failures and a non-string serialization result produce a fixed omission marker.
  Short messages and serializable metadata retain their existing redaction.
  This does not bound subsystem names, total line length, incoming allocations,
  or execution and allocation inside metadata getters, proxies and `toJSON`.
  Disabled log levels still return before inspecting metadata.
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
