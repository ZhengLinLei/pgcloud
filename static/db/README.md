# static/db — PostgreSQL node files

Copied to `/opt/pgcloud` in the `pgcloud_db` image. Build and run instructions are in [`docker/db`](../../docker/db/).

## sbin/

| File | Command | Description |
|---|---|---|
| `entrypoint.sh` | — | Container entrypoint, based on the official `postgres` image entrypoint. Starts as root, switches to `postgres` (`gosu`), then initializes a **primary** (`initdb`, database, replication role, config) or a **replica** (`pg_basebackup` + replication slot). Checks that passwords are not `change_me`. |
| `promote.sh` | `pgcloud_promote [new_ip new_port old_ip old_port]` | Promotes a replica to primary. First checks the WAL replay delay against `PROMOTE_MIN_DELAY`, then runs `pg_promote()` (falls back to `pg_ctl promote`). |
| `redirect.sh` | `pgcloud_redirect <new_ip> <new_port> [old_ip old_port]` | Makes a replica follow a new primary: creates its slot there, updates `primary_conninfo` / `primary_slot_name` and reloads. Also updates `PRIMARY_HOST`/`PRIMARY_PORT` in the mounted `.env`, if there is one. |
| `depromote.sh` | `pgcloud_depromote <new_ip> <new_port> [old_ip old_port]` | Turns a former primary into a replica of the new primary (`standby.signal`, conninfo, slot), then restarts Postgres. |

PgPool's `failover.sh` calls the `pgcloud_*` commands over SSH. They must be run as root (`docker exec`).

## script/

| File | Description |
|---|---|
| `connect.sh` | `psql` to the local database. |
| `getrole.sh` | Prints `true` on a primary, `false` on a replica (also prints the role on stderr). |
| `cluster.sh` | On a primary: `pg_stat_replication`, archiver stats and slots. On a replica: WAL receiver status and last received/replayed LSN. |

## tools/

| File | Description |
|---|---|
| `add_slot.sh <name>` | Creates a physical replication slot (primary only, asks for confirmation). |
| `rm_slot.sh <name>` | Drops a replication slot (primary only, asks for confirmation). |

## conf/

| File | Description |
|---|---|
| `postgresql.conf` | Template (replication: `wal_level=replica`, `hot_standby`, `synchronous_commit=remote_write`...). Memory, sync and logging settings are appended from `.env` on first start. |
| `pg_hba.conf` | Local connections and loopback. `host` rules for `ALLOWED_CIDRS` (normal and replication) are appended on first start. |
| `pg_ident.conf` | Upstream default. |
| `import.sh` | Copies the `*.conf` files into `$PGDATA` again and optionally reloads Postgres. Use it after editing a template inside a running container. |
| `PGC_SLOT` | Generated: this node's replication slot id. A copy is also stored in `$PGDATA/PGC_SLOT`. |

## init/

`init.sql` is a placeholder for your schema or seed data. It is not copied automatically. To run SQL on the first start, mount it into `/docker-entrypoint-initdb.d/`, for example `-v ./init.sql:/docker-entrypoint-initdb.d/init.sql`.
