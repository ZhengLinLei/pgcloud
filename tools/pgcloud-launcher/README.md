# tools/pgcloud-launcher — PgCloud Launcher

A web application to **design, deploy and monitor** PgCloud clusters visually.

- **Topology editor**: drag PostgreSQL, Pgpool-II and PgBouncer nodes onto a canvas and connect them. The links decide the roles: a PostgreSQL node linked to another one is its replica, Pgpool-II balances the PostgreSQL nodes it is linked to, and PgBouncer pools in front of one backend. Links are animated and coloured by live status.
- **One-click deployment over SSH**: for every server the backend detects Docker or Podman, prepares the image (registry pull, `tar.gz` upload, or image already present), writes the configuration, (re)creates the container and waits until it is healthy. Order: primary → replicas → pgpool → pgbouncer.
- **Real-time monitoring** (WebSocket): up/down/degraded state, TCP latency, connections, TPS, replication lag, `pg_stat_replication`, Pgpool `SHOW pool_nodes`, PgBouncer `SHOW POOLS/STATS`, and the container state over SSH.
- **Tabs**: Topology · Monitor · Deploy (pre-flight checks, plan, live console, history) · Events · Settings.
- **Hacker-style UI** with light and dark themes.

```
┌──────────────── browser ────────────────┐        SSH (ssh2)        ┌──── server A ─────┐
│ React + React Flow  ◄── WebSocket ───┐  │   ───────────────────►   │ docker / podman   │
└──────────────────────────────────────┼──┘                          │  pgcloud_db       │
                         ┌─────────────┴──────────┐   SQL (pg)       │  pgcloud_pool     │
                         │ Fastify API (Node 22)  │ ───────────────► │  pgcloud_bouncer  │
                         │ SQLite  ·  /data       │                  └───────────────────┘
                         └────────────────────────┘                   server B, C …
```

## Run it

From the repository root (the PgCloud sources are bundled in the image):

```bash
docker build -t pgcloud/launcher:1.0.0 -f tools/pgcloud-launcher/Dockerfile .
docker run -d --name pgcloud-launcher \
  -p 8080:8080 \
  -v pgcloud-launcher:/data \
  pgcloud/launcher:1.0.0
docker logs pgcloud-launcher     # prints the generated admin password
```

Or use the published image (built by [`.github/workflows/release-images.yml`](../../.github/workflows/release-images.yml) on every GitHub release):

```bash
docker run -d --name pgcloud-launcher -p 8080:8080 -v pgcloud-launcher:/data zhenglinlei/pgcloud-launcher:1.0.0
```

Open <http://localhost:8080>. The admin password is also saved in `/data/admin-password.txt`. You can change it in **Settings**, or fix it with `-e LAUNCHER_ADMIN_PASSWORD=...`.

The launcher must reach every server over **SSH** (deployment) and over the **PostgreSQL / Pgpool / PgBouncer ports** (monitoring). Its address must be inside the cluster's *Allowed networks* (Settings).

### Environment variables

