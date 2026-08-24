# Memongo memory

Active contributors: Rom Iluz

`@memongo/memory` (package directory `packages/memongo-memory`) is a thin convenience barrel: it re-exports everything from `@memongo/memory-bridge` and `@memongo/memory-engine` under a single npm package, for consumers who want one import path instead of pulling both packages separately.

## Key source files

| File | Role |
| --- | --- |
| `packages/memongo-memory/src/index.ts` | The entire implementation — two re-export statements. |
| `packages/memongo-memory/package.json` | Declares `@memongo/memory-engine` and `@memongo/memory-bridge` as dependencies; `main`/`types` point at `dist/index.js`/`dist/index.d.ts`. |
| `packages/memongo-memory/README.md` | The npm-facing install and usage story. |

## What it re-exports

`packages/memongo-memory/src/index.ts` is exactly:

```ts
export * from "@memongo/memory-bridge"
export * from "@memongo/memory-engine"
```

So `@memongo/memory` exposes the full public surface of both packages: every `memongoBridge*` function from [`@memongo/memory-bridge`](memory-bridge.md) (search, writes, lifecycle, recall, status, analytics, shutdown) and every symbol `@memongo/memory-engine` exports from its main barrel (`getMemorySearchManager`, `closeAllMemorySearchManagers`, `MongoDBMemoryManager`, and related types) — see [`@memongo/memory-engine`](../packages/memory-engine/index.md) for what the engine barrel contains. It does not re-export the engine's `@memongo/memory-engine/internal` subpath.

## Why it exists

Per `packages/memongo-memory/README.md`, this package targets internal tooling and consumers who don't need a narrow dependency surface — one `npm install @memongo/memory` instead of installing the bridge and engine packages separately and importing from both. The README explicitly recommends the direct packages (`@memongo/memory-bridge`, `@memongo/memory-engine`) instead when a narrower dependency surface matters.

## Integration points

- Depends on `@memongo/memory-bridge` (`^2.0.1`) and `@memongo/memory-engine` (`^2.0.1`) as its only runtime dependencies.
- Not consumed by any other workspace package or app — `apps/api` imports the bridge and engine directly. This package exists purely as a published npm convenience for external consumers; see the root `README.md` for the install story.
