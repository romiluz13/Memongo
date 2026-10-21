# Memongo benchmark operating contract

Memongo benchmark work has one rule: **numbers are product claims only when the
run proves the product path being claimed**. Internal diagnostics are valuable,
but they must not be presented as official benchmark wins.

## Benchmark lanes

| Lane | Purpose | Required trigger | Publishable? |
| --- | --- | --- | --- |
| Official retrieval | LongMemEval / LoCoMo retrieval quality | release candidate, retrieval algorithm changes, benchmark corpus changes | Yes, when dataset, build, MongoDB topology, embeddings, and command are recorded |
| Diagnostic retrieval | Fast regression signal over legacy or custom query sets | every retrieval/search/scoring change | No, unless labeled as non-comparable diagnostics |
| Conversation recall regression | Protect user-visible recall behavior | conversation recall, event schema, session/time filter, citation, or recall-plane changes | No, regression gate only |
| Query governance | Surface candidate MongoDB query-shape settings | benchmark or operator-trace review | Advisory only |
| Proof pack | Confirm build, tests, and live smoke readiness | release candidate | Yes, as release evidence |

## Required commands

Use the narrowest relevant lane while developing, then run the full gate before
release.

```bash
bun run check-types
bun run test
bun run build
```

Run `bun run build` after source edits and before starting a local API-backed
canary. The API loads workspace packages through their built `dist` entrypoints,
so a stale build can hide or invent benchmark behavior.

The benchmark's `executableDigest` binds tracked executable source at HEAD and
the workspace build bytes observed on disk at admission: the complete `dist`
tree and `package.json` of every `@memongo/*` package imported by name in the
benchmark's source graph (walked from `scripts/run-benchmark.ts` through
relative static and literal dynamic imports) or by those packages' `dist`
files. Files are parsed with the installed TypeScript compiler, not matched
by pattern, so comments and escapes cannot hide an import. Each import is resolved from its own file's directory with fresh
filesystem reads, so nested copies are covered separately. Every source file the
walk reaches is also inventoried under `build.sourceGraph` by repository-relative
path, content sha256 and Git status (`clean`, `modified` or `untracked`, which
includes ignored files) and bound into the digest, whether or not it lies under
the tracked executable pathspecs. Editing any reached file therefore refuses
resume. A reached file that is not `clean` marks the source dirty, so the
evidence-completeness gate refuses publication; a tracked, unmodified file
outside the pathspecs, such as one at the repository root, stays publishable
because HEAD and the inventory identify it. A reached file whose real path
differs from its walked path, through a file or directory link, refuses
identity. The report lists
each package under `build.workspaceBuild` with `relation: "not-verified"`. The
digest records which bytes were on disk when the run was admitted, after the
benchmark's modules had already loaded. It does not prove that those bytes
are the ones loaded or cached in memory, that they were built from the
tracked source, or that they stayed unchanged afterward. It also does not
cover third-party installed packages or the runtime binary. Identity is
refused, not degraded, when any of these hold:

- a walked source or `dist` file does not parse, imports or requires a
  computed name, or (under Bun) contains an import the runtime's own scanner
  finds but the parse does not;
- a relative source import does not resolve to repository source;
- a package does not resolve, or resolves outside the repository;
- under Bun, the running resolver answers differently, for example through
  tsconfig `paths` or a lookup cached before the layout changed;
- a package uses an export condition other than `types`/`default`, or has an
  entry outside `dist`;
- `dist` is missing or unreadable, or contains links, special files or
  `node_modules`.

Checkpoints written before this change carry a digest without build bytes. It
cannot match a current digest, so they are historical only and refused for
resume. A rebuild that produces byte-identical output keeps the digest.

For benchmark-specific work, include the focused engine/API tests that cover the
touched lane. At minimum:

```bash
bunx vitest run scripts/benchmark/mongodb-benchmark-runner.test.ts
bunx vitest run packages/memory-engine/src/mongodb-manager.test.ts
bunx vitest run scripts/benchmark/mongodb-conversation-recall-benchmark.test.ts
```

## Report envelope

Every standalone benchmark run through `bun run benchmark` includes a
`benchmarkReport` envelope with:

