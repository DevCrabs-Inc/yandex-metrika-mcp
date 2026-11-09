# Self-hosted stdio server. There is no OS keychain in a container: pass
# YANDEX_METRIKA_TOKEN, or opt in to the file store with YM_MCP_SECRET_STORE=file.
FROM node:26-slim AS build
WORKDIR /app
# Node 25+ no longer ships corepack; install the pnpm version from packageManager.
RUN npm install -g --no-audit --no-fund pnpm@10.33.2
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

FROM node:26-slim
ENV NODE_ENV=production \
    YM_MCP_DATA_DIR=/data
WORKDIR /app
COPY --from=build /app/dist ./dist
# The bundle is ESM; without "type": "module" Node warns on every start.
RUN echo '{"private":true,"type":"module"}' > package.json \
    && npm install --omit=dev --no-package-lock --no-audit --no-fund @napi-rs/keyring@2.1.2 \
    && mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
ENTRYPOINT ["node", "/app/dist/cli.js"]
