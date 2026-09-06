# MongoDB Manual — db.collection.insertMany() (captured sections)

- source: https://www.mongodb.com/docs/manual/reference/method/db.collection.insertMany/
- accessed: 2026-09-06 (Wave 2a grounding, W09 insert/retry reconciliation)
- capture scope: unordered execution, error-reporting split, partial-success
  result shape; verbatim quotes.

## Execution of Operations

> By default, documents are inserted in the order they are provided.
>
> If `ordered` is set to `true` and an insert fails, the server does not
> continue inserting records.
>
> If `ordered` is set to `false` and an insert fails, the server continues
> inserting records. Documents may be reordered by `mongod` to increase
> performance. Applications should not depend on ordering of inserts if
> using an unordered `insertMany()`.

## Error Handling

> Inserts throw a `BulkWriteError` exception.
>
> Excluding write concern errors, ordered operations stop after an error,
> while unordered operations continue to process any remaining write
> operations in the queue.
>
> Write concern errors are displayed in the `writeConcernErrors` field,
> while all other errors are displayed in the `writeErrors` field. If an
> error is encountered, the number of successful write operations are
> displayed instead of a list of inserted _ids. Ordered operations display
> the single error encountered while unordered operations display each error
> in an array.

## Collection and `_id` Field Creation

> If the document contains an `_id` field, the `_id` value must be unique
> within the collection to avoid duplicate key error.

## Unordered inserts example (verbatim output, abridged to the shapes)

Two duplicate `_id`s in a 7-document unordered insert:

> MongoBulkWriteError: E11000 duplicate key error collection: …movies index:
> _id_ dup key: { _id: 11 }
> Result: BulkWriteResult { insertedCount: 5, …, insertedIds: { '0': 10,
> '1': 11, '3': 12, '4': 13, '6': 14 } }
> Write Errors: [ WriteError { err: { index: 2, code: 11000, errmsg:
> 'E11000 duplicate key error … dup key: { _id: 11 }' } }, … index: 5 … ]

i.e. the thrown error still carries a full partial result (per-operation
`insertedIds` keyed by original array index) plus per-error `index`/`code`.

## Write concern example (abridged)

`w: "majority", wtimeout: 100` that times out returns:

> WriteConcernError({ "code": 64, "errmsg": "waiting for replication timed
> out", "errInfo": { "wtimeout": true, "writeConcern": { … } } })

## Batching

> The driver batches documents specified in the `insertMany()` array
> according to the maxWriteBatchSize, which is 100,000 and cannot be
> modified.

## Wave-2a reliance

W09 reconciliation: an unordered insert that reports E11000 on an item the
caller itself previously sent is evidence the FIRST attempt's copy is
durable (duplicate key), not that the current item failed to persist; the
partial `insertedIds`/`writeErrors.index` payload is sufficient to
reconcile exactly which documents are durable, so no item should be
classified from absence alone when the batch carried a write concern error.
