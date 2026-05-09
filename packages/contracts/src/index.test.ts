import { describe, expect, test } from "bun:test";
import {
  getProjectPathAccess,
  isProjectPath,
  isWorkspaceSlug,
  parseProjectPath,
  runClientMessageSchema,
  runServerMessageSchema,
} from "./index";

describe("isWorkspaceSlug", () => {
  test("accepts V1 route-safe slugs", () => {
    expect(isWorkspaceSlug("alice")).toBe(true);
    expect(isWorkspaceSlug("team_6328-2026")).toBe(true);
  });

  test("rejects path-like or empty slugs", () => {
    expect(isWorkspaceSlug("")).toBe(false);
    expect(isWorkspaceSlug("../alice")).toBe(false);
    expect(isWorkspaceSlug("alice/bob")).toBe(false);
    expect(isWorkspaceSlug("alice.bob")).toBe(false);
    expect(isWorkspaceSlug("a".repeat(41))).toBe(false);
  });
});

describe("project path validation", () => {
  test("accepts relative POSIX project paths", () => {
    expect(String(parseProjectPath("src/main/java/frc/robot/Robot.java"))).toBe(
      "src/main/java/frc/robot/Robot.java",
    );
    expect(isProjectPath(".wpilib/wpilib_preferences.json")).toBe(true);
  });

  test("rejects unsafe filesystem paths", () => {
    const invalidPaths = [
      "",
      "/src/main/java/Robot.java",
      "C:/Users/alice/Robot.java",
      "src\\main\\java\\Robot.java",
      "src/main/../Robot.java",
      "src//main/java/Robot.java",
      "src/main/java/\u0000Robot.java",
    ];

    for (const path of invalidPaths) {
      expect(isProjectPath(path)).toBe(false);
    }
  });

  test("classifies V1 file access allowlists", () => {
    expect(getProjectPathAccess("src/main/java/frc/robot/Robot.java")).toBe("editable");
    expect(getProjectPathAccess("src/test/java/frc/robot/RobotTest.java")).toBe("editable");
    expect(getProjectPathAccess("src/main/deploy/pathplanner/settings.json")).toBe("editable");
    expect(getProjectPathAccess("build.gradle")).toBe("readonly");
    expect(getProjectPathAccess(".wpilib/wpilib_preferences.json")).toBe("readonly");
    expect(getProjectPathAccess("build/classes/Robot.class")).toBe("blocked");
    expect(getProjectPathAccess("gradle/wrapper/gradle-wrapper.jar")).toBe("blocked");
    expect(getProjectPathAccess("vendordeps/WPILibNewCommands.json")).toBe("outside-allowlist");
  });
});

describe("run message schemas", () => {
  test("parses the V1 run WebSocket contract", () => {
    expect(runClientMessageSchema.parse({ type: "start" })).toEqual({ type: "start" });
    expect(
      runServerMessageSchema.parse({
        type: "status",
        status: "queued",
        queueDepth: 1,
        queuePosition: 0,
      }),
    ).toEqual({
      type: "status",
      status: "queued",
      queueDepth: 1,
      queuePosition: 0,
    });
  });
});
