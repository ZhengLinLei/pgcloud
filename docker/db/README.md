# docker/db — PostgreSQL node

Image based on `postgres:16` with PgCloud's own entrypoint ([`static/db/sbin/entrypoint.sh`](../../static/db/sbin/entrypoint.sh)). The same image runs as **primary** or as **streaming replica**, depending on `NODE_ROLE`.

## Usage

```bash
cp .env.example .env    # set POSTGRES_PASSWORD, REPLICA_PASS, NODE_ROLE, ...
./BUILD.sh              # builds image "pgcloud_db"
./RUN.sh                # runs container "pgcloud_db" with volume "pgdata"
```

`RUN.sh` publishes port `5432`. If you change `PGPORT`, change the `-p` mapping too. On Linux you can use the commented `--network=host` variant instead.

## What happens on first start

Initialization only runs when `PGDATA` is empty.

**Primary** (`NODE_ROLE=primary`)
1. `initdb` with `POSTGRES_USER`/`POSTGRES_PASSWORD` and `POSTGRES_INITDB_ARGS`.
2. Creates `POSTGRES_DB` and the replication role `REPLICA_USER`.
3. Runs any file in `/docker-entrypoint-initdb.d/`.
4. Generates `postgresql.conf` (memory settings, `synchronous_standby_names`, logging, port) and `pg_hba.conf` (remote access from `ALLOWED_CIDRS` only).

**Replica** (`NODE_ROLE=replica`)
1. `pg_basebackup` from `PRIMARY_HOST:PRIMARY_PORT`, creating a replication slot `pgcloud<id>` on the primary.
2. Starts in standby mode, streaming from the primary with `application_name=BACKEND_NAME`.

Each node stores its own slot id in `$PGDATA/PGC_SLOT`. The failover scripts use it.

## Main settings (`.env`)

| Variable | Default | Description |
|---|---|---|
| `POSTGRES_DB` / `POSTGRES_USER` / `POSTGRES_PASSWORD` | `db_pgcloud` / `u_pgcloud` / `change_me` | Database, superuser and password. |
| `POSTGRES_HOST_AUTH_METHOD` | `scram-sha-256` | Auth method for remote connections and `password_encryption`. |
| `PGDATA` / `PGPORT` | `/opt/pgdata` / `5432` | Data directory and port. |
| `ALLOWED_CIDRS` | private networks | Comma-separated networks allowed in `pg_hba.conf`. Avoid `0.0.0.0/0`. |
| `MAX_CONNECTIONS`, `SHARED_BUFFERS`, `WORK_MEM`, `EFFECTIVE_CACHE_SIZE`, `MAINTENANCE_WORK_MEM` | see file | Resource tuning (sizing hints in the file). |
| `ENABLE_LOGFILE`, `LOG_FILENAME`, `LOG_ROTATE_AGE` | `off`, … | Write logs to `/opt/pgcloud/log` instead of stdout. |
| `NODE_ROLE` | `primary` | `primary` or `replica`. |
| `BACKEND_NAME` | `node0` | Node name. Must match `PSQL_NAME` in PgPool's `server<N>.env`. |
| `REPLICA_USER` / `REPLICA_PASS` | `pgrepuser` / `change_me` | Replication role (same values on every node and in PgPool). |
| `SYNCHRONOUS_RULE` / `SYNCHRONOUS_NAME` | `FIRST 1` / `*` | Builds `synchronous_standby_names`. Leave both empty for async replication. |
| `PRIMARY_HOST` / `PRIMARY_PORT` | `127.0.0.1` / `5432` | Primary to clone from (replicas only). Updated automatically after a failover. |
| `PROMOTE_MIN_DELAY` | `0` | Max accepted replay delay (seconds) for `pgcloud_promote`. `0` = always promote. |

> `REPLICA_NUM`, `ARCGIVE_MODE`, `ARCHIVE_PATH` and `CLEAN_LOG_AGE` are defined but **not used yet**. WAL archiving is not implemented.

## Commands inside the container

```bash
docker exec -it pgcloud_db bash
./script/connect.sh        # psql to the local database
./script/getrole.sh        # prints "true" on a primary, "false" on a replica
./script/cluster.sh        # replication, archiver and slot status
```

Failover commands (normally called by PgPool over SSH, see [`static/db`](../../static/db/)):

```bash
pgcloud_promote   [new_ip new_port old_ip old_port]   # replica -> primary
pgcloud_redirect  <new_ip> <new_port> [old_ip old_port] # follow a new primary
pgcloud_depromote <new_ip> <new_port> [old_ip old_port] # old primary -> replica
```

## Data

Data lives in the Docker volume `pgdata`, mounted at `/opt/pgdata`. To start from scratch:

```bash
docker volume rm pgdata
```
