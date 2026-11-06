# tools/pgpool-launcher/test — local playground

Run the launcher against two fake servers on your machine, deploy a real cluster and test failover.

| Container | Address | Access |
|---|---|---|
| `launcher` | <http://localhost:8080> | admin password `launcher-test` |
| `srv-a` | `172.30.0.11` | SSH `root` / `pgcloud-test` |
| `srv-b` | `172.30.0.12` | SSH `root` / `pgcloud-test` |

The servers are Docker-in-Docker containers with SSH: the launcher treats them like real hosts. **For testing only.**

Requirements: Docker Desktop (or Docker Engine) with about 6 GB of free disk space.

## 1. Build and start

From the repository root:

```bash
docker compose build
```

```bash
docker compose -f tools/pgpool-launcher/test/compose.yaml up -d --build
```

The first command builds the PgCloud images (`pgcloud/db:dev`, `pgcloud/pgpool:dev`, `pgcloud/pgbouncer:dev`).

## 2. Put the images on the servers

Choose one option:

- **Fast** (image source *on hosts*): copy them directly into the servers.

  ```bash
  bash tools/pgpool-launcher/test/load-images.sh
  ```

- **Like production** (image source *tar.gz*): create the archive and upload it in **Settings → PgCloud images → tar.gz**. The launcher copies it to each server over SFTP.

  ```bash
  docker save pgcloud/db:dev pgcloud/pgpool:dev pgcloud/pgbouncer:dev | gzip -1 > pgcloud-images.tar.gz
  ```

In both cases set **Tag** to `dev` and press **Save settings**.

## 3. Design and deploy

1. Open <http://localhost:8080> and log in with `launcher-test`.
2. **Topology** → *Load 3-tier template* (or add the nodes yourself) and leave two PostgreSQL nodes: one primary and one replica.
3. Click each node → **SSH** tab → host `172.30.0.11` or `172.30.0.12`, user `root`, password `pgcloud-test` → *Save & test*. Put the primary, pgpool and pgbouncer on `srv-a`, and the replica on `srv-b`. Only one node of each type can run per server.
4. **Deploy** → *Deploy cluster*, then follow the console.

## 4. Play with it

Generate load through PgBouncer. The password is in **Settings → Superuser password → 👁**:

```bash
docker run --rm -it --network pgcloud-launcher-test_lab -e PGPASSWORD='<password>' postgres:16 \
  bash -c 'pgbench -h 172.30.0.11 -p 6432 -U u_pgcloud -i -s 5 db_pgcloud && pgbench -h 172.30.0.11 -p 6432 -U u_pgcloud -c 8 -T 300 -P 10 db_pgcloud'
```

Simulate the primary crashing, and watch **Topology / Monitor / Events**:

```bash
docker compose -f tools/pgpool-launcher/test/compose.yaml exec srv-a docker stop pgcloud_db
```

Pgpool promotes the replica (about 4 s), and the old primary comes back as a replica via `pg_rewind` (about 15–20 s).

Inspect a server:

```bash
docker compose -f tools/pgpool-launcher/test/compose.yaml exec srv-a docker ps
```

```bash
docker compose -f tools/pgpool-launcher/test/compose.yaml exec srv-a docker exec pgcloud_pool tail -50 /opt/pgcloud/log/failover.log
```

## 5. Clean up

```bash
docker compose -f tools/pgpool-launcher/test/compose.yaml down -v
```
