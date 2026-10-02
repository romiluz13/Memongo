# Review report: work delivered and evidence limits

Memongo remains a MongoDB-native TypeScript/Bun monorepo: HTTP API, memory engine and facade, client SDK, AI SDK helpers, MCP server, Pi extension, and web console. This handoff supplies inspectable code and validation evidence rather than a claim of benchmark leadership.

## Delivered changes

The 2.2.0 release incorporates 140 independently accepted bounded repair changes. The accepted pre-release snapshot comprised 305 source/test/documentation paths; 301 were integrated, with four audit-only mutation-inventory files kept outside the published tree. The release also includes the preceding local work. These numbers measure accepted artifacts, not unique bugs, parent-task closure, effort, or accuracy gains.

| Concrete behavior | Review and test evidence |
|---|---|
| Selected delayed writers retain their original lifecycle admission and are fenced against erasure/replacement | Native barriers and a two-process erasure fixture; E254/E256 acceptance records in private archive |
| Supported owner coordinates propagate through HTTP, MCP, tools and middleware, with bounded validation and explicit destructive targets | API/MCP/tools unit suites and E189/E191/E192 receipts; full grant hierarchy still needs policy |
| Exposed redaction/query/pattern paths are bounded and repaired database/provider diagnostic boundaries omit raw error text | Before-failing/adversarial fixtures and E01/E02/E04/E06 receipts; not an exhaustive logging-security proof |
| Quarantine transitions work with the validator; selected identity/session preservation and ambiguous legacy conflicts are explicit | Real MongoDB validator and E256 identity fixtures; broader recovery/TTL/deduplication remains open |
| The npm-generated MCP command initializes instead of silently exiting through its symlink | Installed local package bin handshake reports 2.2.0; E255 and release bin smoke |
| Package gate cleans its owned temporary directories without omitting fresh installations | Package gate and focused policy tests; bounded Claude review |
| Automatic paid wiki and provider-test schedules are suspended | Committed workflow diff; manual workflows still exist and are not authorization to run them |

## Verified release evidence

At the released code basis, local validation recorded Node 24.19.0, Bun 1.4.2, MongoDB Node driver 7.6.0, and an isolated MongoDB 8.2.6 replica set. The current CI atlas-local service observed 8.3.11; its Preview tag is floating, so future runs must capture their actual tuple.

