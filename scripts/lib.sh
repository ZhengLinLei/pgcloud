# Helpers shared by the scripts in the repo root (BUILD.sh, EXPORT.sh, RUN.sh, RUN.dev.sh, CLEAN.sh).
# Source it, don't run it. Works with the bash 3.2 that ships with macOS.

info() { printf '>> %s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

# confirm "question" -> 0 if yes. ASSUME_YES=true answers yes; no terminal answers no.
confirm() {
  ${ASSUME_YES:-false} && return 0
  [ -t 0 ] || return 1
  local answer
  read -r -p ">> $1 [y/N] " answer
  [[ "$answer" =~ ^[Yy] ]]
}

# load_env [file]: exports KEY=value lines of .env without running them as shell code.
# Variables already set in the shell win; quotes are removed; " # text" after a value is a comment.
load_env() {
  local file="${1:-.env}" line key value
  [ -f "$file" ] || return 0
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line#"${line%%[![:space:]]*}"}"
    [[ -z "$line" || "$line" == \#* || "$line" != *=* ]] && continue
    line="${line#export }"
    key="${line%%=*}"
    key="${key%"${key##*[![:space:]]}"}"
    [[ "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || { warn "$file: ignored line: $line"; continue; }
    value="${line#*=}"
    value="${value#"${value%%[![:space:]]*}"}"
    if [[ "$value" == \"*\"* ]]; then
      value="${value:1}"; value="${value%%\"*}"
    elif [[ "$value" == \'*\'* ]]; then
      value="${value:1}"; value="${value%%\'*}"
    else
      value="${value%% \#*}"
      value="${value%"${value##*[![:space:]]}"}"
    fi
    [ -z "${!key+x}" ] && export "$key=$value"
  done <"$file"
}

need_docker() {
  command -v docker >/dev/null 2>&1 || die "docker is not installed"
  docker info >/dev/null 2>&1 || die "the Docker daemon is not running"
}

# ------------------------------------------------------------------ PgCloud images
ALL_IMAGES="launcher db pgpool pgbouncer"
NODE_IMAGES="db pgpool pgbouncer"

# pgcloud_defaults: PGCLOUD_VERSION (from the launcher's package.json), PGCLOUD_HUB (Docker Hub namespace).
pgcloud_defaults() {
  if [ -z "${PGCLOUD_VERSION:-}" ]; then
    PGCLOUD_VERSION="$(sed -n 's/^  "version": "\(.*\)",$/\1/p' tools/pgcloud-launcher/package.json | head -1)"
    [ -n "$PGCLOUD_VERSION" ] || die "cannot read the version from tools/pgcloud-launcher/package.json"
  fi
  PGCLOUD_HUB="${PGCLOUD_HUB:-zhenglinlei}"
}

# image_dockerfile <name> / image_repo <name>: Dockerfile and repository of one image.
image_dockerfile() {
  case "$1" in
    launcher) echo tools/pgcloud-launcher/Dockerfile ;;
    db) echo docker/db/Dockerfile ;;
    pgpool) echo docker/pgpool/Dockerfile ;;
    pgbouncer) echo docker/pgbouncer/Dockerfile ;;
    *) return 1 ;;
  esac
}
image_repo() { echo "${PGCLOUD_HUB}/pgcloud-$1"; }

# select_images <args...>: prints the image names to work on (all when no name is given).
select_images() {
  local name out=""
  for name in "$@"; do
    image_dockerfile "$name" >/dev/null || die "unknown image '$name' (choose from: $ALL_IMAGES)"
    out="$out $name"
  done
  out="${out# }"
  echo "${out:-$ALL_IMAGES}"
}

# minor_tag 1.2.3 -> 1.2
minor_tag() { echo "$1" | sed -n 's/^\([0-9][0-9]*\.[0-9][0-9]*\)\..*/\1/p'; }

# usage: prints the comment block at the top of the calling script (its help).
usage() { sed -n '2,/^[^#]/{/^#/p;}' "$0"; }
