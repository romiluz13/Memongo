# @memongo/memory

The published npm surface for in-process Memongo use. The entire implementation is two lines in `packages/memongo-memory/src/index.ts`:

```typescript
export * from "@memongo/memory-bridge"
export * from "@memongo/memory-engine"
```

## Why it exists

Memongo's real code lives in two packages with different audiences:

- [`@memongo/memory-engine`](../packages/memory-engine/index.md) — the core engine, large and fast-moving
- [`@memongo/memory-bridge`](./memory-bridge.md) — the stable facade (config loading + delegation)

`@memongo/memory` (package description: "Memongo memory: published re-export surface for the memory engine and bridge") gives consumers **one install** that covers both: the facade functions for the common path and the engine types/classes for advanced use, without forcing users to understand the internal two-package split. It carries no code of its own, so there is nothing to drift — the re-exports always reflect whatever bridge and engine versions are installed.

```mermaid
graph LR
    USER["Consumer application"]
    MEM["@memongo/memory<br/>(2-line re-export)"]
    BRIDGE["@memongo/memory-bridge"]
    ENGINE["@memongo/memory-engine"]
    USER --> MEM
    MEM --> BRIDGE
    MEM --> ENGINE
    BRIDGE --> ENGINE
```

Use this package when embedding Memongo **in-process** (your Node process talks to MongoDB directly). For access over HTTP to a running Memongo API server, use [`@memongo/client`](./client.md) instead.

## Key file

| File | Role |
|------|------|
| `packages/memongo-memory/src/index.ts` | Re-exports the bridge and engine surfaces (2 LOC) |

**Top contributors:** Rom Iluz (8 commits).

## Related pages

- [Packages overview](./index.md)
- [@memongo/memory-bridge](./memory-bridge.md)
- [The core engine](./memory-engine/index.md)
