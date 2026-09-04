# Memongo HTTP API service image.
#
# Stage 1 (oven/bun): resolve the workspace lockfile and install production
# dependencies for the API slice only (api + its workspace closure).
# Stage 2 (node): run the API from source with tsx, matching the documented
# Node 20+ runtime on the current LTS.
#
# Runtime env (see .env.example): MEMONGO_MONGODB_URI and MEMONGO_API_KEY are
# required and validated before the port binds. Set MEMONGO_API_HOST=0.0.0.0
# when other containers must reach the API.
# Liveness: GET /health. Readiness: GET /ready (503 until lanes pass).

FROM oven/bun:1.3.13 AS build
WORKDIR /app

# Manifests and workspaces first so dependency layers cache independently.
COPY package.json bun.lock turbo.json tsconfig.json tsconfig.base.json ./
COPY apps/ /app/apps/
COPY packages/ /app/packages/
COPY scripts/ /app/scripts/

# Full install: the compiler toolchain (typescript, turbo) is a devDependency.
RUN bun install --frozen-lockfile

# Build the API slice and its workspace closure (lib, memory-bridge, ...).
# Workspace packages resolve through their dist/ builds at runtime.
RUN bunx turbo run build --filter '@memongo/api...'

# Prune back to the API's production dependency set; dist/ outputs live in
# the workspace directories and survive the reinstall. The full install's
# node_modules is wiped first: bun does not reconcile extraneous packages
# when re-running a filtered install over an existing tree.
FROM oven/bun:1.3.13 AS prune
WORKDIR /app
COPY --from=build /app /app
RUN rm -rf node_modules \
	&& bun install --frozen-lockfile --production --filter '@memongo/api'

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=prune /app /app

EXPOSE 3847
HEALTHCHECK --interval=10s --timeout=5s --start-period=20s --retries=12 \
	CMD node -e "fetch('http://127.0.0.1:'+(process.env.MEMONGO_API_PORT||'3847')+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "--import", "tsx", "apps/api/src/server.ts"]
