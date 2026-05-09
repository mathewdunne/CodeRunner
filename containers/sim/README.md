# V1 Sim Container

Headless WPILib 2026 simulation image for V1 workspaces.

The runtime project is a bind mount at `/workspace/project`; the committed template under
`templates/wpilib-java-command/` is copied into the image only to prime Gradle/WPILib caches during build.

## Build

```powershell
bun run docker:build:sim
```

The build script tags `frc-sim:v1` by default. Override with `SIM_IMAGE`.

On native Linux, set `FRC_UID` and `FRC_GID` to the host user that owns `data/` before building and running. If
they are not set, the build script uses the current process UID/GID on Linux and `1000:1000` on Docker Desktop.

## Runtime Contract

The control plane creates containers with:

- `/workspace/project` bound to `data/users/<workspaceId>/project`
- `/home/frc` bound to `data/users/<workspaceId>/home`
- `127.0.0.1:<allocatedPort>:5810`
- labels `frc-sim.managed=true`, `frc-sim.version=v1`, `frc-sim.role=sim`, and `frc-sim.workspace=<workspaceId>`

The image primes Gradle/WPILib dependencies into `/opt/frc-gradle-cache`. On first start with an empty mounted
`/home/frc`, the entrypoint copies that cache into the workspace home and then idles while tailing the sim log. Opening
the IDE starts the container, but it does not start Gradle; only the control-plane run queue calls `start-sim.sh`. Sim
logs and PID files also live under `/home/frc`, so generated cache/runtime files are outside the authoritative student
project directory. Sim Gradle uses `/home/frc/.gradle-project-sim` as its project cache so a running simulator does
not lock `/workspace/project/.gradle` while JDT LS imports the same mounted project. Gradle build output still lands
in the bind-mounted project, and the UID/GID strategy keeps those files readable and removable by the host control
plane.

## Scripts

- `/usr/local/bin/start-sim.sh` starts `./gradlew --no-daemon --console=plain --project-cache-dir "$GRADLE_PROJECT_CACHE_DIR" simulateJava`.
- `/usr/local/bin/stop-sim.sh` stops the saved Gradle/sim process group.
- `/usr/local/bin/entrypoint.sh` prepares the mounted home, validates the mounted project, and tails `/home/frc/sim.log`.

The archived MVP sim image remains under `mvp/containers/sim/` for provenance.
