# Substrate claim and score claim are separate, with separate proofs

We make two distinct public claims about Memongo and they may never share evidence.
The **substrate claim** ("this architecture is better because MongoDB is the substrate")
is proven only by self-facts — verifiable properties of MongoDB and of our own code.
The **score claim** ("best memory framework") is proven only by beating competitors on
LongMemEval under identical methodology, per spec #64.

We split them because 74.6% of LongMemEval failures are reading failures — reasoning over
evidence already retrieved — which the substrate has no hand in. Binding the substrate
claim to the score would make MongoDB answerable for a reader-side problem, and a
disappointing score would discredit an architecture that had nothing to do with it.

## Considered Options

- **Bind them** — only claim "because of MongoDB" where a MongoDB-native capability earned
  benchmark points. Rejected as too strict: most of our native capabilities are operational
  wins, not accuracy wins, so this would leave almost nothing sayable.
- **Substrate claim as headline** — rejected because it reverses spec #64's priority.

## Consequences

The substrate claim is scoped to **self-facts only** — properties of MongoDB and of our own
code, never claims about competitors. Competitor-facts rot the moment someone ships a
feature, and we were already burned once: the "competitors need five bolt-on datastores"
claim was believed provable and turned out to be false.

Concretely this means:

- `autoEmbed` is claimable, with "Public Preview" stated alongside it.
- `$graphLookup` is claimable for **traversal only**. Typed edges come from an LLM
  (`mongodb-graph.ts:1842`), not from MongoDB, and degrade to `mentioned_with@0.2`
  co-occurrence when no enrichment provider is configured.
- Native `$scoreFusion` is the preferred hybrid-fusion path after a controlled
  August 2026 comparison against `$rankFusion` and `js-merge`. The client-side
  `js-merge` implementation remains a fallback and diagnostic path, not the
  preferred architecture. This is a Memongo benchmark decision, not a universal
  claim that `$scoreFusion` improves every workload.
- MongoDB's published reranking figures (+23.84% over full-text, +10.82% over vector) are
  MongoDB's numbers on MongoDB's benchmark. They are never cited as ours.
