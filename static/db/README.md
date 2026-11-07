# static/db — PostgreSQL node files

Copied to `/opt/pgcloud` in the `pgcloud_db` image. Build and run instructions are in [`docker/db`](../../docker/db/).

## sbin/

| File | Command | Description |
|---|---|---|
| `entrypoint.sh` | — | Container entrypoint, based on the official `postgres` image entrypoint. Starts as root, switches to `postgres` (`gosu`), then initializes a **primary** (`initdb`, database, replication role, config) or a **replica** (`pg_basebackup` + replication slot). Checks that passwords are not `change_me`. |
| `promote.sh` | `pgcloud_promote [new_ip new_port old_ip old_port]` | Promotes a replica to primary. First checks the WAL replay delay against `PROMOTE_MIN_DELAY`, then runs `pg_promote()` (falls back to `pg_ctl promote`). Afterwards it disables synchronous replication on the new primary, because with no standby connected every commit would wait forever. Re-enable it once replicas are back (redeploy, or `ALTER SYSTEM SET synchronous_standby_names`). |
| `redirect.sh` | `pgcloud_redirect <new_ip> <new_port> [old_ip old_port]` | Makes a replica follow a new primary: creates its slot there, updates `primary_conninfo` / `primary_slot_name` and reloads. Also updates `PRIMARY_HOST`/`PRIMARY_PORT` in the mounted `.env`, if there is one. |
| `rewind.sh` | `pgcloud_rewind <new_ip> <new_port>` | **Recommended way to bring a former primary back.** With the node stopped, runs `pg_rewind` against the new primary (falls back to a fresh `pg_basebackup` if the needed WAL is gone), keeps the node's own slot id and writes the standby configuration. The entrypoint also runs it automatically when a node configured as replica finds the data of a primary, so a former primary can never start as a second primary. It runs in a one-off container that shares the node's volumes: `docker stop -t 60 pgcloud_db && docker run --rm --network host --volumes-from pgcloud_db --entrypoint pgcloud_rewind <image> <new_ip> <new_port> && docker start pgcloud_db`. |
| `depromote.sh` | `pgcloud_depromote <new_ip> <new_port> [old_ip old_port]` | Legacy alternative without `pg_rewind`: writes the standby configuration and stops PostgreSQL cleanly (the container stops; start it again). Only works if the old primary has no WAL beyond the promotion point. |

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
