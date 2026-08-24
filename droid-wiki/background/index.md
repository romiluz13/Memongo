# Background

Active contributors: Rom Iluz

Memongo's design record is small and deliberate: one architecture decision
record governs how the project is allowed to talk about itself, and one
benchmark run stands as the evidence base (and the cautionary tale) behind
the release-gate discipline described in
`docs/platform/PRODUCTION-READY.md` and summarized in
[Deployment](../deployment.md).

## The substrate claim / score claim split

`docs/adr/0001-substrate-claim-and-score-claim-are-separate.md` is the
project's only ADR, and it is load-bearing for everything the project is
allowed to publicly claim.

Memongo makes two separate claims, and they may never share evidence:

- The **substrate claim** ("this architecture is better because MongoDB is
  the substrate") is proven only by **self-facts** — verifiable properties
  of MongoDB and of Memongo's own code.
- The **score claim** ("best memory framework") is proven only by beating
  competitors on LongMemEval under identical methodology, per spec #64.

The ADR's reasoning for splitting them: 74.6% of LongMemEval failures are
reading failures — reasoning over evidence already retrieved — which the
retrieval substrate has no hand in. Binding the substrate claim to the score
would make MongoDB answerable for a reader-side problem, and a disappointing
score would discredit an architecture that had nothing to do with it.

Two options were considered and rejected:

- **Bind them** — only claim "because of MongoDB" where a MongoDB-native
  capability earned benchmark points. Rejected as too strict: most native
  capabilities are operational wins, not accuracy wins, so this would leave
  almost nothing sayable.
- **Substrate claim as headline** — rejected because it reverses spec #64's
  priority (the score claim leads).

The substrate claim is scoped to self-facts only, never claims about
competitors, because competitor-facts rot the moment someone ships a
feature. The project cites one specific prior burn: a claim that
"competitors need five bolt-on datastores" was believed provable and turned
out to be false.

Concrete examples the ADR gives for what counts as a legitimate self-fact
claim:

- `autoEmbed` is claimable, but only with "Public Preview" stated alongside
  it — it is an upstream MongoDB preview feature, not a shipped guarantee.
- `$graphLookup` is claimable for **traversal only**. Typed edges come from
  an LLM (`packages/memory-engine/src/mongodb-graph.ts:1842`), not from
  MongoDB itself, and degrade to `mentioned_with@0.2` co-occurrence edges
  when no enrichment provider is configured. The database executes the
  traversal; it does not manufacture the semantics of the edges.
- Native `$scoreFusion` is the preferred hybrid-fusion path after a
  controlled August 2026 comparison against `$rankFusion` and the
  client-side `js-merge` fallback. This is explicitly called out as a
  **Memongo benchmark decision**, not a universal claim that `$scoreFusion`
  improves every workload — `js-merge` remains a supported fallback and
  diagnostic path, not a deprecated one.
- MongoDB's own published reranking figures (+23.84% over full-text,
  +10.82% over vector) are MongoDB's numbers on MongoDB's benchmark and are
  never cited as Memongo's.

See [Glossary](../overview/glossary.md) for the full claims/lane vocabulary this ADR
established (substrate claim, score claim, self-fact, competitor-fact) —
it is not repeated here.

## The benchmark result and why it was still gated

The root `README.md` Benchmarks section and `docs/benchmarks/BENCHMARKS.md`
report a complete 500-question LongMemEval retrieval run:

| Metric | Result |
|---|---:|
| Official session RecallAny@10 | 98.57% |
| Official session RecallAll@10 | 94.75% |
| Internal R@5 | 93.15% |
| Internal R@10 | 97.16% |
| Internal hit rate | 98.94% |

The run used MongoDB-native `$scoreFusion`, Voyage 4 Large query embeddings,
Voyage `rerank-2.5`, and no generative LLM enrichment. These are retrieval
metrics, not generated-answer accuracy — a deliberate scope limit, since
Mem0 and Zep publish generated-answer accuracy, Supermemory publishes a
differently aggregated Recall@15, and Letta's public 74.0% figure is on a
different benchmark (LoCoMo) entirely. None of those numbers are an
apples-to-apples comparison with Memongo's retrieval-only result, which is
why the README states that explicitly rather than juxtaposing the numbers.

Despite a 98.57% headline recall number, the registered release contract
classified the run as **not publishable**, because its 1,244 ms p95 latency
exceeded the 1,000 ms gate, and build, cost, and native-operation evidence
was incomplete. This is the project's clearest lesson in its own discipline:
a strong accuracy number does not override a failed operational gate, and
the project's benchmark rules — no question-ID tuning, no hidden fallback,
retrieval recall and judged answer quality reported separately, no broad
ecosystem-leadership claim from one benchmark family — are enforced even
against a result the team would otherwise want to publish.

## The release-gate checklist

`docs/platform/PRODUCTION-READY.md` defines six release-blocking lanes that
must all be green before npm publish, release tags, or public
production-ready claims: `repo-foundation`, `api-contract`,
`package-publishability`, `live-core`, `live-capability`, and `real-agent`.
The checklist is strict by design and calls out its own limits explicitly:
passing these gates does not certify hosting SLAs, backups, monitoring, or
org security review, and a green auto-embed capability lane proves preview
behavior only — it cannot certify a production release, because MongoDB
Automated Embedding is itself an upstream preview feature.

The same discipline that produced the "not publishable" benchmark
classification shows up here: the checklist refuses to let a passing test
lane stand in for a claim it doesn't actually support (for example,
treating a preview connection string as proof for replica-set-only features
it never exercised).
