import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("@/lib/auth-client", () => ({
	authClient: { signOut: vi.fn(() => Promise.resolve()) },
}));

import { authClient } from "@/lib/auth-client";
import { UserMenu } from "./UserMenu";

afterEach(() => {
	vi.unstubAllGlobals();
	vi.mocked(authClient.signOut).mockClear();
});

const guest = { endsAt: "2026-09-30T19:45:00.000Z", workspaceSlug: "alex-d" };

describe("UserMenu", () => {
	test("guests see Leave and the classroom end time instead of their email", async () => {
		const user = userEvent.setup();
		render(
			<UserMenu
				displayName="Alex D"
				email="guest-abc@classroom.invalid"
				avatarUrl={null}
				isAdmin={false}
				guest={guest}
			/>,
		);
		await user.click(screen.getByRole("button", { name: "User menu" }));
		expect(await screen.findByText(/Guest · ends/)).toBeInTheDocument();
		expect(
			screen.queryByText("guest-abc@classroom.invalid"),
		).not.toBeInTheDocument();
		expect(screen.getByRole("menuitem", { name: "Leave" })).toBeInTheDocument();
		expect(screen.queryByRole("menuitem", { name: "Logout" })).toBeNull();
	});

	test("Leave stops the workspace, then signs out", async () => {
		const user = userEvent.setup();
		const fetchMock = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			json: () => Promise.resolve({ ok: true }),
		});
		vi.stubGlobal("fetch", fetchMock);
		render(
			<UserMenu
				displayName="Alex D"
				email="guest-abc@classroom.invalid"
				avatarUrl={null}
				isAdmin={false}
				guest={guest}
			/>,
		);
		await user.click(screen.getByRole("button", { name: "User menu" }));
		await user.click(await screen.findByRole("menuitem", { name: "Leave" }));
		await waitFor(() => expect(authClient.signOut).toHaveBeenCalled());
		expect(fetchMock).toHaveBeenCalledWith(
			"/u/alex-d/api/leave",
			expect.objectContaining({ method: "POST" }),
		);
	});

	test("signed-in users still see their email and Logout", async () => {
		const user = userEvent.setup();
		render(
			<UserMenu
				displayName="Alice"
				email="alice@example.com"
				avatarUrl={null}
				isAdmin={false}
			/>,
		);
		await user.click(screen.getByRole("button", { name: "User menu" }));
		expect(await screen.findByText("alice@example.com")).toBeInTheDocument();
		expect(
			screen.getByRole("menuitem", { name: "Logout" }),
		).toBeInTheDocument();
	});
});
