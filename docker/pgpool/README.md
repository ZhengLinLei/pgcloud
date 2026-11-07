# docker/pgpool — Pgpool-II node

Image based on `ubuntu:24.04` with Pgpool-II 4.7 and the PostgreSQL 18 client from the official PostgreSQL apt repository (PGDG); Ubuntu's own `pgpool2` (4.3) does not support PostgreSQL 18. It provides load balancing between the PostgreSQL nodes, health checks, a watchdog cluster of several PgPool nodes, and automatic failover through [`static/pgpool/sbin/failover.sh`](../../static/pgpool/sbin/failover.sh).

## Usage

```bash
cp .env.example .env                                   # passwords, ports, failover commands...
cp conf/postgres/server.sample.env conf/postgres/server0.env   # one file per Postgres node
cp conf/pgpool/backend.sample.env  conf/pgpool/backend0.env    # one file per PgPool node
./BUILD.sh             # builds image "pgcloud_pool"
./RUN.sh               # runs container "pgcloud_pool" with --network=host
```

`RUN.sh` mounts `conf/pgpool`, `conf/postgres` and `conf/pgbouncer` into the container, so you can edit the node files without rebuilding.

## Node configuration files (`conf/`)

| Folder | Files | Description |
|---|---|---|
| `conf/postgres/` | `server0.env`, `server1.env`, … | One per PostgreSQL node. **`server0` must be the initial primary.** Template: [`server.sample.env`](conf/postgres/server.sample.env). |
| `conf/pgpool/` | `backend0.env`, `backend1.env`, … | One per PgPool node (watchdog). Template: [`backend.sample.env`](conf/pgpool/backend.sample.env). |
| `conf/pgbouncer/` | `pooler.sample.env` | Reserved, not used yet. |

Files must be numbered consecutively starting at `0`.

**`server<N>.env`**

| Variable | Description |
|---|---|
| `PSQL_HOST` / `PSQL_PORT` | Address of the Postgres node. |
| `PSQL_WEIGHT` | Load-balancing weight (`0` = no read traffic). |
| `PSQL_FAIL` | `ALLOW_TO_FAILOVER`, `DISALLOW_TO_FAILOVER` or `ALWAYS_MASTER`. |
| `PSQL_PATH` | `PGDATA` of that node. |
| `PSQL_NAME` | Must match the node's `BACKEND_NAME` (replication `application_name`). |
| `SSH_USER` / `SSH_PORT` / `SSH_PASS` | Access to the node's host, used by the failover scripts. |

**`backend<N>.env`**

| Variable | Description |
|---|---|
| `NODE_PGPOOL_HOST` / `NODE_PGPOOL_PORT` | Address of that PgPool node. The node whose host equals `PGPOOL_HOST` is "this" node (`pgpool_node_id`). |
| `NODE_WD_PORT` / `NODE_HEARTBEAT_PORT` | Watchdog and heartbeat ports (same on every node). |
| `NODE_HEARTBEAT_DEVICE` | Network device for heartbeats (empty = default). |

## Main settings (`.env`)

| Variable | Description |
|---|---|
| `POSTGRES_DB` / `POSTGRES_USER` / `POSTGRES_PASSWORD` | Database user. Used for health checks and stored AES-encrypted in `pool_passwd` for client auth. |
| `PGPOOL_HOST` / `PGPOOL_PORT` | This node's address and listening port (default `5434`). |
| `PGPOOL_BALANCE_MODE` | `on` to send read queries to replicas. |
| `NUM_INIT_CHILDREN` / `MAX_POOL` | Number of PgPool processes and cached connections per process. |
| `ALLOWED_CIDRS` | Networks allowed to connect (written to `pool_hba.conf`, `scram-sha-256`). |
| `PCP_PORT` / `PCP_USER` / `PCP_PASS` | PCP admin interface (attach/detach/recovery tools). |
| `REPLICA_USER` / `REPLICA_PASS` | Used for streaming replication checks. Must match the db nodes. |
| `HEALTH_CHECK_PERIOD` / `HEALTH_CHECK_TIMEOUT`, `REPLICA_CHECK_PERIOD` | Check intervals in seconds. |
| `PGPOOL_NUM` | Number of PgPool nodes. `1` disables the watchdog. |
| `WD_*` | Watchdog / heartbeat tuning. |
| `ENABLE_LOGFILE`, `LOG_NAME`, `LOG_FILENAME` | Log to files with `cronolog` instead of stdout. |

### Failover settings

When the **primary** fails, `failover.sh` connects over SSH (using the `SSH_*` values of each `server<N>.env`) and runs these commands. Placeholders: `%h`/`%p` = new primary host/port, `%x`/`%r` = old primary host/port.

| Variable | Runs on | Default |
|---|---|---|
| `FAILOVER_PROMOTE_CMD` | new primary | `docker container exec pgcloud_db bash -c 'pgcloud_promote %x %r'` |
| `FAILOVER_REDIRECT_CMD` | every other replica | `… pgcloud_redirect %h %p %x %r` |
| `FAILOVER_RECOVERY_PRIMARY_CMD` | old primary host | checks the host is reachable (the pgcloud-launcher does not start the old primary here) |
| `FAILOVER_DEPROMOTE_CMD` | old primary | stop → `pgcloud_rewind %h %p` in a one-off container → start as replica |
| `FAILOVER_RECOVER_REPLICA` / `FAILOVER_RECOVERY_REPLICA_CMD` | failed replica | restart it and re-attach it |
| `FAILOVER_EXTRA_SCRIPT`, `FAILOVER_RECOVERY_CONFIG_SCRIPT` | PgPool node | optional custom hooks |

Logs: `/opt/pgcloud/log/failover.log` and `failback.log`.

What a primary failure looks like (tested end to end with the pgcloud-launcher):

1. Pgpool detects the failure (health check or backend error) and runs `failover.sh`.
2. The new primary is promoted over SSH. Synchronous replication is switched off on it so writes keep working.
3. The old primary is rewound with `pg_rewind` and started as a replica of the new primary, so there are never two primaries.
4. About 15 s after `failover.sh` returns, it is attached back to pgpool. Status checks and `pcp_attach_node` run in the background, because pgpool waits for `failover_command` to finish before serving again (calling pgpool from inside the script deadlocks it).

> `PGPOOL_ROLE`, `TRUSTED_SERVER`, `PHYSICAL_PROJECT_PATH`, `DB_NUM` and `POOLER_CONF_PATH` are defined but **not used yet**.

## Commands inside the container

```bash
docker exec -it pgcloud_pool bash
./script/status.sh         # SHOW pool_nodes
./script/connect.sh        # psql through pgpool
./script/getrole.sh        # watchdog info (leader / standby)
./tools/attach.sh  <id>    # re-attach a node that is down
./tools/detach.sh  <id>    # take a node out of the pool
./tools/recovery.sh <id>   # detach + attach a down node
```

## Notes

- The configuration is generated once and marked with `/etc/pgpool2/lock.pgcloud`. Delete that file and restart to regenerate it.
- Security: the failover scripts use `sshpass` with passwords from the `server<N>.env` files. Restrict access to those files.
