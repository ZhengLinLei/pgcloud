# pgcloud-pgpool — Pgpool-II 4.7 node for PgCloud

> **This image is a module of PgCloud.** It is one of the three node images (`pgcloud-db`, `pgcloud-pgpool`, `pgcloud-pgbouncer`) that together build a PostgreSQL high-availability cluster. It is not meant to be used alone.
>
> **To use the project, download the launcher:** [`zhenglinlei/pgcloud-launcher`](https://hub.docker.com/r/zhenglinlei/pgcloud-launcher). It is a web app that lets you draw the cluster, deploys these images to your servers over SSH and monitors them in real time:
>
> ```bash
> docker run -d --name pgcloud-launcher -p 8080:8080 -v pgcloud-launcher:/data zhenglinlei/pgcloud-launcher:1.0.0
> ```
>
> Source code, manual and book: https://github.com/ZhengLinLei/pgcloud

---

## What it is

Pgpool-II 4.7 and the PostgreSQL 18 client (from the official PostgreSQL apt repository) on Ubuntu 24.04, with PgCloud's configuration generator and failover scripts. It sits in front of the `pgcloud-db` nodes and provides:

- **Load balancing**: writes go to the primary, reads are spread over the replicas.
- **Health checks** and streaming replication checks.
- **Automatic failover** when the primary dies: it promotes a replica over SSH, makes the other replicas follow it, and brings the old primary back as a replica with `pg_rewind`. In the PgCloud tests a replica was promoted within 5 seconds and there were never two primaries.
- **Watchdog**: several Pgpool-II nodes can watch each other.
- Client authentication with `scram-sha-256` (password stored AES-encrypted in `pool_passwd`), allowed networks only (`pool_hba.conf`).

Tags: `1.0.0`, `1.0`, `latest`. Platforms: `linux/amd64`, `linux/arm64`.

## Run it by hand

The launcher writes all of this for you. To run a node manually you need:

- an `.env` file (template: [`docker/pgpool/.env.example`](https://github.com/ZhengLinLei/pgcloud/blob/master/docker/pgpool/.env.example));
- one `conf/postgres/server<N>.env` per PostgreSQL node (`server0` = initial primary), with its address and SSH access;
- one `conf/pgpool/backend<N>.env` per Pgpool-II node (watchdog).

```bash
docker run -d --name pgcloud_pool --restart unless-stopped --network host \
  --env-file .env \
  -v "$PWD/.env":/opt/pgcloud/.env \
  -v "$PWD/conf/pgpool":/opt/pgcloud/conf/pgpool \
  -v "$PWD/conf/postgres":/opt/pgcloud/conf/postgres \
  zhenglinlei/pgcloud-pgpool:1.0.0
```

The PostgreSQL containers must be named `pgcloud_db`: the failover commands run `docker exec pgcloud_db …` on each database host.

## Main settings

| Variable | Description |
|---|---|
| `POSTGRES_DB` / `POSTGRES_USER` / `POSTGRES_PASSWORD` | Database user, used for health checks and client authentication. |
| `PGPOOL_HOST` / `PGPOOL_PORT` | This node's address and port (default `5434`). |
| `PGPOOL_BALANCE_MODE` | `on` to send reads to the replicas. |
| `NUM_INIT_CHILDREN` / `MAX_POOL` | Pgpool-II processes and cached connections per process. |
| `ALLOWED_CIDRS` | Networks allowed to connect. |
| `PCP_PORT` / `PCP_USER` / `PCP_PASS` | PCP admin interface. |
| `REPLICA_USER` / `REPLICA_PASS` | Replication user, same as on the database nodes. |
| `HEALTH_CHECK_PERIOD` / `HEALTH_CHECK_TIMEOUT` | Health check timing (seconds). |
| `PGPOOL_NUM` | Number of Pgpool-II nodes. `1` disables the watchdog. |
| `FAILOVER_*` | Commands run over SSH during a failover (promote, redirect, depromote/rewind, replica recovery). See the template. |

**`server<N>.env`**: `PSQL_HOST`, `PSQL_PORT`, `PSQL_WEIGHT`, `PSQL_FAIL`, `PSQL_PATH`, `PSQL_NAME` (= the node's `BACKEND_NAME`), `SSH_USER`, `SSH_PORT`, `SSH_PASS`.

## Commands inside the container

```bash
docker exec -it pgcloud_pool bash
./script/status.sh        # SHOW pool_nodes
./script/connect.sh       # psql through Pgpool-II
./tools/attach.sh <id>    # re-attach a node that is down
./tools/detach.sh <id>    # take a node out of the pool
```

Failover logs: `/opt/pgcloud/log/failover.log` and `failback.log`.

## Notes

- The configuration is generated on the first start and locked with `/etc/pgpool2/lock.pgcloud`. Delete that file and restart to regenerate it.
- The failover scripts use the SSH passwords of the `server<N>.env` files: keep those files private.

## License

GPL-2.0. Pgpool-II is released under its own BSD-style license.
