# MongoDB Manual — Time Series Indexes (captured sections)

- source: https://www.mongodb.com/docs/manual/core/timeseries/timeseries-index/
- accessed: 2026-09-06 (Wave 2c grounding — W11 access-tracker dedupe: what
  index shapes are legal on the access_events time-series collection)
- capture scope: the secondary-index and prohibited-index contract relied on
  for W11; verbatim quotes.

## Secondary indexes on any field

> Starting in version 6.0, you can add a secondary index to any field in a
> time series collection.

And the performance tip on the same page:

> To improve query performance, you can manually add secondary indexes to
> any field in your time series collection.

## Prohibited Indexes

> MongoDB does not allow the following index types on time series
> collections:
>
> - Text indexes
> - 2d indexes
> - Unique indexes
>
> You cannot create sparse indexes on the metaField.

## Compound Indexes (6.3+)

> Starting in MongoDB 6.3, MongoDB creates a default compound index on both
> the metaField and timeField of a time series collection. [...]
> You can add a compound index on the `timeField`, `metaField`, or
> measurement fields.

## Application to W11 (analysis, not doc text)

The W11 fix needs (a) a non-unique secondary index on the new `batchId`
measurement field of access_events to serve the read-reconcile lookup, and
(b) certainty that no unique constraint can enforce raw-event dedupe. (a) is
explicitly allowed on any field from 6.0 (local stack is 8.3.8). (b) is the
prohibited list: unique indexes are not allowed on time-series collections,
so raw-event exactly-once cannot be index-enforced and must be read-reconcile
(query by batchId before insert) — which is why the fix pairs the guard with
a canonical-side idempotency record instead of relying on the raw layer.
