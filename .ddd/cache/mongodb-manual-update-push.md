# MongoDB Manual — $push update operator (captured sections)

- source: https://www.mongodb.com/docs/manual/reference/operator/update/push/
- accessed: 2026-09-06 (Wave 2c grounding — W11 canonical exactly-once guard:
  recording the applied batch id in the same atomic update that performs the
  increments)
- capture scope: $push definition, missing-field behavior, and the modifier
  table; verbatim quotes.

## Definition

> The `$push` operator appends a specified value to an array.

## Behavior (missing field, wrong type)

> If the field is absent in the document to update, `$push` adds the array
> field with the value as its element.
>
> If the field is **not** an array, the operation fails.

## Modifiers

> | Modifier | Description |
> | --- | --- |
> | `$each` | Appends multiple values to the array field. |
> | `$slice` | Limits the number of array elements. Requires the use of the
>   `$each` modifier. |

> The processing of the `$push` operation with modifiers occur in the
> following order, regardless of the order in which the modifiers appear:
>
> 1. Update array to add elements in the correct position.
> 2. Apply sort, if specified.
> 3. Slice the array, if specified.
> 4. Store the array.

## Application to W11 (analysis, not doc text)

The canonical update appends the flush's batchId to the `appliedBatches`
array in the SAME updateOne that performs `$inc accessCount` / `$set
lastAccessedAt`, guarded by the `$ne` filter (EL-029): a single per-document
atomic operation both applies the increments and records that this batch was
applied. Legacy documents (no field) get the array created with the batchId
as its element; documents that already applied the batch are filtered out
before the update, so no duplicate append can occur. Bounded growth uses
`$each: [batchId]` + `$slice` (negative-value semantics per EL-031).
`appliedBatches` is a tracker-owned denormalized field on the canonical
collections; following the accessCount/lastAccessedAt precedent it is not
declared in the canonical schema validators.
