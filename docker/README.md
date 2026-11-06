# docker/

Build and run scripts for each PgCloud node type. Use these to deploy **one node per machine** (production-like, multi-host). For a single-machine demo, use [`compose.yaml`](../compose.yaml) at the repository root instead.

| Folder | Image | Purpose |
|---|---|---|
| [`db/`](db/) | `pgcloud_db` | PostgreSQL 16 node (primary or streaming replica) |
| [`pgpool/`](pgpool/) | `pgcloud_pool` | Pgpool-II: load balancing, health checks, failover |
| [`pgbouncer/`](pgbouncer/) | `pgcloud_bouncer` | PgBouncer: connection pooling |

Each folder contains:

| File | What it does |
|---|---|
| `Dockerfile` | Image definition. The build context is the **repository root**, so it can copy `static/<service>/`. |
| `BUILD.sh` | Builds the image (`docker build -f ./Dockerfile ../..`) and prunes dangling images. |
| `RUN.sh` | Starts the container with `--env-file ./.env`, opens a shell in it and **stops it when you leave the shell**. |
| `.env.example` | Every setting with its documentation. Copy it to `.env` and edit it. |

The files that end up inside each image (entrypoints, scripts, config templates) live in [`static/`](../static/).

## Typical workflow on a machine

```bash
cd docker/db                 # or pgpool / pgbouncer
cp .env.example .env         # then edit it: passwords, hosts, role...
./BUILD.sh
./RUN.sh
```

- `RUN.sh` refuses to start without a `.env`.
- The entrypoints refuse to start while a password is empty or still `change_me`.
- `.env` files are git-ignored; never commit them.

## Recommended start order

1. `db` primary (`NODE_ROLE=primary`)
2. `db` replicas (`NODE_ROLE=replica`, `PRIMARY_HOST` pointing to the primary)
3. `pgpool` (needs the database nodes to be reachable)
4. `pgbouncer` (needs its backend, PgPool or Postgres, to be reachable)

## Notes

- `RUN.sh` uses `--rm`, so the container (and its generated config) is removed when it stops. Database data is kept in the `pgdata` volume.
- The scripts are intentionally simple. Adapt the `docker run` flags (ports, `--network=host`, volumes, restart policy) to your environment.
