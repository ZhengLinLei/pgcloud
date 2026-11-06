# static/pgpool — Pgpool-II node files

Copied to `/opt/pgcloud` in the `pgcloud_pool` image. Build, run and `.env` reference are in [`docker/pgpool`](../../docker/pgpool/).

## sbin/

| File | Description |
|---|---|
| `entrypoint.sh` | Generates the configuration on first start, then runs `pgpool -n` (stdout, or files through `cronolog`). It appends to `conf/pgpool.conf`: one `backend_*` block per `server<N>.env`, one watchdog block per `backend<N>.env`, and the global, health-check and PCP settings from `.env`. It also creates the PCP user, adds `pool_hba.conf` rules for `ALLOWED_CIDRS`, and stores the database password AES-encrypted in `pool_passwd` (random key in `/root/.pgpoolkey`). Finally it copies everything to `/etc/pgpool2` and creates `lock.pgcloud`, so a restart does not regenerate it. |
| `failover.sh` | `failover_command` (`pgcloud_failover`). If the **primary** failed: promotes the new primary, redirects the other replicas and tries to recover the old primary as a replica, all over SSH with the `FAILOVER_*_CMD` commands. If a **replica** failed, and `FAILOVER_RECOVER_REPLICA=true`, it restarts and re-attaches it. Log: `log/failover.log`. |
| `failback.sh` | `failback_command` (`pgcloud_failback`). Logs the event and the pool status in `log/failback.log`. |

## script/

| File | Description |
|---|---|
| `status.sh` | `SHOW pool_nodes` through PgPool. |
| `connect.sh` | `psql` through PgPool. |
| `getrole.sh` | `pcp_watchdog_info`: watchdog cluster and leader. |

## tools/

All of them use PCP (`PCP_PORT`, `PCP_USER`, `PCP_PASS`) and create `~/.pcppass` the first time. Without an argument they show the node status.

| File | Description |
|---|---|
| `attach.sh <node_id>` | Re-attaches a node that is `down`/`quarantine`. |
| `detach.sh <node_id>` | Detaches a node that is `up` (maintenance). |
| `recovery.sh <node_id>` | Detach + attach of a down node. |

## conf/

| File | Description |
|---|---|
| `pgpool.conf` | Base template (`failover_command`, `failback_command`, streaming replication). The settings generated from `.env` are appended at the end and override earlier values. |
| `pool_hba.conf` | Client authentication. `scram-sha-256` for local connections; rules for `ALLOWED_CIDRS` are appended. |
| `pcp.conf` | PCP users. The `PCP_USER` entry is appended. |

> The template still contains some Pgpool-II 3.x parameters (`master_slave_mode`, `system_db_*`...). Pgpool 4.x ignores them with a warning.
