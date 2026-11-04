#!/bin/bash

export PGPASSWORD="$POSTGRES_PASSWORD"
psql -h 127.0.0.1 -U $POSTGRES_USER -p $PGB_PORT -d pgbouncer -c "SHOW STATS;"