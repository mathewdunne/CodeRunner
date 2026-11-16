# CodeRunner control plane
#
# Multi-stage build that produces a self-contained image: Bun runtime, control
# plane source, production node_modules, web shell dist, AdvantageScope Lite
# dist, bundled lesson catalog, migrations, and ops scripts. The emscripten
# (emsdk) toolchain needed to compile AdvantageScope's wasm lives only in a
# build stage — neither CI runners nor operators install it.
#
# Build context is the repo root (like containers/code/Dockerfile) and needs
# the vendor/AdvantageScope submodule initialized:
#   bun run docker:build:control
#
# See docs/decisions/031-containerized-control-plane.md.

ARG BUN_VERSION=1.4.4

# ── Stage 1: web shell build ───────────────────────────────────────────
FROM oven/bun:${BUN_VERSION} AS web-build
WORKDIR /repo

# Workspace manifests first so the install layer caches across src changes.
COPY package.json bun.lock tsconfig.json tsconfig.base.json ./
COPY apps/web/package.json apps/web/package.json
COPY apps/control/package.json apps/control/package.json
COPY packages/contracts/package.json packages/contracts/package.json
RUN bun install --frozen-lockfile

COPY packages/ packages/
COPY apps/web/ apps/web/
RUN bun run build:web

# ── Stage 2: AdvantageScope Lite build (emsdk) ─────────────────────────
# emscripten/emsdk ships the pinned wasm toolchain with EMSDK/EM_CONFIG
# preset. AdvantageScope's compile tooling wants a modern Node, so install
# Node 24 (matching CI) ahead of emsdk's bundled runtime on PATH, plus a
# pinned Bun for the build scripts.
FROM emscripten/emsdk:4.0.12 AS ascope-build
ARG BUN_VERSION
RUN apt-get update -qq \
    && apt-get install -y --no-install-recommends curl ca-certificates unzip \
    && curl -fsSL https://deb.nodesource.com/setup_24.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL https://bun.sh/install | bash -s "bun-v${BUN_VERSION}" \
    && ln -s /root/.bun/bin/bun /usr/local/bin/bun

WORKDIR /repo
# build-ascope-lite.ts resolves checked-in symlinks from git blobs and
# apply-ascope-patches.ts runs `git apply`, both via `git -C
# vendor/AdvantageScope`. The submodule worktree carries a gitfile pointing at
# .git/modules/vendor/AdvantageScope, so copy that gitdir alongside it (and
# only it — copying all of .git would bust this layer's cache on every
# commit).
COPY .git/modules/vendor/AdvantageScope/ .git/modules/vendor/AdvantageScope/
COPY vendor/ vendor/
COPY patches/ patches/
# Only the two scripts this stage runs — copying all of scripts/ would rerun
# the expensive wasm compile whenever any unrelated ops script changes.
COPY scripts/build-ascope-lite.ts scripts/apply-ascope-patches.ts scripts/
RUN git config --global --add safe.directory '*'
# /usr/bin first so the nodesource node/npm win over emsdk's bundled runtime;
# the wasm step re-prepends the emsdk paths itself (envWithEmsdk).
RUN PATH="/usr/bin:${PATH}" bun scripts/build-ascope-lite.ts

# ── Stage 3: ascope dist hand-off ──────────────────────────────────────
# Filesystem-only stage holding the built AdvantageScope Lite dist. Downstream
# stages copy from here instead of ascope-build so CI can substitute a prebuilt
# dist via a named build context (`--build-context ascope-dist=<dir>`), which
# skips the emsdk stage entirely. That's how the arm64 image build reuses the
# amd64 job's wasm output — emscripten/emsdk publishes no arm64 image, and the
# wasm/JS output is architecture-independent anyway.
FROM scratch AS ascope-dist
COPY --from=ascope-build /repo/dist/advantagescope /

# ── Stage 3b: PathPlanner web dist ─────────────────────────────────────
# Prebuilt in the pathplanner-web fork's CI (Flutter stays out of this
# image, same reasoning as the prebuilt ascope-dist build context).
#
# PATHPLANNER_DIST_TAG doubles as the failure policy:
#   - a real tag (what release.yml passes) is a pinned, required artifact —
#     a failed download fails the build rather than publishing a control
#     image that silently 503s on /pathplanner/.
#   - the "latest" default (local `docker:build:control`) is best-effort:
#     the dist stays empty and /pathplanner/ serves a 503 explaining how to
#     install it, so an offline or rate-limited local build still works.
#
# Pinning also sidesteps a cache hazard: this RUN layer is keyed on its
# inputs, which include the resolved URL below. With "latest" the URL text
# never changes, so a cached layer built against an older release is reused
# even after a newer one is published — and the amd64/arm64 jobs could
# otherwise resolve different releases if "latest" moved between them.
FROM debian:stable-slim AS pathplanner-dist
# The default belongs on the in-stage ARG: an ARG between stages is scoped to
# the preceding stage, so a default declared there never reaches this one and
# the tag would expand empty (composing a 404 `/download//...` URL).
ARG PATHPLANNER_DIST_TAG=latest
RUN apt-get update -qq \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /pathplanner-dist \
    && if [ "$PATHPLANNER_DIST_TAG" = "latest" ]; then \
         url="https://github.com/mathewdunne/pathplanner-web/releases/latest/download/pathplanner-dist.tar.gz"; \
         required=0; \
       else \
         url="https://github.com/mathewdunne/pathplanner-web/releases/download/${PATHPLANNER_DIST_TAG}/pathplanner-dist.tar.gz"; \
         required=1; \
       fi \
    && if curl -fsSL "$url" -o /tmp/pathplanner-dist.tar.gz; then \
         tar -xzf /tmp/pathplanner-dist.tar.gz -C /pathplanner-dist; \
       elif [ "$required" = "1" ]; then \
         echo "ERROR: pinned PathPlanner dist $PATHPLANNER_DIST_TAG could not be downloaded from $url"; \
         exit 1; \
       else \
         echo "WARNING: PathPlanner dist unavailable; /pathplanner will 503"; \
       fi

