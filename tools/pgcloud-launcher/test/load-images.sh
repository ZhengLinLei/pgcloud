#!/bin/bash
# Copy the PgCloud images from your local Docker into the two fake servers
# (for the "on hosts" image source). Run from the repository root after `docker compose build`.
set -e
COMPOSE="docker compose -f tools/pgpool-launcher/test/compose.yaml"
IMAGES="pgcloud/db:dev pgcloud/pgpool:dev pgcloud/pgbouncer:dev"

for img in $IMAGES; do
  docker image inspect "$img" >/dev/null 2>&1 || { echo "Missing $img: run 'docker compose build' at the repository root first"; exit 1; }
done

for srv in srv-a srv-b; do
  echo "Loading images into $srv ..."
  docker save $IMAGES | $COMPOSE exec -T $srv docker load
done
echo "Done. In the launcher choose Settings > Images > 'on hosts', tag 'dev'."
