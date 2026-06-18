#!/bin/bash

STATUS_SCRIPT=$PGCDATA/script/status.sh
PCPPASSFILE=~/.pcppass 

# Check if argument set

if [ "$#" -ne 1 ]; then
    echo "Please specify a node id to perform a detach order"
    $STATUS_SCRIPT

    exit 0
fi

# Detach
echo "Detaching the node $1"

# Check if pass file generated
if [ ! -f "$PCPPASSFILE" ]; then
    echo "127.0.0.1:$PCP_PORT:$PCP_USER:$PCP_PASS" > $PCPPASSFILE
    chmod 600 $PCPPASSFILE
    echo "Pass file generated!"
fi

iRet=$(pcp_node_info   -h 127.0.0.1 -p $PCP_PORT -U $PCP_USER -v -w -n $1 | grep -E "up")

if [ "$iRet" != " " ]; then
    pcp_detach_node -h 127.0.0.1 -p $PCP_PORT -U $PCP_USER -v -w -n $1
    echo "Node $1 is being pushed out the cluster. Do not close or stop the process"
    echo "Wait until the detach is completed"
else
    echo "Node $1 is not up, detach is allowed only for up node"
fi

pcp_node_info   -h 127.0.0.1 -p $PCP_PORT -U $PCP_USER -v -w $1
