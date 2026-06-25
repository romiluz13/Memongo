# @memongo/memory

Convenience barrel over the supported Memongo memory core. It re-exports the bridge and engine for consumers who want one import path.

## Install

```bash
npm install @memongo/memory
```

## When to use this package

- You want a single import for the supported memory core.
- You are shipping internal tooling and do not need to split bridge and engine imports.

## Example

```ts
import { memongoBridgeStatus, getMemorySearchManager } from "@memongo/memory"
```

Prefer the direct packages when you want a narrower dependency surface:

- [`@memongo/memory-bridge`](../memory-bridge/README.md)
- [`@memongo/memory-engine`](../memory-engine/README.md)
