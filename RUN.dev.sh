#!/usr/bin/env bash
# Development playground: 3 simulated servers (Docker-in-Docker + SSH) and the launcher built from
# this checkout (tools/pgcloud-launcher/test/compose.yaml). FOR TESTING ONLY: fixed passwords.
#   ./RUN.dev.sh                -> build and start the launcher + srv-a, srv-b, srv-c
#   ./RUN.dev.sh --servers      -> only the 3 servers (for a launcher you already run, e.g. ./RUN.sh)
#   ./RUN.dev.sh -p 8081        -> launcher on another port (default 8080)
#   ./RUN.dev.sh --status       -> what is running
#   ./RUN.dev.sh --logs         -> follow the launcher logs
#   ./RUN.dev.sh --stop         -> stop everything (data kept)
#   ./RUN.dev.sh --reset        -> stop and delete everything (servers' Docker data, launcher data)
# Servers: srv-a 172.30.0.11, srv-b 172.30.0.12, srv-c 172.30.0.13, SSH root / pgcloud-test
# (from this machine: ssh -p 2211|2212|2213 root@localhost). Launcher admin password: launcher-test.
set -euo pipefail
cd "$(dirname "$0")"
. scripts/lib.sh
load_env

COMPOSE_FILE=tools/pgcloud-launcher/test/compose.yaml
NETWORK=pgcloud-launcher-test_lab
ACTION=up
SERVICES=(launcher srv-a srv-b srv-c)
export LAUNCHER_PORT="${LAUNCHER_PORT:-8080}"

while [ $# -gt 0 ]; do
  case "$1" in
    --servers) SERVICES=(srv-a srv-b srv-c) ;;
    -p|--port) LAUNCHER_PORT="$2"; shift ;;
    --status) ACTION=status ;;
    --logs) ACTION=logs ;;
    --stop) ACTION=stop ;;
    --reset) ACTION=reset ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown option: $1 (see ./RUN.dev.sh --help)" ;;
  esac
  shift
done

need_docker
docker compose version >/dev/null 2>&1 || die "docker compose (v2) is required"
dc() { docker compose -f "$COMPOSE_FILE" "$@"; }

case "$ACTION" in
  status) dc ps; exit 0 ;;
  logs) exec docker compose -f "$COMPOSE_FILE" logs -f launcher ;;
  stop) dc stop; info "Stopped (./RUN.dev.sh starts it again, ./RUN.dev.sh --reset deletes it)"; exit 0 ;;
  reset)
    ASSUME_YES="${ASSUME_YES:-false}"
    confirm "Delete the playground: containers, the servers' Docker data and the launcher data?" || die "cancelled"
    dc down -v --remove-orphans
    info "Playground deleted"
    exit 0 ;;
esac

WITH_LAUNCHER=false
[[ " ${SERVICES[*]} " == *" launcher "* ]] && WITH_LAUNCHER=true
if $WITH_LAUNCHER && ! dc ps --status running --services 2>/dev/null | grep -qx launcher \
  && nc -z localhost "$LAUNCHER_PORT" >/dev/null 2>&1; then
  die "port ${LAUNCHER_PORT} is already in use. Use ./RUN.dev.sh -p 8081 (or stop what uses it, e.g. ./RUN.sh --stop)"
fi

info "Building and starting: ${SERVICES[*]} (the first build takes a few minutes)"
dc up -d --build "${SERVICES[@]}"

info "Waiting for the servers' Docker daemons"
for srv in srv-a srv-b srv-c; do
  for _ in $(seq 1 60); do
    dc exec -T "$srv" docker info >/dev/null 2>&1 && break
    sleep 1
  done
done

cat <<EOF

  Servers (SSH user root, password pgcloud-test, port 22)
    srv-a   172.30.0.11     ssh -p 2211 root@localhost
    srv-b   172.30.0.12     ssh -p 2212 root@localhost
    srv-c   172.30.0.13     ssh -p 2213 root@localhost
EOF

if $WITH_LAUNCHER; then
  for _ in $(seq 1 60); do
    curl -fs "http://localhost:${LAUNCHER_PORT}/api/health" >/dev/null 2>&1 && break
    sleep 1
  done
  cat <<EOF

  Launcher   http://localhost:${LAUNCHER_PORT}    admin password: launcher-test
  In Topology use the IPs above as SSH host (Load 3-tier template, then fill in each node's SSH tab).

EOF
else
  cat <<EOF

  Only the servers were started. A launcher running in Docker must join their network:
    docker network connect ${NETWORK} pgcloud-launcher

EOF
fi
info "Stop: ./RUN.dev.sh --stop   Delete everything: ./RUN.dev.sh --reset"
