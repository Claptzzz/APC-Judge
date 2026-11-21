# syntax=docker/dockerfile:1
# Imagen de @juez/ranking. Contexto = raíz del repo:
#   docker build -f services/ranking/Dockerfile -t juez-ranking .
# Los archivos excluidos del contexto están en Dockerfile.dockerignore (junto a este archivo).
ARG NODE_IMAGE=node:26.13.0-trixie-slim

FROM ${NODE_IMAGE} AS base
ENV CI=true
RUN npm install -g pnpm@12.18.0 --allow-scripts=pnpm

# ---------------------------------------------------------------------------
FROM base AS build
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml buf.yaml ./
COPY proto ./proto
COPY packages/config ./packages/config
COPY packages/contracts ./packages/contracts
COPY services/ranking ./services/ranking
# Solo ranking y sus dependencias del workspace (@juez/contracts, @juez/config).
RUN pnpm install --frozen-lockfile --filter "@juez/ranking..."
RUN pnpm --filter @juez/contracts run generate \
 && pnpm --filter "@juez/ranking..." run build
# Paquete autocontenido con dependencias de producción (incluye @juez/contracts compilado).
RUN pnpm --filter @juez/ranking deploy --prod /out

# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /out ./
USER node
EXPOSE 8084 50054
HEALTHCHECK --interval=10s --timeout=3s --start-period=15s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.RANKING_HTTP_PORT || 8084) + '/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
# Migraciones (one-off):  docker run --rm <imagen> node dist/migrate.js
# Rebuild de Redis:       docker run --rm <imagen> node dist/scripts/rebuild.js
CMD ["node", "dist/main.js"]
