import { describe, test, expect } from "vitest";
import { gamepadFrameToWpilib } from "./gamepad-mapping";
import type { GamepadFrame } from "@/hooks/useGamepad";

function frame(partial: Partial<GamepadFrame> = {}): GamepadFrame {
  return {
    axes: partial.axes ?? Array(4).fill(0),
    buttons: partial.buttons ?? Array.from({ length: 16 }, () => ({ pressed: false, value: 0 })),
  };
}

describe("gamepadFrameToWpilib", () => {
  test("maps the standard axes to WPILib XboxController order", () => {
    const result = gamepadFrameToWpilib(frame({ axes: [0.5, -0.25, 0.1, -0.9] }));
    expect(result.axes[0]).toBe(0.5);
    expect(result.axes[1]).toBe(-0.25);
    expect(result.axes[4]).toBe(0.1);
    expect(result.axes[5]).toBe(-0.9);
  });

  test("triggers slot into axes[2] (LT) and axes[3] (RT)", () => {
    const buttons = Array.from({ length: 16 }, () => ({ pressed: false, value: 0 }));
    buttons[6] = { pressed: true, value: 1 };
    buttons[7] = { pressed: false, value: 0.4 };
    const result = gamepadFrameToWpilib(frame({ buttons }));
    expect(result.axes[2]).toBe(1);
    expect(result.axes[3]).toBe(0.4);
  });

  test("face buttons map to A/B/X/Y", () => {
    const buttons = Array.from({ length: 16 }, () => ({ pressed: false, value: 0 }));
    buttons[0] = { pressed: true, value: 1 };
    buttons[3] = { pressed: true, value: 1 };
    const result = gamepadFrameToWpilib(frame({ buttons }));
    expect(result.buttons[0]).toBe(true); // A
    expect(result.buttons[3]).toBe(true); // Y
  });

  test("d-pad diagonals produce WPILib POV degrees", () => {
    const make = (up: boolean, right: boolean, down: boolean, left: boolean) => {
      const buttons = Array.from({ length: 16 }, () => ({ pressed: false, value: 0 }));
      buttons[12] = { pressed: up, value: up ? 1 : 0 };
      buttons[13] = { pressed: down, value: down ? 1 : 0 };
      buttons[14] = { pressed: left, value: left ? 1 : 0 };
      buttons[15] = { pressed: right, value: right ? 1 : 0 };
      return gamepadFrameToWpilib(frame({ buttons }));
    };
    expect(make(true, true, false, false).povs[0]).toBe(45);
    expect(make(false, true, true, false).povs[0]).toBe(135);
    expect(make(false, false, true, true).povs[0]).toBe(225);
    expect(make(true, false, false, true).povs[0]).toBe(315);
    expect(make(false, false, false, false).povs[0]).toBe(-1);
  });

  test("clamps out-of-range axes", () => {
    const result = gamepadFrameToWpilib(frame({ axes: [2, -2, 3, -3] }));
    expect(result.axes[0]).toBe(1);
    expect(result.axes[1]).toBe(-1);
    expect(result.axes[4]).toBe(1);
    expect(result.axes[5]).toBe(-1);
  });

  test("missing values default to 0/false", () => {
    const result = gamepadFrameToWpilib({ axes: [], buttons: [] });
    expect(result.axes).toEqual([0, 0, 0, 0, 0, 0]);
    expect(result.buttons.every((b) => b === false)).toBe(true);
    expect(result.povs).toEqual([-1]);
  });
});
