import type { GamepadFrame } from "@/hooks/useGamepad";
import type { GamepadState } from "@/lib/contracts";

export const KEYBOARD_GAMEPAD_ID = "keyboard-standard-xbox";
export const KEYBOARD_GAMEPAD_LABEL = "Keyboard";

export const NEUTRAL_GAMEPAD_STATE: GamepadState = {
  axes: [0, 0, 0, 0, 0, 0],
  buttons: [false, false, false, false, false, false, false, false, false, false],
  povs: [-1],
};

export const KEYBOARD_BINDINGS = [
  { code: "KeyW", key: "W", action: "Left stick up", group: "Sticks" },
  { code: "KeyA", key: "A", action: "Left stick left", group: "Sticks" },
  { code: "KeyS", key: "S", action: "Left stick down", group: "Sticks" },
  { code: "KeyD", key: "D", action: "Left stick right", group: "Sticks" },
  { code: "ArrowUp", key: "Arrow Up", action: "Right stick up", group: "Sticks" },
  { code: "ArrowDown", key: "Arrow Down", action: "Right stick down", group: "Sticks" },
  { code: "ArrowLeft", key: "Arrow Left", action: "Right stick left", group: "Sticks" },
  { code: "ArrowRight", key: "Arrow Right", action: "Right stick right", group: "Sticks" },
  { code: "KeyQ", key: "Q", action: "Left trigger", group: "Shoulders" },
  { code: "KeyO", key: "O", action: "Right trigger", group: "Shoulders" },
  { code: "KeyE", key: "E", action: "Left bumper", group: "Shoulders" },
  { code: "KeyU", key: "U", action: "Right bumper", group: "Shoulders" },
  { code: "KeyK", key: "K", action: "A button", group: "Buttons" },
  { code: "KeyL", key: "L", action: "B button", group: "Buttons" },
  { code: "KeyJ", key: "J", action: "X button", group: "Buttons" },
  { code: "KeyI", key: "I", action: "Y button", group: "Buttons" },
  { code: "KeyR", key: "R", action: "Back button", group: "Buttons" },
  { code: "KeyY", key: "Y", action: "Start button", group: "Buttons" },
  { code: "KeyF", key: "F", action: "Left stick click", group: "Buttons" },
  { code: "KeyH", key: "H", action: "Right stick click", group: "Buttons" },
  { code: "KeyZ", key: "Z", action: "POV up", group: "POV" },
  { code: "KeyX", key: "X", action: "POV down", group: "POV" },
  { code: "KeyC", key: "C", action: "POV left", group: "POV" },
  { code: "KeyV", key: "V", action: "POV right", group: "POV" },
] as const;

export type KeyboardBindingGroup = (typeof KEYBOARD_BINDINGS)[number]["group"];

const MAPPED_CODES: ReadonlySet<string> = new Set(KEYBOARD_BINDINGS.map((binding) => binding.code));

function pressed(codes: ReadonlySet<string>, code: string): boolean {
  return codes.has(code);
}

function digitalAxis(
  codes: ReadonlySet<string>,
  negativeCode: string,
  positiveCode: string,
): number {
  const negative = pressed(codes, negativeCode);
  const positive = pressed(codes, positiveCode);
  if (negative === positive) return 0;
  return negative ? -1 : 1;
}

function dpadToPov(up: boolean, down: boolean, left: boolean, right: boolean): number {
  if (up && right) return 45;
  if (right && down) return 135;
  if (down && left) return 225;
  if (left && up) return 315;
  if (up) return 0;
  if (right) return 90;
  if (down) return 180;
  if (left) return 270;
  return -1;
}

function povToButtons(pov: number): [boolean, boolean, boolean, boolean] {
  switch (pov) {
    case 0:
      return [true, false, false, false];
    case 45:
      return [true, false, false, true];
    case 90:
      return [false, false, false, true];
    case 135:
      return [false, true, false, true];
    case 180:
      return [false, true, false, false];
    case 225:
      return [false, true, true, false];
    case 270:
      return [false, false, true, false];
    case 315:
      return [true, false, true, false];
    default:
      return [false, false, false, false];
  }
}

export function isMappedKeyboardCode(code: string): boolean {
  return MAPPED_CODES.has(code);
}

export function keyboardCodesToWpilib(codes: Iterable<string>): GamepadState {
  const pressedCodes = codes instanceof Set ? codes : new Set(codes);
  const leftX = digitalAxis(pressedCodes, "KeyA", "KeyD");
  const leftY = digitalAxis(pressedCodes, "KeyW", "KeyS");
  const rightX = digitalAxis(pressedCodes, "ArrowLeft", "ArrowRight");
  const rightY = digitalAxis(pressedCodes, "ArrowUp", "ArrowDown");

  return {
    axes: [
      leftX,
      leftY,
      pressed(pressedCodes, "KeyQ") ? 1 : 0,
      pressed(pressedCodes, "KeyO") ? 1 : 0,
      rightX,
      rightY,
    ],
    buttons: [
      pressed(pressedCodes, "KeyK"),
      pressed(pressedCodes, "KeyL"),
      pressed(pressedCodes, "KeyJ"),
      pressed(pressedCodes, "KeyI"),
      pressed(pressedCodes, "KeyE"),
      pressed(pressedCodes, "KeyU"),
      pressed(pressedCodes, "KeyR"),
      pressed(pressedCodes, "KeyY"),
      pressed(pressedCodes, "KeyF"),
      pressed(pressedCodes, "KeyH"),
    ],
    povs: [
      dpadToPov(
        pressed(pressedCodes, "KeyZ"),
        pressed(pressedCodes, "KeyX"),
        pressed(pressedCodes, "KeyC"),
        pressed(pressedCodes, "KeyV"),
      ),
    ],
  };
}

export function gamepadStateToVisualizerFrame(state: GamepadState): GamepadFrame {
  const buttons = Array.from({ length: 16 }, () => ({ pressed: false, value: 0 }));
  for (let i = 0; i < 4; i++) {
    buttons[i] = { pressed: Boolean(state.buttons[i]), value: state.buttons[i] ? 1 : 0 };
  }
  buttons[4] = { pressed: Boolean(state.buttons[4]), value: state.buttons[4] ? 1 : 0 };
  buttons[5] = { pressed: Boolean(state.buttons[5]), value: state.buttons[5] ? 1 : 0 };
  buttons[6] = { pressed: (state.axes[2] ?? 0) > 0, value: state.axes[2] ?? 0 };
  buttons[7] = { pressed: (state.axes[3] ?? 0) > 0, value: state.axes[3] ?? 0 };
  buttons[8] = { pressed: Boolean(state.buttons[6]), value: state.buttons[6] ? 1 : 0 };
  buttons[9] = { pressed: Boolean(state.buttons[7]), value: state.buttons[7] ? 1 : 0 };
  buttons[10] = { pressed: Boolean(state.buttons[8]), value: state.buttons[8] ? 1 : 0 };
  buttons[11] = { pressed: Boolean(state.buttons[9]), value: state.buttons[9] ? 1 : 0 };

  const [up, down, left, right] = povToButtons(state.povs[0] ?? -1);
  buttons[12] = { pressed: up, value: up ? 1 : 0 };
  buttons[13] = { pressed: down, value: down ? 1 : 0 };
  buttons[14] = { pressed: left, value: left ? 1 : 0 };
  buttons[15] = { pressed: right, value: right ? 1 : 0 };

  return {
    axes: [state.axes[0] ?? 0, state.axes[1] ?? 0, state.axes[4] ?? 0, state.axes[5] ?? 0],
    buttons,
  };
}
