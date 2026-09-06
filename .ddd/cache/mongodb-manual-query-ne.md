# MongoDB Manual — $ne query operator (captured sections)

- source: https://www.mongodb.com/docs/manual/reference/operator/query/ne/
- accessed: 2026-09-06 (Wave 2c grounding — W11 canonical exactly-once guard:
  filter-side conditional application for legacy documents and already-applied
  batches)
- capture scope: the definition and array/scalar semantics of `$ne`; verbatim
  quotes.

## Definition

> `$ne` selects documents where the value of the field is not equal to the
> specified value. This includes documents that do not contain the field.

## Arrays — scalar comparison

> **Scalar comparison**: `$ne` matches documents where the scalar value is
> not present as an element in the array, including documents that don't
> have the field.

## Update filter example (page's own update usage)

> The `updateMany()` operation searches for an embedded document, `imdb`,
> with a subfield named `rating`. It uses `$set` to update the
> `highestRated` field to `false` in each document where the value of
> `rating` is not equal to `9.3` or where the `rating` subfield does not
> exist.

## Application to W11 (analysis, not doc text)

The canonical dedupe guard is filter-side, not pipeline-side: each bulkWrite
updateOne op carries
`filter = { <canonical compound identity>, appliedBatches: { $ne: batchId } }`.
Per the scalar-comparison rule this matches (a) legacy documents with no
`appliedBatches` field ("including documents that don't have the field") and
(b) documents whose appliedBatches came from other batches; it does NOT
match a document that already applied this exact batchId. A no-match update
changes nothing, so a replayed flush after partial failure applies each
canonical increment exactly once without any read-before-write on the
canonical side. This keeps the classic `$inc`/`$set`/`$push` update operator
shape (single round trip, per-document atomic) and needs no aggregation
pipeline update.
