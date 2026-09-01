# syntax=docker/dockerfile:1
#
# Memongo API server — production image.
#
# Multi-stage build using Turborepo prune to extract only apps/api and its
# workspace dependencies (@memongo/memory-bridge, @memongo/memory-engine,
# @memongo/lib), then build to JS via tsc and run with plain Node (no tsx).
#
# Build:
#   docker build -t memongo-api -f apps/api/Dockerfile .
# Run (connects to Atlas or any MongoDB via MEMONGO_MONGODB_URI):
#   docker run -p 3847:3847 -e MEMONGO_MONGODB_URI="mongodb+srv://..." \
#     -e MEMONGO_API_KEY="your-long-random-token" memongo-api
#
# Runtime env:
#   MEMONGO_MONGODB_URI       — MongoDB connection string (required)
#   MEMONGO_MONGODB_DATABASE  — database name (default: memongo)
#   MEMONGO_API_KEY           — bearer token (required; no default)

ARG NODE_VERSION=22

# ─── Stage 1: Prune the monorepo to apps/api + its deps ────────────
FROM node:${NODE_VERSION}-slim AS prepare
WORKDIR /app
RUN npm install -g turbo@^2
COPY . .
RUN turbo prune --docker @memongo/api

# ─── Stage 2: Install deps + build ─────────────────────────────────
FROM oven/bun:1-debian AS installer
WORKDIR /app

# Install dependencies from the pruned lockfile (Bun understands workspace: protocol)
COPY --from=prepare /app/out/json/ .
COPY --from=prepare /app/out/bun.lock ./bun.lock
RUN bun install --frozen-lockfile

# Copy full source (pruned) and build. turbo prune's out/full/ omits
# root-level tsconfig.base.json, so copy it explicitly for the build.
COPY --from=prepare /app/out/full/ .
COPY turbo.json turbo.json
COPY tsconfig.base.json tsconfig.base.json
RUN bun run turbo build --filter=@memongo/api...

# ─── Stage 3: Minimal production runner ────────────────────────────
FROM node:${NODE_VERSION}-slim AS runner
WORKDIR /app

# Don't run as root (node:slim already ships a 'node' user with UID 1001)
USER node

# Copy built app + node_modules
COPY --from=installer --chown=node:node /app/apps/api/dist ./apps/api/dist
COPY --from=installer --chown=node:node /app/apps/api/package.json ./apps/api/package.json
COPY --from=installer --chown=node:node /app/packages ./packages
COPY --from=installer --chown=node:node /app/node_modules ./node_modules
COPY --from=installer --chown=node:node /app/package.json ./package.json

USER node

EXPOSE 3847
ENV NODE_ENV=production
# Default to loopback for safety. Operators binding to 0.0.0.0 must also
# set MEMONGO_API_KEY or explicitly accept the risk with
# MEMONGO_ALLOW_INSECURE_NO_AUTH=true and MEMONGO_ALLOW_INSECURE_REMOTE=true.
ENV MEMONGO_API_HOST=127.0.0.1
ENV MEMONGO_API_PORT=3847

HEALTHCHECK --interval=30s --timeout=5s --retries=3 --start-period=40s \
  CMD node -e "fetch('http://127.0.0.1:3847/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "apps/api/dist/server.js"]
