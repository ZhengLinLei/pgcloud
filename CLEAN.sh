#!/usr/bin/env bash
# Clean the project.
#   ./CLEAN.sh              -> build leftovers: dist/ (exported archives), the launcher's build output
#                              (tools/pgcloud-launcher/dist) and .DS_Store files
#   ./CLEAN.sh --deps       -> also tools/pgcloud-launcher/node_modules
#   ./CLEAN.sh --dev        -> also the playground of ./RUN.dev.sh (containers, servers' Docker data, launcher data)
#   ./CLEAN.sh --images     -> also the PgCloud images on this machine (<PGCLOUD_HUB>/pgcloud-*, pgcloud/*:dev)
#   ./CLEAN.sh --launcher   -> also the launcher container of ./RUN.sh (its data volume is kept)
#   ./CLEAN.sh --data       -> with --launcher: also its data volume (topology, settings, secrets). Asks first.
#   ./CLEAN.sh --all        -> everything above except --data
#   ./CLEAN.sh -n           -> only show what would be removed
#   ./CLEAN.sh -y           -> don't ask
set -euo pipefail
cd "$(dirname "$0")"
. scripts/lib.sh
load_env

DRY_RUN=false
ASSUME_YES=false
CLEAN_DEPS=false
CLEAN_DEV=false
CLEAN_IMAGES=false
CLEAN_LAUNCHER=false
CLEAN_DATA=false
CONTAINER="${LAUNCHER_CONTAINER:-pgcloud-launcher}"
VOLUME="${LAUNCHER_VOLUME:-pgcloud-launcher}"

while [ $# -gt 0 ]; do
  case "$1" in
    --deps) CLEAN_DEPS=true ;;
    --dev) CLEAN_DEV=true ;;
    --images) CLEAN_IMAGES=true ;;
    --launcher) CLEAN_LAUNCHER=true ;;
    --data) CLEAN_DATA=true ;;
    --all) CLEAN_DEPS=true; CLEAN_DEV=true; CLEAN_IMAGES=true; CLEAN_LAUNCHER=true ;;
    -n|--dry-run) DRY_RUN=true ;;
    -y|--yes) ASSUME_YES=true ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown option: $1 (see ./CLEAN.sh --help)" ;;
  esac
  shift
done
$CLEAN_DATA && ! $CLEAN_LAUNCHER && die "--data deletes the launcher's data volume: use it together with --launcher"

removed=0
remove() {
  local path
  for path in "$@"; do
    [ -e "$path" ] || [ -L "$path" ] || continue
    removed=$((removed + 1))
    if $DRY_RUN; then
      printf 'would remove %s\n' "$path"
    else
      rm -rf -- "$path"
      printf 'removed %s\n' "$path"
    fi
  done
}
# run "description" cmd... : runs a Docker command (or only prints it with -n)
run() {
  local what="$1"
  shift
  removed=$((removed + 1))
  if $DRY_RUN; then
    printf 'would remove %s\n' "$what"
  elif "$@" >/dev/null 2>&1; then
    printf 'removed %s\n' "$what"
  else
    warn "could not remove $what"
  fi
}

info "Build leftovers"
remove dist tools/pgcloud-launcher/dist
while IFS= read -r path; do remove "$path"; done < <(
  find . \( -path ./.git -o -path ./tools/pgcloud-launcher/node_modules \) -prune -o -type f -name .DS_Store -print
)

if $CLEAN_DEPS; then
  info "Node.js dependencies"
  remove tools/pgcloud-launcher/node_modules
fi

DOCKER_OK=false
if $CLEAN_DEV || $CLEAN_IMAGES || $CLEAN_LAUNCHER; then
  if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then DOCKER_OK=true; else warn "Docker is not available, skipping the Docker steps"; fi
fi

if $CLEAN_DEV && $DOCKER_OK; then
  info "Playground (./RUN.dev.sh)"
  if [ -n "$(docker compose -f tools/pgcloud-launcher/test/compose.yaml ps -a -q 2>/dev/null)" ] \
    || docker volume ls -q | grep -q '^pgcloud-launcher-test_'; then
    run "playground containers, networks and volumes" docker compose -f tools/pgcloud-launcher/test/compose.yaml down -v --remove-orphans
  else
    echo "no playground"
  fi
fi

if $CLEAN_LAUNCHER && $DOCKER_OK; then
  info "Launcher (./RUN.sh)"
  if docker container inspect "$CONTAINER" >/dev/null 2>&1; then
    run "container $CONTAINER" docker rm -f "$CONTAINER"
  else
    echo "no container $CONTAINER"
  fi
  if $CLEAN_DATA && docker volume inspect "$VOLUME" >/dev/null 2>&1; then
    if $DRY_RUN || confirm "Delete volume $VOLUME? The launcher forgets its topology, settings, SSH keys and passwords."; then
      run "volume $VOLUME" docker volume rm "$VOLUME"
    else
      echo "kept volume $VOLUME"
    fi
  fi
fi

if $CLEAN_IMAGES && $DOCKER_OK; then
  info "PgCloud images"
  pgcloud_defaults
  refs=()
  while IFS= read -r ref; do [ -n "$ref" ] && refs+=("$ref"); done < <(
    for name in $ALL_IMAGES; do docker image ls "$(image_repo "$name")" --format '{{.Repository}}:{{.Tag}}'; done
    docker image ls --format '{{.Repository}}:{{.Tag}}' | grep -E '^pgcloud/(db|pgpool|pgbouncer|launcher|testhost):dev$' || true
  )
  if [ ${#refs[@]} -eq 0 ]; then
    echo "no PgCloud images"
  else
    for ref in "${refs[@]}"; do run "image $ref" docker rmi "$ref"; done
  fi
fi

if $DRY_RUN; then
  info "Dry run: $removed item(s) would be removed"
else
  info "Done: $removed item(s) removed"
fi
