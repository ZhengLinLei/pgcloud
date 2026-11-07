# Changelog

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
