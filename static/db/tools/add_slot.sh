#!/bin/bash

# Check if exist $1
if [ -z "$1" ]; then
    echo "Usage $0 <slot_name>"
    exit 1
fi

# Get role path
GETROLE_SCRIPT="$PGCDATA/script/getrole.sh"

# Check if is primary, if not exit
ROLE=$($GETROLE_SCRIPT)

if [ "$ROLE" == "false" ]; then
    echo "This script only can be executed in primary node"
    exit 2
fi

read -p "Add slot $1? (y/n) " yn

if [ "$yn" != "y" ]; then
	echo "Aborting process..."
	exit 0
fi

# Create slot
psql -U $POSTGRES_USER -d $POSTGRES_DB -p $PGPORT -c "SELECT pg_create_physical_replication_slot('$1');"