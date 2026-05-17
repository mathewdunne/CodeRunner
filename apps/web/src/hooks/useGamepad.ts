import { useCallback, useEffect, useState } from "react";

export type GamepadInfo = {
	index: number;
	id: string;
	label: string;
};

export type GamepadFrame = {
	axes: number[];
	buttons: { pressed: boolean; value: number }[];
};

interface UseGamepadResult {
	available: GamepadInfo[];
	selectedIndex: number | null;
	frame: GamepadFrame | null;
	selectGamepad: (index: number | null) => void;
}

function makeLabel(gp: Gamepad): string {
	// Native ids look like "Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)".
	// Strip the vendor/product noise for display.
	const idx = gp.id.indexOf(" (");
	return idx > 0 ? gp.id.slice(0, idx) : gp.id;
}

function listConnectedGamepads(): GamepadInfo[] {
	const list: GamepadInfo[] = [];
	const pads =
		typeof navigator !== "undefined" &&
		typeof navigator.getGamepads === "function"
			? navigator.getGamepads()
			: [];
	for (const gp of pads) {
		if (!gp) continue;
		list.push({ index: gp.index, id: gp.id, label: makeLabel(gp) });
	}
	return list;
}

export function useGamepad(): UseGamepadResult {
	const [available, setAvailable] = useState<GamepadInfo[]>([]);
	const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
	const [frame, setFrame] = useState<GamepadFrame | null>(null);

	const refreshAvailable = useCallback(() => {
		setAvailable(listConnectedGamepads());
	}, []);

	useEffect(() => {
		refreshAvailable();
		const handler = () => refreshAvailable();
		window.addEventListener("gamepadconnected", handler);
		window.addEventListener("gamepaddisconnected", handler);
		return () => {
			window.removeEventListener("gamepadconnected", handler);
			window.removeEventListener("gamepaddisconnected", handler);
		};
	}, [refreshAvailable]);

	useEffect(() => {
		if (selectedIndex === null) {
			setFrame(null);
			return;
		}
		let raf = 0;
		let cancelled = false;
		const loop = () => {
			if (cancelled) return;
			const gp = navigator.getGamepads()[selectedIndex];
			if (!gp) {
				// The selected pad was unplugged. Clear selection and let the
				// refreshAvailable handler update the dropdown.
				setFrame(null);
				setSelectedIndex(null);
				refreshAvailable();
				return;
			}
			setFrame({
				axes: Array.from(gp.axes),
				buttons: gp.buttons.map((b) => ({
					pressed: b.pressed,
					value: b.value,
				})),
			});
			raf = requestAnimationFrame(loop);
		};
		raf = requestAnimationFrame(loop);
		return () => {
			cancelled = true;
			cancelAnimationFrame(raf);
		};
	}, [selectedIndex, refreshAvailable]);

	return { available, selectedIndex, frame, selectGamepad: setSelectedIndex };
}
