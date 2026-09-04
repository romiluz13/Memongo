# Publishing `@memongo/*` packages

This monorepo uses the `@memongo` npm scope. Publishing is maintainer-operated; the repo root is `private: true` and does not publish itself.

## Before you publish anything

1. Complete [PRODUCTION-READY.md](PRODUCTION-READY.md).
2. Confirm no secrets in the working tree.
3. Bump semver in the package(s) you ship; tag releases in git to match.
4. Configure `NPM_TOKEN` as a GitHub Actions secret with publish access to the
   `@memongo` npm scope.

## Which packages are intended for npm

| Package | Name | Typical consumers |
|---------|------|-------------------|
| Engine | `@memongo/memory-engine` | Advanced integrations |
| Bridge | `@memongo/memory-bridge` | API and custom servers |
| Barrel | `@memongo/memory` (`packages/memongo-memory`) | Single import for engine + bridge |
| Client | `@memongo/client` | Apps using the HTTP API |
| Tools | `@memongo/tools` | Vercel AI SDK tool helpers |
| Pi extension | `@memongo/pi-extension` | Pi coding-agent users |
| MCP server | `@memongo/mcp` | MCP clients over stdio or HTTP |

`@memongo/lib` is also published as a runtime support package because the engine and bridge depend on it, but it is not a primary integration surface.

## Release flow

1. **Bump versions.** The root `package.json` `version` is the canonical
   workspace release version. Keep these surfaces in sync with it:
   - `apps/api/src/version.ts` (`MEMONGO_API_VERSION`) — drives the OpenAPI
     `info.version` and the `version` field echoed by `GET /v1/status`.
   - `apps/mcp/src/version.ts` (`MEMONGO_SERVER_VERSION`) — drives the MCP
     server handshake version.
   - Per-package semver in each published `package.json`; for
     `@memongo/client`, `packages/client/src/version.ts`
     (`MEMONGO_CLIENT_VERSION`) must equal the client package version — it is
     sent as the `x-memongo-client-version` request header. The API server
     reads that header on every `/v1` request and logs a version-skew warning
     (once per client/server version pair) when it differs from
     `MEMONGO_API_VERSION`, so stale clients surface in server logs instead
     of failing silently; check the logs after a release to see how much
     stale-client traffic remains.
2. **Build.** `bun run build`. Every publishable package runs its package-local
   `clean` script before building, and `prepublishOnly: bun run build` ensures a
   manual `npm publish` never ships stale `dist/`. `@memongo/pi-extension`
   ships unbuilt TS, so its build cleans any stray `dist/` and type-checks the
   extension sources.
3. **Gate.** `bun run check-publishability`. In addition to tarball contents,
   install smoke, and workflow checks it enforces:
   - `engines.node: ">=20.19.0"` and a `prepublishOnly` script on every
     publishable package;
   - no exact-pinned `mongodb` dependency (semver ranges only);
   - `bin` targets exist and start with `#!/usr/bin/env node`;
   - cross-package version consistency for the surfaces above;
   - every coordinated package version is still unpublished on npm;
   - internal runtime dependencies use the coordinated caret range;
   - clean and deliberately dirty `dist/` states produce identical output;
   - no orphan output or compiled test artifact can enter a tarball;
   - `publint` and `@arethetypeswrong/cli` (attw) against every packed
     tarball. These run via `bunx`; when the tools cannot be fetched (offline)
     the gate reports `SKIP` instead of failing, and it always skips
     `@memongo/pi-extension` (no JS entrypoints).
4. **Publish** in dependency order (below) from `v*` tags via the GitHub
   publish workflow.

## Publish mechanics

From repo root, after all release-blocking lanes are green:

```bash
bun run check-publishability
```

CI publish must fail hard if any package fails to publish. Do not rely on best-effort publish loops or workflows that swallow errors.

From a package directory:

```bash
cd packages/client
npm publish --access public
```

The GitHub publish workflow runs only from `v*` tags or manual dispatch. It uses
Bun for install/build/test and `npm publish --access public --provenance` for
npm publishing with provenance.

For an emergency manual publish, use npm with your org's 2FA and provenance
policy.

## Recommended publish order

When shipping the coordinated `@memongo/*` package set, publish in dependency
order so install smoke and downstream resolution stay clean:

1. `@memongo/lib`
2. `@memongo/memory-engine`
3. `@memongo/memory-bridge`
4. `@memongo/memory`
5. `@memongo/client`
6. `@memongo/tools`
7. `@memongo/pi-extension`
8. `@memongo/mcp`

## Docker

There is no single Memongo all-in-one image in-tree as of this writing. Production deployments typically:

- Run MongoDB.
- Run `apps/api` as a container or process behind a reverse proxy.
- Run `apps/web` and `apps/mcp` where needed.

See [self-host.md](self-host.md).

## Scope and naming

- Do not publish under legacy `@romiluz/*` names for new releases; this repo standardizes on `@memongo/*`.
- Historical material is kept outside the public launch tree.

## Related docs

- [MAINTAINER-MAP.md](MAINTAINER-MAP.md)
- [PACKAGE-STATUS.md](PACKAGE-STATUS.md)
- [PRODUCTION-READY.md](PRODUCTION-READY.md)
