#!/bin/bash
# 
# Syntax: depromote.sh <new_primary_ip> <new_primary_port> [<old_primary_ip> <old_primary_port>] (optional)

if [ -z "$1" ] || [ -z "$2" ]; then
    echo "Usage $0 <new_primary_ip> <new_primary_port>"
    echo "Usage $0 <new_primary_ip> <new_primary_port> <old_primary_ip> <old_primary_port>"
    exit 1
fi

# The node may have just been (re)started by the failover: wait until PostgreSQL accepts connections
for i in $(seq 1 60); do
    pg_isready -q -p "$PGPORT" -U "$POSTGRES_USER" -d "$POSTGRES_DB" && break
    sleep 1
done
pg_isready -q -p "$PGPORT" -U "$POSTGRES_USER" -d "$POSTGRES_DB" || {
    echo "PostgreSQL is not accepting connections ... fail"
    exit 3
}

# Get role path
GETROLE_SCRIPT="$PGCDATA/script/getrole.sh"

# Check if is replica, if not exit
ROLE=$($GETROLE_SCRIPT)
if [ "$ROLE" == "false" ]; then
    echo "This script only can be executed in primary node"
    exit 2
fi

echo -e "\n\n"
echo "============================"
echo "  OLD PRIMARY IP: $3"
echo "  OLD PRIMARY PORT: $4"
echo "  NEW PRIMARY IP: $1"
echo "  NEW PRIMARY PORT: $2"
echo "============================"


# Create lock with new server information
echo -e "PRIMARY_HOST=$1\nPRIMARY_PORT=$2" > $PGDATA/standby.signal
echo "Creating standby.signal file ... ok"

# Never remove postmaster.pid of a running server: pg_ctl would lose track of it and
# PostgreSQL would keep running as a second primary until it notices the missing lock file.
rm -f $PGDATA/recovery.conf

echo "Removing recovery.conf ... ok"

# Get replica slot name
slot=$(cat "$PGDATA/PGC_SLOT" 2>/dev/null || cat "$PGCDATA/conf/PGC_SLOT" 2>/dev/null)
if [ -z "$slot" ]; then
    echo "Replica slot id not found in $PGDATA/PGC_SLOT ... fail"
    exit 1
fi
echo "Replica slot: pgcloud$slot"

# Make sure the slot exists on the new primary (ignore error if it already exists)
export PGPASSWORD=${POSTGRES_PASSWORD}
psql -At -U $POSTGRES_USER -d $POSTGRES_DB -p $2 -h $1 -c "SELECT * FROM pg_create_physical_replication_slot('pgcloud$slot');" \
    && echo "Creating slot [pgcloud$slot] in $1:$2 ... ok" \
    || echo "Creating slot [pgcloud$slot] in $1:$2 ... skipped (already exists or primary unreachable)"
unset PGPASSWORD


# Write configuration of new primary
echo -e "primary_conninfo = 'user=$REPLICA_USER password=$REPLICA_PASS application_name=$BACKEND_NAME channel_binding=prefer host=$1 port=$2 sslmode=prefer sslcompression=0 sslcertmode=allow sslsni=1 ssl_min_protocol_version=TLSv1.2 gssencmode=prefer krbsrvname=postgres gssdelegation=0 target_session_attrs=any load_balance_hosts=disable' \n \
        primary_slot_name = 'pgcloud$slot'" > $PGDATA/postgresql.auto.conf

chown postgres:postgres $PGDATA/standby.signal $PGDATA/postgresql.auto.conf
echo "Writing configuration of new primary $1:$2 ... ok"

# Replace to physical machine data
# Update KEY=VALUE in the mounted .env file.
# The file is usually a bind mount, so `sed -i` (rename) fails; rewrite it in place instead.
update_env() {
    local key=$1 value=$2 file="$PGCDATA/.env" tmp
    # No mounted .env (e.g. docker compose): nothing to persist
    [ -f "$file" ] || { echo "No $file found, skipping $key update"; return 0; }
    tmp=$(mktemp)
    sed "s|^${key}=.*|${key}=${value}|" "$file" > "$tmp" && cat "$tmp" > "$file"
    rm -f "$tmp"
}

update_env PRIMARY_HOST "$1"
echo "Changing PRIMARY_HOST in physical machine .env file to $1 ... ok"

update_env PRIMARY_PORT "$2"
echo "Changing PRIMARY_PORT in physical machine .env file to $2 ... ok"

echo "Depromoting to $1:$2 ... ok"
echo "Stopping PostgreSQL; it starts again as a replica when the container is started (docker start pgcloud_db)"
# Clean, fast shutdown. In a container this stops it; the failover command starts it again.
su postgres -c "pg_ctl stop -m fast -w"