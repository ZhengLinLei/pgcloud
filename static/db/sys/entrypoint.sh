#!/bin/bash
set -e

# Check if it is first time
if [ ! -f "$PGDATA/PG_VERSION" ] && []; then
    # First time
    $WORKDIR/sys/initdb.sh
    
    # Enable first time
    FIRST_TIME=true
fi


# Check node role current with before
if [ ! -f "$WORKDIR/NODE_ROLE" ] || [ "$(cat $WORKDIR/NODE_ROLE)" != "$NODE_ROLE" ]; then
    # Setup the configuration to prepare postgres node
    $WORKDIR/sys/setup.sh
fi


echo "Running PostgreSQL as $NODE_ROLE role"
echo "Listening in port ::$PGPORT"

tail -f /dev/null