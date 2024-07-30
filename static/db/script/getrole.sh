#!/bin/bash

# Execute get role
IS_REPLICA=$(psql -U $POSTGRES_USER -d $POSTGRES_DB -p $PGPORT -t -c "SELECT pg_is_in_recovery();")

# Remove blank space
IS_REPLICA=$(echo $IS_REPLICA | xargs)

# Out
if [ "$IS_REPLICA" == "t" ]; then
  echo "false"
  echo "This node role is replica" >&2
else
  echo "true"
  echo "This node role is primary" >&2
fi