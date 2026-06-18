#!/bin/bash

# PostgreSQL Replication Script
# Use with: watch -n 5 ./replication.sh

CONFIG_FILE="${1:-.env}"
if [ ! -f "$CONFIG_FILE" ]; then
    echo "ERROR: Configuration file $CONFIG_FILE not found!"
    exit 1
fi
source "$CONFIG_FILE"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
MAGENTA='\033[0;35m'
CYAN='\033[0;36m'
WHITE='\033[1;37m'
BOLD='\033[1m'
NC='\033[0m'

PG_USER="${PG_USER:-postgres}"
PG_DATABASE="${PG_DATABASE:-postgres}"
REPLICATION_LAG_WARNING="${REPLICATION_LAG_WARNING:-30}"
REPLICATION_LAG_CRITICAL="${REPLICATION_LAG_CRITICAL:-60}"
CONNECTION_WARNING="${CONNECTION_WARNING:-70}"
CONNECTION_CRITICAL="${CONNECTION_CRITICAL:-90}"
CHECK_WAL="${CHECK_WAL:-true}"
CHECK_DISK_USAGE="${CHECK_DISK_USAGE:-true}"
CHECK_CPU_MEMORY="${CHECK_CPU_MEMORY:-true}"

execute_query() {
    local host=$1
    local port=$2
    local query=$3
    
    PGPASSWORD="$PG_PASSWORD" psql -h "$host" -p "$port" -U "$PG_USER" -d "$PG_DATABASE" -t -A -c "$query" 2>/dev/null
}

get_numeric() {
    local value=$1
    local default=$2
    if [[ "$value" =~ ^[0-9]+$ ]]; then
        echo "$value"
    else
        echo "$default"
    fi
}

compare_decimals() {
    local val1=$1
    local val2=$2
    local operator=$3
    
    case $operator in
        ">")
            echo "$(echo "$val1 > $val2" | bc -l 2>/dev/null || echo "0")"
            ;;
        "<")
            echo "$(echo "$val1 < $val2" | bc -l 2>/dev/null || echo "0")"
            ;;
        ">=")
            echo "$(echo "$val1 >= $val2" | bc -l 2>/dev/null || echo "0")"
            ;;
        "<=")
            echo "$(echo "$val1 <= $val2" | bc -l 2>/dev/null || echo "0")"
            ;;
        *)
            echo "0"
            ;;
    esac
}

