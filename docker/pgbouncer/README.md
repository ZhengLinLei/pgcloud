# docker/pgbouncer — PgBouncer node

Image based on Red Hat UBI 9, with PgBouncer 1.23.1 compiled from source (the first build takes a few minutes). PgBouncer pools client connections in front of PgPool or directly in front of PostgreSQL.

## Usage

```bash
cp .env.example .env    # password, backend host/port, pool mode...
./BUILD.sh              # builds image "pgcloud_bouncer"
./RUN.sh                # runs container "pgcloud_bouncer" with --net=host
```

PgBouncer listens on `PGB_PORT` (default `6432`):

```bash
psql -h <pgbouncer-host> -p 6432 -U u_pgcloud db_pgcloud
```

## Choosing the backend

There are two ways to define where PgBouncer connects:

1. **Environment** (default): one database entry `POSTGRES_DB = host=BACKEND_HOST port=BACKEND_PORT`. Use it to point at PgPool (`5434`) or at a single Postgres.
2. **`conf/backend.env`**: read/write and read-only pools. Copy [`conf/backend.sample.env`](conf/backend.sample.env) to `conf/backend.env`. `RUN.sh` mounts `./conf` into the container.

| Variable (`backend.env`) | Description |
|---|---|
| `RW_BACKEND_NUM` / `RO_BACKEND_NUM` | Set to `0` to disable that pool. |
| `RW_BACKEND_HOST` / `RW_BACKEND_PORT` | Read-write backend (comma-separated hosts allowed). |
| `RO_BACKEND_HOST` / `RO_BACKEND_PORT` | Read-only backend (replicas). |
| `RO_POSTGRES_DB` | Alias clients use for the read-only pool, for example `db_pgcloud_ro`. |

> PgBouncer does not load-balance. With direct Postgres backends, the application must choose the `_ro` database for reads.

## Main settings (`.env`)

| Variable | Default | Description |
|---|---|---|
| `POSTGRES_DB` / `POSTGRES_USER` / `POSTGRES_PASSWORD` | `db_pgcloud` / `u_pgcloud` / `change_me` | Database and user served by PgBouncer. |
| `BACKEND_HOST` / `BACKEND_PORT` | `127.0.0.1` / `5432` | Backend when no `backend.env` is present. |
| `PGB_PORT` | `6432` | Listening port. |
| `PGB_AUTH` | `scram-sha-256` | Client auth method: `scram-sha-256` or `md5`. |
| `POOL_MODE` | `transaction` | `session`, `transaction` or `statement`. |
| `MAX_CONNECTIONS` | `2000` | `max_client_conn`. |
| `DEFAULT_POOL_SIZE` | `100` | Server connections per user/database pair. |
| `ENABLE_LOGFILE`, `LOG_NAME`, `LOG_FILENAME` | `off` | Log to files with `cronolog` instead of stdout. |

## Commands inside the container

```bash
docker exec -it pgcloud_bouncer bash
./script/getpool.sh     # SHOW POOLS
./script/getclient.sh   # SHOW CLIENTS
./script/getserver.sh   # SHOW SERVERS
./script/status.sh      # SHOW STATS
```

These scripts use the admin console (database `pgbouncer`). `POSTGRES_USER` is configured as `admin_users`.

## Notes

- `auth_file.cfg` stores the user's password (readable only by root and the `pgbouncer` user). PgBouncer needs it to authenticate against PgPool, which builds its own SCRAM verifier.
- The configuration is generated once and marked with `/etc/pgbouncer/lock.pgcloud`. Delete that file and restart to regenerate it.
