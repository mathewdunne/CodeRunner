import type { Page } from "@playwright/test";

export class AdminPage {
  constructor(private page: Page) {}
  async goto() {
    await this.page.goto("/admin/");
  }
  usersTable() {
    return this.page.getByTestId("admin-users-table");
  }
  auditLogTable() {
    return this.page.getByTestId("admin-audit-log-table");
  }
  capacityInput() {
    return this.page.getByTestId("admin-capacity-input");
  }
  allowlistInput() {
    return this.page.getByTestId("admin-allowlist-input");
  }
}
