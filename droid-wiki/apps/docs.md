# Docs site

Active contributors: Rom Iluz

`apps/docs` is the public, product-facing documentation site, built with [Mintlify](https://mintlify.com). It documents Memongo for people integrating the product (agent builders, MCP host authors, operators); this wiki, by contrast, documents the codebase itself for contributors working on Memongo's source. The two are deliberately separate: this wiki links to `apps/docs` pages for product concepts rather than restating them, and `apps/docs` never describes internal module layout.

## Structure

`apps/docs/docs.json` is Mintlify's site configuration — theme colors (MongoDB green), logo, navbar, and the navigation tree. It defines two top-level tabs:

- **Documentation** — Getting Started (introduction, quickstart, and a Concepts group: `concepts/framework.mdx`, `concepts/memory-taxonomy.mdx`, `concepts/memory.mdx`, `concepts/architecture.mdx`) and Guides (a Company Brain group: `guides/company-brain.mdx`, `guides/writeback-policy.mdx`, `guides/adapters.mdx`; an MCP group: `guides/cli-memory.mdx`; a Configuration group: `guides/memory-config.mdx`, `guides/open-source.mdx`).
- **API Reference** — `api/overview.mdx`, the single page covering the HTTP endpoint surface.

`apps/docs/introduction.mdx` frames Memongo as a "MongoDB-native Company Brain memory framework," summarizes the memory taxonomy and runtime shape, and links out to quickstart, concepts, and API pages. `apps/docs/quickstart.mdx` walks through cloning the repo, starting MongoDB, starting the API, and running an add/search loop in both TypeScript and cURL — it mirrors (with product framing) the steps in [Getting started](../overview/getting-started.md).

## Build and serve

`apps/docs/package.json` scripts:

| Script | Command | Purpose |
|---|---|---|
| `dev` | `mintlify dev --port 3003` | Local Mintlify preview server |
| `build` | `node ../../scripts/check-docs-integrity.mjs` | Validates doc content/link integrity (not a static site build) |
| `validate:mintlify` | `node ../../scripts/validate-mintlify-build.mjs` | Validates the site against Mintlify's build requirements |

Mintlify itself hosts and renders the site from `docs.json` plus the `.mdx` files; there is no separate bundler step to produce static HTML in this repo — Mintlify's own hosting/CLI does that.

## Relationship to product claims

`apps/docs/introduction.mdx` also carries Memongo's evaluation posture (LongMemEval retrieval numbers and their scoped, non-comparative framing) — the same posture documented in [Architecture](../overview/architecture.md)'s note on the substrate claim vs. score claim, and in `docs/adr/0001-substrate-claim-and-score-claim-are-separate.md`.

## Key source files

| File | Role |
|---|---|
| `apps/docs/docs.json` | Mintlify site config: theme, navbar, navigation tree |
| `apps/docs/introduction.mdx` | Landing/overview page for the product docs |
| `apps/docs/quickstart.mdx` | Product-facing install-and-run walkthrough |
| `apps/docs/api/overview.mdx` | HTTP API reference page |
| `apps/docs/concepts/` | Framework, memory taxonomy, memory, and architecture concept pages |
| `apps/docs/guides/` | Company Brain, writeback policy, adapters, MCP, config, and open-source guides |
| `apps/docs/package.json` | Scripts for local preview and doc validation |