diagnose_replication_lag() {
    local host=$1
    local port=$2
    
    echo -e "${WHITE}╔══════════════════════════════════════════════════════════════════════════════════╗${NC}"
    echo -e "${WHITE}║ ${BLUE}REPLICATION LAG DIAGNOSTICS${WHITE}                                                      ║${NC}"
    echo -e "${WHITE}╚══════════════════════════════════════════════════════════════════════════════════╝${NC}"
    
    # Get detailed replication info
    local repl_info=$(execute_query "$host" "$port" "
        SELECT
            application_name,
            client_addr,
            state,
            sync_state,
            sync_priority,
            write_lag,
            flush_lag,
            replay_lag,
            write_lsn,
            flush_lsn,
            replay_lsn,
            sent_lsn,
            COALESCE(ROUND(EXTRACT(EPOCH FROM write_lag)::numeric,3),0),
            COALESCE(ROUND(EXTRACT(EPOCH FROM flush_lag)::numeric,3),0),
            COALESCE(ROUND(EXTRACT(EPOCH FROM replay_lag)::numeric,3),0),
            COALESCE(pg_wal_lsn_diff(sent_lsn, replay_lsn),0)::bigint AS lag_bytes
        FROM pg_stat_replication;
    " 2>/dev/null)
    
    if [ -n "$repl_info" ]; then
        echo "$repl_info" | while IFS='|' read -r app_name client_addr state sync_state sync_priority write_lag flush_lag replay_lag write_lsn flush_lsn replay_lsn sent_lsn write_lag_sec flush_lag_sec replay_lag_sec lag_bytes; do
            if [ -n "$app_name" ]; then
                # Clean values
                app_name=$(echo "$app_name" | xargs)
                client_addr=$(echo "$client_addr" | xargs)
                state=$(echo "$state" | xargs)
                sync_state=$(echo "$sync_state" | xargs)
                
                echo -e "${WHITE}┌────────────────────────────────────────────────────────────────────────────────┐${NC}"
                echo -e "${WHITE}│ ${GREEN}Replica: ${app_name}${NC} (${client_addr})"
                echo -e "${WHITE}│${NC}"
                
                # Estado de replicación
                echo -e "   ${WHITE}State:${NC} ${GREEN}${state}${NC}  ${WHITE}Sync State:${NC} ${YELLOW}${sync_state}${NC}  ${WHITE}Priority:${NC} ${sync_priority}"
                
                # Lags detallados
                echo -e "   ${WHITE}┌─ Lag Metrics ────────────────────────────────────────────────────────────┐${NC}"
                
                # Write Lag
                write_lag_sec=${write_lag_sec:-0}
                local write_color="$GREEN"
                if (( $(compare_decimals "$write_lag_sec" "$REPLICATION_LAG_CRITICAL" ">=") )); then
                    write_color="$RED"
                elif (( $(compare_decimals "$write_lag_sec" "$REPLICATION_LAG_WARNING" ">=") )); then
                    write_color="$YELLOW"
                fi
                echo -e "   ${WHITE}│${NC} Write Lag: ${write_color}${write_lag_sec}s${NC} (${write_lag})"
                
                # Flush Lag
                flush_lag_sec=${flush_lag_sec:-0}
                local flush_color="$GREEN"
                if (( $(compare_decimals "$flush_lag_sec" "$REPLICATION_LAG_CRITICAL" ">=") )); then
                    flush_color="$RED"
                elif (( $(compare_decimals "$flush_lag_sec" "$REPLICATION_LAG_WARNING" ">=") )); then
                    flush_color="$YELLOW"
                fi
                echo -e "   ${WHITE}│${NC} Flush Lag: ${flush_color}${flush_lag_sec}s${NC} (${flush_lag})"
                
                # Replay Lag
                replay_lag_sec=${replay_lag_sec:-0}
                local replay_color="$GREEN"
                if (( $(compare_decimals "$replay_lag_sec" "$REPLICATION_LAG_CRITICAL" ">=") )); then
                    replay_color="$RED"
                elif (( $(compare_decimals "$replay_lag_sec" "$REPLICATION_LAG_WARNING" ">=") )); then
                    replay_color="$YELLOW"
                fi
                echo -e "   ${WHITE}│${NC} Replay Lag: ${replay_color}${replay_lag_sec}s${NC} (${replay_lag})"
                echo -e "   ${WHITE}└──────────────────────────────────────────────────────────────────────────┘${NC}"
                
                # LSN positions
                echo -e "   ${WHITE}┌─ LSN Positions ──────────────────────────────────────────────────────────┐${NC}"
                echo -e "   ${WHITE}│${NC} Sent LSN:   ${CYAN}${sent_lsn}${NC}"
                echo -e "   ${WHITE}│${NC} Write LSN:  ${CYAN}${write_lsn}${NC}"
                echo -e "   ${WHITE}│${NC} Flush LSN:  ${CYAN}${flush_lsn}${NC}"
                echo -e "   ${WHITE}│${NC} Replay LSN: ${CYAN}${replay_lsn}${NC}"
                echo -e "   ${WHITE}└──────────────────────────────────────────────────────────────────────────┘${NC}"
                
                # WAL Lag in MB
                lag_bytes=${lag_bytes:-0}
                local wal_mb=$(awk "BEGIN { printf \"%.2f\", ${lag_bytes}/1024/1024 }" 2>/dev/null || echo "0.00")
                local wal_color="$GREEN"
                if [ "$lag_bytes" -gt 1073741824 ]; then  # 1GB
                    wal_color="$RED"
                elif [ "$lag_bytes" -gt 104857600 ]; then  # 100MB
                    wal_color="$YELLOW"
                fi
                echo -e "   ${WHITE}┌─ WAL Lag ────────────────────────────────────────────────────────────────┐${NC}"
                echo -e "   ${WHITE}│${NC} WAL Lag: ${wal_color}${wal_mb} MB${NC}"
                echo -e "   ${WHITE}└──────────────────────────────────────────────────────────────────────────┘${NC}"
                
                # Diagnosis
                echo -e "   ${WHITE}┌─ Diagnosis ──────────────────────────────────────────────────────────────┐${NC}"
                
                write_lag_sec=${write_lag_sec:-0}
                flush_lag_sec=${flush_lag_sec:-0}
                replay_lag_sec=${replay_lag_sec:-0}
                
                if (( $(compare_decimals "$write_lag_sec" "$flush_lag_sec" ">") )) && \
                   (( $(compare_decimals "$write_lag_sec" "$replay_lag_sec" ">") )); then
                    echo -e "   ${WHITE}│${NC} ${YELLOW}⚠ Write lag is highest - Network or disk I/O issue on primary${NC}"
                elif (( $(compare_decimals "$flush_lag_sec" "$write_lag_sec" ">") )) && \
                     (( $(compare_decimals "$flush_lag_sec" "$replay_lag_sec" ">") )); then
                    echo -e "   ${WHITE}│${NC} ${YELLOW}⚠ Flush lag is highest - Disk I/O bottleneck on replica${NC}"
                elif (( $(compare_decimals "$replay_lag_sec" "$write_lag_sec" ">") )) && \
                     (( $(compare_decimals "$replay_lag_sec" "$flush_lag_sec" ">") )); then
                    echo -e "   ${WHITE}│${NC} ${YELLOW}⚠ Replay lag is highest - CPU/query performance issue on replica${NC}"
                fi
                
                if (( $(compare_decimals "$replay_lag_sec" 60 ">") )); then
                    echo -e "   ${WHITE}│${NC} ${RED}🔴 High replay lag detected! Check:${NC}"
                    echo -e "   ${WHITE}│${NC}    - Long running queries on replica"
                    echo -e "   ${WHITE}│${NC}    - Check pg_stat_activity on replica"
                    echo -e "   ${WHITE}│${NC}    - Verify replica hardware resources"
                    echo -e "   ${WHITE}│${NC}    - Check for blocking locks"
                fi
                
                if (( $(compare_decimals "$write_lag_sec" 30 ">") )) || \
                   (( $(compare_decimals "$flush_lag_sec" 30 ">") )); then
                    echo -e "   ${WHITE}│${NC} ${YELLOW}⚠ Write/Flush lag high:${NC}"
                    echo -e "   ${WHITE}│${NC}    - Check network bandwidth"
                    echo -e "   ${WHITE}│${NC}    - Verify primary disk I/O"
                    echo -e "   ${WHITE}│${NC}    - Check wal_keep_size configuration"
                fi
                
                if [ "$state" = "streaming" ]; then
                    echo -e "   ${WHITE}│${NC} ${GREEN}✓ Replication Stream Active${NC}"
                else
                    echo -e "   ${WHITE}│${NC} ${RED}✗ Replication Stream Inactive (state: ${state})${NC}"
                fi
                
                local repl_slots=$(execute_query "$host" "$port" "
                    SELECT
                        slot_name,
                        active,
                        ROUND(
                            COALESCE(
                                pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn) / 1024.0 / 1024.0,
                                0
                            ),
                            1
                        ) as wal_mb
                    FROM pg_replication_slots
                    WHERE slot_name LIKE '%$app_name%';
                " 2>/dev/null)
                
                if [ -n "$repl_slots" ]; then
                    echo "$repl_slots" | while IFS='|' read -r slot_name active wal_mb; do
                        if [ -n "$slot_name" ]; then
                            local slot_status="$GREEN"
                            if [ "$active" == "f" ]; then
                                slot_status="$RED"
                            fi
                            echo -e "   ${WHITE}│${NC} ${WHITE}Replication Slot:${NC} ${slot_name} (${slot_status}${active}${NC}) WAL: ${wal_mb}MB"
                            
                            if [ "$active" == "f" ] && [ -n "$wal_mb" ] && (( $(echo "$wal_mb > 1024" | bc -l) )); then
                                echo -e "   ${WHITE}│${NC} ${RED}⚠ Inactive slot with ${wal_mb}MB WAL - Consider dropping${NC}"
                            fi
                        fi
                    done
                fi
                
                echo -e "   ${WHITE}└──────────────────────────────────────────────────────────────────────────┘${NC}"
                echo -e "${WHITE}└────────────────────────────────────────────────────────────────────────────────┘${NC}"
                echo ""
            fi
        done
    else
        echo -e "${YELLOW}No replication information available${NC}"
        echo ""
    fi
}

print_header() {
    echo -e "${WHITE}╔══════════════════════════════════════════════════════════════════════════════════╗${NC}"
    echo -e "${WHITE}║          ${GREEN}REPLICATION CLUSTER MONITORING DASHBOARD${WHITE}                                ║${NC}"
    echo -e "${WHITE}║          ${BLUE}$(date '+%Y-%m-%d %H:%M:%S')${WHITE}                                                     ║${NC}"
    echo -e "${WHITE}╚══════════════════════════════════════════════════════════════════════════════════╝${NC}"
}

declare -A PRIMARY_HOST
declare -A PRIMARY_PORT

# Get primary node
for node in $(echo "$NODES" | tr ',' ' '); do
    host=$(echo "$node" | cut -d':' -f1)
    port=$(echo "$node" | cut -d':' -f2)
    
    role=$(execute_query "$host" "$port" "SELECT CASE WHEN pg_is_in_recovery() THEN 'STANDBY' ELSE 'PRIMARY' END;" 2>/dev/null)
    
    if [ "$role" == "PRIMARY" ]; then
        PRIMARY_HOST="$host"
        PRIMARY_PORT="$port"
        break
    fi
done


main() {
    clear
    print_header
    echo ""
    
    if [ -n "$PRIMARY_HOST" ] && [ -n "$PRIMARY_PORT" ]; then
        diagnose_replication_lag "${PRIMARY_HOST}" "${PRIMARY_PORT}"
    else
        echo -e "${RED}No primary node found in the cluster configuration.${NC}"
    fi
    
    echo -e "${WHITE}Last refresh: $(date '+%H:%M:%S')${NC}"
}

main

while false; do
    main
    
    sleep 1
done