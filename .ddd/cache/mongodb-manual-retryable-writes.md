# MongoDB Manual — Retryable Writes (captured sections)

- source: https://www.mongodb.com/docs/manual/core/retryable-writes/
- accessed: 2026-09-06 (Wave 2a grounding, W09 insert/retry reconciliation)
- capture scope: what retries, how many times, and the NoWritesPerformed
  tri-state; verbatim quotes.

## Definition

> Retryable writes let drivers retry specific write operations once after
> network errors or if they cannot find a healthy primary in the replica
> set or sharded cluster.

## Retryable Write Operations

> MongoDB retries the following operations if they have acknowledged write
> concern …: db.collection.insertOne(), db.collection.insertMany() —
> Inserts; … db.collection.bulkWrite() with … insertOne, updateOne,
> replaceOne, deleteOne — bulk write operations that only consist of the
> single-document write operations.

(insertMany with explicit `_id`s is exactly this class in the Node driver.)

## Persistent Network Errors

> By default, MongoDB retries writes **once**. One retry attempts to address
> transient network errors and replica set elections, but not persistent
> network errors.
>
> If you set `timeoutMS`, MongoDB may retry writes multiple times.

## Failover warning (duplicate-apply risk)

> If a client is unresponsive for longer than
> `localLogicalSessionTimeoutMinutes`, the write might retry and apply again
> when the client recovers.

## Error Handling — the NoWritesPerformed tri-state

> Starting in MongoDB 6.1, if both the first and second attempt of a
> retryable write fail without a single write being performed, MongoDB
> returns an error with the `NoWritesPerformed` label.
>
> | Outcome | MongoDB Output |
> | No documents are inserted. | Error returned with `NoWritesPerformed`
> label. |
> | Partial work done. (At least one document is inserted, but not all.) |
> | Error returned without `NoWritesPerformed` label. |
> | All documents are inserted. | Success returned. |
>
> Applications can use the `NoWritesPerformed` label to definitively
> determine that no documents were inserted. This error reporting lets the
> application maintain an accurate state of the database when handling
> retryable writes.

## Wave-2a reliance

W09 reconciliation uses this tri-state: an error WITHOUT `NoWritesPerformed`
means partial-or-full work persisted (unknown which items) — the driver
error's per-item payload plus the caller's stable `_id`s decide item-level
outcomes; an error WITH the label guarantees zero inserts, so a caller-side
retry is safe without duplicate risk from this attempt.
