# PgCloud Launcher: web UI + API to design, deploy and monitor PgCloud clusters over SSH.
#
# Build context = repository root (the PgCloud sources in docker/ and static/ are bundled so the
# launcher can build the node images on each server):
#
#   docker build -t pgcloud/launcher:1.0.0 -f tools/pgcloud-launcher/Dockerfile .
#   docker run -d --name pgcloud-launcher -p 8080:8080 -v pgcloud-launcher:/data pgcloud/launcher:1.0.0

# ---------------------------------------------------------------- build
FROM node:22-alpine AS build
WORKDIR /app
COPY tools/pgcloud-launcher/package.json tools/pgcloud-launcher/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tools/pgcloud-launcher/tsconfig.server.json tools/pgcloud-launcher/tsconfig.web.json tools/pgcloud-launcher/vite.config.ts ./
COPY tools/pgcloud-launcher/shared ./shared
COPY tools/pgcloud-launcher/server ./server
COPY tools/pgcloud-launcher/web ./web
RUN npm run build && npm prune --omit=dev

# ---------------------------------------------------------------- runtime
FROM node:22-alpine
LABEL org.opencontainers.image.title="pgcloud-launcher" \
      org.opencontainers.image.description="Visual launcher for PgCloud clusters (PostgreSQL + Pgpool-II + PgBouncer)" \
      org.opencontainers.image.version="1.0.0" \
      org.opencontainers.image.source="https://github.com/ZhengLinLei/pgcloud" \
      org.opencontainers.image.licenses="GPL-3.0"

ENV NODE_ENV=production \
    DATA_DIR=/data \
    PORT=8080 \
    HOST=0.0.0.0 \
    PGCLOUD_SRC=/app/pgcloud-src

WORKDIR /app
RUN addgroup -S launcher && adduser -S -G launcher launcher \
    && mkdir -p /data && chown launcher:launcher /data
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# PgCloud build contexts for the "build on hosts" image source (no .env files: see Dockerfile.dockerignore)
COPY docker ./pgcloud-src/docker
COPY static ./pgcloud-src/static

USER launcher
VOLUME ["/data"]
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:8080/api/health >/dev/null || exit 1

CMD ["node", "--disable-warning=ExperimentalWarning", "dist/server/index.js"]
