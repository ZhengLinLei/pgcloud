#!/bin/bash

if [ "$(pg_lsclusters | grep $PGNAME)" != "" ]; then
    # Exist, init not needed
    exit 0
else

# Check node role
if [ "$NODE_ROLE" == "primary" ]; then
    #-------------------------
    #- PRIMARY
    #------------------------
    
    # Create the cluster
    pg_createcluster $PGVERSION $PGNAME
else


fi