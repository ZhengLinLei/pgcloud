#!/bin/bash

export PGPASSWORD="$POSTGRES_PASSWORD"
psql -U $POSTGRES_USER -p $PGBOUNCER_PORT -d $POSTGRES_DB -c "SHOW POOLS;"