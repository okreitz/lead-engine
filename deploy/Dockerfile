# syntax=docker/dockerfile:1
# Build from the repo root: docker build -f deploy/Dockerfile --target engine .
# Two runtime targets share one build stage: `engine` (API :4501 + collector :4511) and `web` (:4500).

FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable
WORKDIR /app

FROM base AS build
# better-sqlite3 may compile from source when no prebuilt binary matches.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @le/engine build && pnpm --filter @le/web build
# Self-contained production node_modules for the engine.
RUN pnpm --filter @le/engine deploy --prod --legacy /out/engine

FROM node:22-bookworm-slim AS engine
ENV NODE_ENV=production \
    LE_HOST=0.0.0.0 \
    LE_DB_PATH=/data/le.db
WORKDIR /app
COPY --from=build /out/engine/package.json ./package.json
COPY --from=build /out/engine/node_modules ./node_modules
COPY --from=build /app/apps/engine/dist ./dist
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 4501 4511
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD ["node", "-e", "fetch('http://127.0.0.1:4501/api/v1/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "dist/index.js"]

FROM node:22-bookworm-slim AS web
ENV NODE_ENV=production \
    HOSTNAME=0.0.0.0 \
    PORT=4500 \
    NEXT_TELEMETRY_DISABLED=1
WORKDIR /app
COPY --from=build --chown=node:node /app/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /app/apps/web/.next/static ./apps/web/.next/static
USER node
EXPOSE 4500
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD ["node", "-e", "fetch('http://127.0.0.1:4500/login').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "apps/web/server.js"]
