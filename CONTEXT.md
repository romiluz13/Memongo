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
