#!/bin/bash

# Get role path
GETROLE_SCRIPT="$PGCDATA/script/getrole.sh"

# Execute and verify data
ROLE=$($GETROLE_SCRIPT)

# Verifica el rol del nodo
if [ "$ROLE" == "true" ]; then
    # Listing replicas data
    echo 
    psql -U $POSTGRES_USER -d $POSTGRES_DB -p $PGPORT -c "
        SELECT
        client_addr AS replica_address,
        state,
        sync_state
        FROM
        pg_stat_replication;
    "

    echo ""

    echo "[     Archive WAL data    ]"
    psql -U $POSTGRES_USER -d $POSTGRES_DB -p $PGPORT -c "
        SELECT
            archived_count,
            last_archived_wal,
            last_archived_time,
            failed_count,
            last_failed_wal,
            last_failed_time,
            stats_reset
        FROM
            pg_stat_archiver;
    "

    echo ""

    echo "[   Replica slot information  ]"
    psql -U $POSTGRES_USER -d $POSTGRES_DB -p $PGPORT -c "
        SELECT
            slot_name,
            plugin,
            slot_type,
            datoid,
            database,
            active,
            restart_lsn,
            confirmed_flush_lsn
        FROM
            pg_replication_slots;
    "
else
    # Replica info

    # WAL receiver data
    echo "[    WAL Receiver Information     ]"
    psql -U $POSTGRES_USER -d $POSTGRES_DB -p $PGPORT -c "
        SELECT
            pid,
            status,
            receive_start_lsn,
            receive_start_tli,
            received_lsn,
            received_tli,
            last_msg_send_time,
            last_msg_receipt_time,
            latest_end_lsn,
            latest_end_time,
            slot_name,
            sender_host,
            sender_port,
            conninfo
        FROM
            pg_stat_wal_receiver;
    "
    echo ""

    # Replication slot information
    echo "[  Replication Slots Information  ]"
    psql -U $POSTGRES_USER -d $POSTGRES_DB -p $PGPORT -t -c "
        SELECT
            slot_name,
            plugin,
            slot_type,
            datoid,
            database,
            active,
            restart_lsn,
            confirmed_flush_lsn
        FROM
            pg_stat_replication_slots;
    "

    echo ""

    # Last receive and update of WAL
    echo "[    Last WAL Received LSN    ]"
    psql -U $POSTGRES_USER -d $POSTGRES_DB -p $PGPORT -t -c "SELECT pg_last_wal_receive_lsn();"

    echo ""

    echo "[    Last WAL Replay LSN      ]"
    psql -U $POSTGRES_USER -d $POSTGRES_DB -p $PGPORT -t -c "SELECT pg_last_wal_replay_lsn();"

fi