# ── Stage 4: dist export (CI only) ─────────────────────────────────────
# A filesystem-only stage holding just the built web shell + AdvantageScope
# Lite dists. CI builds this with `--target dist-export --output type=local`
# to harvest the release tarballs (web-dist/ascope-dist) straight from the
# build cache — no need to load the full runtime image into the daemon. It
# shares every upstream layer with the runtime stage, so with a warm cache it
# costs ~nothing. Not referenced by a plain `docker build` (runtime is the
# default last stage), so local builds are unaffected.
FROM scratch AS dist-export
COPY --from=web-build /repo/apps/web/dist /web-dist
COPY --from=ascope-dist / /ascope-dist

# ── Stage 5: runtime (default build target) ────────────────────────────
FROM oven/bun:${BUN_VERSION}

# Docker CLI only — the daemon is the host's, reached through the bind-mounted
# /var/run/docker.sock (docker-out-of-docker; workspace containers are
# siblings). curl serves the compose healthcheck.
COPY --from=docker:27.5.1-cli /usr/local/bin/docker /usr/local/bin/docker
RUN apt-get update -qq \
    && apt-get install -y --no-install-recommends curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
# Manifests before the install so the production node_modules layer caches
# across source changes. Every workspace's package.json must be present —
# bun's isolated linker creates the per-workspace node_modules (e.g.
# apps/control/node_modules) that the control plane resolves dependencies
# through. --production drops the dev toolchain.
COPY package.json bun.lock tsconfig.json tsconfig.base.json ./
COPY apps/web/package.json apps/web/package.json
COPY apps/control/package.json apps/control/package.json
COPY packages/ packages/
RUN bun install --frozen-lockfile --production
COPY apps/control/ apps/control/
COPY scripts/ scripts/
COPY catalog/ catalog/
COPY --from=web-build /repo/apps/web/dist apps/web/dist
COPY --from=ascope-dist / dist/advantagescope
COPY --from=pathplanner-dist /pathplanner-dist dist/pathplanner

# License texts travel with the image, not just the repo: this image ships a
# patched AdvantageScope build, and BSD-3-Clause requires the notice to
# accompany the binary distribution. Last of the COPY layers so editing the
# notices doesn't invalidate the install or dist layers above.
COPY LICENSE THIRD_PARTY_NOTICES.md /usr/share/coderunner/

# /data is the bind-mounted host data directory (SQLite DB + per-student
# projects). The ops scripts' relative "data" fallbacks rely on these being
# set, so keep them even though compose usually repeats them.
ENV FRC_DATA_DIR=/data \
    FRC_DB_PATH=/data/app.db \
    NODE_ENV=production

EXPOSE 4000

# `coderunner` is a dispatching CLI (containers/control/entrypoint.sh) so ops
# commands read as `coderunner <subcommand>` instead of exposing the script
# paths. With CMD=["serve"] the default `docker compose up` migrates then
# execs the server as PID 1, so it receives docker stop's SIGTERM directly;
# `docker compose run --rm control <subcommand>` (allowlist, backup, restore,
# ...) reuses the same entrypoint, and `docker compose exec control coderunner
# <subcommand>` reaches it directly on PATH since `exec` bypasses ENTRYPOINT.
COPY containers/control/entrypoint.sh /usr/local/bin/coderunner
RUN chmod +x /usr/local/bin/coderunner

# Non-root by default; compose overrides the uid:gid to the data-dir owner.
# HOME must be writable by whatever uid runs us (bun runtime cache, etc.), so
# use a world-writable dir rather than the base image's /root. No chown of /app
# is needed — the earlier COPY/install layers are world-readable (umask 0022).
# USER bun (uid 1000) matches the base image's stock user and the typical
# single-host dev user; compose overrides it per deployment.
RUN install -d -m 0777 /home/app
ENV HOME=/home/app
USER bun

ENTRYPOINT ["coderunner"]
CMD ["serve"]
