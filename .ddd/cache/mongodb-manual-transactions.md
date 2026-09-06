# MongoDB Manual — Transactions (captured sections)

- source: https://www.mongodb.com/docs/manual/core/transactions/
- accessed: 2026-09-06 (Wave 2b grounding, W15 atomic file replacement)
- capture scope: transactions-and-atomicity contract, callback API retry
  semantics, 6.2 TransactionTooLargeForCache and 8.1 upsert-in-transaction
  duplicate-key rules, session requirements; verbatim quotes.

## Transactions and Atomicity

> Distributed transactions are atomic:
>
> - Transactions either apply all data changes or roll back the changes.
>
> - If a transaction commits, all data changes made in the transaction are
>   saved and are visible outside of the transaction.
>
> Until a transaction commits, the data changes made in the transaction are
> not visible outside the transaction.
>
> - When a transaction aborts, all data changes made in the transaction are
>   discarded without ever becoming visible.

## Transactions API (callback API)

> The callback API:
>
> - starts a transaction
> - executes the specified operations
> - commits the result or ends the transaction on error

> The callback API incorporates retry logic for certain errors. The driver
> tries to rerun the transaction after a TransientTransactionError or
> UnknownTransactionCommitResult commit error.
>
> Starting in MongoDB 6.2, the server does not retry the transaction if it
> receives a TransactionTooLargeForCache error.
>
> Starting in MongoDB 8.1, if an `upsert` operation runs in a
> multidocument transaction, then the `upsert` does not retry when it
> encounters a duplicate key error.

## Important (driver usage requirements)

> - When using drivers, each operation in the transaction must pass the
>   session to each operation.
> - Operations in a transaction use transaction-level read concern,
>   transaction-level write concern, and transaction-level read preference.

## Transactions and Sessions

> - Transactions are associated with a session.
> - You can have at most one open transaction at a time for a session.
> - If a session ends and it has an open transaction, the transaction aborts.

## Transactions and Operations

> You can create collections and indexes in transactions.

(Explicit collection/index creation inside a transaction requires read
concern `"local"`; the repo's ensure-index paths run outside transactions,
so this restriction does not interact with the fix.)

## Wave-2b reliance

W15 fix basis: the delete + chunk-upsert + metadata-write sequence for one
file replacement is currently split across independent commit boundaries
(one `withTransaction` for the delete, separate batched transactions for
upserts, metadata written last). Under the atomicity contract above, a
crash between those boundaries leaves committed deletions with no
replacement chunks while the stored hash still matches the file, so the
next non-forced sync skips the file — permanent data loss. Putting the
bounded per-file delete + upsert + metadata update in ONE callback-API
transaction makes the replacement all-or-nothing: an aborted transaction
"discards [the changes] without ever becoming visible", so the pre-sync
state (old chunks + old hash) remains, and the next sync retries.

Constraint honored from the same page: `TransactionTooLargeForCache` (6.2+,
local stack is 8.3.8) is not retried by the server, so per-file transaction
payload must stay bounded — chunk batches for very large files must
sub-batch, and the fallback for over-limit payloads is the W09-style
reconciled non-transactional path with hash invalidation before delete.
Also relevant to W07: on 8.1+ an upsert inside a transaction does not retry
on duplicate key, so colliding chunk identities (same `_id`/unique-key
compound from one long line) must be eliminated before the KB transactional
upsert path can be trusted.