| Variable | Default | Description |
|---|---|---|
| `PORT` / `HOST` | `8080` / `0.0.0.0` | Listening address. |
| `DATA_DIR` | `/data` | SQLite database, encryption key, uploaded image archives. Mount it as a volume. |
| `LAUNCHER_ADMIN_PASSWORD` | generated | Fixed admin password (disables changing it from the UI). |
| `LAUNCHER_SECRET_KEY` | random key file | Key used to encrypt the stored secrets. If unset, `/data/secret.key` is created: back it up together with the database. |
| `LAUNCHER_SECURE_COOKIES` | `false` | Set to `true` when served over HTTPS (behind a TLS reverse proxy). |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error`. |

### Try it locally

[`test/`](test/) starts the launcher plus three fake servers (Docker-in-Docker with SSH), so you can deploy a real cluster and test failover on your laptop. See [test/README.md](test/README.md).

## Workflow

1. **Settings** → choose the image source:
   - **build** (default): the launcher copies the bundled PgCloud sources to each server over SFTP and runs `docker build` / `podman build` there. Images are labelled with a hash of their sources and rebuilt only when they change. The first build takes a few minutes and the servers need Internet access.
   - **registry**: `docker pull <registry>/<name>:<tag>` on each server. Selecting it fills in the official images on Docker Hub ([`zhenglinlei`](https://hub.docker.com/u/zhenglinlei)): registry `docker.io/zhenglinlei`, names `pgcloud-db`, `pgcloud-pgpool`, `pgcloud-pgbouncer`, and the launcher version as tag (`1.0.0`). Change them to use your own registry; *Use official images* restores the defaults.
   - **tar.gz**: upload an archive created with `docker save … | gzip`. It is copied over SFTP once per server and loaded only if the image is missing.
   - **on hosts**: the images already exist on the servers (built with `docker/<service>/BUILD.sh`).

   Also choose the runtime (`auto`, `docker`, `podman`) and review the cluster credentials. Strong random passwords are generated on first start.
2. **Topology** → add nodes (or *Load 3-tier template*), connect them, and fill in each node's **SSH** tab (host, user, password or private key, optional `sudo`). Use *Save & test* to check SSH and the container runtime.
3. **Deploy** → fix any blocking pre-flight check, then press **Deploy cluster** and follow the console.
4. **Monitor / Events** → watch the cluster. Per-node operations (redeploy, start, stop, restart, remove container, destroy with data) are in the inspector.

Your application connects to the entry point shown in **Settings → Connect your application** (PgBouncer, else Pgpool, else the primary).

## What gets deployed on each server

| Node | Container | Network | Files (`<remote dir>/<node>/`, mode 700/600) |
|---|---|---|---|
| PostgreSQL | `pgcloud_db` (+ volume `pgcloud_<node>_data`) | host | `.env` |
| Pgpool-II | `pgcloud_pool` | host | `.env`, `conf/postgres/server<N>.env`, `conf/pgpool/backend<N>.env` |
| PgBouncer | `pgcloud_bouncer` | host | `.env` |

All containers use `--restart unless-stopped`. Container names are fixed because Pgpool's failover commands address `pgcloud_db` on each server. So there can be **one node of each type per server**, and ports must not clash (the pre-flight checks enforce both).

Pgpool's automatic failover (promote, redirect, recover) runs from the Pgpool container over SSH with the **password** of each PostgreSQL server. With key authentication, Pgpool still detects failures and detaches nodes, but cannot repair them automatically.

Verified end to end (2 servers, pgbench running through PgBouncer, primary container killed):
- the replica is promoted after about 4 s;
- the old primary is `pg_rewind`-ed and back as a streaming replica after about 15 s, attached to pgpool after about 20 s;
- PgBouncer and Pgpool keep answering, and writes made after the failover reach the rejoined replica.

After a failover the new primary runs with **asynchronous** replication (otherwise commits would block while no standby is connected). The topology still shows the old roles: the deploy is blocked until you press **Adopt live roles** (Topology toolbar), which redraws the replication links to the running primary. The next cluster deploy turns synchronous replication on again as soon as a replica streams.

Planned work never triggers a failover: while the launcher redeploys or restarts PostgreSQL nodes it pauses the Pgpool-II containers and resumes them afterwards.

The complete manual, the illustrated tutorial and the test/benchmark report are in the book: [`doc/wiki/PgCloud_The_Master_Book_v1.0.0.pdf`](../../docs/wiki/PgCloud_The_Master_Book_v1.0.0.pdf).

## Security

- One admin account. Every API call and the WebSocket require a session (HttpOnly, SameSite=Strict cookie, 12 h).
- SSH passwords/keys and cluster passwords are stored encrypted with AES-256-GCM and are never returned to the browser. The cluster passwords can be revealed explicitly in Settings.
- The launcher holds root-level access to your servers: expose it only on a private network or behind a VPN/TLS proxy.

## Release images

Publishing a GitHub release runs [`.github/workflows/release-images.yml`](../../.github/workflows/release-images.yml). It builds the four images for `linux/amd64` and `linux/arm64` and pushes them to Docker Hub ([hub.docker.com/u/zhenglinlei](https://hub.docker.com/u/zhenglinlei)):

| Image | Dockerfile |
|---|---|
| `zhenglinlei/pgcloud-db` | `docker/db/Dockerfile` |
| `zhenglinlei/pgcloud-pgpool` | `docker/pgpool/Dockerfile` |
| `zhenglinlei/pgcloud-pgbouncer` | `docker/pgbouncer/Dockerfile` |
| `zhenglinlei/pgcloud-launcher` | `tools/pgcloud-launcher/Dockerfile` |

A release tagged `v1.2.3` produces the tags `1.2.3`, `1.2` and `latest` (`latest` is skipped for pre-releases). The repository needs the secrets `DOCKERHUB_USERNAME` and `DOCKERHUB_TOKEN` (a Docker Hub access token with *Read & Write* scope). The workflow can also be run by hand (*Actions → Publish release images → Run workflow*) for an existing tag.

## Web demo

`npm run build:demo` builds a front-end only version of the UI into [`docs/`](../../docs/) (`index.html`, `assets/`, `logo.png`, `favicon.png`), with a **DEMO** watermark and a banner. The rest of `doc/` (book, images, diagrams) is kept: each build only replaces the previous demo files. It is for illustration only:

- the API and the live feed are simulated in the browser from [`web/src/demo/snapshot.json`](web/src/demo/snapshot.json), a snapshot recorded from the playground cluster (secrets replaced by `********`);
- the topology can be edited in memory; deploying, node actions, SSH tests and uploads answer "Not available in the demo";
- assets use relative paths, so the folder works from any static host (GitHub Pages, `python3 -m http.server -d doc`). Browsers do not run it from `file://`.

The normal build (`npm run build`) does not contain the demo code.

## Development

```bash
cd tools/pgcloud-launcher
npm install
npm run dev:server      # API on :8080 (tsx watch); DATA_DIR defaults to ./data
npm run dev:web         # UI on :5173 with hot reload, proxied to the API
npm run typecheck
npm run build           # dist/web (Vite) + dist/server (tsc)
```

| Path | Content |
|---|---|
| `server/` | Fastify API: `db.ts` (SQLite), `ssh.ts` (ssh2/SFTP, Docker/Podman detection), `topology.ts` (roles, validation, generated `.env` files), `deploy.ts` (jobs), `monitor.ts` (real-time checks), `auth.ts`, `routes.ts` |
| `web/` | React + React Flow UI (`tabs/`, `components/`) |
| `shared/types.ts` | Types shared by API and UI |

Requirements: Node.js ≥ 22.13 (uses the built-in `node:sqlite`).
