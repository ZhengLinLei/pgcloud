#!/bin/bash
# 
# Syntax: promote.sh [<new_primary_ip> <new_primary_port> <old_primary_ip> <old_primary_port>] (optional)

# Get role path
GETROLE_SCRIPT="$PGDATA/script/getrole.sh"

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

iRet=$(psql -At -U $POSTGRES_USER -d $POSTGRES_DB -p $PGPORT -c "SELECT CASE WHEN pg_last_wal_receive_lsn() = pg_last_wal_replay_lsn() THEN 0 ELSE EXTRACT(EPOCH FROM now() - pg_last_xact_replay_timestamp()) END AS log_delay;") && {
    echo "Getting WAL apply delay ... ok"
    iRet=$(echo $iRet | awk '{print $1}')
} || {
    echo "Getting WAL apply delay ... fail"
}

echo "WAL apply delay: $iRet"

# Check if WAL is synchronized
# If it is null or zero, WAL is synchronized
if [ -z "$iRet" ] || [ "$iRet" -eq "0" ]; then
    echo "WAL streaming synchronized ... ok"
else
    echo "WAL streaming synchronized ... fail"
    echo "Checking WAL risk ... ok"
    # if time is 0
    if [ "$PROMOTE_MIN_DELAY" -eq "0" ] || [ "$iRet" -le "$PROMOTE_MIN_DELAY" ]; then
        echo "Risk accepted with PROMOTE_MIN_DELAY = $PROMOTE_MIN_DELAY ... ok"
        echo "Continue execution"
    else
        echo "Risk not accepted with PROMOTE_MIN_DELAY = $PROMOTE_MIN_DELAY ... fail"
        echo "Cancelling promotion"
        exit 1
    fi
fi

iRet=$(psql -At -U $POSTGRES_USER -d $POSTGRES_DB -p $PGPORT -c "SELECT pg_promote();") && {
    echo "Executing promotion ... ok"
} || {
    echo "Executing promotion ... fail"
}

[ "$iRet" != "t" ] && {
    echo "PSQL promotion failed, trying with pg_ctl"
    # Calling with pg_ctl
    su postgres -c "pg_ctl promote" || {
        echo "pg_ctl promotion ... fail"
        echo "Cancelling promotion"
        exit 1
    }
}


echo "Promotion finished ... ok"