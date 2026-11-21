# Imagen del MCP server. Se construye con el contexto en la RAÍZ del repo:
#   docker build -f services/mcp/Dockerfile -t juez-mcp .
# Con BuildKit (buildx, como en CI), services/mcp/Dockerfile.dockerignore recorta el
# contexto. El builder legado lo ignora; por eso se borran los artefactos del host abajo.

ARG NODE_IMAGE=node:26-trixie-slim

# ---------------------------------------------------------------------------
# build: instala el workspace filtrado, genera @juez/contracts y compila el mcp
# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS build
ENV CI=true
# --allow-scripts=pnpm: npm >= 12 bloquea los scripts de instalación globales (binario nativo).
RUN npm install -g pnpm@12.18.0 --allow-scripts=pnpm
WORKDIR /repo
COPY . .
RUN find . -name node_modules -type d -prune -exec rm -rf {} + \
 && rm -rf packages/contracts/src/gen packages/contracts/dist services/mcp/dist
RUN pnpm install --frozen-lockfile --filter "@juez/mcp..."
RUN pnpm --filter @juez/contracts run generate \
 && pnpm --filter "@juez/mcp..." run build
RUN pnpm --filter @juez/mcp deploy --prod /out

# ---------------------------------------------------------------------------
# runtime: solo Node y el paquete desplegado; usuario no-root
# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    MCP_PORT=4100
WORKDIR /app
COPY --from=build --chown=root:root /out ./
# La imagen oficial de Node trae el usuario `node` (uid 1000).
USER node
EXPOSE 4100
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.MCP_PORT || 4100) + '/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "dist/main.js"]
