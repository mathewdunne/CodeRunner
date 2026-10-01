import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, test, vi } from "vitest";
import { JoinPage } from "./JoinPage";

function renderJoin(url = "/join") {
	const onJoined = vi.fn();
	render(
		<MemoryRouter initialEntries={[url]}>
			<JoinPage onJoined={onJoined} />
		</MemoryRouter>,
	);
	return onJoined;
}

function stubFetch(...responses: Array<{ status: number; body: unknown }>) {
	const fetchMock = vi.fn();
	for (const response of responses) {
		fetchMock.mockResolvedValueOnce({
			ok: response.status >= 200 && response.status < 300,
			status: response.status,
			json: () => Promise.resolve(response.body),
		});
	}
	vi.stubGlobal("fetch", fetchMock);
	return fetchMock;
}

function sentBody(fetchMock: ReturnType<typeof vi.fn>, call: number) {
	const init = fetchMock.mock.calls[call]?.[1] as RequestInit;
	return JSON.parse(String(init.body));
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("JoinPage", () => {
	test("prefills the code from ?code= keeping only digits", () => {
		renderJoin("/join?code=12 34-56");
		expect(screen.getByLabelText("Classroom code")).toHaveValue("123456");
	});

	test("typing a code keeps only digits, max six", async () => {
		const user = userEvent.setup();
		renderJoin();
		await user.type(screen.getByLabelText("Classroom code"), "12a3 45-678");
		expect(screen.getByLabelText("Classroom code")).toHaveValue("123456");
	});

	test("a successful join posts the code and name, then calls onJoined", async () => {
		const user = userEvent.setup();
		const fetchMock = stubFetch({
			status: 200,
			body: { ok: true, userId: "u1" },
		});
		const onJoined = renderJoin("/join?code=123456");
		await user.type(screen.getByLabelText("Your name"), "Alex D");
		await user.click(screen.getByRole("button", { name: "Join" }));
		await waitFor(() => expect(onJoined).toHaveBeenCalled());
		expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/auth/classroom/join");
		expect(sentBody(fetchMock, 0)).toEqual({ code: "123456", name: "Alex D" });
	});

	test("a taken name asks for confirmation and resubmits with confirmExisting", async () => {
		const user = userEvent.setup();
		const fetchMock = stubFetch(
			{
				status: 409,
				body: {
					code: "NAME_TAKEN",
					message: "Alex D already joined this classroom.",
					displayName: "Alex D",
				},
			},
			{ status: 200, body: { ok: true, userId: "u1" } },
		);
		const onJoined = renderJoin("/join?code=123456");
		await user.type(screen.getByLabelText("Your name"), "alex d");
		await user.click(screen.getByRole("button", { name: "Join" }));
		expect(
			await screen.findByText(/already joined this classroom/),
		).toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: "Yes, that's me" }));
		await waitFor(() => expect(onJoined).toHaveBeenCalled());
		expect(sentBody(fetchMock, 1)).toEqual({
			code: "123456",
			name: "alex d",
			confirmExisting: true,
		});
	});

	test("'No, change my name' returns to the form without joining", async () => {
		const user = userEvent.setup();
		stubFetch({
			status: 409,
			body: { code: "NAME_TAKEN", message: "taken", displayName: "Alex D" },
		});
		const onJoined = renderJoin("/join?code=123456");
		await user.type(screen.getByLabelText("Your name"), "Alex D");
		await user.click(screen.getByRole("button", { name: "Join" }));
		await user.click(
			await screen.findByRole("button", { name: "No, change my name" }),
		);
		expect(screen.getByLabelText("Your name")).toHaveValue("Alex D");
		expect(onJoined).not.toHaveBeenCalled();
	});

	test("shows the server's message for a bad code", async () => {
		const user = userEvent.setup();
		stubFetch({
			status: 404,
			body: {
				code: "INVALID_CODE",
				message: "That code isn't valid or has expired.",
			},
		});
		renderJoin("/join?code=000000");
		await user.type(screen.getByLabelText("Your name"), "Alex");
		await user.click(screen.getByRole("button", { name: "Join" }));
		expect(await screen.findByRole("alert")).toHaveTextContent(
			"That code isn't valid or has expired.",
		);
	});

	test("Join stays disabled until there are six digits and a name", async () => {
		const user = userEvent.setup();
		renderJoin();
		const join = screen.getByRole("button", { name: "Join" });
		expect(join).toBeDisabled();
		await user.type(screen.getByLabelText("Classroom code"), "12345");
		await user.type(screen.getByLabelText("Your name"), "Alex");
		expect(join).toBeDisabled();
		await user.type(screen.getByLabelText("Classroom code"), "6");
		expect(join).toBeEnabled();
	});
});
