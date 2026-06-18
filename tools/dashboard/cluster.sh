#!/bin/bash

# PostgreSQL Cluster Script
# Use with: watch -n 5 ./cluster.sh

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

# Print header
print_header() {
    echo -e "${WHITE}╔══════════════════════════════════════════════════════════════════════════════════╗${NC}"
    echo -e "${WHITE}║          ${GREEN}POSTGRESQL CLUSTER MONITORING DASHBOARD${WHITE}                                 ║${NC}"
    echo -e "${WHITE}║          ${BLUE}$(date '+%Y-%m-%d %H:%M:%S')${WHITE}                                                     ║${NC}"
    echo -e "${WHITE}╚══════════════════════════════════════════════════════════════════════════════════╝${NC}"
}

print_node_status_horizontal() {
    local host=$1
    local port=$2
    local node_name="$host:$port"
    
    # Check if node is reachable
    if ! PGPASSWORD="$PG_PASSWORD" psql -h "$host" -p "$port" -U "$PG_USER" -d "$PG_DATABASE" -c "SELECT 1" >/dev/null 2>&1; then
        echo -e "${RED}● $node_name OFFLINE${NC}"
        return 1
    fi
    
    # Get node role
    local role=$(execute_query "$host" "$port" "SELECT CASE WHEN pg_is_in_recovery() THEN 'STANDBY' ELSE 'PRIMARY' END;")
    local role_color="$GREEN"
    if [ "$role" == "STANDBY" ]; then
        role_color="$YELLOW"
    fi
    
    # Get metrics
    local version=$(execute_query "$host" "$port" "SELECT version();" | cut -d' ' -f2 | cut -d'.' -f1-2)
    local uptime=$(execute_query "$host" "$port" "SELECT EXTRACT(EPOCH FROM (NOW() - pg_postmaster_start_time()))::INTEGER / 3600;")
    local connections=$(execute_query "$host" "$port" "SELECT count(*) FROM pg_stat_activity;")
    local max_connections=$(execute_query "$host" "$port" "SELECT setting::INTEGER FROM pg_settings WHERE name='max_connections';")
    local db_size=$(execute_query "$host" "$port" "SELECT ROUND(pg_database_size('$PG_DATABASE') / 1024 / 1024 / 1024::FLOAT, 1);")
    local cache_hit=$(execute_query "$host" "$port" "
        SELECT ROUND(
            (SELECT sum(blks_hit) FROM pg_stat_database) * 100.0 /
            NULLIF((SELECT sum(blks_hit + blks_read) FROM pg_stat_database), 0),
            1
        );
    ")
    
    # Validate and set default values
    connections=$(get_numeric "$connections" 0)
    max_connections=$(get_numeric "$max_connections" 100)
    
    # Calculate connection percentage
    local conn_pct=0
    if [ "$max_connections" -gt 0 ]; then
        conn_pct=$((connections * 100 / max_connections))
    fi
    
    # Connection color
    local conn_color="$GREEN"
    if [ "$conn_pct" -ge "$CONNECTION_CRITICAL" ]; then
        conn_color="$RED"
    elif [ "$conn_pct" -ge "$CONNECTION_WARNING" ]; then
        conn_color="$YELLOW"
    fi
    
    # Cache hit color
    local cache_color="$GREEN"
    if [[ "$cache_hit" =~ ^[0-9.]+$ ]]; then
        if (( $(echo "$cache_hit < 80" | bc -l 2>/dev/null || echo 0) )); then
            cache_color="$RED"
        elif (( $(echo "$cache_hit < 90" | bc -l 2>/dev/null || echo 0) )); then
            cache_color="$YELLOW"
        fi
    else
        cache_hit="0"
        cache_color="$RED"
    fi
    
    echo -e "${WHITE}┌────────────────────────────────────────────────────────────────────────────────┐${NC}"
    echo -e "${role_color}● ${node_name}${NC} - ${role_color}${role}${NC} - PG ${version}"
    echo -e "${WHITE}│${NC}"
    echo -e "   ${WHITE}Uptime:${NC} ${uptime}h  ${WHITE}Conn:${NC} ${conn_color}${connections}/${max_connections} (${conn_pct}%)${NC}  ${WHITE}DB Size:${NC} ${db_size}GB  ${WHITE}Cache:${NC} ${cache_color}${cache_hit}%${NC}"
    
    local tps=$(execute_query "$host" "$port" "
        SELECT ROUND(
            (SELECT sum(xact_commit + xact_rollback) FROM pg_stat_database) / 
            NULLIF(EXTRACT(EPOCH FROM (NOW() - pg_postmaster_start_time())), 0),
            1
        );
    ")
    if [[ "$tps" =~ ^[0-9.]+$ ]]; then
        local active_conns=$(execute_query "$host" "$port" "SELECT count(*) FROM pg_stat_activity WHERE state='active';")
        local idle_conns=$(execute_query "$host" "$port" "SELECT count(*) FROM pg_stat_activity WHERE state='idle';")
        active_conns=$(get_numeric "$active_conns" 0)
        idle_conns=$(get_numeric "$idle_conns" 0)
        echo -e "   ${WHITE}TPS:${NC} ${tps}  ${WHITE}Active:${NC} ${active_conns}  ${WHITE}Idle:${NC} ${idle_conns}"
    fi

    # Disk
    if [ "$CHECK_DISK_USAGE" == "true" ] && [ -n "$host" ] && [ -n "$port" ]; then
        local data_dir=$(execute_query "$host" "$port" "SELECT setting FROM pg_settings WHERE name='data_directory';" 2>/dev/null)
        if [ -n "$data_dir" ] && [ -d "$data_dir" ]; then
            local disk_usage=$(df -h "$data_dir" 2>/dev/null | awk 'NR==2 {print $5}')
            if [ -n "$disk_usage" ]; then
                system_info+="  ${WHITE}Disk:${NC} ${disk_usage}  "
            fi
        fi
    fi
    
    if [ "$role" == "PRIMARY" ] && [ "$CHECK_WAL" == "true" ]; then
        local wal_size=$(execute_query "$host" "$port" "
            SELECT ROUND(
                COALESCE(SUM(size),0) / 1024.0 / 1024.0,
                1
            )
            FROM pg_ls_waldir();
        " 2>/dev/null)
        if [[ "$wal_size" =~ ^[0-9.]+$ ]]; then
            echo -e "   ${WHITE}WAL:${NC} ${wal_size}MB"
        fi
    fi
    
    if [ "$role" == "STANDBY" ]; then
        local lag_bytes=$(execute_query "$host" "$port" "
            SELECT COALESCE(
                pg_wal_lsn_diff(
                    pg_last_wal_receive_lsn(),
                    pg_last_wal_replay_lsn()
                ),
                0
            )::bigint;
        " 2>/dev/null)
        if [[ "$lag_bytes" =~ ^[0-9]+$ ]]; then
            local lag_mb=$(awk "BEGIN { printf \"%.2f\", ${lag_bytes}/1024/1024 }" 2>/dev/null || echo "0.00")
            local lag_color="$GREEN"
            if [ "$lag_bytes" -gt 1073741824 ]; then  # 1GB
                lag_color="$RED"
            elif [ "$lag_bytes" -gt 104857600 ]; then  # 100MB
                lag_color="$YELLOW"
            fi
            echo -e "   ${WHITE}Repl Lag:${NC} ${lag_color}${lag_mb} MB${NC}"
        fi
    fi
    
    local long_queries=$(execute_query "$host" "$port" "
        SELECT count(*) 
        FROM pg_stat_activity 
        WHERE state = 'active' 
        AND EXTRACT(EPOCH FROM (NOW() - query_start)) > 60;
    ")
    long_queries=$(get_numeric "$long_queries" 0)
    if [ "$long_queries" -gt 0 ]; then
        echo -e "   ${YELLOW}⚠ ${long_queries} long queries (>60s)${NC}"
    fi
    
    local lock_count=$(execute_query "$host" "$port" "
        SELECT count(*) FROM pg_locks WHERE NOT granted;
    ")
    lock_count=$(get_numeric "$lock_count" 0)
    if [ "$lock_count" -gt 0 ]; then
        echo -e "   ${YELLOW}🔒 ${lock_count} waiting locks${NC}"
    fi
    
    echo -e "${WHITE}└────────────────────────────────────────────────────────────────────────────────┘${NC}"
    echo ""
}

print_system_info_horizontal() {
    local host=$1
    local port=$2
    
    echo -e "${WHITE}╔══════════════════════════════════════════════════════════════════════════════════╗${NC}"
    echo -e "${WHITE}║ ${BLUE}SYSTEM INFORMATION${WHITE}                                                              ║${NC}"
    echo -e "${WHITE}╚══════════════════════════════════════════════════════════════════════════════════╝${NC}"
    
    local system_info=""
    
    # CPU
    if [ -f "/proc/loadavg" ]; then
        local load_avg=$(cat /proc/loadavg | awk '{print $1", "$2", "$3}')
        local cpu_cores=$(nproc 2>/dev/null || echo "1")
        system_info+="  ${WHITE}CPU Load:${NC} ${load_avg} (${cpu_cores} cores)  "
    fi
    
    # Memory
    if [ -f "/proc/meminfo" ]; then
        local total_mem=$(grep MemTotal /proc/meminfo | awk '{print $2}')
        local free_mem=$(grep MemAvailable /proc/meminfo | awk '{print $2}')
        if [ -n "$total_mem" ] && [ -n "$free_mem" ] && [ "$total_mem" -gt 0 ]; then
            local mem_usage=$(((total_mem - free_mem) * 100 / total_mem))
            local mem_color="$GREEN"
            if [ "$mem_usage" -ge 90 ]; then
                mem_color="$RED"
            elif [ "$mem_usage" -ge 80 ]; then
                mem_color="$YELLOW"
            fi
            system_info+="  ${WHITE}Memory:${NC} ${mem_color}${mem_usage}%${NC}  "
        fi
    fi
    
    
    # Network connections
    if command -v netstat &> /dev/null; then
        local pg_port=$(echo "$NODES" | cut -d':' -f2 | head -1)
        local net_connections=$(netstat -tn 2>/dev/null | grep ":$pg_port" | wc -l)
        net_connections=$(get_numeric "$net_connections" 0)
        system_info+="  ${WHITE}Net Conn:${NC} ${net_connections}  "
    fi
    
    # PostgreSQL processes
    local pg_processes=$(ps aux 2>/dev/null | grep postgres | grep -v grep | wc -l)
    pg_processes=$(get_numeric "$pg_processes" 0)
    system_info+="  ${WHITE}PG Procs:${NC} ${pg_processes}"
    
    echo "$system_info"
    echo ""
}

print_database_stats_horizontal() {
    echo -e "${WHITE}╔══════════════════════════════════════════════════════════════════════════════════╗${NC}"
    echo -e "${WHITE}║ ${BLUE}TOP DATABASES${WHITE}                                                                    ║${NC}"
    echo -e "${WHITE}╚══════════════════════════════════════════════════════════════════════════════════╝${NC}"
    
    echo -e "${WHITE}  Database          Size    Backends  TPS     Hit%  Cache%  Temp Files${NC}"
    echo -e "${WHITE}  ─────────────────────────────────────────────────────────────────────────────────${NC}"
    
    for node in $(echo "$NODES" | tr ',' ' '); do
        host=$(echo "$node" | cut -d':' -f1)
        port=$(echo "$node" | cut -d':' -f2)
        
        local dbs=$(execute_query "$host" "$port" "
            SELECT datname,
                   ROUND(pg_database_size(datname) / 1024 / 1024 / 1024::FLOAT, 2) as size_gb,
                   numbackends,
                   ROUND((xact_commit + xact_rollback)::FLOAT / NULLIF(EXTRACT(EPOCH FROM (NOW() - pg_postmaster_start_time())), 0), 1) as tps,
                   ROUND(100.0 * blks_hit / NULLIF(blks_hit + blks_read, 0), 1) as cache_hit,
                   temp_files
            FROM pg_stat_database
            WHERE datname NOT IN ('template0', 'template1')
            ORDER BY pg_database_size(datname) DESC
            LIMIT 3;
        " 2>/dev/null)
        
        if [ -n "$dbs" ]; then
            echo "$dbs" | while IFS='|' read -r name size backends tps cache_hit temp_files; do
                if [ -n "$name" ]; then
                    size=${size:-0}
                    backends=$(get_numeric "$backends" 0)
                    tps=${tps:-0}
                    cache_hit=${cache_hit:-0}
                    temp_files=$(get_numeric "$temp_files" 0)
                    printf "  %-16s %6.2fGB  %8d  %6.1f  %6.1f%%  %8d\n" \
                        "$name" "$size" "$backends" "$tps" "$cache_hit" "$temp_files"
                fi
            done
        fi
    done
    echo ""
}

print_query_performance_horizontal() {
    echo -e "${WHITE}╔══════════════════════════════════════════════════════════════════════════════════╗${NC}"
    echo -e "${WHITE}║ ${BLUE}TOP QUERIES${WHITE}                                                                      ║${NC}"
    echo -e "${WHITE}╚══════════════════════════════════════════════════════════════════════════════════╝${NC}"
    
    for node in $(echo "$NODES" | tr ',' ' '); do
        host=$(echo "$node" | cut -d':' -f1)
        port=$(echo "$node" | cut -d':' -f2)
        
        local queries=$(execute_query "$host" "$port" "
            SELECT 
                LEFT(query, 40) as query,
                calls,
                ROUND(total_exec_time / 1000, 1) as total_sec,
                ROUND(mean_exec_time, 1) as mean_ms,
                rows,
                ROUND(100.0 * shared_blks_hit / NULLIF(shared_blks_hit + shared_blks_read, 0), 1) as cache_hit
            FROM pg_stat_statements
            ORDER BY total_exec_time DESC
            LIMIT 3;
        " 2>/dev/null)
        
        if [ -n "$queries" ]; then
            echo -e "  ${WHITE}${host}:${port}${NC}"
            echo "$queries" | while IFS='|' read -r query calls total_sec mean_ms rows cache_hit; do
                if [ -n "$query" ]; then
                    query="${query}..."
                    calls=$(get_numeric "$calls" 0)
                    total_sec=${total_sec:-0}
                    mean_ms=${mean_ms:-0}
                    rows=$(get_numeric "$rows" 0)
                    cache_hit=${cache_hit:-0}
                    printf "    %-40s Calls: %5d  Total: %6.1fs  Mean: %6.1fms  Rows: %6d  Cache: %5.1f%%\n" \
                        "$query" "$calls" "$total_sec" "$mean_ms" "$rows" "$cache_hit"
                fi
            done
            echo ""
        fi
    done
}

main() {
    clear
    print_header
    echo ""
    
    IFS=',' read -ra NODE_ARRAY <<< "$NODES"
    for node in "${NODE_ARRAY[@]}"; do
        host=$(echo "$node" | cut -d':' -f1)
        port=$(echo "$node" | cut -d':' -f2)
        print_node_status_horizontal "$host" "$port"
    done
    print_database_stats_horizontal
        print_query_performance_horizontal
    
    echo -e "${WHITE}Last refresh: $(date '+%H:%M:%S')${NC}" 
}

main


while false; do
    main
    
    sleep 5
done