- `generatedAt`
- `build` identity from environment when available
- `corpus` identity and counts
- `metrics.internal`
- optional `metrics.official`
- `releaseGates`
- `warnings`
- `degradations`
- `scenarioCleanup` when the run used isolated scenario agents

### Latency denominators

Two latency figures are reported, each naming its denominator and sample count:

- `metrics.internal.p95LatencyMs` and `metrics.internal.scoredLatency` cover
  scored cases only (`denominator: "scored-cases"`).
- `latency` covers every attempted case of the gate pass, including failed
  ones (`denominator: "all-attempts"`).

Each case's latency is elapsed wall time for its search, including any
retries inside that call. Percentiles use nearest rank. Below 20 samples the
p95 is the sample maximum, so it is marked `p95Basis: "sample-maximum"` and
the CLI prints it as descriptive only. Seven samples can be reported, but they
do not support a stable p95 claim, and no basis claims one.

### Ingest completeness

The `execution-completeness` gate fails when any dataset line failed to parse,
the generic loader rejected any conversation or turn, or any turn failed
ingest, even if every case then executed. Those cases were scored against an
incomplete corpus, so the run is not complete QA evidence. Ingest counts are
checkpointed per scenario, so a resumed run keeps the failure.

The generic JSON/JSONL loader counts a line as `failedLines` only when it is
not valid JSON. Valid JSON with an invalid shape becomes a typed rejection
with the same `{line, conversationIndex, turnIndex, reason}` coordinates and
reasons as the [conversation importer](../conversation-import.md); receipts
report `rejectedTurns` and `rejectedConversations`. A publication run refuses
any rejection. The LongMemEval and LoCoMo adapters do not yet report
rejections; malformed records in those formats can still be skipped.

The same failure labels the QA evidence. The official and custom-judge
summaries report `coverage: "partial"` and `accountingCompleteness:
"incomplete"` even when every declared question was judged, because a judged
question may lack its ingested evidence. Whole-workload accuracy is withheld
and `unavailableReason` names the failed line and turn counts. Per-type
accuracy, per-case verdicts and case counts are kept, and the export is a
sample. The legacy custom-v1 envelope keeps its per-case results and withholds
`accuracy` the same way. Whenever QA evidence is emitted, the
`e2e-answer-quality` gate fails with the failure counts, including runs that
declare no answer thresholds.

### Scenario cleanup

After each scenario, the runner deletes that scenario agent's rows from the
fixed registry of benchmark collections and records the outcome per scenario:
run id, scenario id, agent id, registry version and digest, and each
collection's result. The same outcome is stored in the checkpoint and restored on
resume. A failed delete keeps only a known MongoDB driver error class name
(any other name is recorded as `unknown`) and a numeric error code, never the
message. A restored or reported outcome counts only when it is consistent with
the current registry: an acknowledged scenario must list every registered
collection exactly once with a non-negative deleted count and an agent id.
Anything else reads as unknown. The gate derives its status from the scenario
outcomes, not from the summary label, so an empty or contradictory summary
cannot pass.

The `scenario-cleanup` release gate passes only when every scenario's
registered deletes were acknowledged. It fails when any delete was rejected
or unacknowledged; a rejected `deleteMany` may still have deleted some rows.
It stays `not-run`, and blocks publication, when rows were kept with
`MEMONGO_BENCHMARK_KEEP_SCENARIO_DATA=1`, cleanup was not attempted, or a
checkpoint or report has no readable cleanup outcome. A passing gate covers the
registered collections only: it does not prove the namespace is empty, that
unregistered collections were cleaned, or that later writes were fenced. It
also does not establish namespace ownership.

When a scenario, close or storage-measurement error is already ending the run,
a cleanup failure is appended to that error's message instead of replacing it.
When cleanup itself throws and nothing else failed, the run fails with a new
error that carries only that sanitized description.

Set at least one build identifier before release or public reporting:

```bash
export MEMONGO_BUILD_COMMIT="$(git rev-parse HEAD)"
export MEMONGO_BUILD_ID="local-$(date +%Y%m%d%H%M%S)"
export MEMONGO_BUILD_LABEL="0.0.0-dev"
```

CI providers may provide `GITHUB_SHA`, `GITHUB_RUN_ID`,
`VERCEL_GIT_COMMIT_SHA`, or `VERCEL_DEPLOYMENT_ID`; Memongo reads those as
fallbacks.

## QA protocols

