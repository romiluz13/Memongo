# Docs site (`apps/docs`)

`@memongo/docs` is the public documentation site, built with [Mintlify](https://mintlify.com) (theme `mint`, MongoDB-green palette `#00684A` / `#00ED64`, `apps/docs/docs.json`). It is a private package with no compile step of its own.

## Key files

- `apps/docs/docs.json` — site config: navigation, tabs, redirects, branding
- `apps/docs/introduction.mdx` — "What is Memongo?" landing content
- `apps/docs/quickstart.mdx` — clone → install → start MongoDB → add/search loop
- `apps/docs/package.json` — scripts (`dev`, `build`, `validate:mintlify`)

## Structure

Navigation is declared entirely in `docs.json` (Mintlify's declarative model). Two tabs:

**Documentation tab**

| Anchor | Groups | Pages |
|--------|--------|-------|
| Getting Started | Overview | `introduction`, `quickstart` |
| | Concepts | `concepts/framework`, `concepts/memory-taxonomy`, `concepts/memory`, `concepts/architecture` |
| Guides | Company Brain | `guides/company-brain`, `guides/writeback-policy`, `guides/adapters` |
| | MCP | `guides/cli-memory` |
| | Configuration | `guides/memory-config`, `guides/open-source` |

**API Reference tab**

| Anchor | Group | Pages |
|--------|-------|-------|
| Endpoints | Memory API | `api/overview` |

The root path redirects to `/introduction` (`apps/docs/docs.json` redirects). Supporting assets live in `apps/docs/logo/` and `apps/docs/favicon.png`.

## Scripts

- `bun run dev` — `mintlify dev --port 3003`
- `bun run build` — runs `scripts/check-docs-integrity.mjs` (a repo-level integrity check, not a Mintlify build), so broken docs fail the monorepo build through Turborepo
- `bun run validate:mintlify` — `scripts/validate-mintlify-build.mjs`

## Relationship to the repo docs

`apps/docs` is the *public product story*; the repo keeps maintainer-facing material elsewhere. `CONTRIBUTING.md` assigns the split: public story in `README.md`, `apps/docs`, and `docs/platform`; research/brainstorm under `docs/research`; ADRs under `docs/adr`.

## Related pages

- [Apps overview](index.md)
- [How to contribute](../how-to-contribute/index.md) — documentation rules for contributors
- [Tooling](../how-to-contribute/tooling.md) — how the docs-integrity check runs in CI
