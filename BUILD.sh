#!/usr/bin/env bash
# Build the PgCloud images on this machine (for its own CPU architecture).
#   ./BUILD.sh                      -> the 4 images: launcher, db, pgpool, pgbouncer
#   ./BUILD.sh launcher db          -> only some of them
#   ./BUILD.sh --platform linux/amd64   -> another architecture (docker buildx, loaded locally)
#   ./BUILD.sh --no-cache           -> rebuild everything
# Tags: <PGCLOUD_HUB>/pgcloud-<name>:<version> and :latest (default zhenglinlei, version from
# tools/pgcloud-launcher/package.json). Then: ./RUN.sh --local, ./EXPORT.sh tar or ./EXPORT.sh hub.
set -euo pipefail
cd "$(dirname "$0")"
. scripts/lib.sh
load_env

PLATFORM="${PLATFORM:-}"
EXTRA=()
NAMES=()

while [ $# -gt 0 ]; do
  case "$1" in
    --platform) PLATFORM="$2"; shift ;;
    --no-cache) EXTRA+=(--no-cache) ;;
    -h|--help) usage; exit 0 ;;
    -*) die "unknown option: $1 (see ./BUILD.sh --help)" ;;
    *) NAMES+=("$1") ;;
  esac
  shift
done

need_docker
pgcloud_defaults
IMAGES="$(select_images "${NAMES[@]+"${NAMES[@]}"}")"
[[ "$PLATFORM" == *,* ]] && die "one platform at a time here; for amd64 + arm64 use ./EXPORT.sh hub"

BUILD=(docker build)
[ -n "$PLATFORM" ] && BUILD=(docker buildx build --load --platform "$PLATFORM")

start=$(date +%s)
for name in $IMAGES; do
  repo="$(image_repo "$name")"
  info "Building ${repo}:${PGCLOUD_VERSION}${PLATFORM:+ ($PLATFORM)}"
  # Build context = repository root (the Dockerfiles copy from static/ and docker/)
  "${BUILD[@]}" -f "$(image_dockerfile "$name")" \
    "${EXTRA[@]+"${EXTRA[@]}"}" \
    -t "${repo}:${PGCLOUD_VERSION}" -t "${repo}:latest" \
    .
done

info "Ready in $(( $(date +%s) - start ))s:"
for name in $IMAGES; do
  docker image ls "$(image_repo "$name"):${PGCLOUD_VERSION}" --format '{{.Repository}}:{{.Tag}}  {{.Size}}' | sed 's/^/   /'
done
info "Next: ./RUN.sh --local (launcher), ./EXPORT.sh tar (archives) or ./EXPORT.sh hub (Docker Hub)"
