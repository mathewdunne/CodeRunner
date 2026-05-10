# WPILib Java Command Starter Template

This directory is the V1 source of truth for new student workspaces. The control plane will copy it into `data/users/<workspaceId>/project` on first login.

## Provenance

- WPILib install source: `C:\Users\Public\wpilib\2026\utility\resources\app\resources\gradle\`
- WPILib template version: `2026.1.1`
- GradleRIO version: `2026.1.1`
- Gradle wrapper distribution: `gradle-8.11-bin.zip`

The base project comes from the WPILib 2026 Java command-based template plus the archived MVP simulator project evidence.

## Intentional Template Contents

- `build.gradle`, `settings.gradle`, and `gradle.properties`
- Gradle wrapper files under `gradle/wrapper/`, plus `gradlew` and `gradlew.bat`
- `.wpilib/wpilib_preferences.json`
- `vendordeps/WPILibNewCommands.json`
- `src/main/java/frc/robot/**`
- `src/main/deploy/.gitkeep`
- `WPILib-License.md`

The starter keeps the original telemetry example in `Robot.java`: a counter at `/SmartDashboard/counter` and a moving `Pose2d` at `/SmartDashboard/robotPose`. That gives students and operators an immediate visual confirmation that edit, run, NT4, and AdvantageScope are wired correctly.

Machine-specific IDE metadata from the WPILib template is intentionally excluded.
