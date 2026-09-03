# Memongo

MongoDB-native long-term memory for AI agents. This glossary fixes the language we use
about the system and about the claims we make for it.

## Language

### Claims

**Substrate claim**:
The assertion that Memongo's architecture is better because MongoDB is its substrate.
Proven by self-facts about MongoDB, never by a benchmark score.
_Avoid_: "because of MongoDB" used loosely, "MongoDB advantage"

**Score claim**:
The assertion that Memongo is the best memory framework, earned only by beating
competitors on LongMemEval under identical methodology. Independent of the substrate claim.
_Avoid_: "best in the world" without the methodology qualifier

**Self-fact**:
A verifiable property of MongoDB or of Memongo that stays true regardless of what
competitors ship. The only permitted evidence for the substrate claim.
_Avoid_: differentiator, advantage

**Competitor-fact**:
A property of another system. Rots without re-auditing, so it may provide context but
never load-bearing evidence for a claim.
_Avoid_: competitive moat

### Retrieval

**Lane**:
One scoring path within a single search — vector, text, or graph. Lanes are fused, not
chosen between.
_Avoid_: channel, strategy, branch

### Guardrails

**Silent-failure tripwire**:
A startup check that makes a configuration which would silently degrade or expose the
system fail loudly instead. Adapted from `mongodb-partners/agent-memory` patterns.
_Avoid_: validation, health check, smoke test

**Dimension consistency check (G1)**:
Startup assertion that `queryEmbeddingModel` dimensions match the autoEmbed index model
dimensions. Prevents silent empty `$vectorSearch` results from model mismatch.

**Model migration refusal (G2)**:
Startup preflight that refuses to proceed when an existing autoEmbed index has a different
model than the one about to be deployed, protecting against expensive surprise re-embeds.
Override: `MEMONGO_ALLOW_EMBEDDING_MODEL_CHANGE=true`.

**Routable-bind refusal (G3)**:
Startup check that refuses to bind a non-loopback address with authentication disabled.
Two-layer override: `MEMONGO_ALLOW_INSECURE_NO_AUTH=true` (loopback) and
`MEMONGO_ALLOW_INSECURE_REMOTE=true` (non-loopback, both required).

**Supported-target contract (embedding pipeline)**:
The declared, versioned posture of the embedding pipeline
(`EMBEDDING_PIPELINE_SUPPORT` in backend-config.ts): Atlas Automated Embeddings
only, Preview stage knowingly accepted, on `atlas-local-preview` or
`atlas-managed`, with `embeddingMode "automated"` as the only mode and no
client-side fallback existing or implied. A Preview deprecation surfaces as a
loud startup failure, never as a silent client-side detour.
_Avoid_: client fallback, embedding provider, calling the pipeline generally available
