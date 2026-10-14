# Conversation dataset import

`importConversationDataset` loads a `.json` or `.jsonl` file of conversations
and writes each valid turn. It keeps valid turns and conversations and reports
every record it rejects.

## Accepted records

A conversation needs a `turns` array. A turn needs a `role` of `user`,
`assistant`, `system` or `tool`, and a non-empty `body`.

A turn's `timestamp` is optional:

- Absent: the event takes its write time, as before.
- Present: it must be one of these, with a real calendar date and time:
  - an ISO 8601 date-time with `Z` or a numeric offset, such as
    `2024-02-29T23:59:59.123Z` or `2024-03-01T01:59:59+02:00`;
  - a date only, such as `2024-02-29`, read as UTC midnight.

Any other explicit value is rejected, never replaced by the current time. This
covers an empty string, `null`, a number, an impossible date such as
`2024-02-30`, a non-ISO string, and a date-time without an offset. JavaScript
reads a date-time without an offset in the host's local zone, so the same file
would import different instants on different machines.

## Import receipt

Alongside the existing counts, the receipt carries:

- `failedLines`: JSONL lines that are not valid JSON.
- `rejectedTurns`: turns that were not written.
- `rejectedConversations`: conversations that were not written because they
  are not an object, have no `turns` array, or have no valid turn left.
- `rejections`: one entry per rejection, `{ line, conversationIndex,
  turnIndex, reason }`.

Coordinates:

- `line` is the 1-based physical line for JSONL, and `null` for a JSON document.
- `conversationIndex` is the 0-based position among conversation records in
  the input. For JSONL it counts lines that parsed as JSON.
- `turnIndex` is the 0-based position in that record's `turns` array, or `null`
  for a conversation-level rejection.

`reason` is one of `conversation-not-object`, `turns-not-array`,
`no-valid-turns`, `turn-not-object`, `invalid-role`, `empty-body` or
`invalid-timestamp`. Rejections never include turn text or the rejected value.

## Idempotency

Idempotency keys are numbered over written turns only. A turn that an earlier
version imported with an invalid timestamp is now rejected, so later turns in
that import get different keys. Re-import such a dataset into a fresh scope
rather than over an earlier import.
