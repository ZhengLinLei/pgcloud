#!/bin/bash

PGB_CONF_PATH=/etc/pgbouncer
PGB_LOCK_FILE=lock.pgcloud
CONF_BASE_PATH=$PGCDATA/conf

pglog () {
    echo $@
    printf '%s  |  %s\n' "$(date)" "$@" >> $PGCDATA/log/pgcloud.log
}

# Generate configuration
pglog "------------ Starting pgbouncer ------------"
pglog "  Server: $PGB_PORT"
pglog "  User: $POSTGRES_USER"
pglog "  Database: $POSTGRES_DB"
pglog "--------------------------------------------"
pglog " Important: The configuration will be erased if the container is removed."
pglog "            When recreating the container, the configuration will be reset to the default. And set again with the environment variables."
pglog "            To avoid this, mount the configuration file to the container."

# Check if configuration exists
if [ -f $PGB_CONF_PATH/$PGB_LOCK_FILE ]; then
    pglog "Directory appears to contain a previous configuration; Skipping initialization of config files"
    pglog "To reset the configuration, remove the lock file `$PGB_CONF_PATH/$PGB_LOCK_FILE` and restart the container"
    pglog "If any error occurs, please check the logs and fix the error manually or remove the lock file and let system to write the configuration"
else
    pglog "Initializing pgpool configuration files"
    
    pglog "----- Generating Database conf ------"

    pglog "[database]"
    echo "[database]"           >> $CONF_BASE_PATH/pgbouncer.ini

    # Check if exist the configuration file
    # $CONF_BASE_PATH/backend.env
    if [ -f "$CONF_BASE_PATH/backend.env" ]; then
        source $CONF_BASE_PATH/backend.env

        pglog "$BACKEND_DB = \\"
        echo -e "$BACKEND_DB = \\\n"    >> $CONF_BASE_PATH/pgbouncer.ini

        BACKEND_NUM=$(( BACKEND_NUM - 1 ))
        for i in {0 .. $BACKEND_NUM}; do
            if [ -z $BACKEND_HOST$i ]; then
                pglog "Error: BACKEND_HOST$i is not set"
                exit 1
            fi

            if [ -z $BACKEND_PORT$i ]; then
                pglog "Error: BACKEND_PORT$i is not set"
                exit 1
            fi

            if [ "$BACKEND_NUM" == "$i" ]; then
                end=" \n"
            else
                end=" \\\n"
            fi

            pglog "host=$BACKEND_HOST$i port=$BACKEND_PORT$i dbname=$BACKEND_DB$i user=$POSTGRES_USER $end"
            echo -e "host=$BACKEND_HOST$i port=$BACKEND_PORT$i dbname=$BACKEND_DB$i user=$POSTGRES_USER $end" >> $CONF_BASE_PATH/pgbouncer.ini
        done
    else
        pglog "$POSTGRES_DB = host=$BACKEND_HOST port=$BACKEND_PORT dbname=$POSTGRES_DB"
        echo "$POSTGRES_DB = host=$BACKEND_HOST port=$BACKEND_PORT dbname=$POSTGRES_DB" >> $CONF_BASE_PATH/pgbouncer.ini
    fi

    pglog "----- Generating Common conf ------"

    pglog "[pgbouncer]"
    pglog "[pgbouncer]"
    pglog "listen_addr = *"
    pglog "listen_port = $PGB_PORT"
    pglog "auth_type   = $PCB_AUTH"
    pglog "auth_file   = $PGB_CONF_PATH/auth_file.cfg"

    echo "[pgbouncer]"                                   >> $CONF_BASE_PATH/pgbouncer.ini
    echo "listen_addr = *"                               >> $CONF_BASE_PATH/pgbouncer.ini
    echo "listen_port = $PGB_PORT"                       >> $CONF_BASE_PATH/pgbouncer.ini
    echo "auth_type   = $PCB_AUTH"                       >> $CONF_BASE_PATH/pgbouncer.ini
    echo "auth_file   = $PGB_CONF_PATH/auth_file.cfg"    >> $CONF_BASE_PATH/pgbouncer.ini

    pglog "----- Generating Limits conf ------"

    pglog "pool_mode = $POOL_MODE"
    pglog "max_client_conn = $MAX_CLIENT_CONN"
    pglog "default_pool_size = $DEFAULT_POOL_SIZE"

    echo "pool_mode = $POOL_MODE"                       >> $CONF_BASE_PATH/pgbouncer.ini
    echo "max_client_conn = $MAX_CLIENT_CONN"           >> $CONF_BASE_PATH/pgbouncer.ini
    echo "default_pool_size = $DEFAULT_POOL_SIZE"       >> $CONF_BASE_PATH/pgbouncer.ini

    # Create auth_file
    pglog "----- Generating auth_file ------"
    pglog " User: $POSTGRES_USER"
    pglog " Pass: $POSTGRES_PASSWORD"
    > $CONF_BASE_PATH/auth_file.cfg
    MD5_PASS="md5$(echo -n "$POSTGRES_PASSWORD""$POSTGRES_USER" | md5sum | awk '{print $1}')"
    echo "$POSTGRES_USER $MD5_PASS" >> $CONF_BASE_PATH/auth_file.cfg


    # Move to config path
    cp -rfa $CONF_BASE_PATH/. $PGB_CONF_PATH

fi

pglog "-----------------------------"
pglog "> Starting pgbouncer"
pglog "> Listening on port $PGB_PORT"


# Run pgbouncer
if [ "$ENABLE_LOGFILE" = "on" ]; then
    # Run pgbouncer to cronolog and output to file
    pgbouncer $PGB_CONF_PATH/pgbouncer.ini 2>&1 | cronolog    \
        --hardlink=$PGCDATA/$LOG_NAME   \
        "$PGCDATA/$LOG_FILENAME"
else
    # Run pgbouncer to stdout and stderr
    pgbouncer $PGB_CONF_PATH/pgbouncer.ini
fi