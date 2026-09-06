# MongoDB Node.js Driver — Modify Documents (captured sections)

- source: https://www.mongodb.com/docs/drivers/node/current/fundamentals/crud/write-operations/modify/
  (current driver docs; the repo's resolved driver is the v7 line per
  bun.lock — the modify semantics are stable across it)
- accessed: 2026-09-06 (Wave 1a grounding + compare phase, W01)
- capture scope: the updateOne behavior contract relied on for W01;
  verbatim quotes.

## Update Documents

> To perform an update to one or more documents, create an update document
> that specifies the update operator (the type of update to perform) and
> the fields and values that describe the change.

> $set: replaces the value of a field with a specified one

## updateOne

> // Update the first document that matches the filter
> const result = await movies.updateOne(filter, updateDoc, options);

> If an update operation fails to match any documents in a collection, it
> does not make any changes.

## Application to W01 (analysis, not doc text)

The production AccessTracker flush uses driver `bulkWrite` with
`updateOne` ops `{filter, update: {$inc: {accessCount}, $set:
{lastAccessedAt}}}` (unordered). The driver-level semantics mirror the
manual: first-match selection and silent no-op on zero matches. The filter
exactness obligation is therefore on the caller — the fix supplies every
member of each collection's unique compound index in the filter.
