#!/bin/bash
#
# Syntax: rewind.sh <new_primary_ip> <new_primary_port>
#
# Turns a former primary into a replica of the new primary with pg_rewind.
# PostgreSQL must be STOPPED (cleanly) on this data directory, so this runs in a one-off
# container that shares the volumes of the stopped node container:
#
#   docker stop -t 60 pgcloud_db
#   docker run --rm --volumes-from pgcloud_db --entrypoint pgcloud_rewind <image> <new_ip> <new_port>
#   docker start pgcloud_db
#
# pg_rewind needs data checksums or wal_log_hints (both enabled by PgCloud) and a superuser
# connection to the new primary.

set -o pipefail

if [ -z "$1" ] || [ -z "$2" ]; then
    echo "Usage $0 <new_primary_ip> <new_primary_port>"
    exit 1
fi

# Runs as root (the mounted .env is root-only); everything touching PGDATA runs as postgres
as_pg() {
    if [ "$(id -u)" = '0' ]; then gosu postgres "$@"; else "$@"; fi
}

PGCDATA=${PGCDATA:-/opt/pgcloud}
# Cluster settings (users, passwords, PGDATA) come from the node's mounted .env
if [ -f "$PGCDATA/.env" ]; then
    set -a
    . "$PGCDATA/.env"
    set +a
fi
PGDATA=${PGDATA:-/opt/pgdata}

echo "============================"
echo "  REWIND $PGDATA"
echo "  NEW PRIMARY: $1:$2"
echo "============================"

if as_pg pg_ctl status -D "$PGDATA" >/dev/null 2>&1; then
    echo "PostgreSQL is still running on $PGDATA; stop the node container first ... fail"
    exit 2
fi

# pg_rewind copies non-PostgreSQL files from the source too: keep this node's own slot id
slot=$(cat "$PGDATA/PGC_SLOT" 2>/dev/null)
if [ -z "$slot" ]; then
    echo "Replica slot id not found in $PGDATA/PGC_SLOT ... fail"
    exit 1
fi

export PGPASSWORD="$POSTGRES_PASSWORD"
SOURCE="host=$1 port=$2 user=$POSTGRES_USER dbname=$POSTGRES_DB connect_timeout=10"

echo "Running pg_rewind against $1:$2 ..."
as_pg env PGPASSWORD="$PGPASSWORD" pg_rewind --target-pgdata="$PGDATA" --source-server="$SOURCE" --progress 2>&1 || {
    echo "pg_rewind ... fail (the node needs a fresh base backup: destroy and redeploy it)"
    exit 3
}
echo "pg_rewind ... ok"

echo "$slot" | as_pg tee "$PGDATA/PGC_SLOT" >/dev/null

# The slot must exist on the new primary before streaming from it (ignore "already exists")
psql -At -d "$SOURCE" -c "SELECT pg_create_physical_replication_slot('pgcloud$slot');" >/dev/null 2>&1 \
    && echo "Creating slot pgcloud$slot on $1:$2 ... ok" \
    || echo "Creating slot pgcloud$slot on $1:$2 ... skipped (already exists)"

# Standby configuration (pg_rewind copied the new primary's postgresql.auto.conf, so write it after)
as_pg touch "$PGDATA/standby.signal"
as_pg tee "$PGDATA/postgresql.auto.conf" >/dev/null <<EOF
# Written by pgcloud_rewind
primary_conninfo = 'host=$1 port=$2 user=$REPLICA_USER password=$REPLICA_PASS application_name=$BACKEND_NAME'
primary_slot_name = 'pgcloud$slot'
recovery_target_timeline = 'latest'
EOF
echo "Standby configuration written ... ok"

# Keep the mounted .env in sync (bind mount: rewrite in place)
if [ -w "$PGCDATA/.env" ]; then
    tmp=$(mktemp)
    sed -e "s|^PRIMARY_HOST=.*|PRIMARY_HOST=$1|" -e "s|^PRIMARY_PORT=.*|PRIMARY_PORT=$2|" -e "s|^NODE_ROLE=.*|NODE_ROLE=replica|" \
        "$PGCDATA/.env" > "$tmp" && cat "$tmp" > "$PGCDATA/.env"
    rm -f "$tmp"
fi

echo "Node is ready to start as a replica of $1:$2"
