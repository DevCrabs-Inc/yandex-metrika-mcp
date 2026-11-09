# Self-hosted stdio server. There is no OS keychain in a container: pass
# YANDEX_METRIKA_TOKEN, or opt in to the file store with YM_MCP_SECRET_STORE=file.
FROM node:22-slim AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

FROM node:22-slim
ENV NODE_ENV=production \
    YM_MCP_DATA_DIR=/data
WORKDIR /app
COPY --from=build /app/dist ./dist
RUN npm install --omit=dev --no-package-lock --no-audit --no-fund @napi-rs/keyring@2.1.2 \
    && mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
ENTRYPOINT ["node", "/app/dist/cli.js"]
