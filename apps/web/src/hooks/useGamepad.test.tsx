/**
 * useGamepad hook — covers connect/disconnect, RAF polling, and unplug safety.
 *
 * Regression anchor: decision 018, commit cb9fea6.
 */
import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useGamepad } from "./useGamepad";

type FakePad = Gamepad;

function makePad(index: number, id = "Xbox Wireless Controller (STANDARD GAMEPAD)"): FakePad {
  return {
    id,
    index,
    connected: true,
    mapping: "standard",
    timestamp: performance.now(),
    axes: [0, 0, 0, 0],
    buttons: Array.from({ length: 16 }, () => ({ pressed: false, touched: false, value: 0 })),
    vibrationActuator: null,
    hapticActuators: [],
  } as unknown as FakePad;
}

describe("useGamepad", () => {
  let pads: (FakePad | null)[];
  let originalGetGamepads: typeof navigator.getGamepads | undefined;

  beforeEach(() => {
    pads = [];
    originalGetGamepads = navigator.getGamepads?.bind(navigator);
    Object.defineProperty(navigator, "getGamepads", {
      configurable: true,
      writable: true,
      value: () => pads,
    });
  });

  afterEach(() => {
    if (originalGetGamepads) {
      Object.defineProperty(navigator, "getGamepads", {
        configurable: true,
        writable: true,
        value: originalGetGamepads,
      });
    }
  });

  test("empty list initially when no pads connected", () => {
    const { result } = renderHook(() => useGamepad());
    expect(result.current.available).toEqual([]);
    expect(result.current.selectedIndex).toBeNull();
    expect(result.current.frame).toBeNull();
  });

  test("gamepadconnected event refreshes the available list", () => {
    const { result } = renderHook(() => useGamepad());
    pads = [makePad(0)];
    act(() => {
      window.dispatchEvent(new Event("gamepadconnected"));
    });
    expect(result.current.available).toHaveLength(1);
    expect(result.current.available[0]?.label).toBe("Xbox Wireless Controller");
  });

  test("unplug while selected clears frame and selection (decision 018)", async () => {
    pads = [makePad(0)];
    const { result } = renderHook(() => useGamepad());

    act(() => {
      window.dispatchEvent(new Event("gamepadconnected"));
    });
    act(() => {
      result.current.selectGamepad(0);
    });

    // Let the RAF loop run a tick
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(result.current.frame).not.toBeNull();

    // Unplug
    pads = [null];
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });

    expect(result.current.selectedIndex).toBeNull();
    expect(result.current.frame).toBeNull();
  });

  test("does not throw if navigator.getGamepads is unavailable", () => {
    Object.defineProperty(navigator, "getGamepads", {
      configurable: true,
      writable: true,
      value: undefined,
    });
    const { result } = renderHook(() => useGamepad());
    expect(result.current.available).toEqual([]);
  });
});
