# Patterns and conventions

## Coding style

- **Language:** TypeScript (ESM). Strict typing. Avoid `any`.
- **Formatting:** Biome with tabs, double quotes, semicolons as needed.
- **File size:** Keep files under ~500 LOC. Split or refactor when it improves clarity. (The codebase currently has several violations, notably `mongodb-manager.ts` at ~12,400 LOC.)
- **Naming:** American English spelling and grammar.
- **Imports:** Use `.js` extensions on relative imports (NodeNext module resolution). Use `type` imports for type-only imports.
- **Error handling:** Throw `Error` subclasses. Never swallow errors in catch blocks. Use typed error envelopes at API boundaries.

## Testing

- **Framework:** Vitest with V8 coverage.
- **Location:** Tests are colocated with source as `*.test.ts`.
- **E2E tests:** Named `*.e2e.test.ts`, require a running MongoDB instance.
- **Run:** `bun run test` (unit), `bun run test:e2e` (end-to-end).

## Package naming

| Package | npm name | Published |
|---------|----------|-----------|
| Memory engine | `@memongo/memory-engine` | Yes |
| Memory bridge | `@memongo/memory-bridge` | Yes |
| Re-export | `@memongo/memory` | Yes |
| Client SDK | `@memongo/client` | Yes |
| AI SDK tools | `@memongo/tools` | Yes |
| Pi extension | `@memongo/pi-extension` | Yes |
| Shared lib | `@memongo/lib` | Private |
| API | `@memongo/api` | Private |
| MCP | `@memongo/mcp` | Private |
| Web | `@memongo/web` | Private |
| Docs | `@memongo/docs` | Private |

## Commit guidelines

- Concise, action-oriented messages (e.g., `engine: add graph expansion`).
- Group related changes. Avoid bundling unrelated refactors.
- Include `Co-authored-by: factory-droid[bot] <138933559+factory-droid[bot]@users.noreply.github.com>` for agent-authored commits.

## Security

- Never commit secrets. Use environment variables (`MEMONGO_MONGODB_URI`, `MEMONGO_API_KEY`, etc.).
- Never publish real connection strings, API keys, or personal data in code or docs.
- Use `@memongo/lib` redaction utilities (`redact.ts`) when logging sensitive data.

## Build and quality gates

```bash
bun run build              # Turborepo build
bun run check-types        # TypeScript strict check
bun run lint               # Biome (errors only)
bun run check-publishability  # npm publish readiness
bun run test               # Vitest unit tests
bun run test:e2e           # E2E tests (needs MongoDB)
```

## Linting config

Biome is configured in `biome.json` at the repo root. The lint command runs with `--diagnostic-level=error`, so warnings are suppressed in CI. Run `bun run lint:fix` to auto-fix formatting and lint issues.

## Monorepo structure

The repo uses Turborepo for task orchestration. Package dependencies are declared in each `package.json` and resolved through Bun workspaces. Local package references use `workspace:*` or exact version strings.
