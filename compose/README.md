# compose/

Node definitions used by [`compose.yaml`](../compose.yaml) at the repository root. That file starts a complete three-tier cluster on a single machine:

```
client ──► pgbouncer :6432 ──► pgpool :5434 ──► db0 (primary)
                                            ├─► db1 (replica)
                                            └─► db2 (replica)
```

## Usage (from the repository root)

```bash
cp .env.example .env            # set POSTGRES_PASSWORD, REPLICA_PASS, PCP_PASS
docker compose up -d --build
docker compose ps               # every service should become "healthy"
psql -h localhost -p 6432 -U u_pgcloud db_pgcloud
```

Two-tier only (without PgBouncer): `docker compose up -d db0 db1 db2 pgpool`.

## Files

| Path | Mounted at | Description |
|---|---|---|
| `pgpool/postgres/server0.env` … `server2.env` | `/opt/pgcloud/conf/postgres` in `pgpool` | The PostgreSQL nodes as seen by PgPool (`db0` is the initial primary). `PSQL_NAME` matches each node's `BACKEND_NAME`. |
| `pgpool/pgpool/backend0.env` | `/opt/pgcloud/conf/pgpool` in `pgpool` | The single PgPool node (watchdog disabled with `PGPOOL_NUM=1`). |

The format is the same as the samples in [`docker/pgpool/conf`](../docker/pgpool/conf/).

## How settings are combined

1. Each service loads the defaults from `docker/<service>/.env.example` (`env_file`).
2. `compose.yaml` overrides the per-node values (`NODE_ROLE`, `BACKEND_NAME`, `PRIMARY_HOST`, `BACKEND_HOST`...).
3. The passwords come from the root `.env`. Compose refuses to start if one is missing.

## Adding a replica

1. Copy the `db2` service in `compose.yaml` as `db3` (with `BACKEND_NAME: node3` and a new volume `db3-data`).
2. Create `pgpool/postgres/server3.env` with `PSQL_HOST=db3` and `PSQL_NAME=node3`.
3. Recreate PgPool so it regenerates its config: `docker compose up -d --force-recreate pgpool`.

## Limitations

- Every node runs on the same host, so this setup is meant for development, testing and evaluation.
- Automatic failover *recovery* (promote/redirect over SSH) is not wired up here. PgPool still detects failures and detaches failed nodes. You can test the failover commands by hand:

  ```bash
  docker compose stop db0
  docker compose exec db2 pgcloud_promote db2 5432 db0 5432
  docker compose exec db1 pgcloud_redirect db2 5432 db0 5432
  ```

- `docker compose down -v` deletes all data volumes.
