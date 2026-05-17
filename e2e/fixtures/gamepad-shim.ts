/**
 * Playwright gamepad shim — injects a controllable `navigator.getGamepads()`
 * override via `page.addInitScript`. Tests drive the shim state through
 * `page.evaluate()` helper functions exported below.
 */
import type { Page } from "@playwright/test";

export async function installGamepadShim(page: Page): Promise<void> {
	await page.addInitScript(() => {
		const pads: (Gamepad | null)[] = [null, null, null, null];

		Object.defineProperty(navigator, "getGamepads", {
			configurable: true,
			value: () => [...pads],
		});

		(window as unknown as Record<string, unknown>).__gamepadShim = {
			connect(
				index: number,
				id = "Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 02fd)",
			) {
				pads[index] = {
					id,
					index,
					connected: true,
					mapping: "standard",
					timestamp: performance.now(),
					axes: [0, 0, 0, 0],
					buttons: Array.from({ length: 16 }, () => ({
						pressed: false,
						touched: false,
						value: 0,
					})),
					vibrationActuator: null,
					hapticActuators: [],
				} as unknown as Gamepad;
				window.dispatchEvent(new Event("gamepadconnected"));
			},
			disconnect(index: number) {
				pads[index] = null;
				window.dispatchEvent(new Event("gamepaddisconnected"));
			},
			setAxes(index: number, axes: number[]) {
				if (pads[index]) {
					(pads[index] as unknown as { axes: number[] }).axes = axes;
				}
			},
			setButton(index: number, btnIndex: number, pressed: boolean) {
				if (pads[index]) {
					const buttons = (
						pads[index] as unknown as { buttons: GamepadButton[] }
					).buttons;
					(buttons[btnIndex] as unknown as Record<string, unknown>) = {
						pressed,
						touched: pressed,
						value: pressed ? 1 : 0,
					};
				}
			},
		};
	});
}

/** Connect a virtual gamepad at the given index. */
export async function connectGamepad(
	page: Page,
	index = 0,
	id?: string,
): Promise<void> {
	await page.evaluate(
		({ index, id }) => {
			const shim = (window as unknown as Record<string, any>).__gamepadShim;
			if (id) shim.connect(index, id);
			else shim.connect(index);
		},
		{ index, id },
	);
}

/** Disconnect the virtual gamepad at the given index. */
export async function disconnectGamepad(
	page: Page,
	index: number,
): Promise<void> {
	await page.evaluate((idx) => {
		(window as unknown as Record<string, any>).__gamepadShim.disconnect(idx);
	}, index);
}

/** Set axis values on an already-connected virtual gamepad. */
export async function setGamepadAxes(
	page: Page,
	index: number,
	axes: number[],
): Promise<void> {
	await page.evaluate(
		({ index, axes }) => {
			(window as unknown as Record<string, any>).__gamepadShim.setAxes(
				index,
				axes,
			);
		},
		{ index, axes },
	);
}

/** Press or release a button on an already-connected virtual gamepad. */
export async function setGamepadButton(
	page: Page,
	index: number,
	btnIndex: number,
	pressed: boolean,
): Promise<void> {
	await page.evaluate(
		({ index, btnIndex, pressed }) => {
			(window as unknown as Record<string, any>).__gamepadShim.setButton(
				index,
				btnIndex,
				pressed,
			);
		},
		{ index, btnIndex, pressed },
	);
}
