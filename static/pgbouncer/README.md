# static/pgbouncer — PgBouncer node files

Copied to `/opt/pgcloud` in the `pgcloud_bouncer` image. Build, run and `.env` reference are in [`docker/pgbouncer`](../../docker/pgbouncer/).

## sbin/

| File | Description |
|---|---|
| `entrypoint.sh` | Generates the configuration on first start, then runs `pgbouncer -u pgbouncer` (stdout, or files through `cronolog`). It appends to `conf/pgbouncer.ini`: the `[databases]` section (from `conf/server/backend.env` if mounted, otherwise from `BACKEND_HOST`/`BACKEND_PORT`), plus `[pgbouncer]` with port, `auth_type`, `auth_file`, `admin_users`, pool mode and limits. It also writes `auth_file.cfg` for `POSTGRES_USER`, copies everything to `/etc/pgbouncer` and creates `lock.pgcloud`, so a restart does not regenerate it. |

## script/

All scripts connect to the admin console (`-d pgbouncer`) as `POSTGRES_USER`.

| File | Admin command |
|---|---|
| `getpool.sh` | `SHOW POOLS;` |
| `getclient.sh` | `SHOW CLIENTS;` |
| `getserver.sh` | `SHOW SERVERS;` |
| `status.sh` | `SHOW STATS;` |

## conf/

| File | Description |
|---|---|
| `pgbouncer.ini` | Upstream sample, fully commented. The generated sections are appended at the end. |
| `auth_file.cfg` | Placeholder. On first start it is replaced with `"user" "password"` (mode `640`). It holds the password itself, not a hash, because PgBouncer must authenticate to PgPool, which builds its own SCRAM verifier. |
