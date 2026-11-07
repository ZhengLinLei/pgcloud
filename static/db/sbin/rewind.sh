#!/bin/bash
#
# Syntax: rewind.sh <new_primary_ip> <new_primary_port>
#
# Turns a former primary into a replica of the new primary. PostgreSQL must be STOPPED on this
# data directory. It is used in two ways:
#
#  1. By Pgpool-II's failover (FAILOVER_DEPROMOTE_CMD), in a one-off container that shares the
#     volumes of the stopped node container:
#       docker stop -t 60 pgcloud_db
#       docker run --rm --network host --volumes-from pgcloud_db --entrypoint pgcloud_rewind <image> <ip> <port>
#       docker start pgcloud_db
#  2. By the entrypoint, when a node configured as replica finds data of a primary (self-healing).
#
# Strategy: pg_rewind (fast, needs the WAL since the divergence: wal_keep_size helps); if it fails,
# the data directory is cloned again from the new primary with pg_basebackup.

set -o pipefail

if [ -z "$1" ] || [ -z "$2" ]; then
    echo "Usage $0 <new_primary_ip> <new_primary_port>"
    exit 1
fi

# Runs as root in case 1 (the mounted .env is root-only); everything touching PGDATA runs as postgres
as_pg() {
    if [ "$(id -u)" = '0' ]; then gosu postgres "$@"; else "$@"; fi
}

PGCDATA=${PGCDATA:-/opt/pgcloud}
# Cluster settings from the node's mounted .env (docker --env-file format: KEY=value, no quoting)
if [ -z "$POSTGRES_USER" ] && [ -r "$PGCDATA/.env" ]; then
    while IFS= read -r line || [ -n "$line" ]; do
        case "$line" in
            ''|'#'*) continue ;;
            [A-Za-z_]*=*) export "${line%%=*}=${line#*=}" ;;
        esac
    done < "$PGCDATA/.env"
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

# pg_rewind / pg_basebackup copy non-PostgreSQL files from the source too: keep this node's own slot id
slot=$(cat "$PGDATA/PGC_SLOT" 2>/dev/null)
if [ -z "$slot" ]; then
    slot=$(cat /proc/sys/kernel/random/uuid | md5sum | cut -d ' ' -f1)
    echo "No slot id found, generated a new one: $slot"
fi

export PGPASSWORD="$POSTGRES_PASSWORD"
SOURCE="host=$1 port=$2 user=$POSTGRES_USER dbname=$POSTGRES_DB connect_timeout=10"

echo "Running pg_rewind against $1:$2 ..."
if as_pg env PGPASSWORD="$PGPASSWORD" pg_rewind --target-pgdata="$PGDATA" --source-server="$SOURCE" --progress 2>&1; then
    echo "pg_rewind ... ok"
else
    echo "pg_rewind ... fail: cloning the node again from $1:$2 with pg_basebackup"
    as_pg sh -c "find '$PGDATA' -mindepth 1 -delete" || { echo "Cannot empty $PGDATA ... fail"; exit 3; }
    as_pg env PGPASSWORD="$REPLICA_PASS" pg_basebackup -h "$1" -p "$2" -U "$REPLICA_USER" -D "$PGDATA" -X stream -w \
        -d "host=$1 port=$2 user=$REPLICA_USER application_name=$BACKEND_NAME" 2>&1 || {
        echo "pg_basebackup ... fail"
        exit 3
    }
    echo "pg_basebackup ... ok"
fi

echo "$slot" | as_pg tee "$PGDATA/PGC_SLOT" >/dev/null

# The slot must exist on the new primary before streaming from it (ignore "already exists")
psql -At -d "$SOURCE" -c "SELECT pg_create_physical_replication_slot('pgcloud$slot');" >/dev/null 2>&1 \
    && echo "Creating slot pgcloud$slot on $1:$2 ... ok" \
    || echo "Creating slot pgcloud$slot on $1:$2 ... skipped (already exists)"

# Standby configuration (written last: the copy brought the new primary's postgresql.auto.conf)
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
