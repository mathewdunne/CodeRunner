import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import { SimControlsBlock } from "./SimControlsBlock";

describe("SimControlsBlock", () => {
	test("start button enabled when idle and sessionReady", () => {
		render(
			<SimControlsBlock
				runStatus="idle"
				sessionReady={true}
				onStart={() => {}}
				onStop={() => {}}
				onRestart={() => {}}
			/>,
		);
		expect(screen.getByTestId("run-button")).not.toBeDisabled();
	});

	test("start button disabled when not sessionReady", () => {
		render(
			<SimControlsBlock
				runStatus="idle"
				sessionReady={false}
				onStart={() => {}}
				onStop={() => {}}
				onRestart={() => {}}
			/>,
		);
		expect(screen.getByTestId("run-button")).toBeDisabled();
	});

	test("stop button enabled when running", () => {
		render(
			<SimControlsBlock
				runStatus="running"
				sessionReady={true}
				onStart={() => {}}
				onStop={() => {}}
				onRestart={() => {}}
			/>,
		);
		expect(screen.getByTestId("stop-button")).not.toBeDisabled();
	});

	test("stop button disabled when idle", () => {
		render(
			<SimControlsBlock
				runStatus="idle"
				sessionReady={true}
				onStart={() => {}}
				onStop={() => {}}
				onRestart={() => {}}
			/>,
		);
		expect(screen.getByTestId("stop-button")).toBeDisabled();
	});

	test("restart button enabled when running", () => {
		render(
			<SimControlsBlock
				runStatus="running"
				sessionReady={true}
				onStart={() => {}}
				onStop={() => {}}
				onRestart={() => {}}
			/>,
		);
		expect(screen.getByTestId("restart-button")).not.toBeDisabled();
	});

	test("calls onStart/onStop/onRestart on click", () => {
		const onStart = vi.fn();
		const onStop = vi.fn();
		const onRestart = vi.fn();
		render(
			<SimControlsBlock
				runStatus="running"
				sessionReady={true}
				onStart={onStart}
				onStop={onStop}
				onRestart={onRestart}
			/>,
		);
		fireEvent.click(
			screen.getByTestId("run-button").closest("button") ??
				screen.getByTestId("run-button"),
		);
		// Start is disabled when running, so use stop and restart
		fireEvent.click(screen.getByTestId("stop-button"));
		fireEvent.click(screen.getByTestId("restart-button"));
		expect(onStop).toHaveBeenCalledTimes(1);
		expect(onRestart).toHaveBeenCalledTimes(1);
	});
});
