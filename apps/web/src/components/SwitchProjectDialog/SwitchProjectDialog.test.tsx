import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { SwitchProjectDialog } from "./SwitchProjectDialog";

const startSwap = vi.fn();

vi.mock("@/hooks/useLessons", () => ({
	useLessons: () => ({
		modules: [
			{
				id: "hello-world",
				title: "Hello, World",
				description: "Print a line.",
				kind: "plain-java",
			},
		],
		error: null,
		loading: false,
	}),
}));

vi.mock("@/hooks/useProjectSwap", () => ({
	useProjectSwap: () => ({
		state: {
			status: "idle",
			stage: "",
			detail: "",
			logLines: [],
			success: null,
			message: "",
		},
		startSwap,
		reset: vi.fn(),
	}),
}));

function renderDialog(projectEmpty: boolean) {
	render(
		<SwitchProjectDialog
			open
			onOpenChange={vi.fn()}
			workspaceSlug="alice"
			currentModule={null}
			projectEmpty={projectEmpty}
			onSwapComplete={vi.fn()}
		/>,
	);
}

describe("SwitchProjectDialog", () => {
	beforeEach(() => {
		startSwap.mockClear();
	});

	test("asks before discarding a workspace that has files", async () => {
		renderDialog(false);
		await userEvent.click(screen.getByRole("button", { name: "Load" }));
		expect(screen.getByText("Discard current work?")).toBeInTheDocument();
		expect(startSwap).not.toHaveBeenCalled();

		await userEvent.click(screen.getByRole("button", { name: "Continue" }));
		expect(startSwap).toHaveBeenCalledWith({
			kind: "lesson",
			moduleId: "hello-world",
		});
	});

	test("loads straight away into an empty workspace", async () => {
		renderDialog(true);
		await userEvent.click(screen.getByRole("button", { name: "Load" }));
		expect(screen.queryByText("Discard current work?")).toBeNull();
		expect(startSwap).toHaveBeenCalledWith({
			kind: "lesson",
			moduleId: "hello-world",
		});
	});

	test("imports straight away into an empty workspace", async () => {
		renderDialog(true);
		await userEvent.type(
			screen.getByPlaceholderText("https://github.com/team1234/robot-2026"),
			"https://github.com/team1234/robot-2026",
		);
		await userEvent.click(screen.getByRole("button", { name: "Import" }));
		expect(screen.queryByText("Discard current work?")).toBeNull();
		expect(startSwap).toHaveBeenCalledWith({
			kind: "import",
			url: "https://github.com/team1234/robot-2026",
		});
	});
});
