import { describe, expect, test } from "bun:test";
import { KEYBOARD_BINDINGS, keyboardCodesToWpilib } from "./keyboard-mapping";

describe("keyboardCodesToWpilib", () => {
	test("maps left and right stick axes", () => {
		expect(
			keyboardCodesToWpilib(["KeyW", "KeyD", "ArrowUp", "ArrowRight"]).axes,
		).toEqual([1, -1, 0, 0, 1, -1]);
		expect(
			keyboardCodesToWpilib(["KeyA", "KeyS", "ArrowLeft", "ArrowDown"]).axes,
		).toEqual([-1, 1, 0, 0, -1, 1]);
	});

	test("cancels opposite axis directions", () => {
		expect(
			keyboardCodesToWpilib(["KeyA", "KeyD", "KeyW", "KeyS"]).axes,
		).toEqual([0, 0, 0, 0, 0, 0]);
		expect(
			keyboardCodesToWpilib(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"])
				.axes,
		).toEqual([0, 0, 0, 0, 0, 0]);
	});

	test("maps triggers to WPILib trigger axes", () => {
		expect(keyboardCodesToWpilib(["KeyQ", "KeyO"]).axes).toEqual([
			0, 0, 1, 1, 0, 0,
		]);
	});

	test("maps buttons in WPILib XboxController order", () => {
		expect(
			keyboardCodesToWpilib([
				"KeyK",
				"KeyL",
				"KeyJ",
				"KeyI",
				"KeyE",
				"KeyU",
				"KeyR",
				"KeyY",
				"KeyF",
				"KeyH",
			]).buttons,
		).toEqual([true, true, true, true, true, true, true, true, true, true]);
	});

	test("maps POV diagonals using WPILib degrees", () => {
		expect(keyboardCodesToWpilib(["KeyZ", "KeyV"]).povs).toEqual([45]);
		expect(keyboardCodesToWpilib(["KeyX", "KeyV"]).povs).toEqual([135]);
		expect(keyboardCodesToWpilib(["KeyX", "KeyC"]).povs).toEqual([225]);
		expect(keyboardCodesToWpilib(["KeyC", "KeyZ"]).povs).toEqual([315]);
	});

	test("keeps the exact Standard Xbox key assignments mapped", () => {
		const expectedCodes = [
			"KeyW",
			"KeyA",
			"KeyS",
			"KeyD",
			"ArrowUp",
			"ArrowDown",
			"ArrowLeft",
			"ArrowRight",
			"KeyQ",
			"KeyO",
			"KeyE",
			"KeyU",
			"KeyK",
			"KeyL",
			"KeyJ",
			"KeyI",
			"KeyR",
			"KeyY",
			"KeyF",
			"KeyH",
			"KeyZ",
			"KeyX",
			"KeyC",
			"KeyV",
		];

		expect(KEYBOARD_BINDINGS.map((binding) => binding.code)).toEqual(
			expectedCodes,
		);
	});
});
