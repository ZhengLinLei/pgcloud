#! /bin/bash

PCPPASSFILE=~/.pcppass 
# Check if pass file generated
if [ ! -f "$PCPPASSFILE" ]; then
    echo "127.0.0.1:9898:$PCP_USER:$PCP_PASS" > $PCPPASSFILE
    chmod 600 $PCPPASSFILE
    echo "Pass file generated!"
fi

pcp_watchdog_info -h 127.0.0.1 -U $PCP_USER -p 9898 -w -v
