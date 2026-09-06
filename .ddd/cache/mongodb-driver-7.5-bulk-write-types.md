# MongoDB Node Driver 7.5.0 — bulk-write error/result shapes (shipped types)

- source: installed `mongodb@7.5.0` type declarations,
  `node_modules/mongodb/mongodb.d.ts` (version-exact shipped material;
  no hosted page used)
- accessed: 2026-09-06 (Wave 2a grounding, W09 reconciliation implementation)
- capture scope: the exact runtime shapes the engine's insert paths can
  branch on.

## MongoBulkWriteError (thrown by insertMany on any writeError / writeConcernError)

```ts
export declare class MongoBulkWriteError extends MongoServerError {
    result: BulkWriteResult;
    writeErrors: OneOrMore<WriteError>;
    err?: WriteConcernError;
    get name(): string;
    /** Number of documents inserted. */
    get insertedCount(): number;
    ...
}
```

`MongoServerError` supplies `.code`, `.errorLabels`, and
`hasErrorLabel(label: string): boolean` — including
`NoWritesPerformed: "NoWritesPerformed"`.

## BulkWriteResult (also carried ON the error as `.result`)

```ts
export declare class BulkWriteResult {
    readonly insertedCount: number;
    readonly matchedCount: number;
    readonly modifiedCount: number;
    readonly deletedCount: number;
    readonly upsertedCount: number;
    readonly insertedIds: { [key: number]: any }; // keyed by op index
    readonly upsertedIds: { [key: number]: any };
    get ok(): number;
    hasWriteErrors(): boolean;
    getWriteErrorCount(): number;
    getWriteErrorAt(index: number): WriteError | undefined;
    getWriteErrors(): WriteError[];
    getWriteConcernError(): WriteConcernError | undefined;
    ...
}
```

## WriteError (per-item failure)

```ts
export declare class WriteError {
    get code(): number;          // e.g. 11000 duplicate key
    get index(): number;         // original operation-array index
    get errmsg(): string | undefined;
    get errInfo(): Document | undefined;
    getOperation(): Document;    // the failing op (carries its _id)
}
```

## WriteConcernError (uncertain-outcome signal)

`MongoWriteConcernError`/`WriteConcernErrorResult` surface as
`{ writeConcernError: { code, errmsg, errInfo? }, ok, errorLabels? }`;
on `MongoBulkWriteError` the write-concern error is exposed via `.err`.

## Wave-2a reliance

The reconciliation code can and should branch on, in order:

1. `error instanceof MongoBulkWriteError` → per-item truth available:
   `error.writeErrors` (by `.index`/`.code`) for definitive per-item
   failures, `error.result.insertedIds` for definitive per-item inserts.
2. `error.hasErrorLabel("NoWritesPerformed")` → zero writes performed by
   the failed attempts (server-guaranteed; MongoDB 6.1+, stack is 8.3.8).
3. `.err` / `getWriteConcernError()` presence WITHOUT writeErrors →
   uncertain outcome: data may exist; must be verified by a follow-up read
   before classifying.
4. Plain network/transient errors (no server response) → unknown outcome
   for the whole batch; safe re-run requires stable `_id`s so duplicates
   surface as E11000 (see insertMany cache).