`MEMONGO_BENCHMARK_QA_PROTOCOL` selects how answers are generated and judged.
Only these exact values are accepted; any other value fails before scenario or
provider work.

| Value | Path | Answer request | Envelope |
|---|---|---|---|
| unset or `custom-v1` | Legacy harness | `QUESTION:` line, up to 20 passages as `[n] text` in rank order | `judgeVersion: "v1"` |
| `custom-v2` | Legacy harness | custom-v1 plus the question date and each passage's date(s) and role | `judgeVersion: "v2"` |
| `official` | Durable sidecar path | Dated, chronological chain-of-note prompt; pinned judge | `official` block |
| `custom-judge` | Durable sidecar path | As `official`, with a non-pinned judge | `customJudge` block |

`custom-v2` changes one thing: the answer user content uses the official
renderer's line format, in rank order. The system prompt, judge prompt and
judge flow, 20-passage cap, 512-token answer budget and `answerAttempt`
classification stay those of custom-v1. A passage keeps its own dates and role
through filtering and the cap; one with no date or role renders without that
prefix, and a passage that already starts with its role label is not labeled
twice. For example:

```text
QUESTION (asked on 2031/02/14 (Fri) 09:30): Where did the heron nest?
<context>
[1] [2031/01/20 (Mon) 10:00] User: The heron nested by Quillmarsh pond
[2] [2030/11/02 (Sat) 18:45; 2030/12/01 (Mon) 08:00] Assistant: The heron nested in Brindlewick reeds
[3] An undated note with no known speaker
</context>
Return only {"answer":"..."}.
```

The run configuration records the raw value as
`env.MEMONGO_BENCHMARK_QA_PROTOCOL`, so custom-v1 and custom-v2 runs have
different configuration hashes and never resume each other's checkpoints.
Accepting `custom-v2` added a known value, not a covered key, so coverage stays
`b02-keyed-v5`; a reader built before `custom-v2` refuses such a manifest.
Neither custom protocol writes a prediction sidecar, so `b2-join.ts` cannot
compare them, and neither is the official protocol: a full500 publishable run
refuses both.

### Reader-cut metrics (custom-v1, custom-v2)

A custom-protocol run adds `e2eQa.readerCut` (pooled and per question type) and
a `readerCut` block on each matching `questionTypeBreakdown` row. Gold-turn
recall is the share of marked gold turns whose sent status is `present` under
`containment-v2`, pooled over the cases whose gold diagnostics apply; `unknown`
counts as not present and is reported beside it. Abstention validity excludes
failed cases: correct abstentions over abstention cases, and answers the
harness's abstention rule classifies as abstaining over answerable cases. A
rate without a denominator is `null`. Both are computed from the case results
after the run and never feed retrieval or selection.

## Private QA diagnostic capture

For a fresh official or custom-judge QA run, set
`MEMONGO_BENCHMARK_QA_CAPTURE=1` to retain provider requests and outcomes.
Omitted, empty or `0` leaves capture disabled; other values fail before provider
calls. Capture requires absent prediction and capture paths and no completed
resume scenarios. Default prediction privacy and resume behavior are unchanged.

Capture creates `<checkpoint>.predictions.json.capture` as a new private `0700`
directory. Each provider invocation writes an exclusive `0600` request file
before the call and a separate outcome file afterward, including preflight and
transport or judge-content retries. Files are synced and closed. Existing paths,
symlinks, directory replacement and changed directory permissions are refused.
A capture-write failure stops QA before another provider attempt; a request
without a completed outcome remains incomplete and may already have incurred a
provider charge. Filesystem checks cover the owned local POSIX path; they do not
establish power-loss directory durability or protection against concurrent
same-user path replacement.

Requests retain whitelisted model, messages and settings. Outcomes retain the
adapted completion, finish metadata and available usage, or a fixed failure
classification and HTTP status. Known configured API-key values are redacted.
The opt-in artifacts contain private context, gold answers and hypotheses; keep
them private. They do not capture HTTP headers, raw failed response bodies or
live wire traffic. Missing usage stays missing, and reasoning-token detail must
not be added again to output usage.

