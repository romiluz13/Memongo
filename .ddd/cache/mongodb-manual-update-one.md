# MongoDB Manual — db.collection.updateOne() (captured sections)

- source: https://www.mongodb.com/docs/manual/reference/method/db.collection.updateOne/
- accessed: 2026-09-06 (Wave 1a grounding, W01)
- capture scope: the filter-semantics contract relied on for W01; verbatim
  quotes.

## Behavior

> db.collection.updateOne() finds the first document that matches the
> filter and applies the specified update modifications.

> Even though multiple documents may match the filter, updateOne() only
> modifies the first document it finds.

(Which document is "first" is unspecified without a deterministic sort; in
a shared collection a non-unique filter can therefore update any tenant's
row — this is the wrong-owner hazard the audit reproduced.)

> If the update operation fails to match any documents in the collection,
> it does not make any changes.

## Application to W01 (analysis, not doc text)

- A `{key: ...}`-only filter in structured_mem can match another agent's
  row: "the first document that matches" is not necessarily the caller's.
- An update that matches nothing silently changes nothing: the pre-fix
  relation/procedure/structured canonicalId slicing produced filters that
  matched zero documents (silent reinforcement no-op).
- The fix makes filters exact (full unique compound) so exactly one row can
  match, and treats "matches nothing" as the explicit fail-safe for
  under-specified identities (skipped + warned, raw access event kept).
