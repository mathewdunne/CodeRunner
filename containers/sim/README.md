# Sim container

Headless WPILib 2026 robot project that publishes telemetry over NT4 on port 5810. Used as the simulation backend for the FRC Web Simulator MVP.

## Build

```bash
docker build -t frc-sim:mvp containers/sim
```

First build takes ~5–8 min and downloads ~500 MB from `frcmaven.wpi.edu`. Subsequent builds with unchanged `project/` are cached.

## Run

```bash
docker run --rm -p 5810:5810 --memory=2g --name frc-sim frc-sim:mvp
```

Within ~30 seconds you should see a log line like:

```
NT: server: listening on NT4 port 5810
```

## Verify

Connect desktop AdvantageScope (installed at `C:\Users\Public\wpilib\2026\advantagescope`) to `localhost:5810`. You should see:

- `/SmartDashboard/counter` — integer incrementing every ~20 ms
- `/SmartDashboard/robotPose` — `Pose2d` tracing a circle of radius 2 around (4, 4)

## Stop

```bash
docker stop frc-sim
```

`exec` in the entrypoint ensures the JVM is PID 1 and receives SIGTERM directly.

## What's inside

- `eclipse-temurin:17-jdk-jammy` base image
- `project/` — minimal command-based WPILib 2026 project, hand-rolled from the WPILib install template (`C:\Users\Public\wpilib\2026\utility\resources\app\resources\gradle\java\`)
- `~/.gradle/caches/` — pre-populated with WPILib jars + native libs at image build time

The sim runs headless because `build.gradle` deliberately does NOT call `wpi.sim.addGui()` or `wpi.sim.addDriverstation()`. See [`docs/decisions/001-sim-container.md`](../../docs/decisions/001-sim-container.md).

## Hacking

Edit `project/src/main/java/frc/robot/Robot.java` (or any project file) and rebuild the image. The dependency cache layer is reused as long as `project/build.gradle` and `project/settings.gradle` are unchanged.