On the supported HTTP QA path, a fresh single case is bounded by three
preflight, three answer and six judge requests. Logical scoring counters count
answer and judge operations separately from those transport attempts. This
bound excludes ingestion, additional cases, resume and provider-internal
retries, and does not enforce a monetary or whole-run budget. Capture and
injected-request tests are diagnostic evidence, not benchmark-quality results.

### Per-question stage evidence

The same opt-in capture adds `questionId` to answer/judge request and outcome
records, including every retry. Preflight records have no question ID. Match
request and outcome by their provider `sequence`; the request's `messages`
contain the exact answerer context after configured-key redaction. Gold answers
are supplied only to the judge, never added to the answerer's messages.

Separately numbered `<sequence>.case.json` files join `questionId` and
`scenarioId` to a stage and status. The case sequence is independent of the
provider sequence; join by question ID within this capture directory, not by
matching the two sequence numbers. Cases can stop at `material`, `retrieval`,
or `eligibility` without an answer call. Answer/judge stages distinguish a
failed operation from an unreliable parsed completion; `result` records a
valid judged `correct` or `incorrect` verdict. Reused rows get a `resume`
record, not an invented new provider request. Case records contain no question
text, passages, gold answer or raw error message. A stage identifies where
execution stopped, not the underlying cause: correlate it with provider
outcomes and the prediction sidecar. A request without an outcome or a started
stage without a terminal record remains incomplete.

Case files use the same exclusive private writer and fail-closed behavior as
provider capture. Context can contain personal data not recognized as a
configured API key; this is sensitive opt-in evidence, not anonymized output.
Do not commit it or attach it to public issues/PRs. Disabling capture retains
the prior prompts, prediction sidecar, call accounting and scoring behavior.
This facility covers `official` and `custom-judge`, not `custom-v1` or
`custom-v2`.

Use this evidence to select an experiment before changing answer prompts or
retrieval. The current durable answer path already passes full retrieved text
when available, preserving dates and speaker roles, and asks for per-passage
notes. Capture alone neither establishes a preference failure's cause nor
measures an improvement. Any later prompt/context/query experiment needs its
own switch and run identity; compare exact question sets and report the judge
protocol, sample size and uncertainty. A custom judge is not the pinned
LongMemEval judge, and a subset is not full-set qualification.

## Checkpoint-sidecar comparison

The `b2-join.ts` reader refuses duplicate or inconsistent supplied scenario
IDs, unexpected completed scenarios, duplicate selected final-pass case IDs,
and prediction rows with a mismatched question ID or invalid stage/verdict.
Judged rows require `yes` or `no`; answered and unreliable rows require null.
For declared LongMemEval runs identified by selected LongMemEval metrics, each
scenario has one matching case and prediction IDs must belong to the declared
population. Generic scenarios can retain several distinct case IDs. Earlier
measurement passes are not treated as duplicate final-pass results.

The only comparison verdict is an exact two-sided McNemar test on one
declared endpoint: official judged QA correctness, or binary session R@10
under `--r-only`. It uses a fixed diagnostic alpha of 0.05, which is not a
release or practical-margin policy. The report records the endpoint, method,
complete denominator, B-only and A-only successes, p-value and direction.
Practical significance is reported as not assessed, and a non-significant
result is `inconclusive`, never evidence of equivalence. Net R/Q movement, the
double-baseline flip threshold and `retrievalRealAnswerNeutral` are
descriptive only; `noiseRule.real` mirrors the test for compatibility.

Inference is emitted only for eligible comparisons. Both runs need a version 2
checkpoint whose `datasetSha256`, `configurationHash` and `executableDigest`
are lowercase 64-character sha256 hex and whose `runId` is non-blank text
without surrounding whitespace. The default QA endpoint also needs a v2
prediction sidecar in each run, with every identity field valid (digests as
sha256 hex, other fields non-blank and unpadded) and `runId`, `datasetSha256`
and `configurationHash` equal to its own checkpoint. Under `--r-only` without
`--treatment`, both sidecars may be omitted; a sidecar that is supplied must
still be valid and bound to its checkpoint, and scalar sidecar fields are
compared whenever both runs supply one. `--treatment` always requires valid
sidecars in both runs. Rejections name the field, never its value.

