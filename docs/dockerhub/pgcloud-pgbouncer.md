# pgcloud-pgbouncer — PgBouncer node for PgCloud

> **This image is a module of PgCloud.** It is one of the three node images (`pgcloud-db`, `pgcloud-pgpool`, `pgcloud-pgbouncer`) that together build a PostgreSQL high-availability cluster. It is not meant to be used alone.
>
> **To use the project, download the launcher:** [`zhenglinlei/pgcloud-launcher`](https://hub.docker.com/r/zhenglinlei/pgcloud-launcher). It is a web app that lets you draw the cluster, deploys these images to your servers over SSH and monitors them in real time:
>
> ```bash
> docker run -d --name pgcloud-launcher -p 8080:8080 -v pgcloud-launcher:/data zhenglinlei/pgcloud-launcher:1.1.0
> ```
>
> Source code, manual and book: https://github.com/ZhengLinLei/pgcloud

---

## What it is

PgBouncer 1.23.1 (compiled from source on Red Hat UBI 9) with PgCloud's configuration generator. It is the entry point for applications: it pools client connections in front of `pgcloud-pgpool` (or directly in front of a `pgcloud-db` node), so thousands of client connections share a small number of server connections.

- Pool modes `session`, `transaction` (default) or `statement`.
- Client authentication with `scram-sha-256` (or `md5`).
- Optional separate read-write and read-only pools.
- Admin console for pool, client and server statistics.

Tags: `1.1.0`, `1.1`, `latest` (older: `1.0.1`, `1.0.0`, `1.0`). Platforms: `linux/amd64`, `linux/arm64`.

## Run it by hand

The launcher writes all of this for you. To run a node manually, create an `.env` file (template: [`docker/pgbouncer/.env.example`](https://github.com/ZhengLinLei/pgcloud/blob/master/docker/pgbouncer/.env.example)) and point `BACKEND_HOST` / `BACKEND_PORT` at Pgpool-II:

```bash
docker run -d --name pgcloud_bouncer --restart unless-stopped --network host \
  --env-file .env \
  -v "$PWD/.env":/opt/pgcloud/.env \
  zhenglinlei/pgcloud-pgbouncer:1.1.0
```

Applications then connect to port `6432`:

```bash
psql -h <pgbouncer-host> -p 6432 -U u_pgcloud db_pgcloud
```

## Main settings

| Variable | Default | Description |
|---|---|---|
| `POSTGRES_DB` / `POSTGRES_USER` / `POSTGRES_PASSWORD` | `db_pgcloud` / `u_pgcloud` / — | Database and user served by PgBouncer. |
| `BACKEND_HOST` / `BACKEND_PORT` | `127.0.0.1` / `5432` | Backend: Pgpool-II (port `5434`) or a single PostgreSQL. |
| `PGB_PORT` | `6432` | Listening port. |
| `PGB_AUTH` | `scram-sha-256` | `scram-sha-256` or `md5`. |
| `POOL_MODE` | `transaction` | `session`, `transaction` or `statement`. |
| `MAX_CONNECTIONS` | `2000` | Maximum client connections. |
| `DEFAULT_POOL_SIZE` | `100` | Server connections per user/database pair. |
| `ENABLE_LOGFILE` | `off` | Log to files instead of stdout. |

For separate read-write and read-only pools, mount a `backend.env` file at `/opt/pgcloud/conf/server/backend.env` (`RW_BACKEND_*`, `RO_BACKEND_*`, `RO_POSTGRES_DB`). PgBouncer does not balance load by itself: with Pgpool-II in front of the databases, reads are balanced by Pgpool-II.

## Commands inside the container

```bash
docker exec -it pgcloud_bouncer bash
./script/getpool.sh      # SHOW POOLS
./script/getclient.sh    # SHOW CLIENTS
./script/getserver.sh    # SHOW SERVERS
./script/status.sh       # SHOW STATS
```

## Notes

- The configuration is generated on the first start and locked with `/etc/pgbouncer/lock.pgcloud`. Delete that file and restart to regenerate it.
- `auth_file.cfg` holds the user's password (readable only by root and the `pgbouncer` user); PgBouncer needs it to authenticate against Pgpool-II.

## License

GPL-2.0. PgBouncer is released under the ISC license.
