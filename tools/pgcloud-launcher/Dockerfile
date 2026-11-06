# PgCloud Launcher: web UI + API to design, deploy and monitor PgCloud clusters over SSH.
#
#   docker build -t pgcloud/launcher .
#   docker run -d --name pgcloud-launcher -p 8080:8080 -v pgcloud-launcher:/data pgcloud/launcher

# ---------------------------------------------------------------- build
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.server.json tsconfig.web.json vite.config.ts ./
COPY shared ./shared
COPY server ./server
COPY web ./web
RUN npm run build && npm prune --omit=dev

# ---------------------------------------------------------------- runtime
FROM node:22-alpine
LABEL org.opencontainers.image.title="pgcloud-launcher" \
      org.opencontainers.image.description="Visual launcher for PgCloud clusters (PostgreSQL + Pgpool-II + PgBouncer)" \
      org.opencontainers.image.source="https://github.com/ZhengLinLei/pgcloud" \
      org.opencontainers.image.licenses="GPL-3.0"

ENV NODE_ENV=production \
    DATA_DIR=/data \
    PORT=8080 \
    HOST=0.0.0.0

WORKDIR /app
RUN addgroup -S launcher && adduser -S -G launcher launcher \
    && mkdir -p /data && chown launcher:launcher /data
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist

USER launcher
VOLUME ["/data"]
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:8080/api/health >/dev/null || exit 1

CMD ["node", "--disable-warning=ExperimentalWarning", "dist/server/index.js"]
