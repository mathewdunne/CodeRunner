# Decision Logs

Record active architecture decisions here.

## Active (V2 and post-V2)

011–040 are the current decision logs (see files in this directory). The latest:

- [`032-canonical-image-naming.md`](032-canonical-image-naming.md) — one canonical name per image, derived from `CODERUNNER_IMAGE_NS` + `CODERUNNER_TAG`.
- [`033-workspace-disk-read-limit.md`](033-workspace-disk-read-limit.md) — workspace containers get a per-device `--device-read-bps` cap (`CODE_DISK_READ_LIMIT`) so one memory-thrashing container cannot saturate host disk throughput and freeze the VM; `CODE_MEMORY_LIMIT` default raised to `4096m`.
- [`034-demo-mode-portability.md`](034-demo-mode-portability.md) — the demo runs unconfigured on Docker Desktop: `group_add` uses the Docker socket's owning group and defaults to root (the Docker Desktop case), and demo mode keeps `/config` on a named volume and skips the disk read cap so performance no longer depends on the host filesystem.
- [`035-multi-arch-images-and-workflow-split.md`](035-multi-arch-images-and-workflow-split.md) — both images publish linux/amd64 + linux/arm64 manifest lists built on native runners and merged by digest; the single deploy pipeline splits into CI (verify on PR/main), Release (on `v*` tag push), and Deploy (manual dispatch of a published tag); the emsdk stage builds once on amd64 and feeds the arm64 control build via a named build context.
- [`036-vscodium-web-migration.md`](036-vscodium-web-migration.md) — the workspace editor moves from the abandoned openvscode-server to VSCodium `reh-web` via `linuxserver/vscodium-web`; chosen over `code-server` because `codium-server` keeps `--server-base-path`, so the pass-through proxy contract survives unchanged.
- [`037-gradle-wrapper-alias-and-extension-pins.md`](037-gradle-wrapper-alias-and-extension-pins.md) — shares the primed Gradle distribution across wrapper layouts, enforces the pinned extension manifest, and disables workspace trust in the hosted workbench.
- [`038-java-tooling-compatibility-and-smoke.md`](038-java-tooling-compatibility-and-smoke.md) — runs JDT LS on Java 21 while preserving the Java 17 WPILib path, reconciles managed extension pins, and adds a real-container Java smoke.
- [`039-pathplanner-integration.md`](039-pathplanner-integration.md) — serves the PathPlanner web app in a tab beside AdvantageScope and syncs its project files through an ownership-checked deploy-files API.

- [`040-selinux-container-mounts.md`](040-selinux-container-mounts.md) — exempts the control plane from SELinux labeling and relabels student bind mounts for shared access while preserving demo named volumes.

## Archive

V1 decision logs 007–010 and MVP decision logs 001–006 are archived because V1 is no longer the runtime model and the MVP phase is complete:

- [`archive/001-sim-container.md`](archive/001-sim-container.md)
- [`archive/002-advantagescope-lite-hosting.md`](archive/002-advantagescope-lite-hosting.md)
- [`archive/003-web-shell.md`](archive/003-web-shell.md)
- [`archive/004-backend-wiring.md`](archive/004-backend-wiring.md)
- [`archive/005-java-lsp.md`](archive/005-java-lsp.md)
- [`archive/006-multi-tenancy-findings.md`](archive/006-multi-tenancy-findings.md)
- [`archive/007-v1-sim-container-orchestration.md`](archive/007-v1-sim-container-orchestration.md)
- [`archive/008-v1-lsp-container-bridge.md`](archive/008-v1-lsp-container-bridge.md)
- [`archive/009-lsp-reconnect-and-bridge-serialization.md`](archive/009-lsp-reconnect-and-bridge-serialization.md)
- [`archive/010-gradle-project-cache-isolation.md`](archive/010-gradle-project-cache-isolation.md)
