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
docker build -t pgcloud/launcher:1.1.0 -f tools/pgcloud-launcher/Dockerfile .
docker run -d --name pgcloud-launcher \
  -p 8080:8080 \
  -v pgcloud-launcher:/data \
  pgcloud/launcher:1.1.0
docker logs pgcloud-launcher     # prints the generated admin password
```

Or use the published image (built by [`.github/workflows/release-images.yml`](../../.github/workflows/release-images.yml) on every GitHub release):

```bash
docker run -d --name pgcloud-launcher -p 8080:8080 -v pgcloud-launcher:/data zhenglinlei/pgcloud-launcher:1.1.0
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
   - **registry**: `docker pull <registry>/<name>:<tag>` on each server. Selecting it fills in the official images on Docker Hub ([`zhenglinlei`](https://hub.docker.com/u/zhenglinlei)): registry `docker.io/zhenglinlei`, names `pgcloud-db`, `pgcloud-pgpool`, `pgcloud-pgbouncer`, and the launcher version as tag (`1.1.0`). Change them to use your own registry; *Use official images* restores the defaults.
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

The complete manual, the illustrated tutorial and the test/benchmark report are in the book: [`docs/wiki/PgCloud_The_Master_Book_v1.1.0.pdf`](../../docs/wiki/PgCloud_The_Master_Book_v1.1.0.pdf).

## Manual switchover and watchdog leader

Both are one click in the node inspector (Topology → select the node → *High availability*). They run as an operation, with their log in the Deploy tab.

**Make primary** (on a running PostgreSQL replica): a planned switchover, without losing committed transactions.

1. The Pgpool-II nodes are stopped, so none of them starts a failover on its own.
2. The current primary is stopped cleanly; its last WAL (the shutdown checkpoint) reaches the replicas. The launcher waits until the chosen replica replayed it. If it does not within 60 s, the old primary is started again and nothing changes.
3. The replica is promoted (`pgcloud_promote`) and the other replicas follow it (`pgcloud_redirect`).
4. The old primary is resynchronised with `pg_rewind` and starts as a replica of the new one.
5. The topology is updated (like *Adopt live roles*; PgBouncer nodes connected straight to the old primary move to the new one), the configuration files on every PostgreSQL host are rewritten, Pgpool-II (and those PgBouncer nodes) are redeployed and synchronous replication is restored.

Writes are not accepted while it runs (about a minute in the test servers: 3 PostgreSQL, 3 Pgpool-II, 1 PgBouncer); clients waiting in PgBouncer continue afterwards, other clients must reconnect. In the tests, a client writing through PgBouncer during the switchover committed 392 rows and all of them were on the new primary. Redeploying Pgpool-II also starts a new watchdog election, so check the watchdog leader afterwards if it matters.

**After an automatic failover** the drawing follows by itself: when Pgpool-II serves a new primary, the replication links are redrawn to it. If the old primary comes back on its own (its server was down during the failover, so Pgpool-II could not turn it into a replica), it checks the other nodes at start and, depending on *Settings → Old primary that comes back*, rejoins as a replica (`pg_rewind`, or a fresh copy if that fails) or waits without starting. The launcher marks any node that runs as a second primary, or a replica that does not stream, and its inspector offers **Rejoin as replica** (pg_rewind) and **Rebuild (fresh copy)** (pg_basebackup).

**Make watchdog leader** (on a Pgpool-II node, when two or more are deployed): the inspector shows whether the node is the watchdog LEADER or STANDBY. The button restarts the current leader so that the others elect a new one, until the chosen node leads. Clients connected to the restarted node reconnect after a few seconds. Use three or more Pgpool-II nodes: with two, the one left alone has no quorum.

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

`npm run build:demo` builds a front-end only version of the UI into [`docs/`](../../docs/) (`index.html`, `assets/`, `logo.png`, `favicon.png`), with a **DEMO** watermark and a banner. The rest of `docs/` (book, images, diagrams) is kept: each build only replaces the previous demo files. It is for illustration only:

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
