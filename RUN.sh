#!/usr/bin/env bash
# Start the PgCloud Launcher (web UI on http://localhost:8080).
#   ./RUN.sh                 -> image from Docker Hub (<PGCLOUD_HUB>/pgcloud-launcher:<version>), pulled if missing
#   ./RUN.sh --local         -> image built on this machine with ./BUILD.sh launcher
#   ./RUN.sh --pull          -> pull the Docker Hub image again (update), then start
#   ./RUN.sh -t latest       -> another tag
#   ./RUN.sh -p 9090         -> another port
#   ./RUN.sh --password X    -> fixed admin password (otherwise generated and printed on first start)
#   ./RUN.sh -f              -> foreground (Ctrl+C stops it)
#   ./RUN.sh --logs | --stop -> follow the logs / stop and remove the container (data is kept)
# Data (topology, settings, encrypted secrets) lives in the Docker volume LAUNCHER_VOLUME (default
# pgcloud-launcher), so stopping or updating keeps it. ./CLEAN.sh --launcher --data deletes it.
set -euo pipefail
cd "$(dirname "$0")"
. scripts/lib.sh
load_env

SOURCE=hub
PULL=false
ACTION=run
MODE=(-d --restart unless-stopped)
PORT="${LAUNCHER_PORT:-8080}"
TAG=""
PASSWORD="${LAUNCHER_ADMIN_PASSWORD:-}"
CONTAINER="${LAUNCHER_CONTAINER:-pgcloud-launcher}"
VOLUME="${LAUNCHER_VOLUME:-pgcloud-launcher}"

while [ $# -gt 0 ]; do
  case "$1" in
    --local|--build) SOURCE=local ;;
    --hub) SOURCE=hub ;;
    --pull) PULL=true ;;
    -t|--tag) TAG="$2"; shift ;;
    -p|--port) PORT="$2"; shift ;;
    --password) PASSWORD="$2"; shift ;;
    -f|--foreground) MODE=(--rm -it) ;;
    --logs) ACTION=logs ;;
    --stop) ACTION=stop ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown option: $1 (see ./RUN.sh --help)" ;;
  esac
  shift
done

need_docker
pgcloud_defaults
IMAGE="$(image_repo launcher):${TAG:-$PGCLOUD_VERSION}"

case "$ACTION" in
  logs) exec docker logs -f "$CONTAINER" ;;
  stop)
    if docker rm -f "$CONTAINER" >/dev/null 2>&1; then info "Stopped $CONTAINER (data kept in volume $VOLUME)"; else info "$CONTAINER is not running"; fi
    exit 0 ;;
esac

if [ "$SOURCE" = local ]; then
  docker image inspect "$IMAGE" >/dev/null 2>&1 || die "image $IMAGE does not exist. Run ./BUILD.sh launcher first."
  info "Using the local image $IMAGE"
elif $PULL || ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  info "Pulling $IMAGE from Docker Hub"
  docker pull "$IMAGE" || die "cannot pull $IMAGE. Build it with ./BUILD.sh launcher and use ./RUN.sh --local"
fi

# Replace a previous container (the volume, and so the data, is kept).
if docker container inspect "$CONTAINER" >/dev/null 2>&1; then
  info "Replacing the existing container $CONTAINER (data in volume $VOLUME is kept)"
  docker rm -f "$CONTAINER" >/dev/null
fi

ENV_ARGS=()
[ -n "$PASSWORD" ] && ENV_ARGS+=(-e "LAUNCHER_ADMIN_PASSWORD=$PASSWORD")
for name in LAUNCHER_SECRET_KEY LAUNCHER_SECURE_COOKIES LOG_LEVEL; do
  [ -n "${!name:-}" ] && ENV_ARGS+=(-e "$name=${!name}")
done

docker run "${MODE[@]}" \
  --name "$CONTAINER" \
  -p "${PORT}:8080" \
  -v "${VOLUME}:/data" \
  "${ENV_ARGS[@]+"${ENV_ARGS[@]}"}" \
  "$IMAGE" >/dev/null

[ "${MODE[0]}" = -d ] || exit 0
for _ in $(seq 1 30); do
  curl -fs "http://localhost:${PORT}/api/health" >/dev/null 2>&1 && break
  sleep 1
done
info "PgCloud Launcher is running: http://localhost:${PORT}"
if [ -n "$PASSWORD" ]; then
  info "Admin password: the one you passed with --password / LAUNCHER_ADMIN_PASSWORD"
else
  generated="$(docker logs "$CONTAINER" 2>&1 | sed -n 's/.*admin password: *\([A-Za-z0-9_-]*\).*/\1/p' | tail -1)"
  if [ -n "$generated" ]; then
    info "Admin password (first start): $generated"
  else
    info "Admin password: the one already saved in volume $VOLUME (docker exec $CONTAINER cat /data/admin-password.txt)"
  fi
fi
info "Logs: ./RUN.sh --logs   Stop: ./RUN.sh --stop"
