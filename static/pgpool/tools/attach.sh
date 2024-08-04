#!/bin/bash

STATUS_SCRIPT=$PGCDATA/script/status.sh
PCPPASSFILE=~/.pcppass 

# Check if argument set

if [ "$#" -ne 1 ]; then
    echo "Please specify a node id to perform a attach recovery"
    $STATUS_SCRIPT

    exit 0
fi

# Attach
echo "Attaching the node $1"

# Check if pass file generated
if [ ! -f "$PCPPASSFILE" ]; then
    echo "127.0.0.1:$PCP_PORT:$PCP_USER:$PCP_PASS" > $PCPPASSFILE
    chmod 600 $PCPPASSFILE
    echo "Pass file generated!"
fi

iRet=$(pcp_node_info   -h 127.0.0.1 -p $PCP_PORT -U $PCP_USER -v -w $1 | grep -E "down|quarantine")

if [ "$iRet" != " " ]; then
    pcp_attach_node -h 127.0.0.1 -p $PCP_PORT -U $PCP_USER -v -w $1
    echo "Node $1 started failing back. Do not close or stop the process"
    echo "Wait until the attaching is completed"
else
    echo "Node $1 is not down, attaching is allowed only for down node"
fi

pcp_node_info   -h 127.0.0.1 -p $PCP_PORT -U $PCP_USER -v -w $1