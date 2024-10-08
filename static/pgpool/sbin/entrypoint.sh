#!/bin/bash

PGPOOL_CONF_PATH=/etc/pgpool2
PGPOOL_LOCK_FILE=lock.pgcloud

CONF_BASE_PATH=$PGCDATA/conf

pglog () {
    echo $@
    printf '%s  |  %s\n' "$(date)" "$@" >> $PGCDATA/log/pgcloud.log
}

pglog "------------ Starting pgpool ------------"
pglog "  Server: $PGPOOL_PORT"
pglog "  PCP: $PCP_PORT"
pglog "  User: $POSTGRES_USER"
pglog "  Database: $POSTGRES_DB"
pglog "-----------------------------------------"
pglog " Important: The configuration will be erased if the container is removed."
pglog "            When recreating the container, the configuration will be reset to the default. And set again with the environment variables."
pglog "            To avoid this, mount the configuration file to the container."

# Check if configuration exists
if [ -f $PGPOOL_CONF_PATH/$PGPOOL_LOCK_FILE ]; then
    pglog "Directory appears to contain a previous configuration; Skipping initialization of config files"
    pglog "To reset the configuration, remove the lock file `$PGPOOL_CONF_PATH/$PGPOOL_LOCK_FILE` and restart the container"
    pglog "If any error occurs, please check the logs and fix the error manually or remove the lock file and let system to write the configuration"
