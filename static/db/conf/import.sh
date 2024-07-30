#!/bin/bash

echo "Moving conf file"
cp -rfa $PGCDATA/conf/*.conf $PGDATA


read -p "Do you want to reload Postgres to apply configuration? (y/n) " yn

if [ "$yn" = "y" ]; then
	echo "Reloading configuration..."
	psql -U $POSTGRES_USER -d $POSTGRES_DB -p $PGPORT -c "SELECT pg_reload_conf();"
fi