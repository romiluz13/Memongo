# Silent-failure tripwires adapted from agent-memory

We added three startup guardrails that make existing silent failures fail loudly. Each is a
tripwire that refuses to start (or refuses to bind) when a configuration would silently
degrade or expose the system. The patterns are adapted from `mongodb-partners/agent-memory`,
a battle-tested Python framework, and ported to TypeScript with adjustments for Memongo's
autoEmbed architecture.

## Context

agent-memory prevents three classes of silent failure that Memongo was vulnerable to:

1. **Dimension mismatch** — query embedding model produces vectors in a different dimension
   space than the index model. `$vectorSearch` silently returns nothing — no error, no
   visible symptom, recall goes empty.
2. **Model migration** — changing the autoEmbed index model triggers a full server-side
   re-embed of every document, consuming embedding API calls, billing, and a rebuild
   window. An operator changing the hardcoded model literal may not realize the blast
   radius.
3. **Routable bind without auth** — binding to `0.0.0.0` with authentication disabled
   exposes every user's memories to any network-reachable client. The Docker default was
   exactly this posture.

## Considered Options

- **Log and continue** — rejected. Logs are ignorable; a silent recall failure or open
  port is not recoverable after the fact.
- **Config validation only** — rejected. Config can be correct at write time and drift
  later (e.g., index model changed in the database while code still has the old literal).
- **Startup refusal with override** — chosen. The system refuses to start, forcing the
  operator to acknowledge the risk. Each guardrail has an env-var escape hatch for
  operators who intentionally accept the risk.

## Consequences

- **Docker breaking change**: existing deployments binding `0.0.0.0` without auth will
  refuse to start. Operators must set `MEMONGO_API_KEY`, bind to `127.0.0.1`, or set both
  `MEMONGO_ALLOW_INSECURE_NO_AUTH=true` and `MEMONGO_ALLOW_INSECURE_REMOTE=true`.
- **Guardrail 2 is a blast-radius tripwire, not data-loss prevention**: MongoDB autoEmbed
  re-embeds documents server-side on model change (unlike client-side embedding where
  vectors are stranded forever). The guardrail prevents surprise re-embed cost, not
  permanent data loss.
- **Single-sourced model constant**: `INDEX_AUTOEMBED_MODEL` is exported from
  `mongodb-schema-search-definitions.ts` and used in both the index definition and the
  guardrail comparison, preventing drift.