else
    pglog "Initializing pgpool configuration files"
    
    pglog "----- Generating Postgres conf ------"
    # Reading all files starting from server*.env
    file_count=$(ls -1 $SERVER_CONF_PATH | grep -E 'server[0-9]+\.env' | wc -l)
    pglog "$file_count Postgres servers configuration file found"

    # Iterate from server config files
    set -a
    for i in $(seq 0 $((file_count - 1))); do
        echo "---------------"
        # Config servers
        server_file="$SERVER_CONF_PATH/server$i.env"
        pglog "Configurating params for server $server_file"

        # Source and update data
        source $server_file || {
            pglog "Cannot load configuration, please check the logs and fix the error"
            pglog "Exiting configuration and stop launching pgpool"
            exit 1
        }
            
        # New values
        #backend_hostname1 = 'host2'
        #backend_port1 = 5433
        #backend_weight1 = 1
        #backend_data_directory1 = '/data1'
        #backend_flag1 = 'ALLOW_TO_FAILOVER'
        #backend_application_name1 = 'server1'
        # ---
        pglog "backend_hostname$i            = '$PSQL_HOST'"  
        pglog "backend_port$i                =  $PSQL_PORT "  
        pglog "backend_weight$i              =  $PSQL_WEIGHT" 
        pglog "backend_flag$i                = '$PSQL_FAIL'"  
        pglog "backend_data_directory$i      = '$PSQL_PATH'"  
        pglog "load_balance_node$i           =  $PSQL_ACTIVE"
        pglog "backend_application_name$i    = '$PSQL_NAME'"
        echo "backend_hostname$i            = '$PSQL_HOST'"  >> $CONF_BASE_PATH/pgpool.conf
        echo "backend_port$i                =  $PSQL_PORT "  >> $CONF_BASE_PATH/pgpool.conf
        echo "backend_weight$i              =  $PSQL_WEIGHT" >> $CONF_BASE_PATH/pgpool.conf
        echo "backend_flag$i                = '$PSQL_FAIL'"  >> $CONF_BASE_PATH/pgpool.conf
        echo "backend_data_directory$i      = '$PSQL_PATH'"  >> $CONF_BASE_PATH/pgpool.conf
        echo "load_balance_node$i           =  $PSQL_ACTIVE" >> $CONF_BASE_PATH/pgpool.conf
        echo "backend_application_name$i    = '$PSQL_NAME'"  >> $CONF_BASE_PATH/pgpool.conf
        echo -e "\n"                                         >> $CONF_BASE_PATH/pgpool.conf
    done
    set +a
    pglog "---------------"

    pglog "----- Generating PgPool Cluster conf ------"
    # Reading all files starting from server*.env
    file_count=$(ls -1 $BACKEND_CONF_PATH | grep -E 'backend[0-9]+\.env' | wc -l)
    pglog "$file_count PgPool servers configuration file found"

    # Iterate from server config files
    set -a
    for i in $(seq 0 $((file_count - 1))); do
        echo "---------------"
        # Config servers
        server_file="$BACKEND_CONF_PATH/backend$i.env"
        pglog "Configurating params for PgPool server $server_file"

        # Source and update data
        source $server_file || {
            pglog "Cannot load configuration, please check the logs and fix the error"
            pglog "Exiting configuration and stop launching pgpool"
            exit 1
        }

        if [ "$NODE_PGPOOL_HOST" = "$PGPOOL_HOST" ]; then
            # Create pgpool_node_id file
            # Pgpool-II 4.1 or earlier, because it is required to specify its own pgpool node information and 
            # the destination pgpool nodes information, the settings are different per pgpool node. 
            # Since Pgpool-II 4.2, all configuration parameters are identical on all hosts. If watchdog feature is enabled, 
            # to distinguish which host is which, a pgpool_node_id file is required. You need to create a pgpool_node_id 
            # file and specify the pgpool (watchdog) node number (e.g. 0, 1, 2 ...) to identify pgpool (watchdog) host.
            #
            # Example. pgpool_node_id configuration
            #If you have 3 pgpool nodes with hostname server1, server2 and server3, create the pgpool_node_id file on each host as follows. 

            # [server1]# cat /etc/pgpool2/pgpool_node_id
            # 0
                    

            # [server2]# cat /etc/pgpool2/pgpool_node_id
            # 1
                    

            # [server3]# cat /etc/pgpool2/pgpool_node_id
            # 2

            echo $i > /etc/pgpool2/pgpool_node_id

            pglog "Node id detected for this node: $1"
        fi

        pglog "hostname$i           = $NODE_PGPOOL_HOST"
        pglog "wd_port$i            = $NODE_WD_PORT"
        pglog "pgpool_port$i        = $NODE_PGPOOL_PORT"
        pglog "Heartbeat"
        pglog "heartbeat_hostname$i = $NODE_PGPOOL_HOST"
        pglog "heartbeat_port$i     = $NODE_HEARTBEAT_PORT"
        pglog "heartbeat_device$i   = $NODE_HEARTBEAT_DEVICE"
        pglog ""

        echo "hostname$i           = $NODE_PGPOOL_HOST"         >> $CONF_BASE_PATH/pgpool.conf
        echo "wd_port$i            = $NODE_WD_PORT"             >> $CONF_BASE_PATH/pgpool.conf
        echo "pgpool_port$i        = $NODE_PGPOOL_PORT"         >> $CONF_BASE_PATH/pgpool.conf
        echo "heartbeat_hostname$i = $NODE_PGPOOL_HOST"         >> $CONF_BASE_PATH/pgpool.conf
        echo "heartbeat_port$i     = $NODE_HEARTBEAT_PORT"      >> $CONF_BASE_PATH/pgpool.conf
        echo "heartbeat_device$i   = $NODE_HEARTBEAT_DEVICE"    >> $CONF_BASE_PATH/pgpool.conf 
        echo ""                                                 >> $CONF_BASE_PATH/pgpool.conf
            
        
    done
    set +a
    pglog "---------------"

    pglog "----- Generating Global conf ------"
    # Global configuration
    pglog "Configurating global parameters"
    pglog "port                 =  $PGPOOL_PORT"
    pglog "max_pool             =  $PGPOOL_POOL" 
    pglog "num_init_children    =  $NUM_INIT_CHILDREN"
    pglog "load_balance_mode    =  $PGPOOL_BALANCE_MODE"
    pglog "sr_check_period     =   $REPLICA_CHECK_PERIOD"
    pglog "sr_check_user       =  '$REPLICA_USER'"
    pglog "sr_check_password   =  '$REPLICA_PASS'"
    pglog "sr_check_database   =  '$POSTGRES_DB'"
    pglog "health_check_period     =   $HEALTH_CHECK_PERIOD"
    pglog "health_check_timeout    =   $HEALTH_CHECK_TIMEOUT"
    pglog "health_check_user       =  '$POSTGRES_USER'"       
    pglog "health_check_password   =  '$POSTGRES_PASSWORD'"
    pglog "pcp_port = $PCP_PORT"

    echo -e "\n# PGPOOL CONFIG"                         >> $CONF_BASE_PATH/pgpool.conf
    echo "port                 =  $PGPOOL_PORT"         >> $CONF_BASE_PATH/pgpool.conf
    echo "max_pool             =  $MAX_POOL"            >> $CONF_BASE_PATH/pgpool.conf
    echo "num_init_children    =  $NUM_INIT_CHILDREN"   >> $CONF_BASE_PATH/pgpool.conf
    echo "load_balance_mode    =  $PGPOOL_BALANCE_MODE" >> $CONF_BASE_PATH/pgpool.conf
    echo -e "\n# REPLICATION CHECK"                     >> $CONF_BASE_PATH/pgpool.conf
    echo "sr_check_period     =   $REPLICA_CHECK_PERIOD">> $CONF_BASE_PATH/pgpool.conf
    echo "sr_check_user       =  '$REPLICA_USER'"       >> $CONF_BASE_PATH/pgpool.conf
    echo "sr_check_password   =  '$REPLICA_PASS'"       >> $CONF_BASE_PATH/pgpool.conf
    echo "sr_check_database   =  '$POSTGRES_DB'"        >> $CONF_BASE_PATH/pgpool.conf
    echo -e "\n# HEALTH CHECK"                          >> $CONF_BASE_PATH/pgpool.conf
    echo "health_check_period     =   $HEALTH_CHECK_PERIOD"      >> $CONF_BASE_PATH/pgpool.conf
    echo "health_check_timeout    =   $HEALTH_CHECK_TIMEOUT"     >> $CONF_BASE_PATH/pgpool.conf
    echo "health_check_user       =  '$POSTGRES_USER'"           >> $CONF_BASE_PATH/pgpool.conf
    echo "health_check_password   =  '$POSTGRES_PASSWORD'"       >> $CONF_BASE_PATH/pgpool.conf
    echo -e "\n# PCP CONFIGURATION"                     >> $CONF_BASE_PATH/pgpool.conf
    echo "pcp_port = $PCP_PORT"                         >> $CONF_BASE_PATH/pgpool.conf


    # Create pcp user
    pglog "----- Generating PCP conf ------"
    pglog " User: $PCP_USER"
    pglog " Pass: $PCP_PASS"
    echo -e "\n$PCP_USER:$(pg_md5 $PCP_PASS)" >> $CONF_BASE_PATH/pcp.conf


    # Watchdog configuration PGPOOL_NUM = 1 disable, PGPOOL_NUM > 1 enable
    pglog "----- Generating Watchdog conf ------"
    echo -e "\n# WATCHDOG CONFIG"               >> $CONF_BASE_PATH/pgpool.conf
    if [ "$PGPOOL_NUM" = "1" ]; then
        pglog "Watchdog disabled"
        echo "use_watchdog = off"               >> $CONF_BASE_PATH/pgpool.conf
    else 
        pglog "Watchdog enabled"
        echo "use_watchdog = on"                >> $CONF_BASE_PATH/pgpool.conf

        # Watchdog configuration
        pglog "Configurating watchdog parameters"
        pglog "wd_lifecheck_method      = 'heartbeat'"
        pglog "wd_interval              = $WD_HEARTBEAT_INTERVAL"
        pglog "wd_heartbeat_keepalive   = $WD_HEARTBEAT_KEEPALIVE"
        pglog "wd_heartbeat_deadtime    = $WD_HEARTBEAT_DEADTIME"

        echo "wd_lifecheck_method      = 'heartbeat'"              >> $CONF_BASE_PATH/pgpool.conf
        echo "wd_interval              = $WD_HEARTBEAT_INTERVAL"   >> $CONF_BASE_PATH/pgpool.conf
        echo "wd_heartbeat_keepalive   = $WD_HEARTBEAT_KEEPALIVE"  >> $CONF_BASE_PATH/pgpool.conf
        echo "wd_heartbeat_deadtime    = $WD_HEARTBEAT_DEADTIME"   >> $CONF_BASE_PATH/pgpool.conf
    fi

    # Move to config path
    cp -rfa $CONF_BASE_PATH/. $PGPOOL_CONF_PATH

fi

pglog "-----------------------------"
pglog "> Starting pgpool"
pglog "> Listening on port $PGPOOL_PORT"

if [ "$ENABLE_LOGFILE" = "on" ]; then
    # Run pgpool to cronolog and output to file
    pgpool -n 2>&1 | cronolog    \
        --hardlink=$PGCDATA/$LOG_NAME   \
        "$PGCDATA/$LOG_FILENAME"
else
    # Run pgpool to stdout and stderr
    pgpool -n
fi
