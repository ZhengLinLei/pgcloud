# static/

Everything that is copied **into** the Docker images. Each service folder is copied to `/opt/pgcloud` (`$PGCDATA`) inside its container by the matching `docker/<service>/Dockerfile`.

| Folder | Image | Docs |
|---|---|---|
| [`db/`](db/) | `pgcloud_db` | PostgreSQL entrypoint, failover helpers, config templates |
| [`pgpool/`](pgpool/) | `pgcloud_pool` | Pgpool-II entrypoint, failover/failback hooks, PCP tools |
| [`pgbouncer/`](pgbouncer/) | `pgcloud_bouncer` | PgBouncer entrypoint, admin console scripts |

## Folder convention

| Subfolder | Content |
|---|---|
| `sbin/` | Entrypoint and commands called automatically (failover, promotion...). Some are linked into `/bin` as `pgcloud_*`. |
| `script/` | Read-only helpers for operators: connect, status, role. |
| `tools/` | Operator actions that change state (attach/detach nodes, replication slots). |
| `conf/` | Configuration templates. The entrypoint **appends** the values from `.env` to them on first start. |
| `init/` | SQL run on first initialization (db only). |

Every change PgCloud makes to an upstream template is labelled with a `# @PGCloud:` comment.

## Logs

Each container writes its own log to `/opt/pgcloud/log/pgcloud.log`. PgPool also writes `failover.log` and `failback.log` there.

> Changes here only take effect after rebuilding the image (`docker/<service>/BUILD.sh` or `docker compose up --build`).
