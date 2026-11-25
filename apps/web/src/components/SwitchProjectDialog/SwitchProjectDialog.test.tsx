import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { SwitchProjectDialog } from "./SwitchProjectDialog";

type MockModule = {
	id: string;
	title: string;
	description: string;
	kind: "plain-java" | "robot";
	subdir: string;
	preserveGit: boolean;
	order: number;
};

type MockEntry =
	| MockModule
	| {
			folder: string;
			description?: string;
			order: number;
			modules: MockEntry[];
	  };

function mockModule(
	id: string,
	title: string,
	kind: MockModule["kind"] = "plain-java",
	order = 10,
): MockModule {
	return {
		id,
		title,
		description: `${title} description.`,
		kind,
		subdir: `modules/${id}`,
		preserveGit: false,
		order,
	};
}

const BASE_MODULES: MockEntry[] = [mockModule("hello-world", "Hello, World")];

const { mockModules } = vi.hoisted(() => ({
	mockModules: {
		current: [] as MockEntry[],
	},
}));

const startSwap = vi.fn();

vi.mock("@/hooks/useLessons", () => ({
	useLessons: () => ({
		modules: mockModules.current,
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
		mockModules.current = BASE_MODULES;
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

	test("shows the empty state when every folder is empty", () => {
		mockModules.current = [{ folder: "Week 1", order: 10, modules: [] }];
		renderDialog(true);
		expect(
			screen.getByText("No lessons are available yet."),
		).toBeInTheDocument();
	});

	test("shows modules in collapsible folders", async () => {
		mockModules.current = [
			{
				folder: "FRCSoftware",
				description: "A premade Java and robotics curriculum.",
				order: 10,
				modules: [
					mockModule("stage-1", "Stage 1", "robot", 10),
					mockModule("stage-2", "Stage 2", "robot", 20),
				],
			},
		];
		renderDialog(true);

		expect(screen.getByText("FRCSoftware")).toBeInTheDocument();
		expect(
			screen.getByText("A premade Java and robotics curriculum."),
		).toBeInTheDocument();
		expect(screen.getAllByRole("button", { name: "Load" })).toHaveLength(2);

		await userEvent.click(screen.getByRole("button", { name: /FRCSoftware/ }));
		expect(screen.queryByRole("heading", { name: /Stage 1/ })).toBeNull();
		expect(screen.queryByRole("heading", { name: /Stage 2/ })).toBeNull();

		await userEvent.click(screen.getByRole("button", { name: /FRCSoftware/ }));
		expect(
			screen.getByRole("heading", { name: /Stage 1/ }),
		).toBeInTheDocument();
	});

	test("supports nested folders", async () => {
		mockModules.current = [
			{
				folder: "Course",
				order: 10,
				modules: [
					mockModule("stage-1", "Stage 1", "robot", 10),
					{
						folder: "Advanced",
						order: 20,
						modules: [mockModule("stage-2", "Stage 2", "robot", 20)],
					},
				],
			},
		];
		renderDialog(true);

		await userEvent.click(screen.getByRole("button", { name: /Advanced/ }));
		expect(
			screen.getByRole("heading", { name: /Stage 1/ }),
		).toBeInTheDocument();
		expect(screen.queryByRole("heading", { name: /Stage 2/ })).toBeNull();

		await userEvent.click(screen.getByRole("button", { name: /Course/ }));
		expect(screen.queryByRole("heading", { name: /Stage 1/ })).toBeNull();
		expect(screen.queryByRole("button", { name: /Advanced/ })).toBeNull();
	});

	test("renders module titles without numbering", () => {
		mockModules.current = [
			mockModule("intro", "Intro", "plain-java", 10),
			{
				folder: "Course",
				order: 20,
				modules: [
					mockModule("stage-1", "Stage 1", "robot", 20),
					{
						folder: "Advanced",
						order: 30,
						modules: [mockModule("stage-2", "Stage 2", "robot", 30)],
					},
					mockModule("stage-3", "Stage 3", "robot", 40),
				],
			},
			mockModule("appendix", "Appendix", "plain-java", 50),
		];
		renderDialog(true);

		for (const title of [
			"Intro",
			"Stage 1",
			"Stage 2",
			"Stage 3",
			"Appendix",
		]) {
			expect(screen.getByRole("heading", { name: title })).toBeInTheDocument();
		}
		expect(screen.queryByText(/^\d+\.\s/)).toBeNull();
	});
});
