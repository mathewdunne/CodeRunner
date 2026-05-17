import type { Page } from "@playwright/test";

export class LoginPage {
	constructor(private page: Page) {}
	async goto() {
		await this.page.goto("/login");
	}
	signInButton() {
		return this.page.getByRole("button", { name: /sign in/i });
	}
}
