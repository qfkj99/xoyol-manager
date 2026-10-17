# Build native SQLite dependencies on the same Linux/Node base as the runtime.
FROM node:22-bookworm-slim AS server-build
WORKDIR /app/server
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY server/package*.json ./
RUN npm install --include=dev --no-audit --no-fund
COPY server/tsconfig.json ./
COPY server/src ./src
RUN npm run build \
    && npm prune --omit=dev --no-audit --no-fund

FROM node:22-bookworm-slim AS web-build
WORKDIR /app/web
COPY web/package*.json ./
RUN npm install --include=dev --no-audit --no-fund
COPY web/ ./
RUN npm run build

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production \
    PORT=3000 \
    DB_PATH=/app/data/outlook.db \
    COOKIE_SECURE=true
WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates gosu \
    && rm -rf /var/lib/apt/lists/*
COPY --from=server-build /app/server/package.json ./server/package.json
COPY --from=server-build /app/server/node_modules ./server/node_modules
COPY --from=server-build /app/server/dist ./server/dist
COPY --from=web-build /app/web/dist ./web/dist
COPY docker/entrypoint.sh /usr/local/bin/xoyol-entrypoint
# Keep archives uploaded from Windows usable even when their shell script has CRLF.
RUN sed -i 's/\r$//' /usr/local/bin/xoyol-entrypoint \
    && chmod 755 /usr/local/bin/xoyol-entrypoint \
    && mkdir -p /app/data \
    && chown node:node /app/data
EXPOSE 3000
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:3000/api/health', { signal: AbortSignal.timeout(4000) }).then(r => { if (!r.ok) process.exit(1); }).catch(() => process.exit(1));"
ENTRYPOINT ["xoyol-entrypoint"]
CMD ["node", "server/dist/server.js"]
