# pgcloud-db — PostgreSQL 18 node for PgCloud

> **This image is a module of PgCloud.** It is one of the three node images (`pgcloud-db`, `pgcloud-pgpool`, `pgcloud-pgbouncer`) that together build a PostgreSQL high-availability cluster. It is not meant to be used alone.
>
> **To use the project, download the launcher:** [`zhenglinlei/pgcloud-launcher`](https://hub.docker.com/r/zhenglinlei/pgcloud-launcher). It is a web app that lets you draw the cluster, deploys these images to your servers over SSH and monitors them in real time:
>
> ```bash
> docker run -d --name pgcloud-launcher -p 8080:8080 -v pgcloud-launcher:/data zhenglinlei/pgcloud-launcher:1.2.0
> ```
>
> Source code, manual and book: https://github.com/ZhengLinLei/pgcloud

---

## What it is

PostgreSQL 18 (based on the official `postgres:18` image, supported until November 2030) with PgCloud's own entrypoint and failover scripts. The same image runs as **primary** or as **streaming replica**, depending on `NODE_ROLE`.

- Streaming replication with one replication slot per replica (`pgcloud<id>`).
- Synchronous replication (`FIRST 1 (*)` by default), switched off automatically on a promoted node so writes keep working.
- Failover commands used by `pgcloud-pgpool` over SSH: promote, redirect, depromote and rewind (`pg_rewind` with a `pg_basebackup` fallback).
- A former primary that restarts with replica settings rejoins the cluster by itself.
- `pg_hba.conf` allows only the networks in `ALLOWED_CIDRS`, with `scram-sha-256`. The container refuses to start with placeholder passwords (`change_me`).

Tags: `1.2.0`, `1.2`, `latest` (older: `1.1.0`, `1.1`, `1.0.1`, `1.0.0`, `1.0`). Platforms: `linux/amd64`, `linux/arm64`.

## Run it by hand

The launcher writes all of this for you. To run a node manually, create an `.env` file (template: [`docker/db/.env.example`](https://github.com/ZhengLinLei/pgcloud/blob/master/docker/db/.env.example)) and start the container with the fixed name `pgcloud_db` (the failover scripts use that name):

```bash
docker run -d --name pgcloud_db --restart unless-stopped --network host \
  --env-file .env \
  -v pgcloud_data:/opt/pgdata \
  -v "$PWD/.env":/opt/pgcloud/.env \
  zhenglinlei/pgcloud-db:1.2.0
```

Mounting the `.env` file is needed: after a failover the scripts update `PRIMARY_HOST`, `PRIMARY_PORT` and `NODE_ROLE` in it.

## Main settings

| Variable | Default | Description |
|---|---|---|
| `POSTGRES_DB` / `POSTGRES_USER` / `POSTGRES_PASSWORD` | `db_pgcloud` / `u_pgcloud` / — | Database, superuser and password. |
| `POSTGRES_HOST_AUTH_METHOD` | `scram-sha-256` | Auth method for remote connections. |
| `PGDATA` / `PGPORT` | `/opt/pgdata` / `5432` | Data directory and port. |
| `ALLOWED_CIDRS` | private networks | Networks allowed in `pg_hba.conf`. Avoid `0.0.0.0/0`. |
| `NODE_ROLE` | `primary` | `primary` or `replica`. |
| `BACKEND_NAME` | `node0` | Node name (replication `application_name`). |
| `REPLICA_USER` / `REPLICA_PASS` | `pgrepuser` / — | Replication role, same on every node. |
| `PRIMARY_HOST` / `PRIMARY_PORT` | — / `5432` | Primary to clone from (replicas only). |
| `SYNCHRONOUS_RULE` / `SYNCHRONOUS_NAME` | `FIRST 1` / `*` | Builds `synchronous_standby_names`. Empty = asynchronous. |
| `WAL_KEEP_SIZE` | `1GB` | WAL kept so `pg_rewind` can resynchronise a former primary. |
| `MAX_CONNECTIONS`, `SHARED_BUFFERS`, `WORK_MEM`, `EFFECTIVE_CACHE_SIZE`, `MAINTENANCE_WORK_MEM` | see template | Resource tuning. |
| `ENABLE_LOGFILE` | `off` | Write logs to `/opt/pgcloud/log` instead of stdout. |

## Commands inside the container

```bash
docker exec -it pgcloud_db bash
./script/connect.sh      # psql to the local database
./script/getrole.sh      # "true" on a primary, "false" on a replica
./script/cluster.sh      # replication and slot status

pgcloud_promote   [new_ip new_port old_ip old_port]    # replica -> primary
pgcloud_redirect  <new_ip> <new_port> [old_ip old_port] # follow a new primary
pgcloud_rewind    <new_ip> <new_port>                  # resync a stopped former primary
```

## Upgrading from PostgreSQL 16

PgCloud 1.0 uses PostgreSQL 18. A data volume created by PostgreSQL 16 does not start with this image: migrate the data first (`pg_dump` / restore or `pg_upgrade`) or start with new volumes.

## License

GPL-2.0. PostgreSQL is released under the PostgreSQL License.
