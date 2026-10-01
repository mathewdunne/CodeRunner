/**
 * Classroom join codes (decision 043): a student joins with a code and name,
 * leaves, and rejoins the same workspace by confirming their name.
 */
import { createClassroom } from "../../../apps/control/src/classrooms";
import { expect, test } from "../../fixtures/app";
import { seedRuntimeRunning } from "../../fixtures/runtime";

test("student joins with a classroom code, leaves, and rejoins the same workspace", async ({
	page,
	app,
	runtime,
	fakeVscode,
	fakeHalsim,
}) => {
	const classroom = createClassroom(app.storage.db, {
		createdBy: "e2e-admin",
		durationMinutes: 240,
	});

	await page.goto(`/join?code=${classroom.code}`);
	await expect(page.getByLabel("Classroom code")).toHaveValue(classroom.code);
	await page.getByLabel("Your name").fill("Alex D");
	await page.getByRole("button", { name: "Join" }).click();
	await expect(page).toHaveURL(/\/u\/alex-d\/$/);

	// The fixture doesn't auto-start containers; seed one so Leave has a
	// running workspace to stop.
	const workspace = app.storage.findWorkspaceBySlug("alex-d" as never)!;
	seedRuntimeRunning({
		runtime,
		workspaceId: workspace.id,
		fakeVscode,
		fakeHalsim,
	});

	// An empty project auto-opens Switch Project; close it to reach the menu.
	// Wait for it to open first so the Escape isn't swallowed by a race.
	const switchProject = page.getByRole("dialog");
	await expect(switchProject).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(switchProject).toBeHidden();
	await page.getByRole("button", { name: "User menu" }).click();
	await expect(page.getByText(/Guest · ends/)).toBeVisible();
	const leave = page.waitForResponse(
		(response) =>
			response.url().endsWith("/u/alex-d/api/leave") &&
			response.request().method() === "POST",
	);
	await page.getByRole("menuitem", { name: "Leave" }).click();
	expect((await leave).ok()).toBe(true);
	await expect(page).toHaveURL(/\/join$/);
	expect((await runtime.getWorkspaceStatus(workspace.id)).state).toBe(
		"stopped",
	);

	await page.getByLabel("Classroom code").fill(classroom.code);
	await page.getByLabel("Your name").fill("alex d");
	await page.getByRole("button", { name: "Join" }).click();
	await expect(page.getByText(/already joined this classroom/)).toBeVisible();
	await page.getByRole("button", { name: "Yes, that's me" }).click();
	await expect(page).toHaveURL(/\/u\/alex-d\/$/);
	expect(app.storage.findWorkspaceBySlug("alex-d" as never)?.id).toBe(
		workspace.id,
	);

	const guests = app.storage.db
		.query("SELECT COUNT(*) AS count FROM user WHERE classroomId = ?")
		.get(classroom.id) as { count: number };
	expect(guests.count).toBe(1);
});

test("a wrong code shows an error and stays on /join", async ({ page }) => {
	await page.goto("/join?code=000000");
	await page.getByLabel("Your name").fill("Alex");
	await page.getByRole("button", { name: "Join" }).click();
	await expect(page.getByRole("alert")).toHaveText(
		"That code isn't valid or has expired.",
	);
	await expect(page).toHaveURL(/\/join/);
});
