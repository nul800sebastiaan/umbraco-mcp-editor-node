# syntax=docker/dockerfile:1
ARG NODE_VERSION=24

# --- build: fetch pinned upstream Editor MCP source, bundle into dist/server.js ---
FROM node:${NODE_VERSION}-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
# v18.0.2 = Umbraco 18, v17.6.2 = Umbraco 17
ARG EDITOR_MCP_REF=v18.0.2
COPY package.json ./
COPY locks ./locks
COPY scripts ./scripts
# Fetches the Editor MCP source for the chosen Umbraco major, aligns mcp-dev/zod to it, installs.
RUN EDITOR_MCP_REF=${EDITOR_MCP_REF} bash scripts/sync-editor.sh
COPY tsconfig.json tsup.config.ts ./
COPY src ./src
RUN npm run build && npm prune --omit=dev --ignore-scripts

# --- runtime ---
FROM node:${NODE_VERSION}-slim
ENV NODE_ENV=production PORT=8787 DATA_DIR=/data TRUST_PROXY=true
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=3s CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/server.js"]
