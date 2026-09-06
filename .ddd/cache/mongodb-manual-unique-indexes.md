# MongoDB Manual — Unique Indexes (captured sections)

- source: https://www.mongodb.com/docs/manual/core/index-unique/
- accessed: 2026-09-06 (Wave 1a grounding, W01)
- capture scope: the contract sections relied on for W01; verbatim quotes.

## Unique Indexes

> A unique index ensures that the indexed fields do not store duplicate
> values; i.e. it enforces uniqueness for the indexed fields.

> A unique compound index ensures that any given combination of the index
> values appears at most once.

## Application to W01 (analysis, not doc text)

The identity of a row in a collection whose uniqueness is enforced by a
unique compound index IS the full combination of index values — not any
single member. memongo's schema (mongodb-schema-standard-indexes-core.ts /
-graph.ts / -operations.ts) declares:

- uq_structured_agent_scope_scoperef_type_key: {agentId, scope, scopeRef, type, key}
- uq_procedures_identity: {procedureId, agentId, scope, scopeRef}
- uq_entities_entityid_agent_scope_scoperef: {entityId, agentId, scope, scopeRef}
- uq_relations_identity: {agentId, scope, scopeRef, fromEntityId, toEntityId, type}
- uq_events_eventid: {eventId}
- uq_episodes_episodeid: {episodeId}

Therefore a canonical access update filtered on `key` (or any single field)
does not identify a row: the same `key` legitimately exists across agents,
scopes, scopeRefs, and types. The W01 fix filters on the full compound.
