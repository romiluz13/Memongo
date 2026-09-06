# MongoDB Manual — db.collection.updateMany() (captured sections)

- source: https://www.mongodb.com/docs/manual/reference/method/db.collection.updateMany/
- accessed: 2026-09-06 (Wave 1c grounding + compare, W18 dead-letter sweep)
- capture scope: the multi-document update semantics relied on for the
  dead-letter sweep; verbatim quotes.

## Definition

> Updates all documents that match the specified filter for a collection.

## Returns

The method returns a document that contains:

> A boolean `acknowledged` as `true` if the operation ran with write concern
> or `false` if write concern was disabled
>
> `matchedCount` containing the number of matched documents
>
> `modifiedCount` containing the number of modified documents
>
> `upsertedId` containing the `_id` for the upserted document
>
> `upsertedCount` containing the number of upserted documents

## Behavior

> `updateMany()` modifies each document individually. Each document write is
> an atomic operation, but `updateMany()` as a whole is _not_ atomic. If your
> use case requires atomicity of writes to multiple documents, use
> Transactions.

> If a single document update fails, all document updates written before the
> failure are retained, but any remaining matching documents are _not_
> updated.

## Limitations

> `updateMany()` should only be used for idempotent operations.

## Idempotent Updates

> If the operation fails to update all matched documents, you can safely
> rerun an idempotent command until no additional documents match the
> specified filter. In this case, each document's `imdb.rating` field is only
> updated one time regardless of how many times it is retried because the
> command is idempotent.

## writeConcern option (Syntax → Parameters)

> A document expressing the write concern. Omit to use the default write
> concern.

## Application to W18 (analysis, not doc text)

The dead-letter sweep is an updateMany over running rows whose retry budget
is spent and whose lease expired (or was never set): $set status failed +
deadLetterAt + error, $unset the lease/completedAt/retryAt fields. It
satisfies the page's own idempotency requirement by construction — a
transitioned row leaves the `running` state, so a re-run matches nothing
(modifiedCount 0, live-verified in the w1c probe) — and per-document
determinism makes the not-atomic-as-a-whole residual harmless: each row's
transition is independent, and the partial-failure rule ("updates written
before the failure are retained") leaves exactly the rows a re-run would
sweep. The sweep passes the majority write concern, which the page
documents as an explicit option.
