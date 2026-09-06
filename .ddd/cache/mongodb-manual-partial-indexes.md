# MongoDB Manual — Partial Indexes (captured sections)

- source: https://www.mongodb.com/docs/manual/core/index-partial/
- accessed: 2026-09-06 (Wave 1b grounding + compare, W12 TTL backstop)
- capture scope: the partialFilterExpression operator contract and partial
  TTL behavior relied on for the quarantine TTL widening; verbatim quotes.

## Create a Partial Index

> The partialFilterExpression option accepts a document that specifies the
> filter condition using:
> - equality expressions
> - $exists: true expression
> - $gt, $gte, $lt, $lte expressions
> - $type expressions
> - $and operator
> - $or operator
> - $in operator

## Partial TTL Indexes

> Partial indexes can also be TTL indexes. Partial TTL indexes match the
> specified filter expression and expire only those documents.

## Restrictions (relevant excerpt)

> - You cannot specify both the partialFilterExpression option and the
>   sparse option.
> - _id indexes cannot be partial indexes.

## Application to W12 (analysis, not doc text)

The quarantine pending-review TTL index widens its partial filter to
`{status: {$in: ["pending-review", "promoting"]}}` so an abandoned promote
claim (crash between the leased claim and the finalize) cannot outlive the
backstop. $in is an officially accepted partialFilterExpression operator;
the same index name with different options is an IndexOptionsConflict, so
the schema migration drops the old index first (the established
dropIndex/createIndex pattern in the same schema module). Live-verified on
the local 8.3.8 server: createIndex with the $in partial TTL filter
succeeded (ddd_w1b_idxcheck disposable database, dropped after the check).
