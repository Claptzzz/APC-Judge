# syntax=docker/dockerfile:1
# Imagen de @juez/web. Contexto = raíz del repo:
#   docker build -f apps/web/Dockerfile -t juez-web .
#   docker run --rm -p 8080:8080 -e BFF_UPSTREAM=bff:4000 juez-web
# Los archivos excluidos del contexto están en Dockerfile.dockerignore (junto a este archivo).
ARG NODE_IMAGE=node:26.13.0-trixie-slim
ARG NGINX_IMAGE=nginxinc/nginx-unprivileged:1.30.6-alpine

# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS build
ENV CI=true
RUN npm install -g pnpm@12.18.0 --allow-scripts=pnpm
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/config ./packages/config
# Del paquete de contratos el front solo usa el schema GraphQL (para el codegen).
COPY packages/contracts/graphql ./packages/contracts/graphql
COPY apps/web ./apps/web
RUN pnpm install --frozen-lockfile --filter "@juez/web..."
# Vacías por defecto: el front usa /graphql relativo y nginx hace el proxy al BFF.
ARG VITE_GRAPHQL_URL=
ARG VITE_GRAPHQL_WS_URL=
RUN pnpm --filter @juez/web run build

# ---------------------------------------------------------------------------
# nginx sin root (usuario 101, puerto 8080).
FROM ${NGINX_IMAGE} AS runtime
ENV BFF_UPSTREAM=bff:4000 \
    NGINX_ENTRYPOINT_LOCAL_RESOLVERS=1
COPY apps/web/nginx/default.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /repo/apps/web/dist /usr/share/nginx/html
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD ["wget", "-q", "-O", "/dev/null", "http://127.0.0.1:8080/healthz"]
