import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("@/lib/auth-client", () => ({
	authClient: { signOut: vi.fn(() => Promise.resolve()) },
}));

import { authClient } from "@/lib/auth-client";
import { UserMenu } from "./UserMenu";

/** jsdom can't navigate; swap in a spy for window.location.assign. */
function stubLocationAssign() {
	const assign = vi.fn();
	vi.stubGlobal("location", { ...window.location, assign });
	return assign;
}

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

	function renderGuestMenu() {
		render(
			<UserMenu
				displayName="Alex D"
				email="guest-abc@classroom.invalid"
				avatarUrl={null}
				isAdmin={false}
				guest={guest}
			/>,
		);
	}

	test("Leave posts to the server, which signs out, then goes to /join", async () => {
		const user = userEvent.setup();
		const fetchMock = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			json: () => Promise.resolve({ ok: true }),
		});
		vi.stubGlobal("fetch", fetchMock);
		const assign = stubLocationAssign();
		renderGuestMenu();
		await user.click(screen.getByRole("button", { name: "User menu" }));
		await user.click(await screen.findByRole("menuitem", { name: "Leave" }));
		await waitFor(() => expect(assign).toHaveBeenCalledWith("/join"));
		expect(fetchMock).toHaveBeenCalledWith(
			"/u/alex-d/api/leave",
			expect.objectContaining({ method: "POST" }),
		);
		expect(authClient.signOut).not.toHaveBeenCalled();
	});

	test.each([
		["fails", () => Promise.resolve({ ok: false, status: 500 })],
		["can't reach the server", () => Promise.reject(new TypeError("offline"))],
	])("when Leave %s it still signs out before going to /join", async (_label, respond) => {
		const user = userEvent.setup();
		vi.stubGlobal("fetch", vi.fn(respond));
		const assign = stubLocationAssign();
		renderGuestMenu();
		await user.click(screen.getByRole("button", { name: "User menu" }));
		await user.click(await screen.findByRole("menuitem", { name: "Leave" }));
		await waitFor(() => expect(assign).toHaveBeenCalledWith("/join"));
		expect(authClient.signOut).toHaveBeenCalled();
		expect(
			vi.mocked(authClient.signOut).mock.invocationCallOrder[0],
		).toBeLessThan(assign.mock.invocationCallOrder[0] ?? 0);
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
