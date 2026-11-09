import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
	SimPanePanels,
	SimPaneTabSelector,
	SimPaneTabs,
} from "./SimPaneSwitcher";

function renderSwitcher(onPreviewActivated?: () => void) {
	return render(
		<SimPaneTabs onPreviewActivated={onPreviewActivated}>
			<SimPaneTabSelector />
			<SimPanePanels
				scope={<div>scope-pane</div>}
				pathplanner={<div>pathplanner-pane</div>}
				preview={<div>preview-pane</div>}
			/>
		</SimPaneTabs>,
	);
}

describe("SimPaneSwitcher", () => {
	afterEach(() => {
		sessionStorage.clear();
	});

	test("defaults to the AdvantageScope tab with all panes mounted", () => {
		renderSwitcher();

		// All stay mounted so the hidden iframes keep their state.
		expect(screen.getByText("scope-pane")).toBeInTheDocument();
		expect(screen.getByText("pathplanner-pane")).toBeInTheDocument();
		expect(screen.getByText("preview-pane")).toBeInTheDocument();

		expect(screen.getByRole("tab", { name: "AdvantageScope" })).toHaveAttribute(
			"aria-selected",
			"true",
		);
		expect(screen.getByText("pathplanner-pane").parentElement).toHaveProperty(
			"hidden",
			true,
		);
	});

	test("switches tabs and persists the choice", () => {
		renderSwitcher();

		fireEvent.click(screen.getByRole("tab", { name: "PathPlanner" }));

		expect(screen.getByRole("tab", { name: "PathPlanner" })).toHaveAttribute(
			"aria-selected",
			"true",
		);
		expect(screen.getByText("scope-pane").parentElement).toHaveProperty(
			"hidden",
			true,
		);
		expect(screen.getByText("pathplanner-pane").parentElement).toHaveProperty(
			"hidden",
			false,
		);
		expect(sessionStorage.getItem("coderunner:sim-pane-tab")).toBe(
			"pathplanner",
		);
	});

	test("restores the persisted tab", () => {
		sessionStorage.setItem("coderunner:sim-pane-tab", "pathplanner");
		renderSwitcher();

		expect(screen.getByRole("tab", { name: "PathPlanner" })).toHaveAttribute(
			"aria-selected",
			"true",
		);
	});

	test("switches to Preview and persists it, leaving AS/PP mounted", () => {
		renderSwitcher();

		fireEvent.click(screen.getByRole("tab", { name: "Preview" }));

		expect(screen.getByRole("tab", { name: "Preview" })).toHaveAttribute(
			"aria-selected",
			"true",
		);
		expect(screen.getByText("preview-pane").parentElement).toHaveProperty(
			"hidden",
			false,
		);
		// The AdvantageScope session and PathPlanner working copy survive the
		// switch — they are hidden, not unmounted.
		expect(screen.getByText("scope-pane")).toBeInTheDocument();
		expect(screen.getByText("pathplanner-pane")).toBeInTheDocument();
		expect(screen.getByText("scope-pane").parentElement).toHaveProperty(
			"hidden",
			true,
		);
		expect(sessionStorage.getItem("coderunner:sim-pane-tab")).toBe("preview");
	});

	test("hides an inactive Preview without display:none so its scroll survives", () => {
		renderSwitcher();

		// `hidden` means display:none, which collapses the document iframe's
		// viewport and resets its scroll to the top. Preview is hidden with
		// visibility instead and stays laid out at full size.
		const previewPanel = screen.getByText("preview-pane").parentElement;
		expect(previewPanel).toHaveProperty("hidden", false);
		expect(previewPanel).toHaveAttribute("data-hidden");
		expect(previewPanel).toHaveAttribute("inert");
		expect(previewPanel).toHaveClass("data-hidden:invisible");

		fireEvent.click(screen.getByRole("tab", { name: "Preview" }));
		expect(previewPanel).not.toHaveAttribute("data-hidden");
		expect(previewPanel).not.toHaveAttribute("inert");
	});

	test("restores a persisted Preview tab", () => {
		sessionStorage.setItem("coderunner:sim-pane-tab", "preview");
		renderSwitcher();

		expect(screen.getByRole("tab", { name: "Preview" })).toHaveAttribute(
			"aria-selected",
			"true",
		);
	});

	test("falls back to AdvantageScope for an unrecognised stored value", () => {
		sessionStorage.setItem("coderunner:sim-pane-tab", "not-a-pane");
		renderSwitcher();

		expect(screen.getByRole("tab", { name: "AdvantageScope" })).toHaveAttribute(
			"aria-selected",
			"true",
		);
	});

	test("announces activation when Preview is selected", () => {
		const onPreviewActivated = vi.fn();
		renderSwitcher(onPreviewActivated);

		expect(onPreviewActivated).not.toHaveBeenCalled();

		fireEvent.click(screen.getByRole("tab", { name: "Preview" }));

		expect(onPreviewActivated).toHaveBeenCalled();
	});

	test("announces activation for a session that starts on Preview", () => {
		// The restored tab never fires a change event, so activation has to be
		// keyed on the tab itself or the first fetch would never happen.
		sessionStorage.setItem("coderunner:sim-pane-tab", "preview");
		const onPreviewActivated = vi.fn();
		renderSwitcher(onPreviewActivated);

		expect(onPreviewActivated).toHaveBeenCalled();
	});

	test("wires each tab to its panel via aria-controls/aria-labelledby", () => {
		renderSwitcher();

		const scopeTab = screen.getByRole("tab", { name: "AdvantageScope" });
		const pathplannerTab = screen.getByRole("tab", { name: "PathPlanner" });
		const previewTab = screen.getByRole("tab", { name: "Preview" });
		const [scopePanel, pathplannerPanel, previewPanel] = screen.getAllByRole(
			"tabpanel",
			{ hidden: true },
		);

		expect(scopeTab).toHaveAttribute("aria-controls", scopePanel.id);
		expect(scopePanel).toHaveAttribute("aria-labelledby", scopeTab.id);
		expect(pathplannerTab).toHaveAttribute(
			"aria-controls",
			pathplannerPanel.id,
		);
		expect(pathplannerPanel).toHaveAttribute(
			"aria-labelledby",
			pathplannerTab.id,
		);
		expect(previewTab).toHaveAttribute("aria-controls", previewPanel?.id);
		expect(previewPanel).toHaveAttribute("aria-labelledby", previewTab.id);
	});

	test("ArrowRight reaches Preview as the third tab", async () => {
		renderSwitcher();

		const user = userEvent.setup();
		screen.getByRole("tab", { name: "AdvantageScope" }).focus();
		await user.keyboard("{ArrowRight}{ArrowRight}");

		const previewTab = screen.getByRole("tab", { name: "Preview" });
		await waitFor(() => expect(previewTab).toHaveFocus());

		await user.keyboard("{Enter}");
		expect(previewTab).toHaveAttribute("aria-selected", "true");
	});

	test("ArrowRight moves focus and Enter activates PathPlanner", async () => {
		renderSwitcher();

		const scopeTab = screen.getByRole("tab", { name: "AdvantageScope" });
		const pathplannerTab = screen.getByRole("tab", { name: "PathPlanner" });

		expect(scopeTab).toHaveAttribute("tabindex", "0");
		expect(pathplannerTab).toHaveAttribute("tabindex", "-1");

		const user = userEvent.setup();
		scopeTab.focus();
		await user.keyboard("{ArrowRight}");

		// Manual activation: arrowing only moves focus, so a keyboard user can
		// pass over PathPlanner without swapping the pane's iframe.
		await waitFor(() => expect(pathplannerTab).toHaveFocus());
		expect(scopeTab).toHaveAttribute("aria-selected", "true");

		await user.keyboard("{Enter}");

		expect(pathplannerTab).toHaveAttribute("aria-selected", "true");
		expect(scopeTab).toHaveAttribute("aria-selected", "false");
	});
});
