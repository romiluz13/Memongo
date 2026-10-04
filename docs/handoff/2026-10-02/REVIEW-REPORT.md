**October 4 critical-memory follow-up:** source `b6c96dfe306f0c7df8d21765be1c06d352e0c05f` ranks critical structured memories before the unchanged six-row slate limit. An older critical blocker now reaches the default wake-up bundle despite newer high-priority fillers. Fresh local proof records 5,911 passing units, four existing skips and zero failures, plus the six-case paired MongoDB probe and 15 native tests. The complete-clause mapping is 19/418 (4.55% lower bound); benchmark technical gates remain 1/6. These are evidence measures, not product completion or quality. [Behavior and limits](#critical-memory-before-bounded-slate-selection--2026-10-04). Main delivery and exact-head hosted CI require separate observations. Earlier entries below are historical.

**2026-10-04 reliability follow-up:** reviewed source `56c6daa5aa83b41a6906e31a0295d692b2a39df1` sanitizes recognized credentials in quarantine receipts/audit metadata and checks the installed MCP executable during package validation. Combined local proof records 5,905 passes/four existing skips/zero failures and expected artifact/freshness outcomes. [Behavior and limits](REVIEW-REPORT.md#quarantine-diagnostic-redaction-and-installed-mcp-validation--2026-10-04). Original 14/418 evidence credit and 1/6 technical readiness are unchanged; main delivery and exact-head hosted CI are separate observations. Earlier entries below remain historical.

**2026-10-03 cost-status follow-up:** reviewed source `99f4fc22b7d7698024fcb39925f71427baaa6795` discloses a failed cost aggregation as `costLedger.dailySums`/partial while healthy empty remains complete and default reader behavior is preserved. Affected offline proof passes3,533 engine cases/no skips or failures and the unchanged exported-status probe4/4. The fixed418-criterion map now records **14 verified (3.35% lower bound),0 failed,28 partial,354 unverified and22 policy-held;0/58 whole parents certified**. Access-retry evidence remains partial because synthetic two-target and native one-target checks do not prove the exact multi-row transaction clause. Read [behavior, evidence and limits](REVIEW-REPORT.md#cost-status-disclosure-and-access-retry-evidence--2026-10-03). Source review is accepted; final shared review, main delivery and current exact-head CI are separate. Earlier snapshots below remain historical; no campaign win or publication authority follows.

**2026-10-03 bounded offline follow-up:** supplied-baseline coverage is repaired on reviewed code `26c409eec7070f20035b124ad883ba68c22c1903`. The fixed original roadmap has 58 parents and 418 acceptance criteria. A bounded independent evidence mapping verifies **13/418 criteria (3.11% lower bound)**; 27 are partial, 356 lack a complete mapping in this pass and 22 remain policy-held. **0/58 whole parents are certified.** Unmapped does not mean unimplemented. This supersedes older current-source/campaign-continuation pointers below; historical receipts and original criteria are preserved. Read [the follow-up and its limits](REVIEW-REPORT.md#offline-baseline-coverage-and-criterion-evidence--2026-10-03). The preserved campaign remains inconclusive: B2 completed 11/50 after six failed attempts; no comparative win, model/campaign resume or publication is authorized by these results.

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

## Offline baseline coverage and criterion evidence — 2026-10-03

Reviewed code `26c409eec7070f20035b124ad883ba68c22c1903`, from main `0528d79692faff7281e9b0a96e9be74a6ec8612b`, adds one existing-field guard to `scripts/benchmark/b2-join.ts` and its test. With both baseline paths supplied, the CLI requires the same nonempty unique declared scenario IDs and total, one matching completed question entry per ID, matching sidecar question ID/stage `judged`/verdict `yes` or `no`, and full paired baseline coverage. Partial, unreliable, missing, duplicate or mismatched coverage exits nonzero without a REAL JSON report. No-baseline and ordinary sidecar-free `--r-only` behavior remain compatible; supplied calibration stays Q-required. No formula, report schema, configuration identity, resume or scorer change was made.

The actual offline CLI previously printed `real=true` and exited 0 on one-partial and both-partial-same-overlap baselines with only 1/3 declared questions. Both now exit1 without JSON, while the complete positive report remains. New regressions failed 17/36 before the guard and pass 36/36 afterward; two actual CLI compatibility controls also passed. Final integrated affected checks passed 655 scripts tests with four existing dataset-dependent skips, the required-suite execution guard, strict two-file TypeScript, Biome, diff check and the original three CLI controls. Frozen source/test hashes match the independently accepted diff. An initial broader check environment omitted Bun from PATH and forced the thread pool, breaking existing subprocess/timezone fixtures; its raw output is preserved. Restoring installed Bun and the repository fork pool passed without product changes. There was no new database, model, campaign or artifact run and no manual CI dispatch.

The fixed original denominator is 418 acceptance coordinates across 58 parent packages. The independently checked lower bound is **13/418 (3.11%)**, with **27 partial, 356 unverified, 22 policy-held, 0 verified failures and 0 superseded proposals** in this derived mapping. These labels preserve original text/status and **0/58 certified parent closures**. Unverified means no complete exact-coordinate join validated in this bounded pass, not a finding of absent implementation. Partial receives no fractional weight. Prior selected N-QR+EX-GATE coding scope was 2/2 and prior offline reconciliation assignment 1/1; neither is a whole-roadmap percentage.

One proposed complete criterion was corrected during review: O01:C03 is partial because the cited artifact fixture installs every sibling tarball together, checks bin metadata and imports package entrypoints; it does not isolate each target dependency closure or execute installed npm bin symlinks. The new baseline guard leaves B06:C03 partial because comparison missing-pair/min-judged and full paired inference/comparability requirements remain outside this child. It raises no verified-criterion numerator. The 13 bounded joins reuse accepted raw receipts with source identity checks; previously recorded 5753 unit passes/four skips and596 native cases/71 files are historical proof counts, not newly rerun or criterion counts.

The gate establishes declared coverage only. It does not attest equal effective reader/judge settings, executed builds, actual delivered text/requests, raw judge responses, invoice completeness, causal quality or publishability. Current source already supports declared population, settings snapshots, answer/sidecar pins, truncation handling and bounded judge parsing; missing historical receipts cannot be recovered by changing today's code. A future matched validation needs a named licensed heldout workload, effective-settings/build/transport and durable answer/judge capture gates, and an explicit spending/time cap. No further child, model work, architecture expansion, campaign resume, npm publication or deployment follows automatically. The source delivery and any automatic CI result are recorded separately from this local affected proof.

## Explicit judged-count validation — 2026-10-03

Reviewed code `a5aa509a3a078af8b52f4e2f581f130f233434b9`, from main `7b8a06d246658fe75aab4a2e60ab0cc43581436b`, repairs only explicit `--min-judged` input in `scripts/benchmark/b2-join.ts`. Missing, malformed, negative, fractional, trailing-junk or unsafe-integer values exit nonzero without JSON before artifact reads. Omission remains optional; zero, leading zeros and optional `+` integers remain valid. The valid below-count error, first repeated value, supplied-baseline guard, no-baseline/r-only behavior and all formulas/report fields are preserved.

Five actual invalid CLI cases previously emitted `real=true`/exit0; all now reject. Four original positive/below-count outputs are byte-identical, and five additional no-baseline/zero/+003/sidecar-free r-only controls pass. Corrected before regressions failed19/64; after64/64 passed. An initial test assertion used a nonexistent report field and was corrected before production edits; its raw failure is preserved. Final integrated scripts proof passed683 cases with four existing dataset-dependent skips, including64 B2 cases; the execution guard, narrow types, Biome, diff and nine CLI assertions passed. Both source/test hashes match independent acceptance. The preceding automatic exact-head CI on7b8 succeeded; any CI for this delivery is separate and must be observed at its exact head.

B06:C03 stays partial because this child covers explicit minimum parsing plus the preceding supplied-baseline coverage gate, not all comparison-pair/inference/comparability clauses. It adds no verified-criterion numerator and does not establish a campaign win, equal treatment settings, production quality or billing completeness. Published v2.2.0/tag/packages are unchanged; no provider, campaign, database, publication or deployment work occurred in these local checks.

The independently accepted criterion map now has13 satisfied,1 failed,27 partial,355 unverified and22 policy-held coordinates, totaling418;0/58 whole-parent closures. Only O03:C02 changes from unmapped to a bounded verified failure. A source-level offline probe calls the real current exported status and ledger functions with synthetic read-only collections: one cost aggregation rejection yields daily=[]/dataCompleteness=complete/failedChecks=[], while healthy empty/nonempty and unrelated entity-failure controls pass. The existing best-effort ledger contract remains unchanged. An initial fixture omitted the empty cursor used by unrelated orphan checks; its failed positive control was retained and corrected before the supported probe. No live MongoDB/HTTP/production/billing result is inferred. A correction requires its separate concrete scope and proof; no telemetry architecture or cost-efficiency certification follows. The13 satisfied joins and all original criterion/status/closure fields are unchanged.

## Cost-status disclosure and access-retry evidence — 2026-10-03

Reviewed source `99f4fc22b7d7698024fcb39925f71427baaa6795`, based on main `df04c7809760412640cceab7e64a9c96d8b4a66a`, changes only the cost reader/status and their two existing test files. `getDailyCostSums` gains an optional strict-read flag; omission/false retains best-effort empty results and sanitized warnings. The existing status call opts in. A failed aggregation now rejects with a fixed generic error without raw driver payload or cause, so existing settled-check classification reports `costLedger.dailySums` and partial while retaining empty daily fallback. Healthy empty/nonempty results, tenant/window/pipeline, writes and other status fields are preserved.

Supported regressions fail3/55 before and pass afterward. Final integrated engine checks pass3,533/3,533 across193 files, no skips or failures, preserving the old3,525 cases and adding8 passing controls. Required cost/admin/privacy suites execute55 cases; source and strict fixture types, Biome, diff and execution guards pass. The unchanged exported-function probe goes3pass/1fail to4pass using the same32 synthetic read-only calls per case. Healthy empty/nonempty and unrelated entity-error controls are preserved; strict/status diagnostics reject private driver canaries. Initial fixture, diagnostic-capture, working-directory and test-typing attempts are retained separately; final reviewed bytes pass. No live database, HTTP, production, provider or invoice completeness was exercised. Normal main delivery and automatic exact-head CI must be observed separately; prior df04 CI success does not certify this head.

Only O03:C02 changes from a preserved bounded failure to a bounded verified criterion. O03:C03 changes from unmapped to partial after source/raw receipt reconciliation: six existing unit and three native coordinates support rebuffer and one-target transactional rollback/same-batch retry. The synthetic two-target partial apply bypasses a real transaction; native one-target proof cannot establish the exact original multi-row raw partial-apply/abort/retry clause. No current lost-item defect or new access code/runtime is claimed. All original58 cards,418 criterion texts/statuses and0 parent closures remain preserved. The resulting lower bound is14/418(3.35%):0failed,28partial,354unverified,22policy-held. Partial has no fractional credit and unverified does not mean absent implementation.

Initial continuation2/2, baseline child1/1, explicit-minimum repair1/1 and earlier failing cost proof1/1 remain separate sealed scopes. This cost correction consumes the second/final additional source slot; no third source child follows. Existing683 scripts passes/four dataset skips/64 B2, historical5,753 unit passes/four skips,596 native cases/71files and eight artifact checks were not rerun or added to this affected-engine count. B06:C03 remains partial; B2 remains11/50/inconclusive. No quality win, campaign/model resume, publication or deployment follows. Any matched validation needs its workload, settings/build/transport/judge gates and explicit spending/time cap.

## Build readiness and candidate-retirement evidence — 2026-10-03

Two independently reviewed evidence-only joins use delivered source `10339f3df70c9f18f72b6e67f80970b895c00341`; no new product/source/test/build/model/Mongo/campaign work occurred. The current report helper records environment build metadata and checks a nonempty commit declaration. Four guarded offline controls distinguish absent/label-only metadata from current/different40hex declarations; all remain unpublishable for monetary cost and other missing gates. Actual executed built/source identity, canonical manifest/resume binding and historical campaign lineage remain unverified. Strict transitive fixture and source-only checks both exit2 with the same four existing script diagnostics, no final private fixture errors; no full type pass is claimed.

The candidate-retirement join parses20 exact historical native JSON/JUnit coordinates and confirms10 selected source/test hashes match native start/end/current. Existing prepare-then-commit/persisted-source repairs preserve targets through the selected NOOP/quality/write/audit/stale controls. Eight consolidation targets explicitly carry observed provenance; twelve direct/worker targets are legacy without an explicit origin. Standalone prewrite authority, after-barrier races and broader physical-generation/transaction boundaries remain open. Historical cleanup is preserved, with no new server/liveness claim.

Only B02:C04 and S03:C02 move unverified to partial. Original58 cards/418 criteria/status/closure remain unchanged:14verified,0failed,30partial,352unverified,22policy-held;3.35% verified lower bound and zero whole-parent closures. Partial receives no fractional credit. Earlier runtime/CI counts remain separate historical receipts. B2 remains11/50/inconclusive; no matched quality win, campaign resumption, model spending or publication follows. A future matched experiment requires independently checked executed-build identity plus its separate settings/transport/judge/workload/spending gates.

## Dataset join gate and scanner preservation — 2026-10-03

The minimal two-path benchmark fix is independently accepted and integrated at `5aa93b7b874ccb18806e13fbe62e7d3a53c0cbd9` from delivered10339f3. Existing checkpoint metadata now rejects nonempty unequal A/B datasetSha256 before report output, including R-only. Six actual guarded CLI controls cover unequal Q/R-only, equal Q/R-only and one/both missing legacy fields. Both unequal controls previously emitted REAL/exit0; now reject1/noJSON. Four compatibility stdout/stderr pairs are byte-equivalent. Six unit regressions include two before failures. Fresh integrated scripts proof records689PASS, four unchanged dataset-dependent skips, zero failures, including70B2; required-suite guard, affected types, Biome and diff checks pass. An initial unit-run PATH omission prevented Bun subprocess startup; original failures are retained, and only PATH was corrected. Actual CLI is network guarded separately; no blanket unit network guard is claimed. Formulas/pure exports/checkpoint schema remain unchanged.

This proves known A/B recorded dataset inequality only. Missing legacy/equal declarations are not actual-byte attestation. Baseline-to-treatment/model/judge/prompt/configuration identity, declared-treatment handling and the original descriptive invalid-report clause remain unproved. No valid matched score/noise win or campaign resumption follows. Build/env readiness and candidate-retirement limits in the prior section remain.

The scanner evidence join independently reads five existing native JSON/JUnit cases and seven unchanged selected current/native source hashes. Four preserve actual event/window rows through stale scanner deletion or same-path file replacement under admitted and compatibility routes. A fifth passing test intentionally observes an unfixed lower-level file-first projection collision; it does not run later cleanup or demonstrate a supported manager-generated UUID collision. Raw healthy payloads are pre-row snapshots; post-row equality comes from the passed fixture assertion. Current startLine-present deletion predicates are a narrow discriminator, not typed/imported ownership proof; a present null value also matches. No new server/native/whole-product run occurs. Historical UUID/baseline/server cleanup stays dated.

Only four evidence classifications change in this continuation: B02:C04, S03:C02, S02:C01 and B06:C06 become partial. All58 original parent rows and418 text/status/closure coordinates remain unchanged. Current split14verified,0failed,32partial,350unverified,22policy-held; verified lower bound3.35%, zero parent closures. Three evidence-only outcomes and one narrow source child are separate workstream outcomes, not criterion completion. Previous exact-head CI37116729849SUCCESS belongs to10339f3; current delivery/new CI is not asserted by this prepared report. Immutable release/npm/tag2.2.0 remains unchanged.


## Private QA capture and request bounds — 2026-10-03

Reviewed source `65835971a904a2d3146c28c0a761c71b55bfffba` adds opt-in capture through the existing
benchmark preparation and sidecar seams. The manager already forwards the
capture setting. Preflight, answer and judge invocations share a sequence;
whitelisted requests and adapted outcomes are persisted separately before and
after each call. Fresh private paths, exclusive writes, known-key redaction and
terminal capture failures protect the requested diagnostic mode. Default
providers, prediction schema, resume, logical counters and core HTTP retry
behavior are unchanged. See the [operator contract](../../benchmarks/benchmark-operating-contract.md#private-qa-diagnostic-capture).

Before implementation, the supported injected HTTP journey passed four controls
and failed the requested new durable-capture check. After implementation, all
eight controls and four escape-denial controls passed: five injected HTTP calls
produced ten private request/outcome files, including a 429 failure and the raw
adapted invalid judge response before parsing. Independent source and
privacy review accepted the four-path change. Fresh integration passed 720
scripts tests with four existing dataset skips, including 90 scoring and 24
sidecar cases; all 693 earlier cases/statuses remain, with 31 added passing cases.
Affected TypeScript, Biome, diff and required-suite guards passed. Three existing
test fixtures were completed with their already-required unreliable counters;
this did not change the runtime statistics contract.

A separate 12-case injected-request proof on base
`e59332487d82a993b2bf0939ecdb8e603370895e` verified the existing fresh one-case
HTTP bound of 3 preflight + 3 answer + 6 judge requests, permanent/transient failure
paths and redirect refusal. All 12 controls and four escape-denial controls
passed. Its lower admission caps exist only in the fixture; no new runtime
budget feature was shipped. Requested output allowance is not actual usage or
billing, and logical scoring counters are intentionally separate.

This is provider-boundary and affected offline evidence. It does not establish
actual benchmark-manager retrieval delivery, live HTTP wire behavior, missing
usage or embedding cost, a monetary cap, directory-entry power-loss durability,
or safety against hostile same-user path races. Raw diagnostic content remains
private; known-key redaction is not universal redaction. An outcome-write
failure can follow a paid call and leaves an incomplete request. No model,
benchmark campaign, live database, package publication or deployment was run.

The original 58 parents / 418 clauses and their closure states remain intact:
14 verified, 0 failed, 32 partial, 350 unverified, 22 policy-held and 0 whole-parent
closures. Technical readiness retains its frozen six gates/eighteen requirements
and 1/6 whole-gate credit. The capture repair contributes partial evidence; it
does not certify a complete gate, current quality or benchmark leadership.
The next live qualification still needs the separately chosen model/routes,
spend bound, owned target and private retention decision. Delivery/automatic CI
for the documentation commit must be observed separately; no new CI result is
claimed by this local proof.


## Primary artifact validation and local identity evidence — 2026-10-03

Reviewed source `eef9ff5b44ca65d34491360583e482171e9a3666` changes only the existing B2 reader and its tests.
Supplied scenario declarations must be unique and consistent; completed
scenarios and selected final-pass cases cannot silently overwrite each other.
Prediction row IDs and stage/verdict combinations are validated before scoring.
Declared question membership and one-case identity apply to existing selected
LongMemEval metrics; generic multiple-case scenarios remain valid. Partial
primary data, missing legacy declarations, optional R-only sidecars and earlier
measurement passes remain supported. Pure joins, formulas, complete-repeat,
minimum-count and declared dataset guards are unchanged. See the
[comparison contract](../../benchmarks/benchmark-operating-contract.md#checkpoint-sidecar-comparison).

Twelve malformed actual CLI inputs previously emitted `REAL` with exit0; all
now reject with exit1 and no JSON. Seven original valid controls and three
additional generic/repeated-pass/known-null controls preserve byte-identical
stdout/stderr. Focused tests pass87/87. Fresh integrated scripts pass737 cases,
with four unchanged dataset-dependent skips and zero failures: the prior724
case/status multiset remains, with17 added passing cases. Required scoring,
sidecar and B2 suites execute; affected types, Biome and diff checks pass.
All1299 tracked file hashes remain unchanged during checks. Initial after-test
fixture diagnostics were retained and corrected without relaxing rejection.

A separate evidence-only local probe imports the benchmark entrypoint without
running its main function, resolves selected local package exports and observes
loaded dist/runtime/settings boundaries. Its12 assertion controls, four escape
denials and three injected HTTP requests pass; six private request/outcome
files retain the synthetic effective settings. Declared setting changes reject;
namespace-only configuration changes demonstrate why raw configuration hashes
do not alone prove a changed treatment. All three selected single-file emitter
comparisons differ from existing dist, so complete build equivalence remains
UNKNOWN. This does not establish stale or semantically different code. In-memory
byte/request drift checks are fixture comparisons, not shipped prepaid guards.
The probe uses Bun1.4.2; its process.version compatibility value is v26.3.0.
It does not exercise actual manager acquisition/retrieval, a complete loaded
graph, live requests or MongoDB, and it performs no build or source edit.

Both source and evidence reviews are independently accepted. Main delivery and
its automatic CI remain separate until observed at the exact documentation
head. Published2.2.0 packages/tag and historical campaign artifacts are unchanged.
No model, benchmark campaign, live database, publication or deployment runs.
The58/418 original criteria remain14 verified,0 failed,32 partial,350 unverified,
22 policy-held and0 whole-parent closures; technical readiness remains1/6.
These two local outcomes add partial G02/G05 evidence only. Live qualification
still requires named routes/models, currency/time limits, accountable ownership,
private retention and separately verified enforcement under A01–A03. Current
quality and benchmark leadership remain unmeasured.


## QA summary correspondence — 2026-10-03

Reviewed source `d3483ba2f2579c3e690dcc00b4020ff1593dba27`, from main
`b96075608966c28f569cd33d392cf285a0d1ddb3`, adds a guard to the existing QA
summary and regressions in its colocated test. The current manager calls this
summary; a synthetic canonical sidecar write/read/summary journey demonstrated
that a foreign judged row could produce full coverage and accuracy 50/51 with
51 completed answers against 50 declared cases. Duplicate row/declaration
identity and invalid or null judged verdicts also reached metrics or export.
These findings concern corrupted/restored artifacts or supplied declarations;
the normal producer and fixed loader already emit valid verdicts and unique IDs.

The summary now rejects nonblank/unique case-ID violations and inconsistent
row key, question ID, declared membership, stage or verdict before metrics and
export, using a fixed existing error without artifact payload. It preserves
valid partial/unreliable coverage, declared orphan accounting, custom-judge
provenance, generic multiple-case scenarios and unavailable empty populations.
Storage, formulas, provider behavior, resume and export shape are unchanged.
See the [QA summary contract](../../benchmarks/benchmark-operating-contract.md#qa-summary-population).

Before the repair, six of thirteen canonical fixture cases failed the expected
rejection; all seven compatibility controls passed. Eight meaningful unit
regressions failed on the unchanged source. On the integrated source, the
canonical fixture passes 13/13 with four guard denials and zero provider calls;
the seven accepted summary values and exported bytes match the previous
behavior. Fresh scripts validation records 747 passes, four unchanged
dataset-dependent skips and zero failures, retaining all 741 previous case
statuses plus ten passing regressions. Scoring100, sidecar24 and B2-join87 all
execute; unit, required-suite guard, affected types, Biome and diff checks exit
zero. All 1,299 tracked inputs remain unchanged throughout those checks. The
unit suite itself has no network-guard claim; the canonical fixture is guarded.

This is late aggregation validation, not admission before paid work or complete
S1-G05 evidence. It executes no manager, model, live benchmark or MongoDB path.
The original roadmap remains 14/418 verified (3.35% lower bound), 32 partial,
350 unverified, 22 policy-held and zero whole-parent closures. Technical
readiness remains 1/6 (16.67%), with all six definitions and 18 acceptance texts
unchanged. Current quality and competitive leadership remain unmeasured;
historical B2 remains 11/50 and inconclusive. Main delivery and exact-head CI
are separate observations. Published npm/tag 2.2.0 retains its immutable basis.


## Quarantine diagnostic redaction and installed MCP validation — 2026-10-04

Reviewed source `af470dd23ebdace2dc200bf1d630fbb1cdfa0752` applies the existing
recognized-credential redactor to quarantine finalization and decision-audit
error messages before caller receipts and finalization audit metadata use them.
It preserves ordinary diagnostics, lifecycle outcomes, recovery flags and
admission-conflict propagation. This is new-message sanitization under the
existing pattern and partial-mask contract, not an exhaustive privacy audit.

Supported fault-injected helper journeys previously exposed synthetic URI
credentials in three cases; the same eight cases now pass, preserving all
recorded state and memory outcomes. Nine credential unit regressions fail before
repair; all 44 narrow cases and 3,560 engine cases pass afterward, retaining all
3,533 prior case statuses plus 27 new cases. Existing bridge (7), client (13), and API (30)
unit seams pass separately; they do not establish a live Mongo/HTTP incident or
complete hosted end-to-end journey. No local native server was needed or run.

Reviewed source `56c6daa5aa83b41a6906e31a0295d692b2a39df1` strengthens the package
checker after actual npm-installed broken, silent and wrong-version MCP
executables were accepted by import-only smoke. It directly launches the
installed executable, sends one stdio initialize request and requires the
installed package version in the reply, bounded by ten seconds and 1 MiB output.
The same four packed/installed fixture cases now pass. Six unit rejection cases
fail before repair; all 26 checker cases pass afterward, and scripts validation
records 754 passes, four existing dataset-dependent skips and zero failures,
retaining all 751 prior case statuses plus seven new passing cases. An actual
Bun hanging-child control rejects after 10.439 seconds despite ignoring SIGTERM.

Fresh local artifact checks pass for eight packages, including the installed
MCP command, with its network boundary guarded. Strict release freshness still
rejects the existing coordinated2.2.0 versions. Individual dependency closure
remains unproved because install smoke supplies all sibling tarballs; the bin
probe is initialization/version evidence, not full tool/API behavior. The
[publication contract](../../platform/publish.md) keeps those limits explicit.

Both source changes are independently accepted. Combined local foundation
checks pass build, monorepo types, lint, units, suite guard, eight-package
artifacts and diff validation; strict release freshness is the expected existing-
version failure. Nine fresh JUnit reports record 5,905 passes, four existing
skips and zero failures. All 1,299 tracked inputs remain unchanged during those
checks; the three subsequent documentation changes are reviewed separately.
Exact-head hosted CI remains a separate observation. These source proofs do
not certify publication, deployment, live performance or universal security. No model or benchmark campaign runs. The fixed original
58 parents/418 criteria remain 14 verified, 0 failed, 32 partial, 350 unverified,
22 policy-held and zero whole-parent closures; 3.35 percent is the evidence-mapping
lower bound, not product completion or a bug percentage. The six benchmark
gates and 18 acceptance texts retain 1/6 credit; current quality and competitive
leadership remain unmeasured.

## Wake-up profile and isolated consumer proof — 2026-10-04

Default wake-up requests disable profile entities and episodes with zero limits. The profile reader now skips those two reads and returns empty sections, avoiding an invalid aggregate limit and an unlimited episode cursor. Structured preferences, facts and activity retain their behavior, as do positive/default queries, tenant/temporal filters and source failures. MongoDB 8.2.6 with driver 7.6.0 reproduced four failures and two passing controls; the same six cases pass after repair, alongside nine profile validity, TTL, outage and wake-up cases and 48 affected units. Owned databases were removed, baseline names preserved and the server exited normally. All 268 tested engine build files match integration, allowing reuse of that exact native proof.

Eight freshly built, unmodified local tarballs were each installed in a separate clean consumer containing only the target, its declared Memongo dependency closure and explicit external peers. Every packed Memongo file matches its installed copy. Thirteen public exports import, Pi 0.83's installed host loader registers the extension, and the npm MCP executable initializes at its installed 2.2.0 version with JSON-only stdout and exits on EOF. All 33 subprocess checks and eight fixture cleanups pass. Pi's availability fetch is blocked before transport; no live API, provider or database operation is claimed. This covers Node 24.19, npm 11.17 and selected peer versions, rather than every platform or peer range. The existing package checker is unchanged; this separate proof fills its all-sibling installation gap.

At source `b696173e3b14e15f73632586c1e9ff48aebbb2eb`, 5,908 unit cases pass with four unchanged dataset-dependent skips and zero failures. The prior population remains intact with three new passing regressions. Build, types, lint, required-suite, artifact and diff checks pass; strict freshness rejects already-published 2.2.0 versions as expected. Pi retains its existing publint/attw skip for having no JavaScript entrypoint; actual host loading is separately proved. Versions and schemas are unchanged. This evidence does not establish npm publication, deployment or production certification.

All original 418 criteria remain exact. Three full mappings cover R01a:C01 and R01:C07, which overlap on the zero-limit requirement, and O01:C03. The verified lower bound rises from 14 to 17 (4.07%): 17 verified, zero failed, 31 partial, 348 unverified and 22 held, with zero parent closures. These are acceptance mappings, not three bugs or product completion. The six technical benchmark gates remain 1/6 (16.67%); old campaigns do not establish current accuracy or leadership. Other wake-up anchors/salience, wider release/live contracts, policy/retention and matched workload/settings/accounting remain open. Current main delivery and hosted CI are separate observations from this local source evidence.


## Critical memory before bounded slate selection — 2026-10-04

The active-critical query previously chose the six newest critical/high rows before applying its local salience order. An older critical todo behind eight newer high rows disappeared from both the active slate and the default wake-up bundle. Source `b6c96dfe306f0c7df8d21765be1c06d352e0c05f` changes one cursor sort to `salience: 1, updatedAt: -1` before the existing limit of six. The admitted critical/high scalar strings rank critical first; the existing scope/state/salience/updatedAt index supports this policy. Ownership, current validity, expiry, projection, other queries, defaults and stored data are unchanged.

The same owned MongoDB 8.2.6 / driver 7.6.0 probe failed the old-blocker leaf and wake-up assertions before the change (four controls passed) and passes all six after it. The blocker is first in the five-item slate and reaches the default rendered bundle within its 250-token budget; healthy `partial` remains false. Same-salience newest-first selection and the six-row bound, foreign ownership/current-validity/expiry/inactive exclusions, and healthy empty state pass. The new six-case native fixture plus nine existing profile-validity tests pass 15/15 with no skips. UUID fixtures are removed, the preexisting database baseline is preserved, the server exits normally and its port is closed. All 268 native-tested engine output hashes match the fresh integrated build; this is proof reuse at identical bytes, not another MongoDB run.

Fresh repository validation records **5,911 PASS, four unchanged SKIP, zero FAIL** across nine unit reports. All prior 5,912 testcase/status entries are retained and the three additions pass. Build, types, lint, required-suite guard, eight-package artifact validation and diff checks exit zero. Strict fixture types and the 63 affected units also pass. Installed dependencies and the unchanged lockfile are reused. Prior eight isolated package-consumer checks belong to the earlier source revision; they were not rerun here. Unchanged version 2.2.0 still prevents strict publication freshness, and no publication or deployment is attempted.

The two overlapping original coordinates R01:C02 and R01a:C03 receive scoped complete-clause evidence joins for this one repair. The fixed denominator remains **418 original acceptance criteria across 58 parents**: 19 verified satisfied (4.55% lower bound), zero failed, 31 partial, 346 unverified and 22 policy-held; zero whole parents closed. Unverified does not mean unimplemented. Frozen benchmark gates and all 18 subrequirements remain unchanged at **1/6**. No current model-quality, campaign-win or competitor-leadership claim follows.

The observed existing-index plan establishes the fixture's bounded ordering, not a production planner or speed guarantee. More than six equally critical rows still select the newest six. Arbitrary custom collation, malformed records, same-time tie stability, global slate optimality, production-scale latency and Atlas/provider behavior are outside this proof. Initial driver Map diagnostic serialization and guarded Turbo environment failures were retained and corrected without additional production changes. The native fixture uses the existing preview URI resolver and passes on the MONGODB_TEST_URI-only owned route after a setup compatibility correction; generic Docker/service execution is not claimed. Source/spec/privacy review accepts exactly three source/test paths; main delivery and hosted CI remain separate evidence surfaces.


## Same-time context neighbors — 2026-10-04

Source `5c2f197e31dd4df99bab35d29e7d177c4753a5e4` fixes a supported context-expansion loss: distinct event turns sharing the retrieved parent's exact millisecond were excluded by strict timestamp comparisons. The two-file repair orders only the already-fetched valid-Date events locally by timestamp and event ID, then admits tied neighbors around the exact returned parent. The real session-context caller invokes this reader; the proof exercises canonical event writes and the built reader directly, not a full manager/provider search. ID order is deterministic availability, not conversational chronology.

The Mongo query, timestamp sort, ownership/session/lifecycle filters, 24-hour window and 100-row fetch cap are unchanged. Neighbor window size, output cap, deduplication, 0.95 scoring, role/derivation and concurrency remain unchanged. No index, schema, writer, public API, configuration or dependency changes were made.

Local proof uses Node 24.19.0, Bun 1.4.2, MongoDB driver 7.6.0 and owned MongoDB 8.2.6. Six unit regressions failed before the fix; all 43 affected tests pass after it. The identical corrected native ten-case probe changes from four passes/six failures to ten passes/zero failures. It covers first/middle/last tied parents, mixed timestamps/window two, Unicode ID ordering, strict timestamp controls, missing-parent fallback, owner/scope/session/lifecycle exclusions, dedup/output cap and healthy empty results. Initial diagnostic phase-label/driver-Map mistakes were preserved and corrected separately; the initial native run used baseline source and built files, and the corrected before run intentionally reused the same baseline-built files before the candidate was rebuilt.

Fresh combined validation records 5,919 unit passes, 4 unchanged dataset-dependent skips and zero failures across nine fresh JUnit reports. The complete previous testcase/status multiset is retained; eight passing tests are added. Build, types, lint, unit execution guard (including the changed context-expansion suite), eight-package artifact validation and diff checks pass. Source and native-built identities are compared at integration. Artifact-only validation is not publication: unchanged 2.2.0 versions retain the previously observed strict freshness rejection.

All native UUID fixtures were removed, the preexisting database baseline preserved, guarded processes gone, and the owned server stopped with SIGTERM exit zero/port refusal. A separate 101-same-time-event fixture observes the retained limit: 100 fetched rows omit one parent, and that parent's tied neighbors remain unavailable. R04:C02 therefore changes only from unverified to partial; R04:C03 and all other original clauses remain open. Fixed full-clause mapping remains 19/418=4.55%, with 32 partial, 345 unverified, 22 held, zero verified failures and zero parent closures. Six technical gates remain 1/6=16.67%. No chronology/global tie completeness, whole-parent, hosted numeric-count, Atlas/provider, benchmark, performance, production or release claim follows.

The unchanged database sort semantics are described in [MongoDB cursor sort](https://www.mongodb.com/docs/v8.0/reference/method/cursor.sort/); local comparisons follow [ECMAScript string ordering](https://tc39.es/ecma262/multipage/abstract-operations.html#sec-islessthan). Independent source/requirements/privacy review accepts the exact two source/test paths; final shared review and normal main delivery are recorded separately.


## Minimum observed graph depth — 2026-10-04

Source `5a8334207600895623bb8826806d8e467f977961` repairs a supported cyclic-graph ranking loss. The previous collector retained the first relation observation, so a cyclic traversal could record a root's direct edge at depth two before the direct observation arrived. The existing search caller uses this depth in ranking. The six-line production change updates the existing relation map only when the next observation is shallower; direct observations take depth zero, and equal-depth observations retain their first metadata.

The graph query, ownership/lifecycle filters, directed/type identity, maximum depth, root-seed limit, output sorting and connection cap remain unchanged. Endpoint direction, scoring, telemetry and errors are preserved. No API, schema, index, writer, dependency or configuration changes were made. This is minimum **observed** depth, not a guarantee of globally shortest paths.

Local proof uses Node 24.19.0, Bun 1.4.2, MongoDB driver 7.6.0 and owned MongoDB 8.2.6. Three added unit regressions failed before the repair; all 109 affected tests pass after it. The identical corrected native nine-case probe changes from six passes/three failures to nine passes/zero failures. It exercises cycle-before-direct order, shorter transitive paths, reverse direct precedence, ranking/caps, ownership/lifecycle controls and an unchanged seed-limit residual. The initial native run also failed an unrelated control because its fixture attempted an unsupported arbitrary validTo write; that initial script/raw result is retained, and the control was corrected to the supported invalidated state before the identical decisive before/after pair. No extra product repair was made for that fixture mistake.

Fresh combined validation records 5,927 unit passes, 4 unchanged dataset-dependent skips and zero failures across nine fresh JUnit reports. The complete previous testcase/status multiset is retained with eight new passing cases. Build, root source types, lint, unit execution guard including graph/search suites, eight-package artifact validation and diff checks pass. Strict typing of the existing graph test fixture separately exits two with the same four inherited TS2339 diagnostics as the clean parent; that fixture check is not passing. Artifact-only validation is not publication: unchanged 2.2.0 versions retain the earlier observed strict freshness rejection.

Native tracked and built identities remain frozen; all tested built files match the combined build. All owned UUID fixtures were removed, the preexisting database baseline preserved, the server stopped with SIGTERM exit zero and the port refused connections. A small root-seed fixture still omits a direct root edge before traversal; the cycle then exposes that edge only at depth two. This retained counterexample prevents whole R04:C01 credit. Other graph frontier, relevance, shortest-unobserved-path, latency and production questions remain open.

Fixed full-clause evidence mapping remains 19/418=4.55%, with 33 partial, 344 unverified, 22 held, zero verified failures and zero parent closures. Six technical gates remain 1/6=16.67%. These acceptance criteria are not bugs or product completion. No whole-parent, provider/Atlas, benchmark, performance, release or hosted numeric-count claim follows. [MongoDB graphLookup](https://www.mongodb.com/docs/v8.0/reference/operator/aggregation/graphlookup/) documents unordered traversal results and depth numbering; [ECMAScript Map.set](https://tc39.es/ecma262/multipage/keyed-collections.html#sec-map.prototype.set) supports updating the existing key without changing its position. Independent source/requirements/privacy review accepts the exact two source/test paths; shared review, main delivery and current CI are recorded separately.


## Named relationship changes — 2026-10-04

Source `df230e80914965e0e9d93964f6b78bd5a42c285b` repairs a supported named discovery failure. The current local entity producer stores owner-bound opaque 16-character IDs. A request such as “what changed for Apollo” previously searched those IDs with the name regex and returned no relationship; an opaque ID substring could instead create a false relevance match. The relation lane now joins each endpoint ID to at most one owned entity matching the existing name/alias regex. Either endpoint or the existing relation-type match makes the relation relevant before the unchanged timestamp sort and result cap. Temporary join arrays are removed before evidence conversion.

Only query-bearing what-changed relationship lookup changes. Relation ownership/scope/date prefilters, current-name semantics, query escaping/token behavior, output IDs/titles, section caps, lane failure disclosure and other discovery lanes remain unchanged. Query-free requests retain the previous find/sort/limit path. No identity/hash migration, schema, index, public API, dependency, name cache, global ID list or provider change was made. Entity brief cannot substitute for a time-window change query.

The same canonical local Regex extraction and entity/alias/relation writers followed by the built native reader change from six passes/four failures to ten passes/zero failures. Controls cover source name, target name, alias, opaque-substring rejection, relation type, query-free behavior, owner/scope boundaries, missing names and future time windows. All 86 affected unit cases pass. Source and strict projection-fixture type checks pass. Initial test-fixture cast and guard-count setup attempts and their corrections are retained in the proof.

Fresh validation of both integrated repairs records 5,935 passes, 4 unchanged dataset-dependent skips and zero failures across nine JUnit reports. The complete previous graph-stage testcase/status multiset is retained with only new passing cases. Build, root source types, lint, required graph/discovery test execution guard, eight-package artifacts and diff checks pass. The graph fixture's four inherited TS2339 diagnostics remain an explicitly nonpassing separate strict check. Native tracked/built hashes and UUID/baseline/server cleanup are checked; the named-reader native build matches integration, while the earlier graph proof is reused for its unchanged reader with only the declared unrelated projection-build drift.

R04:C06 changes only from unverified to partial. Contradiction-report matching remains unfixed, endpoint names are current rather than historical snapshots, and large-graph latency/index use and broader ranking completeness are unproved. The graph root-seed residual remains. Fixed original full-clause evidence stays 19/418=4.55%, with 34 partial, 343 unverified, 22 held, zero verified failures and zero parent closures; whole technical gates stay 1/6=16.67%. These criteria are not bugs or product completion. No manager/provider, Atlas, benchmark, performance, production, publication or hosted numeric-count claim follows. [MongoDB lookup](https://www.mongodb.com/docs/v8.0/reference/operator/aggregation/lookup/) supports equality joins with an additional scoped foreign pipeline. Independent source/requirements/privacy review accepts both two-file repairs; shared review, main delivery and exact-head CI are separate evidence.


## Named contradiction relationships (October 4, 2026)

Source `b93553849dd898d3b2030e5450bce789cc1b69fb` repairs named `contradiction-report` relationship discovery. The query now joins either endpoint's owned current name or alias before the existing result sort and cap. Opaque entity-ID substrings no longer establish relevance. The existing owner/scope/ref and conflicted/invalidated-state prefilter, relation-type matching, query-free cursor and other evidence lanes retain their behavior; the previously repaired `what-changed` function is byte-identical. No schema, index, identity, API or trust-policy change. MongoDB's [version8.0 lookup syntax and equality/pipeline order](https://www.mongodb.com/docs/v8.0/reference/operator/aggregation/lookup/) supports the existing pattern.

Canonical local Regex/entity/alias/relation writers and the real MongoDB8.2.6 reader reproduce five failures: source name, target name, alias and invalidated name missing, plus opaque-ID false relevance. Identical12case logic changes7PASS5FAIL→12PASS; seven controls retain outcomes. Source/built identities, UUID removal, baseline including priorE39, commands settled, SIGTERMserver0, port free61 and three network-denial controls are verified. Focused unit19PASS6FAIL→113PASS across five suites, source/strict fixture types/build/Biome/diff/execution guard pass. An initial104PASS9FAIL runner suppressed warnings required by existing privacy tests; removing that environment override fixes the run on identical source. Raw failure is preserved; no warning-free claim.

ONE final combined foundation records 5,943 passes, four unchanged dataset skips and zero failures in nine JUnit reports; the complete prior5939case/status multiset remains with eight new passing cases. Root build/types/lint/unit/required guards/eight-package artifact checks/diff all pass. Native after-build files equal final integrated build. Independent source/requirements/privacy review accepts the two-path diff; shared review, main delivery and exact-head CI are recorded separately. Ordinary artifacts do not qualify a new published version.

The exact R04:C06 named-query clause has full bounded evidence after source and canonical evidence review: current names are not historical snapshots, and large-graph/index/latency, broad ranking, full manager/API/provider/quality, release and production claims remain unproved. Original20/418=4.78% is an acceptance-evidence lower bound, not product completion or bugs;33partial343unverified22held/zero parent closures. Whole technical gates remain1/6=16.67%. No paid calls, benchmark, Atlas, version, publication or deployment.
