# Serveur central FEDONIX 360 pour un serveur loué (VPS) : base intégrée, sauvegardes
# quotidiennes dans /data. Construit depuis la racine du dépôt :
#   docker build -f deploy/Dockerfile -t fedonix360-serveur .
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY apps/server/package.json apps/server/
COPY apps/server-app/package.json apps/server-app/
COPY apps/desktop/package.json apps/desktop/
COPY apps/inventory/package.json apps/inventory/
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
RUN npm ci --workspace @superette/server --include-workspace-root --ignore-scripts --no-audit --no-fund
COPY apps/server apps/server
COPY apps/server-app/build/icon.png apps/server-app/build/icon.png
RUN npm run build -w @superette/server && npm prune --omit=dev --workspace @superette/server --include-workspace-root --ignore-scripts

FROM node:22-bookworm-slim
ENV NODE_ENV=production DATA_DIR=/data/base BACKUP_DIR=/data/sauvegardes UPDATES_DIR=/data/mises-a-jour PORT=3000
WORKDIR /app
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/apps/server/package.json apps/server/package.json
COPY --from=build /app/apps/server/dist apps/server/dist
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD node -e "fetch('http://127.0.0.1:3000/').then((r)=>process.exit(r.status<500?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/server/dist/main.js"]
