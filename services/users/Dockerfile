# syntax=docker/dockerfile:1
# Imagen de @juez/users. Contexto = raíz del repo:
#   docker build -f services/users/Dockerfile -t juez-users .
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
COPY services/users ./services/users
# Solo users y sus dependencias del workspace (@juez/contracts, @juez/config).
RUN pnpm install --frozen-lockfile --filter "@juez/users..."
RUN pnpm --filter @juez/contracts run generate \
 && pnpm --filter "@juez/users..." run build
# Paquete autocontenido con dependencias de producción (incluye @juez/contracts compilado).
RUN pnpm --filter @juez/users deploy --prod /out

# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /out ./
USER node
EXPOSE 8081 50051
HEALTHCHECK --interval=10s --timeout=3s --start-period=15s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.USERS_HTTP_PORT || 8081) + '/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
# Migraciones (one-off): docker run --rm <imagen> node dist/migrate.js
CMD ["node", "dist/main.js"]
