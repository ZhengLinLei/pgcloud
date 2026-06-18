#!/bin/bash

# PostgreSQL Raw Script
# Use with: watch -n 5 ./raw.sh

CONFIG_FILE="${1:-.env}"
if [ ! -f "$CONFIG_FILE" ]; then
    echo "ERROR: Configuration file $CONFIG_FILE not found!"
    exit 1
fi
source "$CONFIG_FILE"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
MAGENTA='\033[0;35m'
CYAN='\033[0;36m'
WHITE='\033[1;37m'
BOLD='\033[1m'
NC='\033[0m'

PG_USER="${PG_USER:-postgres}"
PG_DATABASE="${PG_DATABASE:-postgres}"
REPLICATION_LAG_WARNING="${REPLICATION_LAG_WARNING:-30}"
REPLICATION_LAG_CRITICAL="${REPLICATION_LAG_CRITICAL:-60}"
CONNECTION_WARNING="${CONNECTION_WARNING:-70}"
CONNECTION_CRITICAL="${CONNECTION_CRITICAL:-90}"
CHECK_WAL="${CHECK_WAL:-true}"
CHECK_DISK_USAGE="${CHECK_DISK_USAGE:-true}"
CHECK_CPU_MEMORY="${CHECK_CPU_MEMORY:-true}"

execute_query() {
    local host=$1
    local port=$2
    local query=$3
    
    PGPASSWORD="$PG_PASSWORD" \
    psql -h "$host" -p "$port" -U "$PG_USER" -d "$PG_DATABASE" \
    -P expanded=on \
    -c "$query" 2>/dev/null
}

clear

# Get primary node
for node in $(echo "$NODES" | tr ',' ' '); do
    host=$(echo "$node" | cut -d':' -f1)
    port=$(echo "$node" | cut -d':' -f2)
    echo "╔═══════════════════════════════════════════════════════════════════════╗"
    echo "  Node: $host:$port"
    echo "╚═══════════════════════════════════════════════════════════════════════╝"
    execute_query "$host" "$port" "
        SELECT * FROM pg_stat_replication;
    " 2>/dev/null | column -t -s $'\t'

    execute_query "$host" "$port" "
        SELECT * FROM pg_stat_wal_receiver;
    " 2>/dev/null | column -t -s $'\t'
done

        

echo ""
    
echo -e "${WHITE}Last refresh: $(date '+%H:%M:%S')${NC}"