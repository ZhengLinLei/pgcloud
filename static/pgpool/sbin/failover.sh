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
SCRIPT_LOG="$PGCDATA/log/failover.log"
STATUS_SCRIPT=$PGCDATA/script/status.sh
ATTACH_SCRIPT=$PGCDATA/script/attach.sh

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

DATE=$(date)

pglog "----------------------------------------------------------------------"
pglog "New failover detected date: ${DATE}"
pglog "$0 $*"
pglog "----------------------------------------------------------------------"
pglog ""

pglog ""
pglog "[ node which failed ]                           "
pglog "FAILED_NODE_ID           ${FAILED_NODE_ID}      "
pglog "FAILED_NODE_HOST         ${FAILED_NODE_HOST}    "
pglog "FAILED_NODE_PORT         ${FAILED_NODE_PORT}    "
pglog "FAILED_NODE_PGDATA       ${FAILED_NODE_PGDATA}  "

pglog "[ before failover ]                             "
pglog "OLD_PRIMARY_NODE_ID      ${OLD_PRIMARY_NODE_ID} "
pglog "OLD_MASTER_NODE_ID       ${OLD_MASTER_NODE_ID}  "

pglog "[ after failover ]                                  "
pglog "NEW_MASTER_NODE_ID       ${NEW_MASTER_NODE_ID}      "
pglog "NEW_MASTER_NODE_HOST     ${NEW_MASTER_NODE_HOST}    "
pglog "NEW_MASTER_NODE_PORT     ${NEW_MASTER_NODE_PORT}    "
pglog "NEW_MASTER_NODE_PGDATA   ${NEW_MASTER_NODE_PGDATA}  "
pglog ""
pglog "                    ---------                       "

# Call extra script
# Check if exist env var
if [ -z "$FAILOVER_EXTRA_SCRIPT" ]; then
    pglog "No extra script to execute"
else
    pglog "Execute: $FAILOVER_EXTRA_SCRIPT"
    # Execute the script
    $FAILOVER_EXTRA_SCRIPT >> $SCRIPT_LOG 2>&1
fi

