# @memongo/tools

AI SDK tool helpers for Memongo. Use this package when you want to expose supported Memongo operations as Vercel AI SDK tools.

## Install

```bash
npm install @memongo/tools
```

## When to use this package

- You are wiring Memongo into an AI SDK agent.
- You want ready-made tool definitions for search, KB search, read, add, write-event, profile, status, chain-trace, novelty-scan, and consolidate.

## Example

```ts
import { MemongoClient } from "@memongo/client"
import { createMemongoTools } from "@memongo/tools"

const client = new MemongoClient({ baseUrl: "http://127.0.0.1:3847" })
const tools = createMemongoTools(client)
```

Lifecycle-get and unified-state tools carry the existing top-level
untrusted-memory provenance notice, preserving the underlying response fields
and nested provenance. The notice is advisory model context; it does not
replace authorization or guarantee protection against prompt injection.
Lifecycle-history tools remain outside this change.

## Middleware behavior

`withMemongo` (Vercel AI SDK) and `createOpenAIMiddleware` (OpenAI SDK) fetch context from the API for each model call. They do not reuse earlier rendered responses, so each call reaches the server's current authorization and retrieval checks. Turn capture sends conversation events with idempotency keys. The `_clearCache` export from `@memongo/tools/vercel` remains a callable no-op for compatibility.

Middleware options accept `scope` and `scopeRef`. Vercel calls can override them through `providerOptions.memongo`; OpenAI uses constructor options. Explicit refs are trimmed. A request supplying `scope` must also supply its ref, or use `scope: "user"` with a nonblank `userId`, which derives `user:<trimmed id>`. A request without `scope` can inherit the constructor ref, except that a request supplying `userId` under user scope derives its own user ref. A blank user override cannot inherit the constructor user ref. Context reads and turn writes send the same coordinates. `userId` alone preserves the existing scope default.

These are trusted-host coordinates, not end-user authentication. An unrestricted API key accepts caller-chosen refs; hosts must assign distinct coordinates to their users and enforce authorization. Scoped API-key checks remain server-side. Missing user identity with explicit user scope and no ref remains an API error, reported through the existing middleware failure hook.

Turn keys include resolved refs when present; legacy calls without a ref retain their keys. Adding a ref to an existing deployment changes turn keys, so a retry spanning that change can store a turn twice. The `user:<id>` derivation mirrors the engine and must evolve with its canonical identity format.

For stable turn capture, supply a unique `requestId` for each logical model call and reuse it only when retrying that same call with the same captured content. Vercel accepts `providerOptions.memongo.requestId`; both middlewares accept a constructor `requestId`. A nonblank per-call ID wins, then a nonblank constructor ID; whitespace-only values fall through, while nonblank IDs preserve their exact bytes. The ID is hashed with the resolved memory coordinates and kept separate from context retrieval. Without an ID, legacy prompt-tail keys remain unchanged and cannot distinguish repeated prompts or prompts sharing their last 200 characters. Introducing IDs changes capture keys, so retries spanning that transition can store a turn twice. Stability requires WebCrypto; the existing random fallback cannot deduplicate retries.

Do not leave one fixed constructor ID on a middleware reused for distinct calls: later captures reuse the first call's keys. OpenAI currently has only the constructor channel, so use an instance for one logical call and its retries. Multi-step AI SDK tool loops reuse provider options; this ID identifies a model call, not an entire multi-step loop. Reusing it for later steps with different content can produce capture conflicts, which are reported through `onError` rather than overwriting stored events. Only assistant text is captured; reasoning and tool-only output are omitted, and OpenAI streams capture the user message only.

## Memory intelligence tools

- `memongo_chain_trace` -- reasoning chain traversal (provenance via `$lookup`)
- `memongo_novelty_scan` -- surprisal novelty detection (Atlas Vector Search centroid)
- `memongo_consolidate` -- trigger offline consolidation (Dreamer pipeline)

If you need a different agent wrapper or a custom tool set, build on top of [`@memongo/client`](../client/README.md).

The OpenAI Chat Completions middleware uses only nonempty `type: "text"`
parts of the latest user content array, joined with newlines, for memory queries
and user-turn capture. It forwards the original messages, including images,
audio and file parts, to the provider. An empty or image-only latest array supplies
no user query or user capture; plain empty strings and null retain the legacy
fallback to an earlier user message. Assistant text may still be captured on a
nonstreaming call. Responses API `input_text` parts are outside this wrapper's
contract. The Vercel wrapper's existing first-text-part extraction is unchanged.
