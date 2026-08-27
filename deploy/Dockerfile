# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e

ARG NODE_IMAGE=node:22.20.0-bookworm-slim@sha256:b21fe589dfbe5cc39365d0544b9be3f1f33f55f3c86c87a76ff65a02f8f5848e

FROM ${NODE_IMAGE} AS dependencies
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

# Keep native better-sqlite3 compilation reproducible when no matching prebuild exists.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit --no-fund

FROM ${NODE_IMAGE} AS builder
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1

COPY --from=dependencies /app/node_modules ./node_modules
COPY . .
RUN mkdir -p public && npm run build

FROM ${NODE_IMAGE} AS runner
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    NODE_OPTIONS=--max-old-space-size=256 \
    HOSTNAME=0.0.0.0 \
    PORT=3000

COPY --from=builder --chown=node:node /app/.next/standalone ./
COPY --from=builder --chown=node:node /app/.next/static ./.next/static
COPY --from=builder --chown=node:node /app/public ./public
COPY --from=builder --chown=node:node /app/scripts/healthcheck.mjs ./scripts/healthcheck.mjs
COPY --from=builder --chown=node:node /app/scripts/ingress-gate-store.mjs ./scripts/ingress-gate-store.mjs
COPY --from=builder --chown=node:node /app/scripts/ingress-gate-http.mjs ./scripts/ingress-gate-http.mjs
COPY --from=builder --chown=node:node /app/scripts/ingress-gate.mjs ./scripts/ingress-gate.mjs
COPY --from=builder --chown=node:node /app/scripts/validate-release-archive.py ./scripts/validate-release-archive.py

RUN mkdir -p /var/lib/claimgate .next/cache \
  && chown -R node:node /var/lib/claimgate .next

USER node
RUN node -e "const Database=require('better-sqlite3');const database=new Database(':memory:');const row=database.prepare('SELECT 1 AS value').get();database.close();if(row.value!==1)process.exit(1)"
EXPOSE 3000
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=6s --start-period=30s --retries=3 \
  CMD ["node", "scripts/healthcheck.mjs", "http://127.0.0.1:3000"]
CMD ["node", "server.js"]