# ---------------------------------------------------------------------
# Do promote only when the primary node failes
# ---------------------------------------------------------------------
if [ "${FAILED_NODE_ID}" == "${OLD_PRIMARY_NODE_ID}" ]; then
    pglog "The primary node (node ${OLD_PRIMARY_NODE_ID}) dies."
    pglog "Node ${NEW_MASTER_NODE_ID} takes over the primary."

    # Get server data
    pglog "Retrieving died primary node ssh data..."
    source $PSQL_SERVER_FILE_PATH/server$OLD_PRIMARY_NODE_ID.env
    SSH_USER0=$SSH_USER
    SSH_PORT0=$SSH_PORT
    SSH_PASS0=$SSH_PASS

    pglog "Retrieving new primary node ssh data..."
    source $PSQL_SERVER_FILE_PATH/server$NEW_MASTER_NODE_ID.env
    SSH_USER1=$SSH_USER
    SSH_PORT1=$SSH_PORT
    SSH_PASS1=$SSH_PASS0

    # %h = ip new primary
    # %p = port new primary
    # %x = ip old primary
    # %r = port old primary

    pglog "============================================================ PROMOTING NEW PRIMARY"
    pglog "Promoting new primary db"

    FAILOVER_PROMOTE_CMD=${FAILOVER_PROMOTE_CMD//%h/$NEW_MASTER_NODE_HOST}
    FAILOVER_PROMOTE_CMD=${FAILOVER_PROMOTE_CMD//%p/$NEW_MASTER_NODE_PORT}
    FAILOVER_PROMOTE_CMD=${FAILOVER_PROMOTE_CMD//%x/$OLD_PRIMARY_NODE_HOST}
    FAILOVER_PROMOTE_CMD=${FAILOVER_PROMOTE_CMD//%r/$OLD_PRIMARY_NODE_PORT}

    pglog "Execute: ${FAILOVER_PROMOTE_CMD}"
    pglog "ssh -o StrictHostKeyChecking=no ${SSH_USER1}@${NEW_MASTER_NODE_HOST} -p ${SSH_PORT1} exit"
    pglog "ssh ${SSH_USER1}@${NEW_MASTER_NODE_HOST} -p ${SSH_PORT1} \"${FAILOVER_PROMOTE_CMD}\""
    pglog ""
    pglog ""
    pglog "_________________ Remote server logs ____________________"
    sshpass -p "${SSH_PASS1}" ssh -o StrictHostKeyChecking=no ${SSH_USER1}@${NEW_MASTER_NODE_HOST} -p ${SSH_PORT1} exit  >> $SCRIPT_LOG 2>&1 || {
        pglog ">> Login ssh to new primary machine failed... PLEASE CHECK THE LOGIN PARAMETERS"
        end_time=$(date +%s)
        exe_time=$((end_time - start_time))
        pglog "Time used: $exe_time s"
        exit 1
    }
    sshpass -p "${SSH_PASS1}" ssh ${SSH_USER1}@${NEW_MASTER_NODE_HOST} -p ${SSH_PORT1} "${FAILOVER_PROMOTE_CMD}" >> $SCRIPT_LOG 2>&1 || {
        pglog ">> Executing ssh to new primary machine failed... PLEASE CHECK THE LOGIN PARAMETERS"
        end_time=$(date +%s)
        exe_time=$((end_time - start_time))
        pglog "Time used: $exe_time s"
        exit 1
    }
    pglog "_________________________________________________________"
    pglog ""
    pglog ""

    pglog "============================================================ REDIRECT REPLICA"
    pglog "Redirecting streaming from died primary to new primary"

    FAILOVER_REDIRECT_CMD=${FAILOVER_REDIRECT_CMD//%h/$NEW_MASTER_NODE_HOST}
    FAILOVER_REDIRECT_CMD=${FAILOVER_REDIRECT_CMD//%p/$NEW_MASTER_NODE_PORT}
    FAILOVER_REDIRECT_CMD=${FAILOVER_REDIRECT_CMD//%x/$OLD_PRIMARY_NODE_HOST}
    FAILOVER_REDIRECT_CMD=${FAILOVER_REDIRECT_CMD//%r/$OLD_PRIMARY_NODE_PORT}

    pglog "${OLD_PRIMARY_NODE_HOST} -> ${NEW_MASTER_NODE_HOST}"
    pglog "Execute: ${FAILOVER_REDIRECT_CMD}"

    # Get all nodes
    if [ "$PSQL_SERVER_USE_FILE" = "on" ]; then
        pglog "Server file configuration activated. Using configuration in $SERVER_CONF_PATH"

        # Reading all files starting from server*.env
        file_count=$(ls -1 $SERVER_CONF_PATH | grep -E 'server[0-9]+\.env' | wc -l)
        pglog "$file_count servers configuration file found"

        # Iterate from server config files
        set -a
        for i in $(seq 0 $((file_count - 1))); do
            if [ "$i" = "$OLD_PRIMARY_NODE_ID" ] || [ "$i" = "$NEW_MASTER_NODE_ID" ]; then
                continue
            fi
            pglog "---------------"
            # Config servers
            server_file="$SERVER_CONF_PATH/server$i.env"
            pglog "Server $server_file"

            # Source and update data
            source $server_file || {
                pglog "Cannot load configuration, please check the logs and fix the error"
                pglog "Server id: $i failed configurating new primary connection"
            }
            # ---

            pglog "ssh -o StrictHostKeyChecking=no ${SSH_USER}@${PSQL_HOST} -p ${SSH_PORT} exit"
            pglog "ssh ${SSH_USER}@${PSQL_HOST} -p ${SSH_PORT} \"${FAILOVER_REDIRECT_CMD}\""
            pglog ""
            pglog ""
            pglog "_________________ Remote server logs ____________________"
            sshpass -p "${SSH_PASS}" ssh -o StrictHostKeyChecking=no ${SSH_USER}@${PSQL_HOST} -p ${SSH_PORT} exit  >> $SCRIPT_LOG 2>&1 || {
                pglog ">> Login ssh to machine failed..."
                pglog "<< Server could be down or configuration not set correctly. SERVER REDIRECT FAILED"
            }
            # redirect
            sshpass -p "${SSH_PASS}" ssh ${SSH_USER}@${PSQL_HOST} -p ${SSH_PORT} "${FAILOVER_REDIRECT_CMD}" >> $SCRIPT_LOG 2>&1 || {
                pglog ">> Executing ssh to machine failed..."
                pglog "<< Avoiding redirect for this server $PSQL_HOST"
            }
            pglog "_________________________________________________________"
            pglog ""
            pglog ""
        done
        set +a
        echo "---------------"
    else
        echo "Server env configuration. Retrieving configuration from variables"

        IFS=', ' read -r -a PSQL_HOSTS    <<< "$PSQL_HOSTS"
        IFS=', ' read -r -a PSQL_PORTS    <<< "$PSQL_PORTS"
        IFS=', ' read -r -a PSQL_WEIGHTS  <<< "$PSQL_WEIGHTS"
        IFS=', ' read -r -a PSQL_FAILS    <<< "$PSQL_FAILS"
        IFS=', ' read -r -a PSQL_PATHS    <<< "$PSQL_PATHS"
        IFS=', ' read -r -a PSQL_ACTIVES  <<< "$PSQL_ACTIVES"
        IFS=', ' read -r -a SSH_USERS     <<< "$SSH_USERS"
        IFS=', ' read -r -a SSH_PASSW     <<< "$SSH_PASSW"

        array_len=${#PSQL_HOSTS[@]}
        echo "$array_len servers configuration variables found"

        for (( i=0; i<array_len; i++ )); do
            if [ "$i" = "$OLD_PRIMARY_NODE_ID" ] || [ "$i" = "$NEW_MASTER_NODE_ID" ]; then
                continue
            fi
            echo "---------------"
            echo "Server $i"
            # ---
            PSQL_HOST=${PSQL_HOSTS[i]}
            PSQL_PORT=${PSQL_PORTS[i]}
            PSQL_WEIGHT=${PSQL_WEIGHTS[i]}
            PSQL_FAIL=${PSQL_FAILS[i]}
            PSQL_PATH=${PSQL_PATHS[i]}
            PSQL_ACTIVE=${PSQL_ACTIVES[i]}

            pglog "ssh -o StrictHostKeyChecking=no ${SSH_USER}@${PSQL_HOST} -p ${SSH_PORT} exit"
            pglog "ssh ${SSH_USER}@${PSQL_HOST} -p ${SSH_PORT} \"${FAILOVER_REDIRECT_CMD}\""
            pglog ""
            pglog ""
            pglog "_________________ Remote server logs ____________________"
            sshpass -p "${SSH_PASS}" ssh -o StrictHostKeyChecking=no ${SSH_USER}@${PSQL_HOST} -p ${SSH_PORT} exit  >> $SCRIPT_LOG 2>&1 || {
                pglog ">> Login ssh to machine failed..."
                pglog "<< Server could be down or configuration not set correctly. SERVER REDIRECT FAILED"
            }
            # redirect
            sshpass -p "${SSH_PASS}" ssh ${SSH_USER}@${PSQL_HOST} -p ${SSH_PORT} "${FAILOVER_REDIRECT_CMD}" >> $SCRIPT_LOG 2>&1 || {
                pglog ">> Executing ssh to machine failed..."
                pglog "<< Avoiding redirect for this server $PSQL_HOST"
            }
            pglog "_________________________________________________________"
            pglog ""
            pglog ""
        done
        echo "---------------"

    fi

    pglog "============================================================ DEPROMOTING OLD PRIMARY"
    pglog "Forcing died primary to become replica, and update it."
    pglog "Trying if connection can be stablished"

    FAILOVER_RECOVERY_PRIMARY_CMD=${FAILOVER_RECOVERY_PRIMARY_CMD//%h/$NEW_MASTER_NODE_HOST}
    FAILOVER_RECOVERY_PRIMARY_CMD=${FAILOVER_RECOVERY_PRIMARY_CMD//%p/$NEW_MASTER_NODE_PORT}
    FAILOVER_RECOVERY_PRIMARY_CMD=${FAILOVER_RECOVERY_PRIMARY_CMD//%x/$OLD_PRIMARY_NODE_HOST}
    FAILOVER_RECOVERY_PRIMARY_CMD=${FAILOVER_RECOVERY_PRIMARY_CMD//%r/$OLD_PRIMARY_NODE_PORT}

    FAILOVER_DEPROMOTE_CMD=${FAILOVER_DEPROMOTE_CMD//%h/$NEW_MASTER_NODE_HOST}
    FAILOVER_DEPROMOTE_CMD=${FAILOVER_DEPROMOTE_CMD//%p/$NEW_MASTER_NODE_PORT}
    FAILOVER_DEPROMOTE_CMD=${FAILOVER_DEPROMOTE_CMD//%x/$OLD_PRIMARY_NODE_HOST}
    FAILOVER_DEPROMOTE_CMD=${FAILOVER_DEPROMOTE_CMD//%r/$OLD_PRIMARY_NODE_PORT}

    pglog "ssh -o StrictHostKeyChecking=no ${SSH_USER0}@${OLD_PRIMARY_NODE_HOST} -p ${SSH_PORT0} exit"
    pglog ""
    pglog ""
    pglog "_________________ Remote server logs ____________________"
    sshpass -p "${SSH_PASS0}" ssh -o StrictHostKeyChecking=no ${SSH_USER0}@${OLD_PRIMARY_NODE_HOST} -p ${SSH_PORT0} exit  >> $SCRIPT_LOG 2>&1 && {
        pglog "_________________________________________________________"
        pglog ""
        pglog ""
        pglog "Connection stablished, trying to recover the old primary node"
        pglog "Execute: ${FAILOVER_RECOVERY_PRIMARY_CMD}"
        pglog "ssh ${SSH_USER0}@${OLD_PRIMARY_NODE_HOST} -p ${SSH_PORT0} \"${FAILOVER_RECOVERY_PRIMARY_CMD}\"" 
        pglog ""
        pglog ""
        pglog "_________________ Remote server logs ____________________"
        sshpass -p "${SSH_PASS0}" ssh ${SSH_USER0}@${OLD_PRIMARY_NODE_HOST} -p ${SSH_PORT0} "${FAILOVER_RECOVERY_PRIMARY_CMD}" >> $SCRIPT_LOG 2>&1 && {
            pglog "Node recovered succesfully, depromoting old primary and restart with replica configuration"
            pglog "Execute: ${FAILOVER_DEPROMOTE_CMD}"
            pglog "ssh ${SSH_USER0}@${OLD_PRIMARY_NODE_HOST} -p ${SSH_PORT0} \"${FAILOVER_DEPROMOTE_CMD}\""
            sshpass -p "${SSH_PASS0}" ssh ${SSH_USER0}@${OLD_PRIMARY_NODE_HOST} -p ${SSH_PORT0} "${FAILOVER_DEPROMOTE_CMD}" >> $SCRIPT_LOG 2>&1 && {
                pglog "Node recovered succesfully as replica, continue with normal execution"
                pglog "Attaching the node $FAILED_NODE_ID back to up and allow to receive request"

                $ATTACH_SCRIPT $FAILED_NODE_ID >> $SCRIPT_LOG 2>&1
            } || {
                pglog ">> Executing ssh to old primary machine failed..."
                pglog "<< Avoiding force call. LAUCH PRIMARY AS REPLICA IN DEPROMOTION MODE"
            }
        } || {
            pglog "Cannot recover the node, let it died [Aborting]  MANUAL RECOVERY MUST NEEDED"
        }
        pglog "_________________________________________________________"
        pglog ""
        pglog ""
    } || {
        pglog ">> Login ssh to old primary machine failed..."
        pglog "<< Server could be down or configuration not set correctly"
        pglog "<< Stop trying to recover old primary [Aborting]  MANUAL RECOVERY MUST NEEDED"
    }


    # Changing lb_wight to prevent execute select in primary and set old primary as replica
    # backend_weight2\s*=\s*\d
    sed -i "s/^backend_weight$NEW_MASTER_NODE_ID\s*=\s*\d/backend_weight$NEW_MASTER_NODE_ID          =  0/" $BASE_PATH/conf/pgpool.conf
    sed -i "s/^backend_weight$OLD_PRIMARY_NODE_ID\s*=\s*\d/backend_weight$OLD_PRIMARY_NODE_ID          =  1/" $BASE_PATH/conf/pgpool.conf

    # Move to config path
    cp -rf $BASE_PATH/conf/pgpool.conf $PGPOOL_CONF_FILE

    # Reload
    pgpool reload &

    # Get status
    $STATUS_SCRIPT >> $SCRIPT_LOG
    
else
    pglog "Node ${FAILED_NODE_ID} dies, but it's not the primary node."

    if [ "$FAILOVER_RECOVER_REPLICA" = "true" ]; then
        # Get server data
        pglog "Retrieving died primary node ssh data..."
        source $PSQL_SERVER_FILE_PATH/server$FAILED_NODE_ID.env
        SSH_USER0=$SSH_USER
        SSH_PORT0=$SSH_PORT
        SSH_PASS0=$SSH_PASS
        pglog "Replica recover failover enabled, trying to recover the died replica node"
        pglog ""
        pglog "============================================================ RECOVERING REPLICA"
        pglog "Trying if connection can be stablished"
        pglog "ssh -o StrictHostKeyChecking=no $SSH_USER0@$FAILED_NODE_HOST -p $SSH_PORT0 exit"
        pglog ""
        pglog ""
        pglog "_________________ Remote server logs ____________________"
        sshpass -p "${SSH_PASS0}" ssh -o StrictHostKeyChecking=no ${SSH_USER0}@${FAILED_NODE_HOST} -p ${SSH_PORT0} exit  >> $SCRIPT_LOG 2>&1 && {
            pglog "_________________________________________________________"
            pglog ""
            pglog ""
            pglog "Connection stablished, trying to recover the replica node"
            pglog "Execute: ${FAILOVER_RECOVERY_REPLICA_CMD}"
            pglog "ssh ${SSH_USER0}@${FAILED_NODE_HOST} -p ${SSH_PORT0} \"${FAILOVER_RECOVERY_REPLICA_CMD}\"" 
            pglog ""
            pglog ""
            pglog "_________________ Remote server logs ____________________"
            sshpass -p "${SSH_PASS0}" ssh ${SSH_USER0}@${FAILED_NODE_HOST} -p ${SSH_PORT0} "${FAILOVER_RECOVERY_REPLICA_CMD}" >> $SCRIPT_LOG 2>&1 && {
            pglog "_________________________________________________________"
                pglog "Node recovered succesfully, continue with normal execution"

                # Attach
                pglog "Attaching the node $FAILED_NODE_ID back to up and allow to receive request"

                $ATTACH_SCRIPT $FAILED_NODE_ID >> $SCRIPT_LOG 2>&1
            } || {
                pglog "_________________________________________________________"
                pglog "Cannot recover the node, let it died [Aborting]  MANUAL RECOVERY MUST NEEDED"
            }
            pglog ""
            pglog ""
        } || {
            pglog ">> Login ssh to old died replica machine failed..."
            pglog "<< Server could be down or configuration not set correctly"
            pglog "<< Stop trying to recover replica [Aborting]  MANUAL RECOVERY MUST NEEDED"
        }
    else
        pglog "Replica recover failover not enabled. Not action set for this failover"
        pglog ">> PLEASE RECOVER THE REPLICA DB AS FAST AS POSSIBLE MANUALLY AND UPDATE IT WITH "pg_rewind" :)"
    fi
fi

pglog ""
pglog ""

end_time=$(date +%s)
exe_time=$((end_time - start_time))
pglog "Time used: $exe_time s"