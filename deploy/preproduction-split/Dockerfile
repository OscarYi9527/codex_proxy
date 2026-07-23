FROM node:24.16.0-bookworm-slim AS build

WORKDIR /opt/ai-editor
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
COPY gateway/package.json gateway/package.json
COPY gateway/admin-web/package.json gateway/admin-web/package.json
RUN npm ci

COPY src ./src
COPY gateway ./gateway
COPY index.js ./
RUN npm run gateway:build \
  && npm run admin:build \
  && npm prune --omit=dev

FROM node:24.16.0-bookworm-slim AS runtime

ENV NODE_ENV=preproduction
WORKDIR /opt/ai-editor
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates tini \
  && rm -rf /var/lib/apt/lists/*

COPY --from=build --chown=node:node /opt/ai-editor/package.json ./
COPY --from=build --chown=node:node /opt/ai-editor/package-lock.json ./
COPY --from=build --chown=node:node /opt/ai-editor/node_modules ./node_modules
COPY --from=build --chown=node:node /opt/ai-editor/index.js ./
COPY --from=build --chown=node:node /opt/ai-editor/src ./src
COPY --from=build --chown=node:node /opt/ai-editor/gateway/package.json ./gateway/package.json
COPY --from=build --chown=node:node /opt/ai-editor/gateway/dist ./gateway/dist
COPY --from=build --chown=node:node /opt/ai-editor/gateway/admin-web/dist ./gateway/admin-web/dist

USER node
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "gateway/dist/server.js"]
