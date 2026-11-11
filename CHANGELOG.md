# Changelog


## 1.2.0 - 2026-11-09

### Added

- **The topology follows a failover by itself**: when Pgpool-II serves a new primary, the launcher redraws the replication links (no more replicas drawn on the old primary) and rewrites the PostgreSQL configuration files it can reach.
- **Old primaries never start as a second primary**: at start, a node configured as primary checks the other nodes (`PEER_HOSTS`); if one is primary on a newer timeline, this node is an old primary. Settings → *Old primary that comes back*: **rejoin automatically** (pg_rewind, fresh copy if that fails) or **wait for me** (it does not start). The launcher flags old primaries and replicas that do not stream, with **Rejoin as replica** and **Rebuild (fresh copy)** in the node inspector. `pgcloud_rewind --clone` forces a fresh copy.

## 1.1.0 — 2026-11-07

### Added
- **Manual switchover** in the launcher: *Make primary* on a PostgreSQL replica makes it the primary and the current primary its replica, in one click and without losing committed transactions (Pgpool-II paused, clean stop, promote, redirect, `pg_rewind`, topology and Pgpool-II updated, synchronous replication restored).
- **Pgpool-II watchdog leader**: the inspector shows LEADER / STANDBY and *Make watchdog leader* moves the leadership to the chosen node.
- *PgCloud - The Master Book* v1.1.0 (`docs/wiki`): root scripts, switchover and watchdog in the manual (4.7.4) and the tutorial (5.10), test results in section 6.6.

### Fixed
- **Pgpool-II looped forever after `docker stop` / `docker start`** ("pid file found. is another pgpool running?"): the entrypoint was PID 1 and did not pass the stop signal, so Docker killed Pgpool-II and its pid file stayed. Pgpool-II and PgBouncer now run as PID 1 (`exec`), the Pgpool-II image stops with SIGINT (fast shutdown), and stale pid / socket files are removed at start.
- **Pgpool-II kept a running PostgreSQL node detached** after the whole system restarted (the primary came back after Pgpool-II, which never attaches a primary by itself, so writes failed). `auto_failback = on` now re-attaches streaming replicas automatically, and the launcher warns about any running node that Pgpool-II keeps detached, with a **Re-attach** button in the Pgpool-II inspector.
- A promoted node kept `NODE_ROLE=replica` in its container environment. After a restart, the entrypoint could try to rejoin the old primary. `pgcloud_promote` now records `NODE_ROLE=primary` in the mounted `.env`, the entrypoint reads the role from that file, and it never rejoins a host that is itself a replica.
- **A Pgpool-II node added later never joined the watchdog** ("Add to watchdog cluster request is rejected") and restarted in a loop: deploying one Pgpool-II node left the others with the old member list. Deploying a Pgpool-II node now redeploys every deployed Pgpool-II node, and the launcher warns about any deployed node whose configuration no longer matches the topology ("Redeploy it").

## 1.0.1 — 2026-11-07

### Fixed
- **Pgpool-II rejected every client (`SCRAM authentication failed`, `pool_passwd file does not contain an entry`) when the database password started with `-`.** `pg_enc` read the password as an option, printed its help, exited with 0 and wrote an empty `pool_passwd`. The same happened to the PCP password with `pg_md5`. The entrypoint now passes passwords after `--` and stops with an error if `pool_passwd` or the PCP hash were not written.
- The launcher no longer generates passwords or tokens that start with `-` (about 1 in 64 did).

### Added
- Root scripts: `BUILD.sh`, `EXPORT.sh` (tar.gz archives or multi-arch push to Docker Hub), `RUN.sh` (launcher from Docker Hub or a local build), `RUN.dev.sh` (playground with 3 simulated servers) and `CLEAN.sh`.

### Upgrading from 1.0.0
Redeploy the Pgpool-II nodes with the 1.0.1 image (in the launcher: Settings > Images, tag `1.0.1`, then redeploy). Clusters whose password does not start with `-` were not affected.

## 1.0.0 — 2026-11-06

First stable release: PostgreSQL 18, Pgpool-II 4.7, PgBouncer 1.23.1, the PgCloud Launcher (visual topology, deployment over SSH, real-time monitoring) and the book *PgCloud - The Master Book v1.0.0*.