- 5,731 unit tests executed, zero failures; four known dataset-dependent script tests skipped.
- 69 native MongoDB fixture files, 581 cases passed. Source/build hashes were sealed; owned server shutdown and fixture cleanup checked.
- Type checks, lint, build, frozen installation, package tarball/install/import checks passed. The MCP packed-bin initialized with version 2.2.0.
- [Main CI](https://github.com/romiluz13/Memongo/actions/runs/36980293298): both quality and real MongoDB tier-A jobs passed at d2579054a4. Initial CI failed on missing explicit test URI; the three-line workflow correction was reviewed and actual CI rerun passed.
- [Container publication](https://github.com/romiluz13/Memongo/actions/runs/36980657591) passed. Public digest: `sha256:9fc41296c02aa6dbffa1ce4075bab125cb9f434d27e8a224aa91a4f1fb9ff63f`.
- Cloudflare deployment version `9f51fd42-b06b-4f38-8a26-91964d7f20bf` served home and console HTTP 200; BUILD_ID and asset SHA matched the new build. This checks deployment, not end-to-end hosted API functionality.
- Eight GitHub release package downloads were SHA256 verified. [npm publication](https://github.com/romiluz13/Memongo/actions/runs/36980657586), attempt 2, passed build, tests, publishability and all eight package uploads after access restoration. All eight registry versions expose provenance; downloaded SHA1/SHA512 match the verified release tarballs. The workflow is **failed** because its immediate install smoke exhausted ten version-not-found retries. After propagation, the independent fresh-cache exact registry install, public imports, Pi source and MCP initialize 2.2.0 passed. [Verification receipt](NPM-PUBLICATION.json). The original first-attempt HTTP 404 cause remains unresolved; the prior Sigstore record alone did not prove publication.

## Bounded post-release follow-up

The follow-up source starts from `effced564536e6c609c2123cb03870985ad9bdec` and is integrated at `ccf4b3d904336899e8780120301296d7c0c00637`. It includes structured-history commit `8da290c7b382d6d3f44e8045ddc475ea87cc34ec` and the ordinary CI repair. The immutable `v2.2.0` release and published package versions retain their original code.

Ordinary CI now calls `check-publishability --artifacts-only`: published versions can pass the same build, metadata, version-alignment, tarball and installation checks. The default release command still rejects already-published versions and registry lookup errors. The published-version failure was reproduced locally and in hosted CI 36988359561. CLI regressions failed before the change and all 19 passed afterward. The publication workflow continues to use the strict default; no publishing or deployment was rerun.

Structured current history reads the current physical document first, returns an empty result if it is absent, and filters snapshots by raw BSON `structuredId` equality before the history limit. Legacy and earlier-generation snapshots remain stored but hidden from current history, without backfill. The existing API maps empty history to its existing 404 response. Procedures, what-changed, mixed old writers, numeric identity equivalence and manual physical-id reuse remain open; the two reads do not promise a linearizable latest view. Independent cross-review accepted both repairs and their documented scope.

Sequential checks on the combined source used Node 24.19.0, Bun 1.4.2, MongoDB driver 7.6.0 and an owned MongoDB 8.2.6 replica set:

- Frozen installation, forced build, type checks and lint passed.
- 5,743 unit tests executed with zero failures and four existing dataset-dependent skips. All nine JUnit reports and the required OpenAPI conformance suite passed the execution guard.
- Artifact validation passed for all eight packages, including clean/dirty build comparison, packed installation and entry-point checks. The existing publint/attw skip for the source-shipped Pi extension remains explicit. The default strict release command separately rejected the existing 2.2.0 version as expected.
- 47 native cases across four fixture files passed on the combined source, including seven new structured-history cases and existing generation/update/invalidation regressions. Before the reader fix, six of the seven new native cases failed; related unit regressions had four failures. Source/build hashes remained unchanged during final checks; fixture databases were removed, the preexisting database baseline was preserved, and the owned server exited cleanly. No Atlas or model endpoint was used.
- The new fixture and changed unit file passed a separate type check. Staged secret scanning and diff checks passed.

Hosted CI for the follow-up head is a separate check; this local evidence does not assert its result. Full manual provider E2E and registry propagation retry behavior remain unfinished. All 58 original parent acceptance criteria and closure status are preserved; these two repairs do not certify S03, O01 or the entire roadmap.

## What the evidence does not establish

No matched competitor win, measured improvement from the release repairs, production capacity/SLA, exhaustive writer coverage, two-process CAS/unknown-commit recovery, full retention policy, or entire roadmap completion is claimed. 0 of 58 original parents were formally certified end-to-end in the conservative ledger; that does not mean no implementation exists. Finding-level closure across 381 routes has not been fully mapped to 140 repairs. Original audit findings describe the old baseline and require current-code adjudication before being treated as current defects.

The prior A benchmark scored 31/50 using a custom judge;15 of 19 failures were empty hypotheses.31/35 correct among intact answers is conditional, not a full accuracy score. B1 has 49 judged rows and 1 unreliable, so its overall judge accuracy is withheld. B2 is still running on the earlier pinned 4b7d07 revision, not the release. Its results cannot validate this release.

This handoff does not audit invoices or reconcile model billing. Code changes and checks are concrete outputs; their business value and future funding are for the reviewing team to assess.

## Suggested independent review

Read the release diff and tests; spot-check representative before/after receipts from the private context. Inspect security-sensitive identity/erase/promotion paths and the known residuals. Start with offline unit/build checks on an isolated checkout. Do not run paid/live suites, alter the campaign namespace, or infer public-doc claims are specifications for original audit adjudication. Official version-matched dependency docs and current code are the technical basis. Record any new review findings separately; a finding is not permission to implement it.
