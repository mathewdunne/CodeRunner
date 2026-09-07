import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import { AllianceToggle } from "./AllianceToggle";

describe("AllianceToggle", () => {
	test("renders blue and red segments", () => {
		render(
			<AllianceToggle alliance="blue1" enabled={false} onSelect={() => {}} />,
		);
		expect(screen.getByTestId("ds-alliance-blue")).toBeInTheDocument();
		expect(screen.getByTestId("ds-alliance-red")).toBeInTheDocument();
	});

	test.each([
		"blue1",
		"blue2",
		"blue3",
	] as const)("shows blue active for %s", (alliance) => {
		render(
			<AllianceToggle
				alliance={alliance}
				enabled={false}
				onSelect={() => {}}
			/>,
		);
		expect(screen.getByTestId("ds-alliance-blue")).toHaveAttribute(
			"data-active",
			"true",
		);
		expect(screen.getByTestId("ds-alliance-red")).toHaveAttribute(
			"data-active",
			"false",
		);
	});

	test.each([
		"red1",
		"red2",
		"red3",
	] as const)("shows red active for %s", (alliance) => {
		render(
			<AllianceToggle
				alliance={alliance}
				enabled={false}
				onSelect={() => {}}
			/>,
		);
		expect(screen.getByTestId("ds-alliance-red")).toHaveAttribute(
			"data-active",
			"true",
		);
		expect(screen.getByTestId("ds-alliance-blue")).toHaveAttribute(
			"data-active",
			"false",
		);
	});

	test("selecting red sends red1", () => {
		const onSelect = vi.fn();
		render(
			<AllianceToggle alliance="blue1" enabled={false} onSelect={onSelect} />,
		);
		fireEvent.click(screen.getByTestId("ds-alliance-red"));
		expect(onSelect).toHaveBeenCalledWith("red1");
	});

	test("selecting blue sends blue1", () => {
		const onSelect = vi.fn();
		render(
			<AllianceToggle alliance="red3" enabled={false} onSelect={onSelect} />,
		);
		fireEvent.click(screen.getByTestId("ds-alliance-blue"));
		expect(onSelect).toHaveBeenCalledWith("blue1");
	});

	test("clicking the active segment keeps the station number", () => {
		const onSelect = vi.fn();
		render(
			<AllianceToggle alliance="red3" enabled={false} onSelect={onSelect} />,
		);
		fireEvent.click(screen.getByTestId("ds-alliance-red"));
		expect(onSelect).not.toHaveBeenCalled();
	});

	test("locks both segments while the robot is enabled", () => {
		const onSelect = vi.fn();
		render(
			<AllianceToggle alliance="blue1" enabled={true} onSelect={onSelect} />,
		);
		expect(screen.getByTestId("ds-alliance-blue")).toBeDisabled();
		expect(screen.getByTestId("ds-alliance-red")).toBeDisabled();
		fireEvent.click(screen.getByTestId("ds-alliance-red"));
		expect(onSelect).not.toHaveBeenCalled();
	});
});
