#!/bin/bash

export PGPASSWORD="$POSTGRES_PASSWORD"
psql -U $POSTGRES_USER -p $PGPOOL_PORT -d $POSTGRES_DB