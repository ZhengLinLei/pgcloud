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

    pglog "[databases]"
    echo -e "\n"                >> $CONF_BASE_PATH/pgbouncer.ini
    echo "[databases]"           >> $CONF_BASE_PATH/pgbouncer.ini

    # Check if exist the configuration file
    # $CONF_BASE_PATH/backend.env
    if [ -f "$CONF_BASE_PATH/server/backend.env" ]; then
        pglog "----- Using backend.env ------"
        source $CONF_BASE_PATH/server/backend.env

        if [ -z "$RW_BACKEND_NUM" ]; then
            pglog "ERROR: RW_BACKEND_NUM is not set"
            exit 1
        fi
        if [ -z "$RO_BACKEND_NUM" ]; then
            pglog "ERROR: RO_BACKEND_NUM is not set"
            exit 1
        fi

        # Check if set RW
        if [ "$RW_BACKEND_NUM" -gt 0 ]; then
            if [ -z "$RW_BACKEND_HOST" ]; then
                pglog "ERROR: RW_BACKEND_HOST is not set"
                exit 1
            fi
            if [ -z "$RW_BACKEND_PORT" ]; then
                pglog "ERROR: RW_BACKEND_PORT is not set"
                exit 1
            fi

            pglog "$POSTGRES_DB = host=$RW_BACKEND_HOST port=$RW_BACKEND_PORT dbname=$POSTGRES_DB"
            echo "$POSTGRES_DB = host=$RW_BACKEND_HOST port=$RW_BACKEND_PORT dbname=$POSTGRES_DB password=$POSTGRES_PASSWORD" >> $CONF_BASE_PATH/pgbouncer.ini
        fi

        # Check if set RO
        if [ "$RO_BACKEND_NUM" -gt 0 ]; then
            if [ -z "$RO_BACKEND_HOST$" ]; then
                pglog "ERROR: RO_BACKEND_HOST is not set"
                exit 1
            fi
            if [ -z "$RO_BACKEND_PORT" ]; then
                pglog "ERROR: RO_BACKEND_PORT is not set"
                exit 1
            fi

            pglog "$RO_POSTGRES_DB = host=$RO_BACKEND_HOST port=$RW_BACKEND_PORT dbname=$POSTGRES_DB"
            echo "$RO_POSTGRES_DB = host=$RO_BACKEND_PORT port=$RW_BACKEND_PORT dbname=$POSTGRES_DB password=$POSTGRES_PASSWORD" >> $CONF_BASE_PATH/pgbouncer.ini
        fi
    else
        pglog "----- Using environment variables ------"
        pglog "$POSTGRES_DB = host=$BACKEND_HOST port=$BACKEND_PORT dbname=$POSTGRES_DB"
        echo "$POSTGRES_DB = host=$BACKEND_HOST port=$BACKEND_PORT dbname=$POSTGRES_DB password=$POSTGRES_PASSWORD" >> $CONF_BASE_PATH/pgbouncer.ini
    fi

    pglog "----- Generating Common conf ------"

    pglog "[pgbouncer]"
    pglog "listen_addr = *"
    pglog "listen_port = $PGB_PORT"
    pglog "auth_type   = $PCB_AUTH"
    pglog "auth_file   = $PGB_CONF_PATH/auth_file.cfg"

    echo "[pgbouncer]"                                   >> $CONF_BASE_PATH/pgbouncer.ini
    echo "listen_addr = *"                               >> $CONF_BASE_PATH/pgbouncer.ini
    echo "listen_port = $PGB_PORT"                       >> $CONF_BASE_PATH/pgbouncer.ini
    echo "auth_type   = $PGB_AUTH"                       >> $CONF_BASE_PATH/pgbouncer.ini
    echo "auth_file   = $PGB_CONF_PATH/auth_file.cfg"    >> $CONF_BASE_PATH/pgbouncer.ini

    pglog "----- Generating Limits conf ------"

    pglog "pool_mode = $POOL_MODE"
    pglog "max_client_conn = $MAX_CONNECTIONS"
    pglog "default_pool_size = $DEFAULT_POOL_SIZE"

    echo "pool_mode = $POOL_MODE"                       >> $CONF_BASE_PATH/pgbouncer.ini
    echo "max_client_conn = $MAX_CONNECTIONS"           >> $CONF_BASE_PATH/pgbouncer.ini
    echo "default_pool_size = $DEFAULT_POOL_SIZE"       >> $CONF_BASE_PATH/pgbouncer.ini

    # Create auth_file
    pglog "----- Generating auth_file ------"
    pglog " User: $POSTGRES_USER"
    pglog " Pass: $POSTGRES_PASSWORD"
    > $CONF_BASE_PATH/auth_file.cfg

    # Create password for Postgres
    export PGPASSWORD=$POSTGRES_PASSWORD
    ENCRYPTED_PASS=$(psql -At -h $BACKEND_HOST -p $BACKEND_PORT -U $POSTGRES_USER -d $POSTGRES_DB -c "SELECT rolpassword FROM pg_authid WHERE rolname='$POSTGRES_USER';")
    
    # If error exit with error and log
    if [ $? -ne 0 ]; then
        # Print to stderror
        echo "ERROR: Please check logs. Could not connect to the database" 1>&2
        pglog "ERROR: Please check logs. Could not connect to the database"
        exit 1
    fi

    pglog "Backend password: $ENCRYPTED_PASS"
    if [ "$PGB_AUTH" == "md5" ]; then
        # Check if password is already encrypted in md5
        if [[ $ENCRYPTED_PASS == "md5"* ]]; then
            pglog "Password is already encrypted in md5"
        else
            pglog "WARNING: Backend password is not encrypted in md5, this may cause authentication errors"
        fi
        ENCRYPTED_PASS="md5$(echo -n "$POSTGRES_PASSWORD""$POSTGRES_USER" | md5sum | awk '{print $1}')"
    elif [ "$PGB_AUTH" == "scram-sha-256" ]; then
        # Check if password is already encrypted in scram-sha-256
        if [[ $ENCRYPTED_PASS == "SCRAM-SHA-256"* ]]; then
            pglog "Password is already encrypted in SCRAM-SHA-256"
        else
            pglog "WARNING: Backend password is not encrypted in SCRAM-SHA-256, this may cause authentication errors"
        fi
    fi
    echo "\"$POSTGRES_USER\" \"$ENCRYPTED_PASS\"" >> $CONF_BASE_PATH/auth_file.cfg


    # Move to config path
    cp -rfa $CONF_BASE_PATH/. $PGB_CONF_PATH

fi

pglog "-----------------------------"
pglog "> Starting pgbouncer"
pglog "> Listening on port $PGB_PORT"
pglog "> Ini file: $PGB_CONF_PATH/pgbouncer.ini"


# Run pgbouncer
if [ "$ENABLE_LOGFILE" = "on" ]; then
    # Run pgbouncer to cronolog and output to file
    pgbouncer -u pgbouncer $PGB_CONF_PATH/pgbouncer.ini 2>&1 | cronolog    \
        --hardlink=$PGCDATA/$LOG_NAME   \
        "$PGCDATA/$LOG_FILENAME"
else
    # Run pgbouncer to stdout and stderr
    pgbouncer -u pgbouncer $PGB_CONF_PATH/pgbouncer.ini
fi