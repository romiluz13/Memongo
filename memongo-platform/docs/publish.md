# Publishing Memongo + Memongo platform

See [PRODUCTION-READY.md](PRODUCTION-READY.md) for the full pre-release checklist.

## `@romiluz/memongo` (engine)

1. Run full repo checks: `pnpm check`, `pnpm test`, `pnpm build`.
2. `npm publish --access public` from the repository root (or your maintainer pipeline).
3. Ensure `dist/memongo-bridge.js` is included in the published tarball (`package.json` `files` includes `dist/`).

## `@romiluz/memongo-platform` (SDK / product)

1. In `memongo-platform/apps/api`, set the engine dependency to a **semver** range, for example:
   `pnpm add @romiluz/memongo@^2026.3.29`
2. Optionally compile the SDK to `dist/` and point `package.json` `exports["."]` at `./dist/index.js` for consumers who do not want TypeScript source.
3. Publish from `memongo-platform/` (or split to a dedicated repo) with `npm publish --access public`.

## Docker

The sample `memongo-platform/Dockerfile` expects a published engine on npm. For private builds, multi-stage `COPY` your built `@romiluz/memongo` into `node_modules` or use `pnpm pack` tarballs.
