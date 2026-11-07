#!/usr/bin/env bash
# Export the PgCloud images.
#   ./EXPORT.sh tar                 -> dist/pgcloud-nodes-<version>.tar.gz (db, pgpool, pgbouncer: upload it in
#                                      the launcher, Settings > Images > tar.gz) and dist/pgcloud-launcher-<version>.tar.gz
#   ./EXPORT.sh tar db pgpool       -> only these images, in one archive
#   ./EXPORT.sh hub                 -> build for linux/amd64 + linux/arm64 and push to Docker Hub with the tags
#                                      <version>, <major.minor> and latest (run docker login first)
#   ./EXPORT.sh hub launcher        -> only some images
#   ./EXPORT.sh hub --local         -> push the images built by ./BUILD.sh as they are (this machine's architecture)
#   ./EXPORT.sh hub --no-latest     -> do not move the latest tag (pre-releases)
# tar needs the images from ./BUILD.sh. On a server: gunzip -c file.tar.gz | docker load
set -euo pipefail
cd "$(dirname "$0")"
. scripts/lib.sh
load_env

MODE="${1:-}"
[ $# -gt 0 ] && shift
LOCAL=false
LATEST=true
NAMES=()
while [ $# -gt 0 ]; do
  case "$1" in
    --local) LOCAL=true ;;
    --no-latest) LATEST=false ;;
    -h|--help) MODE=help ;;
    -*) die "unknown option: $1 (see ./EXPORT.sh --help)" ;;
    *) NAMES+=("$1") ;;
  esac
  shift
done

case "$MODE" in
  tar|hub) ;;
  help|-h|--help) usage; exit 0 ;;
  *) usage; exit 1 ;;
esac

need_docker
pgcloud_defaults
IMAGES="$(select_images "${NAMES[@]+"${NAMES[@]}"}")"

require_local() {
  local name
  for name in $IMAGES; do
    docker image inspect "$(image_repo "$name"):${PGCLOUD_VERSION}" >/dev/null 2>&1 \
      || die "image $(image_repo "$name"):${PGCLOUD_VERSION} does not exist. Run ./BUILD.sh $name first."
  done
}

# save_archive <file> <names...>
save_archive() {
  local out="$1" refs=() name
  shift
  for name in "$@"; do refs+=("$(image_repo "$name"):${PGCLOUD_VERSION}"); done
  info "Saving ${refs[*]} -> $out"
  docker save "${refs[@]}" | gzip >"$out"
  info "Ready: $out ($(du -h "$out" | cut -f1))"
}

if [ "$MODE" = tar ]; then
  require_local
  mkdir -p dist
  nodes="" launcher=""
  for name in $IMAGES; do
    if [ "$name" = launcher ]; then launcher=launcher; else nodes="$nodes $name"; fi
  done
  # shellcheck disable=SC2086
  [ -n "$nodes" ] && save_archive "dist/pgcloud-nodes-${PGCLOUD_VERSION}.tar.gz" $nodes
  [ -n "$launcher" ] && save_archive "dist/pgcloud-launcher-${PGCLOUD_VERSION}.tar.gz" launcher
  if [ -n "$nodes" ]; then
    info "In the launcher: Settings > Images > tar.gz, upload the nodes archive and set"
    info "   names $(for n in $nodes; do printf '%s ' "$(image_repo "$n")"; done)  tag ${PGCLOUD_VERSION}"
  fi
  exit 0
fi

# ---- hub
MINOR="$(minor_tag "$PGCLOUD_VERSION")"
tags_for() {
  local repo="$1"
  printf '%s\n' "${repo}:${PGCLOUD_VERSION}"
  [ -n "$MINOR" ] && printf '%s\n' "${repo}:${MINOR}"
  $LATEST && printf '%s\n' "${repo}:latest"
  return 0
}
info "Pushing to Docker Hub as ${PGCLOUD_HUB}/ (tags ${PGCLOUD_VERSION}${MINOR:+, $MINOR}$($LATEST && echo ', latest'))"

if $LOCAL; then
  require_local
  for name in $IMAGES; do
    repo="$(image_repo "$name")"
    while IFS= read -r tag; do
      docker tag "${repo}:${PGCLOUD_VERSION}" "$tag"
      docker push "$tag"
    done < <(tags_for "$repo")
  done
else
  BUILDER="${PGCLOUD_BUILDER:-pgcloud-multi}"
  if ! docker buildx inspect "$BUILDER" >/dev/null 2>&1; then
    info "Creating the buildx builder $BUILDER (multi-platform)"
    docker buildx create --name "$BUILDER" --driver docker-container --bootstrap >/dev/null
  fi
  for name in $IMAGES; do
    repo="$(image_repo "$name")"
    TAG_ARGS=()
    while IFS= read -r tag; do TAG_ARGS+=(-t "$tag"); done < <(tags_for "$repo")
    info "Building and pushing ${repo} for linux/amd64 + linux/arm64 (arm64/amd64 is emulated: it takes a while)"
    docker buildx build --builder "$BUILDER" --platform linux/amd64,linux/arm64 \
      -f "$(image_dockerfile "$name")" "${TAG_ARGS[@]}" --push .
  done
fi

# shellcheck disable=SC2086
set -- $IMAGES
info "Done. Check: docker buildx imagetools inspect $(image_repo "$1"):${PGCLOUD_VERSION}"
