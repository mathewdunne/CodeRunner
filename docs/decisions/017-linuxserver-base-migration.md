# 017 — Migrate code container to linuxserver/openvscode-server base

**Status:** Implemented  
**Date:** 2026-05-11

## Context

Decision 016 noted that switching from `gitpod/openvscode-server:1.105.1` (Ubuntu 22.04) to `linuxserver/openvscode-server` (Ubuntu 24.04) was deferred due to its fundamentally different image structure. This decision implements that migration.

The gitpod base image was aging: Ubuntu 22.04 required a PPA workaround for GLIBCXX_3.4.32 (needed by WPILib vendor JNI libs like PhotonLib), and the image is no longer actively maintained. The linuxserver.io image provides:

- Ubuntu 24.04 (Noble) with native GLIBCXX_3.4.32+ support
- s6-overlay for proper process supervision
- Runtime UID/GID configuration via PUID/PGID (no build-time user creation)
- Active maintenance with security patches

## Decisions

### Use `ghcr.io/linuxserver/baseimage-ubuntu:noble` as base

We extend the linuxserver base image rather than using `linuxserver/openvscode-server` directly. This gives us s6-overlay and the LSIO user model while allowing us to pin our own openvscode-server version and install extensions/JDK as before.

### s6-overlay replaces tini + monolithic entrypoint

- `init-frc-setup` (oneshot): seeds Gradle cache, extensions, validates project mount
- `svc-openvscode-server` (longrun): launches the editor with `s6-setuidgid abc`

This replaces the single `entrypoint.sh` that handled both initialization and exec-ing the server.

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
- All 126 tests pass
- Template project builds and simulates
- Imported projects with vendor deps load JNI libs without GLIBCXX errors
