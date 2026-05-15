import type { Page } from "@playwright/test";

export class ImportDialogPage {
  constructor(private page: Page) {}
  openButton() {
    return this.page.getByTestId("import-open");
  }
  urlInput() {
    return this.page.getByTestId("import-url-input");
  }
  branchInput() {
    return this.page.getByTestId("import-branch-input");
  }
  subdirInput() {
    return this.page.getByTestId("import-subdir-input");
  }
  confirmButton() {
    return this.page.getByTestId("import-confirm");
  }
  progressLog() {
    return this.page.getByTestId("import-progress-log");
  }
  errorBanner() {
    return this.page.getByTestId("import-error-banner");
  }
}