Each checkpoint must also persist its run configuration, the exact
`OperationRunConfiguration` hashed into `configurationHash`, with the supported
`settings.configurationCoverage` marker. The manifest is accepted only with
that exact top-level shape, a hash equal to the checkpoint's and complete
coverage as defined in `benchmark-run-configuration-schema.ts`, which the
producer also builds from: exactly the covered settings keys; credential
fingerprints as 64-character hex or null, plus a non-null key id; env values as trimmed text or null; known values for the
QA protocol, judge auth style, judge token parameter and answer source; a
dedicated answer source only with a fingerprinted dedicated key; and a durable
QA protocol only with a judge model, key and endpoint. A self-consistent hash
over an incomplete or malformed manifest is refused, and schema validity says
nothing about whether the values are authentic. `-0` counts as `0`, as it
hashes. The marker sits inside the hash, so a manifest copied from an older
run cannot verify. Coverage (`b02-keyed-v6`) includes the judge model, auth
style, token parameter and QA protocol, keyed fingerprints of every supported
credential, the configured MongoDB connection inputs described below, the
extraction-job drain stall window (`MEMONGO_BENCHMARK_JOB_DRAIN_STALL_MS`, raw
and resolved), and session turn recall (`MEMONGO_SESSION_TURN_RECALL` raw,
`effectiveSessionTurnRecall`, and its frozen seed-result, seed-session and
turns-per-session bounds), so a `b02-keyed-v5` manifest does not resume.
Checkpoints without a valid manifest, including every earlier run, every
`b02-keyed-v1` run without connection inputs and every `b02-judge-v1` run with
plain sha256 fingerprints, stay descriptive and are refused for resume: equal hashes alone once missed a
changed judge endpoint, so this is a deliberate compatibility change, not
retroactive certification.

Credentials never enter a manifest raw or as a plain digest, which anyone could
confirm by guessing. The enrichment, answer and judge API keys and base URLs
(`env.<KEY>.hmac`) are recorded as HMAC-SHA-256 under the operator's
`MEMONGO_BENCHMARK_FINGERPRINT_KEY`, over a fixed scheme label, the setting
name and the effective value, separated by NUL bytes. The effective value is
the env value trimmed as the provider resolvers trim it, and the Voyage key as
configured; URLs are not canonicalized, so two spellings of one endpoint can
refuse a resume but never merge. An absent credential is `null`.
`credentialFingerprintKeyId`, an HMAC of a fixed label under the same key,
names the key domain inside the hash; it is an equality tag, not provenance.

