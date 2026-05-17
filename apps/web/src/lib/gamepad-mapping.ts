import type { GamepadFrame } from "@/hooks/useGamepad";
import type { GamepadState } from "@/lib/contracts";

// Maps a browser Gamepad API frame (standard mapping) to the WPILib
// XboxController axis/button layout that HALSim consumes:
//
//   axes:    [LeftX, LeftY, LeftTrigger, RightTrigger, RightX, RightY]
//   buttons: [A, B, X, Y, LB, RB, Back, Start, LS, RS]
//   povs[0]: D-pad direction in degrees (-1 if not pressed)
//
// See https://w3c.github.io/gamepad/#remapping for the standard mapping that
// browsers report for Xbox / PS / DInput-style controllers.

function round4(n: number): number {
	return Math.round(n * 10000) / 10000;
}

function dpadToPov(
	up: boolean,
	down: boolean,
	left: boolean,
	right: boolean,
): number {
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

function clamp(n: number, lo: number, hi: number): number {
	return n < lo ? lo : n > hi ? hi : n;
}

export function gamepadFrameToWpilib(frame: GamepadFrame): GamepadState {
	const axis = (i: number) => round4(clamp(frame.axes[i] ?? 0, -1, 1));
	const bv = (i: number) => round4(clamp(frame.buttons[i]?.value ?? 0, 0, 1));
	const bp = (i: number) => frame.buttons[i]?.pressed ?? false;

	const axes: number[] = [axis(0), axis(1), bv(6), bv(7), axis(2), axis(3)];
	const buttons: boolean[] = [
		bp(0),
		bp(1),
		bp(2),
		bp(3),
		bp(4),
		bp(5),
		bp(8),
		bp(9),
		bp(10),
		bp(11),
	];
	const povs: number[] = [dpadToPov(bp(12), bp(13), bp(14), bp(15))];
	return { axes, buttons, povs };
}
