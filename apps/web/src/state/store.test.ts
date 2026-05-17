import { beforeEach, describe, expect, test } from "vitest";
import { useUIStore } from "./store";

describe("UI store", () => {
	beforeEach(() => {
		useUIStore.setState({
			inputMode: "controller",
			consoleCollapsed: false,
			scopeCollapsed: false,
		});
		localStorage.clear();
	});

	test("inputMode transitions between controller and keyboard", () => {
		useUIStore.getState().setInputMode("keyboard");
		expect(useUIStore.getState().inputMode).toBe("keyboard");
		useUIStore.getState().setInputMode("controller");
		expect(useUIStore.getState().inputMode).toBe("controller");
	});

	test("toggleConsoleCollapsed flips the boolean", () => {
		expect(useUIStore.getState().consoleCollapsed).toBe(false);
		useUIStore.getState().toggleConsoleCollapsed();
		expect(useUIStore.getState().consoleCollapsed).toBe(true);
		useUIStore.getState().toggleConsoleCollapsed();
		expect(useUIStore.getState().consoleCollapsed).toBe(false);
	});

	test("toggleScopeCollapsed flips the boolean", () => {
		expect(useUIStore.getState().scopeCollapsed).toBe(false);
		useUIStore.getState().toggleScopeCollapsed();
		expect(useUIStore.getState().scopeCollapsed).toBe(true);
	});

	test("only inputMode is persisted (partialize)", () => {
		useUIStore.getState().setInputMode("keyboard");
		useUIStore.getState().toggleConsoleCollapsed();
		// Read the persisted blob directly
		const persisted = JSON.parse(
			localStorage.getItem("frc-coderunner-ui") ?? "{}",
		);
		expect(persisted?.state?.inputMode).toBe("keyboard");
		// consoleCollapsed should NOT be persisted
		expect(persisted?.state?.consoleCollapsed).toBeUndefined();
	});

	test("inputMode persists after store rehydration from localStorage", () => {
		// Write keyboard mode into localStorage as if a previous session saved it
		localStorage.setItem(
			"frc-coderunner-ui",
			JSON.stringify({ state: { inputMode: "keyboard" }, version: 0 }),
		);
		// Trigger rehydration
		useUIStore.persist.rehydrate();
		expect(useUIStore.getState().inputMode).toBe("keyboard");
	});

	test("multiple rapid toggles work correctly", () => {
		const store = useUIStore.getState();
		store.toggleConsoleCollapsed();
		store.toggleConsoleCollapsed();
		store.toggleConsoleCollapsed();
		expect(useUIStore.getState().consoleCollapsed).toBe(true);

		store.toggleScopeCollapsed();
		store.toggleScopeCollapsed();
		expect(useUIStore.getState().scopeCollapsed).toBe(false);
	});
});
