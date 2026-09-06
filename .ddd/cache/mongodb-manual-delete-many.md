# MongoDB Manual — db.collection.deleteMany() (captured sections)

- source: https://www.mongodb.com/docs/manual/reference/method/db.collection.deleteMany/
- accessed: 2026-09-06 (Wave 1b grounding + compare, W02/W03)
- capture scope: the delete semantics + re-check guidance relied on for the
  erasure redesign; verbatim quotes.

## Definition

> Removes all documents that match the filter from a collection.

Returns: `acknowledged` and `deletedCount` — "the number of deleted
documents".

## Behavior (sharded-collection warning — the re-check guidance)

> Due to concurrent chunk migrations, deleteMany() might run without
> deleting all documents that match the specified filter. To ensure you
> delete all matching documents, perform one of the following operations:
> - Run the deleteMany() method iteratively until the corresponding find
>   query with the same filter returns no documents.

## Application to W02/W03 (analysis, not doc text)

The erasure sweep's post-delete VERIFICATION pass (countDocuments per swept
target; residual forces "partial") implements the manual's own re-check
guidance: never trust a single delete's completeness claim — re-query. The
W02 probe exercised it live: a failed delete surfaced as
verification.residual [{collection: "events", count: 1}].
