# syntax=docker/dockerfile:1
# Imagen de @juez/problems. El contexto es la RAÍZ del repo:
#   docker build -f services/problems/Dockerfile -t juez-problems .
# Las exclusiones del contexto están en services/problems/Dockerfile.dockerignore (BuildKit).

ARG NODE_IMAGE=node:26.13.0-alpine

# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS build
# Node 26 no trae corepack: pnpm se instala con npm (ver CLAUDE.md).
RUN npm install -g pnpm@12.18.0 --allow-scripts=pnpm
WORKDIR /repo

# 1) Descarga de dependencias cacheable: solo depende del lockfile.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
RUN pnpm fetch

# 2) Fuentes necesarias: contratos (proto + generador), config compartida y el servicio.
COPY buf.yaml ./
COPY proto ./proto
COPY packages/config ./packages/config
COPY packages/contracts ./packages/contracts
COPY services/problems ./services/problems
RUN pnpm install --offline --frozen-lockfile --filter "@juez/problems..."

# 3) Genera y compila @juez/contracts, compila el servicio y arma un node_modules de producción.
RUN pnpm --filter @juez/contracts run generate \
 && pnpm --filter "@juez/problems..." run build \
 && pnpm --filter @juez/problems deploy --prod --legacy /out

# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /out ./
USER node
EXPOSE 8082 50052
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PROBLEMS_HTTP_PORT||8082)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
# Migraciones y seed con la misma imagen:
#   docker run --rm --env-file … juez-problems node dist/scripts/migrate.js
#   docker run --rm --env-file … juez-problems node dist/scripts/seed.js
CMD ["node", "dist/main.js"]
