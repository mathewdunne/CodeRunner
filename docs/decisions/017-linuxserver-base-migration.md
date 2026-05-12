# 017 — Migrate code container to linuxserver/openvscode-server

**Status:** Implemented  
**Date:** 2026-05-11

## Context

Decision 016 noted that switching from `gitpod/openvscode-server:1.105.1` (Ubuntu 22.04) to `linuxserver/openvscode-server` (Ubuntu 24.04) was deferred due to its fundamentally different image structure. This decision implements that migration.

The gitpod base image was aging: Ubuntu 22.04 required a PPA workaround for GLIBCXX_3.4.32 (needed by WPILib vendor JNI libs like PhotonLib), and the image is no longer actively maintained. The linuxserver.io image provides:

- Ubuntu 24.04 (Noble) with native GLIBCXX_3.4.32+ support
- openvscode-server pre-installed at `/app/openvscode-server/`
- s6-overlay for proper process supervision
- Runtime UID/GID configuration via PUID/PGID (no build-time user creation)
- Active maintenance with security patches

## Decisions

### Use `linuxserver/openvscode-server` as base

We extend `linuxserver/openvscode-server:1.109.5` directly rather than the bare `baseimage-ubuntu:noble`. This gives us a fully working openvscode-server with its s6 service, init scripts, and the LSIO user model out of the box. We layer JDK, extensions, and Gradle cache on top.

The openvscode-server version is pinned via the image tag (currently 1.109.5).

### Layered s6-overlay: additive, not replacement

The upstream image already provides `init-openvscode-server` (oneshot) and `svc-openvscode-server` (longrun). We add:

- `init-frc-setup` (oneshot): seeds Gradle cache, extensions, validates project mount
- Override of `svc-openvscode-server/run`: custom launch with `--extensions-dir`, `--user-data-dir`, `--server-base-path`, and workspace folder arg
- Dependency link: `svc-openvscode-server → init-frc-setup` ensures our init completes before the editor starts

The upstream's `type`, `notification-fd`, and `dependencies.d/init-services` are preserved — we only add/override files.

### Runtime PUID/PGID instead of build-time --user

The linuxserver base image creates an `abc` user whose UID/GID are set at container startup via PUID/PGID environment variables. The control plane now passes `-e PUID=<uid> -e PGID=<gid>` instead of `--user UID:GID`.

This means the image is user-agnostic at build time — no more FRC_UID/FRC_GID build args.

### Bind mount target changes from /home/frc to /config

The linuxserver convention uses `/config` as the persistent data directory (HOME). The host-side path (`data/users/<id>/home/`) is unchanged; only the container mount point moves.

### Sim scripts remain independent of s6

`start-sim.sh` and `stop-sim.sh` are invoked via `docker exec` and operate independently of s6-overlay. They updated their HOME default from `/home/frc` to `/config`.

## Migration Notes

- Existing containers must be recreated (stop + remove via admin or idle sweep)
- Host-side data directories persist unchanged
- The new data layout under `/config` uses `extensions/` and `data/` directly (not nested under `.openvscode-server/`)
- For existing users whose home dirs have `.openvscode-server/data/` and `.openvscode-server/extensions/`, extensions and settings will be re-seeded from the image cache on first start

## Verification

- Typecheck: passes
- All tests pass
- Template project builds and simulates
- Imported projects with vendor deps load JNI libs without GLIBCXX errors
