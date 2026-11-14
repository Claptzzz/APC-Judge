# syntax=docker/dockerfile:1
# Imagen de @juez/submissions. Contexto = raíz del repo:
#   docker build -f services/submissions/Dockerfile -t juez-submissions .
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
COPY services/submissions ./services/submissions
# Solo submissions y sus dependencias del workspace (@juez/contracts, @juez/config).
RUN pnpm install --frozen-lockfile --filter "@juez/submissions..."
RUN pnpm --filter @juez/contracts run generate \
 && pnpm --filter "@juez/submissions..." run build
# Paquete autocontenido con dependencias de producción (incluye @juez/contracts compilado).
RUN pnpm --filter @juez/submissions deploy --prod /out

# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /out ./
USER node
EXPOSE 8083 50053
HEALTHCHECK --interval=10s --timeout=3s --start-period=15s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.SUBMISSIONS_HTTP_PORT || 8083) + '/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
# Migraciones (one-off): docker run --rm <imagen> node dist/migrate.js
CMD ["node", "dist/main.js"]
