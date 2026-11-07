# tools/dashboard — terminal monitoring

Bash scripts that query the PostgreSQL nodes directly with `psql` and print a colored dashboard. Run them with `watch` to refresh them periodically.

## Requirements

- `psql` (PostgreSQL client), `bc` and `column` on the machine running the scripts.
- Network access to every node, and a user allowed to read the statistics views (`pg_stat_replication`, `pg_stat_activity`...). A superuser or a role with `pg_monitor` works.

## Configuration

```bash
cp .env.example .env    # then edit it
```

| Variable | Description |
|---|---|
| `PG_USER` / `PG_PASSWORD` / `PG_DATABASE` | Credentials used on every node. |
| `NODES` | Comma-separated `host:port` list, for example `10.0.0.1:5432,10.0.0.2:5432`. |
| `PRIMARY_HOST` / `PRIMARY_PORT` | Primary node for `replication.sh` (not in the example file, so add them). |
| `REPLICATION_LAG_WARNING` / `_CRITICAL` | Lag thresholds in seconds. |
| `CONNECTION_WARNING` / `_CRITICAL` | Connection usage thresholds in % of `max_connections`. |
| `WAL_SIZE_WARNING` / `_CRITICAL`, `CHECK_*` | Optional thresholds and feature switches. |

Each script accepts another config file as its first argument: `./cluster.sh prod.env`.

## Scripts

| Script | Shows |
|---|---|
| `cluster.sh` | One line per node in `NODES`: online/offline, role (primary/standby), version, uptime, connections vs. `max_connections`, database size and cache hit ratio. Also database statistics and query performance. |
| `replication.sh` | Replication lag diagnostics on the primary (`PRIMARY_HOST`): every standby with its state, sync state and lag, colored by threshold. |
| `raw.sh` | The raw output of `pg_stat_replication` and `pg_stat_wal_receiver` for every node in `NODES`. |

```bash
watch -c -n 5 ./cluster.sh
watch -c -n 2 ./replication.sh
watch -n 5 ./raw.sh
```

## With the compose demo

The compose demo does not publish the Postgres ports, so run the dashboard from a container on the same network:

```bash
docker run --rm -it --network pgcloud_default -e DEBIAN_FRONTEND=noninteractive \
  -v "$PWD":/dash -w /dash postgres:18 \
  bash -c 'apt-get update -qq && apt-get install -y -qq bc bsdextrautils >/dev/null && ./cluster.sh'
```

The `.env` should use `NODES=db0:5432,db1:5432,db2:5432`.

> `.env` is git-ignored. Do not commit real credentials.
