# Changelog


## 1.2.0 - 2026-11-09

### Added

- **The topology follows a failover by itself**: when Pgpool-II serves a new primary, the launcher redraws the replication links (no more replicas drawn on the old primary) and rewrites the PostgreSQL configuration files it can reach.
- **Old primaries never start as a second primary**: at start, a node configured as primary checks the other nodes (`PEER_HOSTS`); if one is primary on a newer timeline, this node is an old primary. Settings → *Old primary that comes back*: **rejoin automatically** (pg_rewind, fresh copy if that fails) or **wait for me** (it does not start). The launcher flags old primaries and replicas that do not stream, with **Rejoin as replica** and **Rebuild (fresh copy)** in the node inspector. `pgcloud_rewind --clone` forces a fresh copy.
- **Auto-heal** (Settings, on by default): after an outage the launcher rejoins old primaries (with *rejoin automatically*) and re-attaches healthy nodes that Pgpool-II keeps detached; a standby Pgpool-II that stays out of sync with the watchdog leader is restarted to copy its view. Re-attach does the same by hand.
- Pgpool-II `detach_false_primary = on`: if two primaries run, the one without streaming replicas is detached.
- **Destroy & rebuild cluster** (Deploy tab → Danger zone): deletes every node and its data and deploys the cluster again from scratch.
- **Backup nodes**: PostgreSQL replicas that serve no traffic (no Pgpool-II / PgBouncer link). Per node: keep the number of replicas (replace a node that stays down and take over its links), last resort (become the primary when every other node is down), priority and grace time.
- **Fast-swap**: when the cluster is about to lose its data a red banner offers to copy the freshest data (pg_basebackup over streaming replication) to a new server, created as a top-priority backup.
- **Audit recordings**: REC button in the top bar (with an optional name); the Audit tab shows one timeline of launcher events, operations, container logs and Pgpool-II failover logs, renames recordings, and downloads them as `.log` / `.json`. The web demo has a recording of its deployment and records its own events.
- When the backend list of Pgpool-II changes (backup activation, deploying a Pgpool-II node), every Pgpool-II node is stopped first and then started: a node started with the new list no longer copies the backend states of a watchdog leader that still has the old one (it marked the new primary down). Nodes skipped because their server was down are redeployed by themselves as soon as the server answers over SSH.
- Deploying a backup node, or a PostgreSQL node for the first time, no longer pauses Pgpool-II.
- **"System not accessible" alert**: when no entry point (PgBouncer, else Pgpool-II, else the primary) accepts connections for 6 s, a card in the bottom-right corner explains why, layer by layer, and offers the fixes the launcher can apply (deploy, start, promote the freshest replica, rejoin, re-attach, redeploy Pgpool-II, restart PgBouncer, fast-swap, rebuild). New action: promote a replica when no primary is left.
- Playground: `./RUN.dev.sh --extra` adds two spare servers (srv-d, srv-e) for backup nodes and fast-swap.
- **Backup nodes return to backup** when the cluster recovers (new option, on by default): a backup that stood in for a failed node hands its links back once that node is healthy again (as the primary, after a planned switchover). With the option off it becomes a system node for good, with a *previously a backup* notice. A backup can no longer be made primary by hand (switchover / promote); it only becomes primary as a last resort.

### Fixed
- **Stop on a PostgreSQL replica did not stick**: Pgpool-II saw the node down and its failover recovery restarted the container over SSH within seconds. Stop now leaves a `pgcloud_db_stopped` volume on the host as a marker, and the recovery skips a replica that has it; Start, Restart and Deploy remove it. Redeploy the Pgpool-II nodes to apply it.
- **Links could not be selected in the topology** (so they could not be removed): the links are controlled by the launcher and React Flow's own selection was dropped on the next render. Clicking a link or its label now selects it; remove it with ⌫ or the new **✕ remove** button on its label.
- **No PostgreSQL node could start after a full outage.** The stale-primary check asks the other nodes for their timeline; with every node down `psql` failed (exit 2) and, under `set -e`, the entrypoint stopped before starting PostgreSQL, in a restart loop with no message. Unreachable peers are now ignored, as intended.
- **Start failed when the configuration had vanished from the host** (`error mounting ... .env: not a directory`): Docker recreates a missing bind-mount source as an empty directory, so the container could not start and Pgpool-II ran with no backends. Start and Restart now check the node configuration on the host and write it again (removing those directories) before starting; Deploy removes them too.

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
