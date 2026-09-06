# MongoDB Manual — $slice update modifier (captured sections)

- source: https://www.mongodb.com/docs/manual/reference/operator/update/slice/
- accessed: 2026-09-06 (Wave 2c grounding — W11 canonical exactly-once guard:
  bounding the appliedBatches dedupe window)
- capture scope: the sign semantics of the $push `$slice` modifier; verbatim
  quotes.

## Definition

> The `$slice` modifier limits the number of array elements during a `$push`
> operation. [...]
> To use the `$slice` modifier, it **must** appear with the `$each` modifier.

## Value semantics

> The `<num>` can be:
>
> | Value | Description |
> | --- | --- |
> | Zero | To update the array `<field>` to an empty array. |
> | Negative | To update the array `<field>` to contain only the last
>   `<num>` elements. |
> | Positive | To update the array `<field>` contain only the first `<num>`
>   elements. |

## Slice from the End of the Array (page's own example)

> The following operation adds new elements to the `scores` array, and then
> uses the `$slice` modifier to trim the array to the last five elements:
>
> `db.students.updateOne( { _id: 1 }, { $push: { scores: { $each: [ 80, 78,
> 86 ], $slice: -5 } } } )`
>
> The result of the operation is slice the elements of the updated `scores`
> array to the last five elements.

## Application to W11 (analysis, not doc text)

The canonical guard pushes
`appliedBatches: { $each: [batchId], $slice: -APPLIED_BATCH_WINDOW }`.
Negative `$slice` keeps only the LAST N elements, so the window always
retains the most recently applied batch ids while bounding the array (and
therefore the document size) forever. A re-buffered flush replays with the
SAME batchId, and that id stays guarded until N further batches have been
applied to that same document — N is chosen far above any realistic
retry/flush interleaving on one memory document (window size 32).