The key is 32 bytes written as exactly 64 hex characters. The operator owns
it and must create it as a fresh, cryptographically random value (RFC 2104
section 3 requires random keys), for example with `openssl rand -hex 32`. The
parser checks only the format, not randomness, so a patterned value or the
synthetic keys in tests and docs must never be used for a real run. The
benchmark never generates, persists, records or logs the key; it only reads it
from the environment for the run. Every `scripts/run-benchmark.ts` run requires
it and refuses a missing or malformed key right after the MongoDB URI check,
before the recall-test subprocess (which runs a mocked suite), manager
acquisition (the run's first database connection) or any provider call. The producer refuses too, which protects
direct callers of the benchmark ops only from that point on: a caller that
acquires its own manager has already connected by then. Rotating the key is a
deliberate operator act: the key id and every fingerprint change, so resume
refuses ("configuration hash does not match"), b2-join refuses inference
("credential fingerprint key differs between runs") and earlier runs remain
historical. A key changed mid-run fails the run as a configuration change. The
fingerprints hide guessable values only while the key stays secret, and runs
under one key still reveal which ones share a credential.

The configured MongoDB connection inputs are bound the same way.
`mongodbUriHmac` is the keyed fingerprint (setting name `mongodb.uri`) of the
exact URI the client is built from, never parsed, trimmed or normalized, and
always present; the URI, user, password and query values are never recorded.
Any byte change refuses resume and comparison, including a password rotation,
an option reorder or a case change that the driver would treat alike; a
password change can change connection success and the failures a run records,
and a second parser would risk merging URIs the driver reads differently. The
eleven client inputs the engine passes to `MongoClient` are recorded as typed
`configuredMongoClient.<name>` values (null only for optional ones left unset):
`serverSelectionTimeoutMs`, `connectTimeoutMs`, `maxPoolSize`, `minPoolSize`,
`maxConnecting`, `maxIdleTimeMs`, `networkFamily`, `socketTimeoutMs`,
`heartbeatFrequencyMs`, `serverMonitoringMode` and `waitQueueTimeoutMs`. This
binds configured inputs only. A run may borrow a shared client whose pool was
created with the first acquirer's options, and `mongodb+srv` hosts and TXT
options, server roles and server, index, model or data state are resolved at
runtime; none of these is proven by the manifest. `deploymentIdentitySha256`
is unchanged.

Provider failures are reported without provider or runtime payload, because a
provider error body can echo the key or request URL and runtime, DNS or SSRF
guard errors can quote a header value, the host or the response body. The
answer, judge and enrichment providers report `HTTP <status> (response body
withheld)` and never read the body. A runtime `TypeError`, such as a header
value the runtime rejects, becomes `transport failed (TypeError)` with status
503 and stays retryable. A DNS failure stays a plain `Error` and a guard
refusal stays an `SsrFBlockedError`, both under fixed text and, as before,
never retried. Two classes change: an Anthropic success body that is not JSON
now fails as a non-retryable `EnrichmentResponseError` with shape
`malformed-body` instead of a raw `SyntaxError`, and any other unrecognized
failure, including an `EnrichmentResponseError` thrown by an injected `fetch`,
becomes a plain non-retryable `Error`. An `EnrichmentHttpError` thrown by an
injected `fetch` keeps only its status, and so its retry decision. HTTP status
codes, the timeout 408 and the retry and capture classification of the default
`fetch` are otherwise unchanged. This covers configured credentials in these failure diagnostics; it
does not cover MongoDB driver errors, successful provider content or dataset
text.

The runs must be distinct and must share `datasetSha256` and
`executableDigest`; an opaque digest cannot show that a single setting
changed, so it is never a treatment and source treatments are deferred.
Configuration is compared field by field: every differing manifest field is
refused unless the declared `--treatment` owns it. `answerModel` owns
`MEMONGO_BENCHMARK_ANSWER_MODEL` and requires a dedicated answerer in both
runs, because the enrichment-fallback model also drives ingestion;
`judgeModel` owns `MEMONGO_BENCHMARK_JUDGE_MODEL`; `judgeProtocol` owns
`MEMONGO_BENCHMARK_QA_PROTOCOL` between `official` and `custom-judge`. The
owned field must actually change. Prompt versions, answer temperature and max
tokens are source constants and cannot be a treatment. Each sidecar's answer
model, judge model and judge protocol must equal the values its manifest makes
effective; a contradicting label is refused. Diagnostics name fields, never
their values.

Every declared scenario must be completed with exactly one final-pass entry
carrying a valid case ID (which may differ from the scenario ID), and both runs
must select the same case IDs. Each selected case needs a paired outcome in
both runs: a judged `yes`/`no` verdict for QA, or a session R@10 of exactly 0
or 1 under `--r-only` (fractional or missing recall is refused, never
rounded). `--min-judged`, when given, must be met. Question-level independence
is an assumption the caller declares with `--assume-independent-questions`;
the report records it as declared, not verified. Known clustered populations
(several cases per scenario) are refused even with that declaration.

Ineligible comparisons, including legacy artifacts without identity, partial
coverage and dataset inequality, still print the descriptive join and exit
non-zero with the reasons. Malformed artifacts and invalid flags remain errors
without a report. Paired intervals, power analysis and cluster-aware
estimators are not implemented.

Build environment labels do not attest the full loaded graph or effective
requests. Record actual entrypoints, loaded artifacts and intended-target
requests before qualification; different single-file compiler output alone
cannot establish a stale or behaviorally different build.

## QA summary population

The official and custom-judge QA summary validates its declared case IDs and
prediction rows before computing metrics or writing an export. Case IDs must
be nonblank and unique. Each row key must match its question ID and belong to
the declared case population. Judged verdicts require `yes` or `no`; answered
and unreliable rows require null. Inconsistent inputs raise the existing
sidecar error without including artifact values or rewriting stored rows.

Valid missing, answered and unreliable cases still withhold whole-workload
accuracy. Declared orphan rows retain incomplete-accounting disclosure; an
empty population stays unavailable, and generic scenarios may contain multiple
cases. This check rejects corrupt or foreign restored inputs at aggregation.
It does not provide admission before provider calls, complete-run coverage or
proof of a matched benchmark result.

## Publishable benchmark claims

A claim may be published only when all are true:

1. `benchmarkReport.releaseGates` contains a passing `official-retrieval` gate.
2. `officialMetrics` is present and matches the dataset being claimed.
3. `corpus.cases > 0` and `corpus.scoredCases === corpus.cases`; partial or
   missing scored-case coverage is a warning, not a publishable official win.
4. The commit/build id, dataset name/version, MongoDB topology, embedding model,
   and benchmark command are recorded.
5. `warnings` and `degradations` are reviewed and disclosed when material.
6. The conversation recall regression test is run for any recall-plane change.
7. The `scenario-cleanup` gate passed.
8. The `execution-completeness` gate passed, so no case failed and ingest was
   complete.

If `datasetKind` is `legacy-query` or `officialMetrics` is absent, the result is
an internal diagnostic, not a benchmark win.

## Query governance policy

Benchmark output may recommend query-shape governance candidates, but it must
not apply MongoDB query settings automatically.

MongoDB query settings are cluster-scoped and persistent. Treat any
`consider-setQuerySettings` candidate as an operator review item:

1. Inspect query stats and explain output.
2. Apply the setting manually in the intended environment.
3. Record the setting and rollback command.
4. Remove it with `removeQuerySettings` if it degrades behavior.

This is why `query-governance` remains `advisory-only` in `benchmarkReport`.

## PR and release delta recording

For every benchmark-affecting PR or release candidate, record:

- base commit and candidate commit
- commands run
- dataset and corpus version
- `benchmarkReport` JSON
- deltas for `hitRate`, `emptyRate`, `p95LatencyMs`, `rAt5`, `rAt10`,
  `ndcgAt10`
- any warnings, degradations, or skipped cases

Do not compare numbers from different corpora, embedding models, or MongoDB
topologies without labeling the comparison as non-equivalent.


## Benchmark timestamp treatment and resume

The benchmark loader validates explicit timestamps before normalization can
hide malformed values. Direct replay and fast ingest validate the selected
conversations before the first write. Missing timestamps retain the existing
write-time behavior; explicit null, empty strings, impossible calendar dates,
and unsupported grammars fail with value-free rejection coordinates.

`benchmark-timestamp-utc-fields-literal12h-v1` accepts the strict ISO/date-only
forms documented in [conversation import](../conversation-import.md), plus
these corpus forms:

- LongMemEval: `YYYY/MM/DD (Mon) HH:MM`, with any English weekday abbreviation.
  Numeric calendar fields determine the instant. The loader reports weekday
  disagreements in `timestampValidation.weekdayMismatches`.
- LoCoMo: `h:mm am on d Month, YYYY` or `pm`, using English month names.
  Twelve am is midnight; twelve pm is noon. The loader reports twelve-am labels
  in `timestampValidation.literalMidnightLabels`.

Nonzero interpretation counts also appear in the benchmark report warnings.

Both corpus grammars use UTC calendar fields. This is an explicit benchmark
policy, not evidence of the source conversations' real timezone. The pinned
[LoCoMo generator](https://github.com/snap-research/LoCoMo/blob/3eb6f2c585f5e1699204e3c3bdf7adc5c28cb376/generative_agents/generate_conversations.py)
labels noon as am; that does not establish the intended instant of each
released record. The policy preserves the literal released labels. Original
strings remain available to QA prompts; replay and session-evidence writers
receive cloned ISO instants. Question-day cutoffs use the end of the same UTC
day. This avoids the host-local interpretation of naive date-times described
by [ECMA-262 Date.parse](https://tc39.es/ecma262/multipage/numbers-and-dates.html#sec-date.parse).

The policy version is bound into the run configuration and benchmark replay
idempotency keys. Resume rejects older or different policies, executable
identities, malformed ingest counters and a line-failure or rejection count
that disagrees with the loaded dataset. Start a fresh benchmark scope after a policy change.
The production conversation importer retains its own timestamp and key contract.

Comparison inference also requires `failedLines: 0`, `rejectedTurns: 0`,
`rejectedConversations: 0` and valid nonnegative integer scenario ingest
counters with `failedTurns: 0`. Unknown or failed
ingestion keeps a b2-join result descriptive and exits nonzero even when every
question has a verdict. Historical checkpoints without these fields cannot
establish complete ingestion.
