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
  - an ISO 8601 date-time with `Z` or a `±HH:MM` offset, such as
    `2024-02-29T23:59:59.123Z` or `2024-03-01T01:59:59+02:00`. Up to nine
    fractional-second digits are accepted and truncated to milliseconds;
  - a date only, such as `2024-02-29`, read as UTC midnight.

Surrounding whitespace is ignored. Any other explicit value is rejected, never
replaced by the current time. This covers an empty string, `null`, a number, an
impossible date such as `2024-02-30`, a non-ISO string, a lowercase `z`, a space
instead of `T`, an offset without a colon, and a date-time without an offset.
JavaScript reads a date-time without an offset in the host's local zone, so the
same file would import different instants on different machines.

## Import receipt

Alongside the existing counts, the receipt carries:

- `failedLines`: JSONL lines that are not valid JSON.
- `rejectedTurns`: turns that were not written.
- `rejectedConversations`: conversations that were not written because they
  are not an object, have no `turns` array, or have no valid turn left.
- `rejections`: one entry per rejection, `{ line, conversationIndex,
  turnIndex, reason }`.

Coordinates:

- `line` is the 1-based physical line when it is knowable: every JSONL record,
  and every record of a document written on one line. It is `null` for a
  document spread over several lines.
- `conversationIndex` is the 0-based position among conversation records in
  the input. For JSONL it counts lines that parsed as JSON.
- `turnIndex` is the 0-based position in that record's `turns` array, or `null`
  for a conversation-level rejection.

`reason` is one of `conversation-not-object`, `turns-not-array`,
`no-valid-turns`, `turn-not-object`, `invalid-role`, `empty-body` or
`invalid-timestamp`. Rejections never include turn text or the rejected value.

When no conversation is valid, the import fails, and the error lists counts
by reason (for example `failedLines=1, invalid-timestamp=1, no-valid-turns=1`)
without any values.

JSONL lines that parse as JSON but are not a valid conversation are counted
in `rejectedConversations`, no longer in `failedLines`.

## Idempotency

Idempotency keys are numbered over written turns only. A turn that an earlier
version imported with a timestamp that is now rejected (for example an empty
string, a date-time without an offset, or a lowercase `z`) is no longer
written, so later turns in that import get different keys. Re-import such a
dataset into a fresh scope rather than over an earlier import.
