# MongoDB Manual — Write Concern (captured sections)

- source: https://www.mongodb.com/docs/manual/reference/write-concern/
- accessed: 2026-09-06 (Wave 2a grounding, W09 write-concern-error
  classification)
- capture scope: what a write concern error means for data durability;
  verbatim quotes.

## wtimeout (the load-bearing section)

> This option specifies a time limit, in milliseconds, for a write
> operation to propagate to enough members to achieve the write concern
> after the operation succeeds on the primary. … If the write operation
> does not achieve the write concern within this time limit, MongoDB
> returns a write concern error.
>
> `wtimeout` causes write operations to return with a write concern error
> after the specified limit, even if the required write concern will
> eventually succeed. When these write operations return, MongoDB **does
> not** undo successful data modifications performed before the write
> concern exceeded the `wtimeout` time limit.

## Implicit Default Write Concern

> The implicit default write concern is `w: majority`.

## w: "majority" (durability semantics)

> Requests acknowledgment that the calculated majority of data-bearing
> voting members have durably written the change to their local oplog.
>
> If you specify a `"majority"` write concern for writes and the operation
> does not replicate to the calculated majority of replica set members
> before it returns a response, then the data eventually replicates or
> rolls back.

## Acknowledgment Behavior (replica sets)

> The `w` value determines the number of replica set members that must
> acknowledge the write before returning success.

## Wave-2a reliance

W09 classification: a `writeConcernError` is NOT evidence that the write
failed — the data may be (and often is) already applied; it is an uncertain
outcome that may still roll back under specific failover conditions. The
correct application behavior is to keep recovery/repair markers intact
(retry-safe paths), never to mark the item as definitively-failed and never
to claim it definitively-durable without a follow-up read; item-level
`writeErrors` (e.g. E11000) remain the only per-item failure signal.
