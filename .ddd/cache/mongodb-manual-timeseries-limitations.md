# MongoDB Manual — Time Series Collection Limitations (captured sections)

- source: https://www.mongodb.com/docs/manual/core/timeseries/timeseries-limitations/
- accessed: 2026-09-06 (Wave 2c grounding — W11 access-tracker dedupe: which
  cross-collection atomicity and identity mechanisms are unavailable for a
  flush that writes access_events plus canonical collections)
- capture scope: the transactions, default-index, unique-index, and update
  restrictions relied on for W11; verbatim quotes.

## Transactions

> You cannot write to time series collections in transactions.
>
> Note: MongoDB supports reads from time series collections in transactions.

## Indexes — Default Index

> MongoDB does not create an index on the `_id` field when you create a time
> series collection. This differs from regular collections which have an
> index on the `_id` field by default. Commands that specify a hint on the
> `_id` field on time series collections return an error unless you manually
> create an index on the `_id` field.

## Indexes — unsupported index types

> MongoDB doesn't support the following index types on time series
> collections:
>
> - Text indexes
> - Unique indexes

## Updates

> Update commands must meet the following requirements:
>
> - You can only match on the `metaField` field value.
> - You can only modify the `metaField` field value.
> - Your update document can only contain update operator expressions.
> - Your update command must not limit the number of documents to be
>   updated. Set `multi: true` or use the `updateMany()` method.
> - Your update command must not set `upsert: true.`

## Unsupported Features (context)

> MongoDB does not support the following features with time series
> collections: MongoDB Search; Change streams; [...] Schema validation
> rules; [...]

## Application to W11 (analysis, not doc text)

The tracker's flush writes raw events to the access_events time-series
collection and canonical `$inc` updates to six regular collections. Because
"You cannot write to time series collections in transactions", the flush
cannot be made atomic across the raw and canonical layers — the two-phase
design is forced, and the fix must make each phase independently
idempotent instead of jointly atomic. No `_id` index and no unique indexes
mean raw inserts cannot be keyed or constraint-deduplicated; combined with
EL-027 this forces the read-reconcile-by-batchId shape. The update
restrictions do not apply to the fix: the tracker's access_events path is
insert-only (the canonical guard lives on the regular collections, not on
access_events). "Schema validation rules" unsupported also reconfirms the
Wave 1a observation that canonical-side validators are the only validation
surface, and that tracker-owned denormalized fields (accessCount,
lastAccessedAt, and the new appliedBatches) live outside declared schema
properties by house precedent.
