# TOON context format

Memongo can render context bundles as TOON for prompt injection when you want a compact, table-like string for many similar memory records.

JSON remains the default and canonical programmatic format. HTTP requests and responses still use JSON, MongoDB documents stay structured and queryable, and Memongo does not store TOON in the database.

## Where it is available

TOON is available for context-bundle rendering only:

- HTTP API: `POST /v1/context-bundle` with `{ "format": "toon" }`
- TypeScript client: `client.buildContextBundle({ format: "toon" })`
- AI SDK tools: `memongo_build_context_bundle` with `format: "toon"`
- OpenAI/Vercel middleware: pass `format: "toon"` in `MemongoCoreOptions`
- MCP: `memongo_build_context_bundle` with `format: "toon"`

Omit `format` to keep the existing markdown-style rendered string. Use `format: "json"` if you want `rendered` to contain compact JSON while preserving the normal JSON response envelope.

## When to use TOON

Use TOON for LLM prompt/context injection when the returned bundle has many similar records, such as search results, facts, preferences, procedures, recent events, or citation summaries.

TOON is most useful for token-sensitive agents that need the same retrieved memory payload in fewer prompt tokens than compact JSON.

## When not to use TOON

Do not use TOON as API transport, MongoDB storage, schema representation, or vector-search input. Do not use it for deeply nested or highly irregular objects when exact structure matters more than prompt compactness. Avoid model-generated tool calls that request TOON unless the tool input is validated.

The encoder quotes cells containing commas, newlines, quotes, pipes, brackets, braces, colons, or row-breaking characters with JSON string escaping. Nested metadata and trust/citation objects are serialized as stable JSON cells.

## Benchmark

Run:

```sh
bun run benchmark:toon
```

The benchmark writes machine-readable local results to `artifacts/benchmarks/toon-token-benchmark.json` and prints a table comparing:

- JSON pretty
- JSON compact
- existing markdown-style context
- TOON

To refresh the tracked documentation sample, pass `--sample-out=docs/benchmarks/toon-token-benchmark.sample.json`.

Sample local results from June 27, 2026 using `gpt-tokenizer` for `gpt-4o` / `o200k_base`:

| Fixture | Compact JSON tokens | TOON tokens | TOON savings |
| --- | ---: | ---: | ---: |
| small-uniform-5 | 505 | 444 | 12.1% |
| medium-uniform-50 | 4714 | 3843 | 18.5% |
| large-uniform-250 | 23414 | 18943 | 19.1% |
| mixed-memory-types | 336 | 348 | -3.6% |
| nested-metadata | 1459 | 1526 | -4.6% |
| realistic-retrieved-context | 1750 | 1417 | 19.0% |
| toon-unfriendly-irregular | 242 | 355 | -46.7% |

In this fixture set, TOON saved tokens on 4 of 7 fixtures and lost tokens on 3 of 7. Use TOON only after measuring representative payloads; it is not a universal replacement for compact JSON or markdown-style context.
