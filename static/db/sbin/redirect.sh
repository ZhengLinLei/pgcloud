#!/bin/bash
# 
# Syntax: redirect.sh <new_primary_ip> <new_primary_port> [<old_primary_ip> <old_primary_port>] (optional)
if [ -z "$1" ] || [ -z "$2" ]; then
    echo "Usage $0 <new_primary_ip> <new_primary_port>"
    echo "Usage $0 <new_primary_ip> <new_primary_port> <old_primary_ip> <old_primary_port>"
    exit 1
fi

# Get role path
GETROLE_SCRIPT="$PGCDATA/script/getrole.sh"

# Check if is replica, if not exit
ROLE=$($GETROLE_SCRIPT)
if [ "$ROLE" == "true" ]; then
    echo "This script only can be executed in replica node"
    exit 2
fi

echo -e "\n\n"
echo "============================"
echo "  OLD PRIMARY IP: $3"
echo "  OLD PRIMARY PORT: $4"
echo "  NEW PRIMARY IP: $1"
echo "  NEW PRIMARY PORT: $2"
echo "============================"

echo "Redirecting to $1:$2"
# Add replica slot name to new primary
export PGPASSWORD=${POSTGRES_PASSWORD}
slot=$(cat "$PGDATA/PGC_SLOT" 2>/dev/null || cat "$PGCDATA/conf/PGC_SLOT" 2>/dev/null)
if [ -z "$slot" ]; then
    echo "Replica slot id not found in $PGDATA/PGC_SLOT ... fail"
    exit 1
fi
psql -At -U $POSTGRES_USER -d $POSTGRES_DB -p $2 -h $1 -c "SELECT * FROM pg_create_physical_replication_slot('pgcloud$slot');" \
    && echo "Creating slot [pgcloud$slot] in $1:$2 ... ok" \
    || echo "Creating slot [pgcloud$slot] in $1:$2 ... skipped (already exists or primary unreachable)"

# Change conninfo
psql -At -U $POSTGRES_USER -d $POSTGRES_DB -p $PGPORT -c "ALTER SYSTEM SET primary_conninfo TO 'host=$1 port=$2 user=$REPLICA_USER password=$REPLICA_PASS application_name=$BACKEND_NAME';" 
echo "Changing primary_conninfo to host=$1 port=$2 ... ok"

psql -At -U $POSTGRES_USER -d $POSTGRES_DB -p $PGPORT -c "ALTER SYSTEM SET primary_slot_name TO 'pgcloud$slot';"
echo "Changing primary_slot_name to pgcloud$slot ... ok"

psql -At -U $POSTGRES_USER -d $POSTGRES_DB -p $PGPORT -c "SELECT pg_reload_conf();"
echo "Reloading configuration ... ok"

# Replace to physical machine data
# Update KEY=VALUE in the mounted .env file.
# The file is usually a bind mount, so `sed -i` (rename) fails; rewrite it in place instead.
update_env() {
    local key=$1 value=$2 file="$PGCDATA/.env" tmp
    tmp=$(mktemp)
    sed "s|^${key}=.*|${key}=${value}|" "$file" > "$tmp" && cat "$tmp" > "$file"
    rm -f "$tmp"
}

update_env PRIMARY_HOST "$1"
echo "Changing PRIMARY_HOST in physical machine .env file to $1 ... ok"

update_env PRIMARY_PORT "$2"
echo "Changing PRIMARY_PORT in physical machine .env file to $2 ... ok"

echo "Redirecting to $1:$2 ... ok"