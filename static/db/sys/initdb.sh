#!/bin/bash

if [ "$(pg_lsclusters | grep $PGNAME)" != "" ]; then
    echo "Cluster already prepared, init not needed"
    # Exist, init not needed
    exit 0
fi

echo $PGDATA
echo aaa
echo $PGNAME

# Remove default cluster
pg_dropcluster --stop $PGVERSION main

# Check node role
if [ "$NODE_ROLE" == "primary" ]; then
    #-------------------------
    #- PRIMARY
    #------------------------

    echo "Creating Primary Cluster Named: $PGNAME"
    echo aaa
    
    # Create the cluster
    pg_createcluster -d $PGDATA -l $PGCLOG/$PGNAME.log -p $PGPORT $PGVERSION $PGNAME
else
    #-------------------------
    #- PRIMARY
    #------------------------

    echo "Replicating Primary Cluster Named: $PGNAME"
fi