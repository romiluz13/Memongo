# The autoEmbed Preview posture is a supported-target contract

The embedding pipeline declares its MongoDB Preview dependency as an explicit,
versioned supported-target contract (automated embeddings only, on the two
deployment profiles that knowingly accept Preview semantics, with no
client-side fallback), the autoEmbed model literal has exactly one production
source, and the dead client-side provider stack is deleted rather than
quarantined — a Preview deprecation surfaces as a loud failure, never as a
silent detour or a stranded default.

## Context

DDD workstream WS-04 covers C-007 from the GLM-5.3 remediation program's
embedding-pipeline review (EL-002). The entire vector pipeline runs on Atlas
Automated Embeddings — a MongoDB Preview feature — and the review found three
exposures stacked on top of each other. The posture was implicit: nothing in
the configuration stated what is supported, so a Preview change would surface
as a warn-and-continue note or a confusing downstream failure. The
`voyage-4-large` model literal was duplicated across nine fallback sites plus
configuration defaults, so a model change had to be hunted site-by-site, and
any missed site would silently strand a query-side default against the index's
actual embedding. And a ~1,312-line client-side provider stack (voyage,
gemini, ollama, openai, mistral, and remote providers, plus vectors,
normalize, and debug modules — 12 source files and 7 test files) was
unreachable dead code whose existence implied a fallback capability that does
not exist.

Adversarial refutation reshaped the validation, not the design. Round 1
returned partially_refuted: all three obligations were discharged in tree,
but one mandated vacuity mutation escaped — reverting
`DEFAULT_QUERY_EMBEDDING_MODEL` to a hardcoded typed literal
(`const X: SomeType = "voyage-4-large"`) passed the full focused battery,
because the centralization pin test's const-keyword regex could not match
type-annotated declarations. The pattern was broadened to forbid any
`= "voyage-4-large"` assignment or declaration (a `(?<![=!])` lookbehind
excludes the allow-list's `===` comparisons), and round 2 sustained the
claim: all four mandated vacuity mutations caught (including the escaped one
re-run verbatim, failing with the pin naming the file), new mutation shapes
in other files caught, the production funnel traced end-to-end
(memory-bridge → `getMemorySearchManager` → `resolveMemoryBackendConfig` →
the assertion), a sentinel model spike producing 98 loud failures (78
config-resolution throws plus every pin), zero residual references to the
deleted family with repo check-types 15/15 and build 11/11 green, and no
missed sites.

## Considered Options

- **Declare the supported-target contract — chosen.**
  `EMBEDDING_PIPELINE_SUPPORT` (contractVersion 1) declares `embeddingMode:
  "automated"` as the only supported mode, `deploymentProfiles:
  ["atlas-local-preview", "atlas-managed"]` (the local container stack and
  Atlas clusters — the two profiles that knowingly accept Preview semantics),
  `featureStage: "preview-accepted"`, and `clientSideFallback: "none"`.
  `assertEmbeddingPipelineSupport` cross-checks the resolved
  (deploymentProfile, embeddingMode) pair inside `resolveMemoryBackendConfig`
  on the single production funnel, so the declaration and the resolver cannot
  drift apart silently, and an out-of-contract configuration fails loudly at
  startup with a message naming the supported targets.
- **Implement a client-side embedding fallback — rejected.** A fallback needs
  a provider, credentials, and a dimension/quota story, and it re-legitimizes
  the dead stack the claim exists to remove; worse, client- and server-side
  embeddings in the same collection would mix two vector spaces behind one
  index. The Preview risk is better spent loudly: under the contract, a
  retirement is a clear, named failure — not a silent quality degradation
  onto a second embedding path.
- **A documented warn-and-continue posture note — rejected.** A note changes
  no behavior and cannot fail; the contract turns posture drift into a
  startup throw.
- **Centralize the model literal in the autoEmbed index definitions module —
  chosen.** `INDEX_AUTOEMBED_MODEL` lives beside the index definitions it
  pins, because the model is a property of the index, not of the config.
  Every former fallback site imports it (search, search-v2, manager
  lifecycle, kb, sync, consolidator ×3, novelty, the backend-config default
  and the F22 dimensions warning, and the benchmark parity envelope via
  re-export). `embedding-model-single-source.test.ts` scans every production
  `.ts` file for three forbidden literal forms — nullish defaults, stage
  properties, and any assignment or declaration of the bare literal — and
  anchors the source of truth by equality.
- **Centralize in backend-config — rejected.** The config already imports
  from the definitions module for index creation; anchoring the literal in
  config would add a second direction of dependency for no gain.
- **Quarantine the dead provider stack — rejected.** Quarantine keeps the
  compile surface, the test surface, and the implication of a fallback path
  alive behind a flag. The stack had zero live importers; deletion (19 files,
  3,192 lines: 1,312 production + 1,880 test) with the refuter verifying zero
  residual references anywhere in the repository is strictly simpler.
- **Keep the stack for a future fallback — rejected.** Same liability as
  quarantine without even the flag; the contract explicitly declares that no
  client-side fallback exists, making the stack's premise false.

## Consequences

- **A Preview retirement is loud and named.** Config resolution (or index
  creation / search, for an in-place Atlas change) throws with the contract
  message naming the supported profiles; there is no code path that silently
  degrades to a client-side embedding.
- **Model changes propagate from one point.** Changing
  `INDEX_AUTOEMBED_MODEL` updates every default that derives from it; the
  refuter's sentinel spike (98 failures across 8 files) shows any stranding
  is caught by pins before it can reach users.
- **The pin test is the sole static gate against literal reintroduction.**
  Its round-1 blind spot for typed declarations is closed by the
  any-assignment pattern; deliberate obfuscation (split string literals,
  backticks) still evades the regex but dies at drift time on the equality
  anchors — a documented, accepted residual. The benchmark envelope's default
  is derived and its test pins the derivation, not the value.
- **Scan boundary is explicit.** The pin test scans engine `src` only; the
  e2e-only `preview-env` test helper keeps a deliberate literal outside the
  boundary (it fakes the Preview environment itself).
- **Kept modules are the minimal live surface.** `embedding-inputs`,
  `embedding-input-limits` (byte estimation on the write path),
  `embedding-validation`, and `mongodb-embedding-retry` survive with live
  importers; everything else in the family was dead.
- **Negative knowledge and accepted observations.** The vestigial
  analytics `"client"` measurement branch is unreachable from production (the
  manager always passes the resolved automated-only mode) and embeds
  nothing — left as-is, out of scope. Stale generated `droid-wiki/` docs
  still describe the deleted stack until regenerated (untracked). The
  contract assertion is structurally unreachable from raw input because the
  input validators reject invalid profiles and modes first; it is a
  declaration↔resolver drift lock, which is its job.
- **Post-refutation hardening, recorded for honesty.** After round 2
  sustained, the benchmark parity test was strengthened from a value pin to a
  derivation pin (`toBe(BENCHMARK_AUTOEMBED_MODEL)`, per the refuter's
  recommendation). The first cut referenced the re-export alias inside the
  module body — an `export { X as Y }` alias creates no local binding, a
  ReferenceError the hardened battery caught immediately — and was fixed to
  reference the imported binding directly (37/37 green,
  `.ddd/reports/runs/ws04-benchmark-hardening.log`). This delta is outside
  the claim's constructs; the refuted engine tree is byte-identical to the
  attested state.
