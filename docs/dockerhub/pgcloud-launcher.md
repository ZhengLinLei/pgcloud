# PgCloud Launcher

**Draw your PostgreSQL cluster. Press Deploy. Watch it live.**

PgCloud Launcher is a web app that designs, deploys and monitors PostgreSQL high-availability clusters. You draw the nodes (PostgreSQL primary and replicas, Pgpool-II, PgBouncer), add SSH access to your servers, and the launcher installs everything for you, then shows replication, failover and traffic in real time.

This is the entry point of the **PgCloud** project. The node images it deploys are:

| Image | Role |
|---|---|
| [`zhenglinlei/pgcloud-db`](https://hub.docker.com/r/zhenglinlei/pgcloud-db) | PostgreSQL 18, primary or streaming replica |
| [`zhenglinlei/pgcloud-pgpool`](https://hub.docker.com/r/zhenglinlei/pgcloud-pgpool) | Pgpool-II 4.7: load balancing, health checks, automatic failover |
| [`zhenglinlei/pgcloud-pgbouncer`](https://hub.docker.com/r/zhenglinlei/pgcloud-pgbouncer) | PgBouncer 1.23.1: connection pooling |

Source code, manual and book: https://github.com/ZhengLinLei/pgcloud

Tags: `1.2.0`, `1.2`, `latest` (older: `1.1.0`, `1.1`, `1.0.1`, `1.0.0`, `1.0`). Platforms: `linux/amd64`, `linux/arm64`.

## Quick start

```bash
docker run -d --name pgcloud-launcher \
  -p 8080:8080 \
  -v pgcloud-launcher:/data \
  zhenglinlei/pgcloud-launcher:1.2.0

docker logs pgcloud-launcher    # prints the generated admin password
```

Open http://localhost:8080, log in, then:

1. **Settings**: choose where the node images come from and review the cluster credentials (strong passwords are generated on first start).
2. **Topology**: add nodes (or load the 3-tier template), connect them and fill in each node's SSH access. *Save & test* checks SSH and the container runtime.
3. **Deploy**: fix any pre-flight error and press **Deploy cluster**. Order: primary → replicas → Pgpool-II → PgBouncer; each node waits until it is healthy.
4. **Monitor / Events**: status, latency, TPS, connections and replication lag of every node, refreshed every 3 seconds.

The launcher must reach every server over SSH and over the PostgreSQL / Pgpool-II / PgBouncer ports.

## Features

- **Visual topology** with links by node type and validation (roles, ports, SSH, one node of each type per server) before anything runs.
- **One-click deployment over SSH**: detects Docker or Podman, prepares the images, writes the configuration and (re)creates each container. Data volumes are kept on redeploy.
- **Image sources**: build on each server from the bundled sources (default), pull from Docker Hub (`zhenglinlei/*`, filled in automatically), upload a `tar.gz` for air-gapped sites, or use images already on the hosts.
- **Automatic failover** handled by Pgpool-II: a replica is promoted, the others follow it, and the old primary comes back as a replica with `pg_rewind`. Planned work from the launcher pauses Pgpool-II so it never triggers a failover. *Adopt live roles* updates the drawing after a failover.
- **Manual switchover in one click**: *Make primary* on a replica swaps it with the primary without losing committed transactions; *Make watchdog leader* moves the Pgpool-II leadership.
- **Real-time monitoring** and event log, light and dark mode.
- **Security**: admin password (scrypt), SSH secrets and cluster passwords encrypted with AES-256-GCM, SCRAM authentication and allowed networks on every node.

Measured in the PgCloud tests: a replica promoted within 5 s of a primary failure, the old primary back as a replica within 36 s, and never two primaries.

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `PORT` / `HOST` | `8080` / `0.0.0.0` | Listening address. |
| `DATA_DIR` | `/data` | SQLite database, encryption key and uploaded image archives. Mount it as a volume. |
| `LAUNCHER_ADMIN_PASSWORD` | generated | Fixed admin password (disables changing it from the UI). |
| `LAUNCHER_SECRET_KEY` | random key file | Key used to encrypt stored secrets. If unset, `/data/secret.key` is created: back it up with the database. |
| `LAUNCHER_SECURE_COOKIES` | `false` | Set to `true` behind an HTTPS reverse proxy. |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error`. |

## Data and backups

Everything the launcher knows (topology, settings, encrypted secrets, deployment history) is in the `/data` volume. Back up the whole volume; without `secret.key` (or `LAUNCHER_SECRET_KEY`) the stored secrets cannot be decrypted.

## License

GPL-2.0.
