# Imagen del judge. Se construye con el contexto en la RAÍZ del repo:
#   docker build -f services/judge/Dockerfile -t juez-judge .
# Con BuildKit (buildx, como en CI), services/judge/Dockerfile.dockerignore recorta el
# contexto. El builder legado lo ignora; por eso se borran los artefactos del host abajo.

ARG NODE_IMAGE=node:26-trixie-slim

# ---------------------------------------------------------------------------
# build: instala el workspace filtrado, genera @juez/contracts y compila el judge
# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS build
ENV CI=true
# --allow-scripts=pnpm: npm >= 12 bloquea los scripts de instalación globales (binario nativo).
RUN npm install -g pnpm@12.18.0 --allow-scripts=pnpm
WORKDIR /repo
COPY . .
RUN find . -name node_modules -type d -prune -exec rm -rf {} + \
 && rm -rf packages/contracts/src/gen packages/contracts/dist services/judge/dist
RUN pnpm install --frozen-lockfile --filter "@juez/judge..."
RUN pnpm --filter @juez/contracts run generate \
 && pnpm --filter "@juez/judge..." run build
RUN pnpm --filter @juez/judge deploy --prod /out

# ---------------------------------------------------------------------------
# runtime: g++, python3, GNU time y util-linux (prlimit, unshare); usuario no-root
# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime
RUN apt-get update \
 && apt-get install -y --no-install-recommends g++ python3 time util-linux \
 && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production \
    JUDGE_HTTP_PORT=8085 \
    JUDGE_WORKDIR=/tmp/juez-judge
WORKDIR /app
COPY --from=build --chown=root:root /out ./
# La imagen oficial de Node trae el usuario `node` (uid 1000).
USER node
EXPOSE 8085
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.JUDGE_HTTP_PORT || 8085) + '/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "dist/main.js"]
