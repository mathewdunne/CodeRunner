import { describe, expect, test } from "bun:test";
import { runFlushBlockers, type RunFlushFileState } from "./save-before-run";

function file(patch: Partial<RunFlushFileState> = {}): RunFlushFileState {
  return {
    path: "src/main/java/frc/robot/Robot.java",
    access: "editable",
    dirty: false,
    saving: false,
    error: null,
    ...patch,
  };
}

describe("runFlushBlockers", () => {
  test("blocks runs while editable files are dirty, saving, or failed", () => {
    expect(runFlushBlockers([file({ dirty: true })])).toHaveLength(1);
    expect(runFlushBlockers([file({ saving: true })])).toHaveLength(1);
    expect(runFlushBlockers([file({ error: "Save failed." })])).toHaveLength(1);
  });

  test("ignores clean editable files and readonly files", () => {
    expect(
      runFlushBlockers([
        file(),
        file({ path: "build.gradle", access: "readonly", dirty: true, saving: true, error: "readonly" }),
      ]),
    ).toEqual([]);
  });
});
