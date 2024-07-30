#!/bin/bash
# 
# Syntax: depromote.sh <new_primary_ip> <new_primary_port> [<old_primary_ip> <old_primary_port>] (optional)

if [ -z "$1" ] || [ -z "$2" ]; then
    echo "Usage $0 <new_primary_ip> <new_primary_port>"
    echo "Usage $0 <new_primary_ip> <new_primary_port> <old_primary_ip> <old_primary_port>"
    exit 1
fi

# Get role path
GETROLE_SCRIPT="$PGDATA/script/getrole.sh"

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

rm -f $PGDATA/postmaster.pid
rm -f $PGDATA/recovery.conf

echo "Removing postmaster.pid and recovery.conf ... ok"

# Get replica slot name
slot=$(cat $PGDATA/pgcloud)
echo "Replica slot: $replica_slot "


# Write configuration of new primary
echo -e "primary_conninfo = 'user=$REPLICA_USER password=$REPLICA_PASS application_name=$BACKEND_NAME hannel_binding=prefer host=$1 port=$2 sslmode=prefer sslcompression=0 sslcertmode=allow sslsni=1 ssl_min_protocol_version=TLSv1.2 gssencmode=prefer krbsrvname=postgres gssdelegation=0 target_session_attrs=any load_balance_hosts=disable' \n \
        primary_slot_name = 'pgcloud$slot'" > $PGDATA/postgresql.auto.conf

echo "Writing configuration of new primary $1:$2 ... ok"

# Replace to physical machine data
sed -i "s/^PRIMARY_HOST=.*/PRIMARY_HOST=$1/" $PGCDATA/.env || {
    echo ".env file busy, using cat for replace PRIMARY_HOST"
    # If file is busy
    sed "s/^PRIMARY_HOST=.*/PRIMARY_HOST=$1/" $PGCDATA/.env > $PGCDATA/.env.tmp
    > $PGCDATA/.env
    cat $PGCDATA/.env.tmp > $PGCDATA/.env
    rm -f $PGCDATA/.env.tmp
}
echo "Changing PRIMARY_HOST in physical machine .env file to $1 ... ok"

sed -i "s/^PRIMARY_PORT=.*/PRIMARY_PORT=$2/" $PGCDATA/.env || {
    echo ".env file busy, using cat for replace PRIMARY_PORT"
    # If file is busy
    sed "s/^PRIMARY_HOST=.*/PRIMARY_HOST=$1/" $PGCDATA/.env > $PGCDATA/.env.tmp
    > $PGCDATA/.env
    cat $PGCDATA/.env.tmp > $PGCDATA/.env
    rm -f $PGCDATA/.env.tmp
}
echo "Changing PRIMARY_PORT in physical machine .env file to $2 ... ok"

echo "Depromoting to $1:$2 ... ok"
echo "Restarting to create setup, remember to launch Postgres again. Bye!"
# Restart to create setup
su postgres -c "pg_ctl restart"