/**
 * Property tests for keyboard → WPILib gamepad mapping.
 *
 * P7 — for any set of pressed keys, all axis values are in [-1.0, 1.0] and button values
 *      are boolean. POV is -1 or in [0, 360].
 * P8 — no combination produces NaN/Infinity.
 */
import { describe, test, expect } from "bun:test";
import fc from "fast-check";
import { keyboardCodesToWpilib, KEYBOARD_BINDINGS } from "./keyboard-mapping";

const NUM_RUNS = Number(process.env.FAST_CHECK_NUM_RUNS ?? 200);
const ALL_CODES = KEYBOARD_BINDINGS.map((b) => b.code);

describe("keyboardCodesToWpilib — properties", () => {
  test("P7 axes always in [-1, 1]", () => {
    fc.assert(
      fc.property(fc.subarray(ALL_CODES), (codes) => {
        const state = keyboardCodesToWpilib(codes);
        for (const a of state.axes) {
          expect(Number.isFinite(a)).toBe(true);
          expect(a).toBeGreaterThanOrEqual(-1);
          expect(a).toBeLessThanOrEqual(1);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  test("P7 buttons always boolean", () => {
    fc.assert(
      fc.property(fc.subarray(ALL_CODES), (codes) => {
        const state = keyboardCodesToWpilib(codes);
        for (const b of state.buttons) {
          expect(typeof b).toBe("boolean");
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  test("P7 POV either -1 or in {0,45,90,135,180,225,270,315}", () => {
    const valid = new Set([-1, 0, 45, 90, 135, 180, 225, 270, 315]);
    fc.assert(
      fc.property(fc.subarray(ALL_CODES), (codes) => {
        const state = keyboardCodesToWpilib(codes);
        for (const p of state.povs) {
          expect(valid.has(p)).toBe(true);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  test("P8 unknown/garbage keycodes are silently ignored", () => {
    fc.assert(
      fc.property(fc.array(fc.string()), (codes) => {
        const state = keyboardCodesToWpilib(codes);
        for (const a of state.axes) expect(Number.isFinite(a)).toBe(true);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
