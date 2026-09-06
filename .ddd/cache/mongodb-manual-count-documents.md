# MongoDB Manual — db.collection.countDocuments() (captured sections)

- source: https://www.mongodb.com/docs/manual/reference/method/db.collection.countDocuments/
- accessed: 2026-09-06 (Wave 1b grounding + compare, W03 verification pass)
- capture scope: the accurate-count contract relied on for the post-sweep
  verification; verbatim quotes.

## Mechanics

> Unlike db.collection.count(), countDocuments() does not use the metadata
> to return the count. Instead, it performs an aggregation of the document
> to return an accurate count, even after an unclean shutdown or in the
> presence of orphaned documents in a sharded cluster.

## Empty or Non-Existing Collections

> countDocuments() returns 0 on an empty or non-existing collection or view.

## Application to W03 (analysis, not doc text)

The erasure verification pass needs a trustworthy post-delete count:
metadata-based counts can drift, countDocuments is aggregation-based and
accurate, and a missing collection reads as 0 (not an error) — exactly the
semantics a residual check over ~30 collections requires.
