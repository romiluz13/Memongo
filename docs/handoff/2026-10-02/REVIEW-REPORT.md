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

The source follow-up was delivered to main at `aadffd324b8af482b66ab29710363bcb5958b1d3`. [Automatic exact-head CI](https://github.com/romiluz13/Memongo/actions/runs/37033780070) completed SUCCESS at 16:29:54 UTC: quality (including all artifact checks and unit execution guard) and real MongoDB tier-A (including suite execution guard) passed. Final API status and step conclusions are retained locally. Full hosted log retrieval failed twice on GitHub connectivity; hosted case counts/server tuple are not inferred from the status. This documentation refresh has a separate later commit; its CI result is not asserted here. Full manual provider E2E and registry propagation retry behavior remain unfinished. All 58 original parent acceptance criteria and closure status are preserved; these two repairs do not certify S03, O01 or the entire roadmap.

## Agreed two-child follow-up

The later bounded implementation starts at documentation main `5f5be80f60ab689fa7595b5468d95e6073d33aef` and integrates N-QR at `e1d4eb25a93b24cbda6d05a58c7f76d6240bb2c7`, then EX-GATE at `0aabbc887b73c11e983bcf2578b6eecbcedefa1a`. Both children passed independent source/standards and requirements/technology review with zero actionable findings. The reviewed public documentation follows in a separate commit. The published npm/tag 2.2.0 basis is unchanged.

N-QR adds optional `memoryMayRemain?: true` to successful rejection of an expired promotion claim, derived from the existing recovery decision and present even if audit persistence fails. It means structured memory may remain; no lookup, deletion, erasure promise, stored schema, lease or state-machine change was introduced. Ordinary pending rejection and successful promotion omit it. Client types also expose existing `finalizeError?: string`. The supported native journey used an actual manager promotion write, an injected finalization failure, lease expiry and rejection; retained-memory, no-memory-possible and foreign owner/session controls were checked. Before the repair, three of 17 unit cases and four of eight native cases failed for missing disclosure, and SDK type checks reported four missing-field errors. Afterward, 116 affected unit cases and 51 native cases passed. Bridge/API/client pass-through fixtures are separate seams, not hosted transport end-to-end proof. Preliminary test-fixture assertion corrections are retained outside the supported baseline counts.

EX-GATE retains the manual service's 27017 mapping, adds 27218 to the same container, pairs test URIs with that owned port and creates the runner-owned evidence directory. The existing execution verifier now requires structured-history, erasure-two-process, search-community-contracts and kb-scope-community. Before repair, safe installed-Vitest file collection selected 101 files including 70 owned fixtures; the old URI failed the owned history guard before connection, and absent evidence failed the two-process preload guard. Four required owned suites then passed all 18 cases. Their exact raw testcase aggregate passes the verifier; copies missing or skipping only the two-process cases fail while the other 16 cases execute. Provider requirements, full selection, manual dispatch and paid benchmark lane are unchanged and were not run.

Final checks were serialized on frozen source/build inputs using Node 24.19.0, Bun 1.4.2, driver 7.6.0 and owned MongoDB 8.2.6:

- Frozen offline install, forced build, types, lint and the new/changed fixture type check passed.
- 5,753 unit cases executed with zero failures; four existing dataset-dependent script cases skipped. All nine raw JUnit reports and the required OpenAPI suite passed the execution guard; forced Turbo tasks were neither cached nor force-killed.
- All eight artifact checks passed. The existing source-shipped Pi extension publint/attw skip remains explicit. Default strict release validation separately rejected already-published 2.2.0 as expected; no publish was attempted.
- 596 native cases across 71 owned regression files, including the new recovery fixture, passed without skips. UUID databases were removed, the preexisting database baseline was preserved, source/build hashes stayed equal, guarded workers exited, and SIGTERM stopped the owned server with exit 0 and refused port afterward. No model endpoint or Atlas workload was used.

This is local native routing/regression proof. The manual full/provider workflow, Docker-hosted dual-port routing, floating Preview search/embedding behavior and production incidence remain unverified. Ordinary hosted CI for the final documentation revision is a separate delivery check; consult its exact commit in [CI runs](https://github.com/romiluz13/Memongo/actions/workflows/ci.yml). Local case counts are not inferred for hosted CI. All 58 original criteria/statuses and zero full-parent closures remain unchanged; current closure across 381 historical routes remains unknown. Further work stops for manager reevaluation, with no third implementation child implied.

## What the evidence does not establish

No matched competitor win, measured improvement from the release repairs, production capacity/SLA, exhaustive writer coverage, two-process CAS/unknown-commit recovery, full retention policy, or entire roadmap completion is claimed. 0 of 58 original parents were formally certified end-to-end in the conservative ledger; that does not mean no implementation exists. Finding-level closure across 381 routes has not been fully mapped to 140 repairs. Original audit findings describe the old baseline and require current-code adjudication before being treated as current defects.

The prior A benchmark scored 31/50 using a custom judge;15 of 19 failures were empty hypotheses.31/35 correct among intact answers is conditional, not a full accuracy score. B1 has 49 judged rows and 1 unreliable, so its overall judge accuracy is withheld. B2 was last observed running on earlier pinned 4b7d07 code; current process/terminal status is unverified in this refresh. Its older-code results cannot validate the release or follow-up source.

This handoff does not audit invoices or reconcile model billing. Code changes and checks are concrete outputs; their business value and future funding are for the reviewing team to assess.

## Suggested independent review

Read the release diff and tests; spot-check representative before/after receipts from the private context. Inspect security-sensitive identity/erase/promotion paths and the known residuals. Start with offline unit/build checks on an isolated checkout. Do not run paid/live suites, alter the campaign namespace, or infer public-doc claims are specifications for original audit adjudication. Official version-matched dependency docs and current code are the technical basis. Record any new review findings separately; a finding is not permission to implement it.

## Bounded proposal for manager approval

The proposal below predates the agreed two-child implementation and remains a separate optional offline evidence scope. Completion of N-QR/EX-GATE does not execute campaign sealing or renew model/comparison authority. Choose its executor and fixed cap explicitly before any remaining offline evidence work; reevaluate the two concrete outcomes above first.

The inspectable release artifacts, exact source refs, before-failing regressions and passing checks establish two repaired behaviors and a delivered reliability release. They do not establish a competitive win, production readiness or a return on spending. Model/token expenses are not invoice-reconciled here. Historical Claude/Codex audits and consensus routes identify hypotheses and requirements; this sprint did not re-audit all findings. Start with this report, then the roadmap and original acceptance ledger; do not interpret agreement or activity counts as proof.

A small next assignment can determine whether preserved campaign evidence supports further investment. Rom is the accountable owner. Managers choose a fixed time cap and explicitly approve a single offline deliverable: an A/B1/B2 lineage, eligibility and seal matrix plus a bounded interpretation memo, using preserved artifacts only and no new model calls. First verify cheap process/terminal metadata and preserve originals; do not alter the campaign. Stop at the cap or if identities, eligibility or terminal artifacts cannot be verified, and return the missing evidence as a failed/inconclusive gate. Independent review precedes any decision to fund more work.

Only after that review should managers consider representative matched controls and heldout confirmation with a separate explicit model-cost cap. Coding/lifecycle safety tasks require separate prioritization and authorization. Managers may decline further work. Benchmark leadership remains an aspiration requiring matched evidence.

Copyable request: “Please approve one bounded offline reassignment, owned by Rom, with a time cap you select and no new model calls. Deliver a verified campaign lineage/eligibility/seal matrix and interpretation memo, then stop for independent review. If evidence cannot be verified within the cap, report the gap and stop. This does not approve the full roadmap or further coding. Any matched-control or heldout campaign would require a separate cost-capped decision.”
