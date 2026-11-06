#!/bin/bash

PGB_CONF_PATH=/etc/pgbouncer
PGB_LOCK_FILE=lock.pgcloud
CONF_BASE_PATH=$PGCDATA/conf

# Refuse to start with placeholder passwords from .env.example
for var in POSTGRES_PASSWORD; do
    if [ -z "${!var}" ] || [ "${!var}" = "change_me" ]; then
        echo "ERROR: $var is empty or still 'change_me'. Set a real value in .env" >&2
        exit 1
    fi
done

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
    pglog "To reset the configuration, remove the lock file '$PGB_CONF_PATH/$PGB_LOCK_FILE' and restart the container"
    pglog "If any error occurs, please check the logs and fix the error manually or remove the lock file and let system to write the configuration"
else
    pglog "Initializing pgbouncer configuration files"
    
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
            echo "$POSTGRES_DB = host=$RW_BACKEND_HOST port=$RW_BACKEND_PORT dbname=$POSTGRES_DB" >> $CONF_BASE_PATH/pgbouncer.ini
        fi

        # Check if set RO
        if [ "$RO_BACKEND_NUM" -gt 0 ]; then
            if [ -z "$RO_BACKEND_HOST" ]; then
                pglog "ERROR: RO_BACKEND_HOST is not set"
                exit 1
            fi
            if [ -z "$RO_BACKEND_PORT" ]; then
                pglog "ERROR: RO_BACKEND_PORT is not set"
                exit 1
            fi

            pglog "$RO_POSTGRES_DB = host=$RO_BACKEND_HOST port=$RO_BACKEND_PORT dbname=$POSTGRES_DB"
            echo "$RO_POSTGRES_DB = host=$RO_BACKEND_HOST port=$RO_BACKEND_PORT dbname=$POSTGRES_DB" >> $CONF_BASE_PATH/pgbouncer.ini
        fi
    else
        pglog "----- Using environment variables ------"
        pglog "$POSTGRES_DB = host=$BACKEND_HOST port=$BACKEND_PORT dbname=$POSTGRES_DB"
        echo "$POSTGRES_DB = host=$BACKEND_HOST port=$BACKEND_PORT dbname=$POSTGRES_DB" >> $CONF_BASE_PATH/pgbouncer.ini
    fi

    pglog "----- Generating Common conf ------"

    pglog "[pgbouncer]"
    pglog "listen_addr = *"
    pglog "listen_port = $PGB_PORT"
    pglog "auth_type   = $PGB_AUTH"
    pglog "auth_file   = $PGB_CONF_PATH/auth_file.cfg"

    echo "[pgbouncer]"                                   >> $CONF_BASE_PATH/pgbouncer.ini
    echo "listen_addr = *"                               >> $CONF_BASE_PATH/pgbouncer.ini
    echo "listen_port = $PGB_PORT"                       >> $CONF_BASE_PATH/pgbouncer.ini
    echo "auth_type   = $PGB_AUTH"                       >> $CONF_BASE_PATH/pgbouncer.ini
    echo "auth_file   = $PGB_CONF_PATH/auth_file.cfg"    >> $CONF_BASE_PATH/pgbouncer.ini
    # Allow the main user to run SHOW POOLS/CLIENTS/... on the admin console (scripts/*.sh)
    echo "admin_users = $POSTGRES_USER"                  >> $CONF_BASE_PATH/pgbouncer.ini

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
    pglog " Pass: ********"
    > $CONF_BASE_PATH/auth_file.cfg

    # Store the password itself (not the Postgres SCRAM/MD5 hash). PgBouncer derives the
    # md5/SCRAM exchange from it for both clients and servers. With a SCRAM *hash* PgBouncer
    # falls back to "SCRAM pass-through", which only works when the server uses the very same
    # salt (direct Postgres) and fails against pgpool, which builds its own verifier.
    # The file is only readable by root and the pgbouncer user.
    printf '"%s" "%s"\n' "$POSTGRES_USER" "$POSTGRES_PASSWORD" >> $CONF_BASE_PATH/auth_file.cfg
    chmod 640 $CONF_BASE_PATH/auth_file.cfg $CONF_BASE_PATH/pgbouncer.ini


    # Move to config path
    mkdir -p $PGB_CONF_PATH
    cp -rfa $CONF_BASE_PATH/. $PGB_CONF_PATH

    # Mark configuration as generated, so a container restart does not append it again
    touch $PGB_CONF_PATH/$PGB_LOCK_FILE
    pglog "Configuration generated, lock file created: $PGB_CONF_PATH/$PGB_LOCK_FILE"

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