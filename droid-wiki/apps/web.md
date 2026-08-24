# Web console

Active contributors: Rom Iluz

`apps/web` is a Next.js 15 app with two jobs: a marketing landing page at `/` and an operator console at `/console` for exercising a running `apps/api` instance by hand. It is also the public "Live Site" linked from the repo README (`https://memongo.rom-88f.workers.dev`).

## Landing page

`apps/web/app/page.tsx` renders the product's public pitch — hero section, memory-layer explainer, capability tiles, and a quickstart code sample — with GSAP-driven scroll animations (`ScrollTrigger`) that are skipped entirely when `prefers-reduced-motion: reduce` is set. `apps/web/app/layout.tsx` sets the page's `<title>`, description, and Open Graph/Twitter metadata, hardcoding `siteUrl` to the Cloudflare Workers deployment. `apps/web/app/globals.css` holds the hand-rolled CSS for the landing page (no CSS framework).

## Operator console

`apps/web/app/console/page.tsx` is a single client component (`"use client"`) that wraps `@memongo/client`'s `MemongoClient` in a form-driven UI. An operator sets the API base URL, an optional bearer API key, an agent ID, and a session/scope value, then switches between five tabs — Overview, Search, KB, Profile, Write — each calling one `MemongoClient` method (or a raw `fetch` for `/health` and `/openapi.json`) and rendering the JSON response in a pre-formatted output pane. There is no server-side state; every action is a direct client-side call to the configured API.

The console's default API base URL comes from `NEXT_PUBLIC_MEMONGO_API_URL`, falling back to `http://127.0.0.1:3847` (`apps/web/app/console/page.tsx:8-9`) — this is a Next.js public env var, so it must be set at build time to point at a non-local API, not just at runtime. The base URL field in the UI can override it per-session without a rebuild.

## Deployment: Cloudflare Workers via OpenNext

The app builds as a normal Next.js app but deploys to Cloudflare Workers, not Vercel or Node hosting:

- `apps/web/open-next.config.ts` calls `defineCloudflareConfig()` from `@opennextjs/cloudflare`, which adapts the Next.js build output (server components, route handlers, static assets) into a Cloudflare Workers-compatible bundle under `.open-next/`.
- `apps/web/wrangler.jsonc` points Wrangler at that bundle (`main: ".open-next/worker.js"`), binds the static assets directory (`.open-next/assets`) to `ASSETS`, and declares a `WORKER_SELF_REFERENCE` service binding (the worker can invoke itself, which OpenNext uses for some Next.js runtime behaviors like ISR revalidation). `compatibility_flags` enables Node.js compatibility APIs in the Workers runtime.
- `apps/web/next.config.ts` also supports a static-export mode gated by `MEMONGO_WEB_STATIC_EXPORT=true` (sets `output: "export"` and unoptimized images), and pins `outputFileTracingRoot` to the monorepo root and `transpilePackages: ["@memongo/client"]` so the workspace package builds correctly inside Next's bundler.

`apps/web/package.json` scripts:

| Script | Command | Purpose |
|---|---|---|
| `dev` | `next dev -p 3040` | Local dev server on port 3040 |
| `build` | `next build` | Standard Next.js production build |
| `preview` | `opennextjs-cloudflare build && wrangler dev` | Build the Workers bundle and run it locally under Wrangler |
| `deploy` | `opennextjs-cloudflare build && opennextjs-cloudflare deploy` | Build and publish to Cloudflare Workers |

See [Deployment](../deployment.md) for the CI/release side of shipping this app, and [Getting started](../overview/getting-started.md) for the local dev command (`cd apps/web && bun run dev`, served at `http://127.0.0.1:3040`).

## Modifying the console

To add a new console action (e.g. a new API operation), add a tab to the `Tab` union and the tab-button list in `apps/web/app/console/page.tsx`, then extend `runCurrentTab()` with a branch that calls the corresponding `MemongoClient` method — see [API](../apps/api/index.md) for the routes it can call.

## Key source files

| File | Role |
|---|---|
| `apps/web/app/page.tsx` | Public landing page, GSAP scroll animations |
| `apps/web/app/layout.tsx` | Root layout, page metadata, Open Graph/Twitter tags |
| `apps/web/app/console/page.tsx` | Operator console: connection form, tabbed actions, output pane |
| `apps/web/app/globals.css` | Landing page and console styling |
| `apps/web/next.config.ts` | Next.js config: static export toggle, workspace path tracing |
| `apps/web/open-next.config.ts` | OpenNext Cloudflare adapter entry point |
| `apps/web/wrangler.jsonc` | Cloudflare Workers deployment config (bundle, assets, bindings) |
| `apps/web/package.json` | Scripts for dev, build, preview, and deploy |
