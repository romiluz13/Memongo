# MongoDB Manual — db.collection.bulkWrite() (captured sections)

- source: https://www.mongodb.com/docs/manual/reference/method/db.collection.bulkWrite/
- accessed: 2026-09-06 (Wave 2b grounding, W07 chunk identity collisions)
- capture scope: updateOne first-match semantics, ordered/unordered
  execution, `_id` uniqueness, error handling inside transactions; verbatim
  quotes.

## updateOne and updateMany (Behavior)

> `updateOne` updates a _single_ document in the collection that matches the
> filter. If multiple documents match, `updateOne` will update the _first_
> matching document only.

> | `upsert` | Optional. A boolean to indicate whether to perform an upsert.
> By default, `upsert` is `false`. |

## `_id` Field

> If the document contains an `_id` field, the `_id` value must be unique
> within the collection to avoid duplicate key error.
>
> Update or replace operations cannot specify an `_id` value that differs
> from the original document.

## Execution of Operations

> With `ordered : true` (default), operations execute serially. If an error
> occurs, subsequent operations are not executed.
>
> With `ordered : false`, operations may execute in parallel. All
> operations without errors are completed even if some operations fail.

## Error Handling

> Excluding write concern errors, ordered operations stop after an error,
> while unordered operations continue to process any remaining write
> operations in the queue, unless when run inside a transaction.
>
> Write concern errors are displayed in the `writeConcernErrors` field,
> while all other errors are displayed in the `writeErrors` field.

## Transactions (bulkWrite inside a transaction)

> `bulkWrite()` can be used inside distributed transactions.

> #### Error Handling inside Transactions
>
> Starting in MongoDB 4.2, if a `db.collection.bulkWrite()` operation
> encounters an error inside a transaction, the method throws a
> BulkWriteException (same as outside a transaction).
>
> Inside a transaction, the first error in a bulk write causes the entire
> bulk write to fail and aborts the transaction, even if the bulk write is
> unordered.

## Wave-2b reliance

W07 fix basis: `buildChunkOps` emits one `updateOne` op per chunk with
filter `{ _id: chunkId }` and `upsert: true`. `chunkMarkdown` currently
emits multiple character-segments of one long line that all share the same
`startLine`/`endLine`, so `chunkId = storageId:startLine:endLine` collides.
Per the captured contract, the ops in one bulkWrite are executed against
one collection: the first colliding op upserts the document, the following
op MATCHES that same `_id` and updates it — last-write-wins — so every
earlier segment of that line is silently overwritten (the duplicate-key
guard never fires because the second op is an update match, not an insert).
Chunk identity must therefore include a per-segment discriminator
(character-offset ordinal) so that each segment maps to a distinct
document, in the memory-chunk `_id`, the KB chunk upsert filter, and the
`kb_chunks` unique index.

W15 interplay: when the chunk upserts run inside a transaction (the fix
moves delete + upsert + metadata into one transaction), the captured
in-transaction rule makes any single chunk error abort the whole
transaction (unordered offers no continuation inside a transaction), which
is exactly the all-or-nothing replacement the fix needs — but it also means
W07's identity collisions must be fixed first, since an E11000 upsert
collision would otherwise abort every large-file sync transaction.
