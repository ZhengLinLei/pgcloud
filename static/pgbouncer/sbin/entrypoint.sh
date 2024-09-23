#!/bin/bash

PGPOOL_CONF_PATH=/etc/pgbouncer
CONF_BASE_PATH=$PGCDATA/conf

pglog () {
    echo $@
    printf '%s  |  %s\n' "$(date)" "$@" >> $PGCDATA/log/pgcloud.log
}

# Generate configuration
pglog "------------ Starting pgbouncer ------------"
pglog "  Server: $PGPOOL_PORT"
pglog "  PCP: $PCP_PORT"
pglog "  User: $POSTGRES_USER"
pglog "  Database: $POSTGRES_DB"
pglog "--------------------------------------------"
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
    
    pglog "----- Generating Database conf ------"

    pglog "[database]"
    echo "[database]"           >> $PGPOOL_CONF_PATH/pgbouncer.ini

    # Check if exist the configuration file
    # $CONF_BASE_PATH/backend.env
    if [ -f "$CONF_BASE_PATH/backend.env" ]; then
        source $CONF_BASE_PATH/backend.env

        pglog "$BACKEND_DB = \\"
        echo -e "$BACKEND_DB = \\\n"    >> $PGPOOL_CONF_PATH/pgbouncer.ini

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
            echo -e "host=$BACKEND_HOST$i port=$BACKEND_PORT$i dbname=$BACKEND_DB$i user=$POSTGRES_USER $end" >> $PGPOOL_CONF_PATH/pgbouncer.ini
        done
    else
        pglog "$POSTGRES_DB = host=$BACKEND_HOST port=$BACKEND_PORT dbname=$POSTGRES_DB"
        echo "$POSTGRES_DB = host=$BACKEND_HOST port=$BACKEND_PORT dbname=$POSTGRES_DB" >> $PGPOOL_CONF_PATH/pgbouncer.ini
    fi

    pglog "----- Generating Common conf ------"

    pglog "[pgbouncer]"
    pglog "[pgbouncer]"
    pglog "listen_addr = *"
    pglog "listen_port = $PGB_PORT"
    pglog "auth_type   = $PCB_AUTH"
    pglog "auth_file   = $PGPOOL_CONF_PATH/auth_file.cfg"

    echo "[pgbouncer]"                                   >> $PGPOOL_CONF_PATH/pgbouncer.ini
    echo "listen_addr = *"                               >> $PGPOOL_CONF_PATH/pgbouncer.ini
    echo "listen_port = $PGB_PORT"                       >> $PGPOOL_CONF_PATH/pgbouncer.ini
    echo "auth_type   = $PCB_AUTH"                       >> $PGPOOL_CONF_PATH/pgbouncer.ini
    echo "auth_file   = $PGPOOL_CONF_PATH/auth_file.cfg" >> $PGPOOL_CONF_PATH/pgbouncer.ini

    # pglog "----- Generating Auth conf ------"

fi