#! /bin/bash

# Execute command by failover.
# special values:  %d = node id
#                  %h = host name
#                  %p = port number
#                  %D = database cluster path
#                  %m = new master node id
#                  %M = old master node id
#                  %H = new master node host name
#                  %P = old primary node id
#                  %% = '%' character
#                  %R = new master database cluster path
#                  %% = '%' character

# ---------------------------------------------------------------------
# prepare
# ---------------------------------------------------------------------

start_time=$(date +%s)

PGPOOL_CONF_FILE="/etc/pgpool2"
SCRIPT_LOG="$PGCDATA/log/failback.log"
STATUS_SCRIPT=$PGCDATA/script/status.sh

# Log function
pglog () {
    printf '%s |  %s\n' "$(date)" "$@" >> $SCRIPT_LOG
}

FAILED_NODE_ID=${1}
FAILED_NODE_HOST=${2}
FAILED_NODE_PORT=${3}
FAILED_NODE_PGDATA=${4}
NEW_MASTER_NODE_ID=${5}
NEW_MASTER_NODE_HOST=${6}
OLD_MASTER_NODE_ID=${7}
OLD_PRIMARY_NODE_ID=${8}
NEW_MASTER_NODE_PORT=${9}
NEW_MASTER_NODE_PGDATA=${10}
OLD_PRIMARY_NODE_HOST=${11}
OLD_PRIMARY_NODE_PORT=${12}

pglog "----------------------------------------------------------------------"
pglog "New failback detected date: ${DATE}"
pglog "$0 $*"
pglog "----------------------------------------------------------------------"
pglog ""

pglog ""
pglog "[ node recover ]                           "
pglog "FAILED_NODE_ID           ${FAILED_NODE_ID}      "
pglog "FAILED_NODE_HOST         ${FAILED_NODE_HOST}    "
pglog "FAILED_NODE_PORT         ${FAILED_NODE_PORT}    "
pglog "FAILED_NODE_PGDATA       ${FAILED_NODE_PGDATA}  "
pglog ""
pglog "                    ---------                       "

pglog "Failback done for node: $FAILED_NODE_ID "

# Get status
$STATUS_SCRIPT >> $SCRIPT_LOG