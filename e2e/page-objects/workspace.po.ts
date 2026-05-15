import type { Page } from "@playwright/test";

export class WorkspacePage {
  constructor(private page: Page, public slug: string) {}

  async goto() {
    await this.page.goto(`/u/${this.slug}/`);
  }

  editorIframe() {
    return this.page.frameLocator("iframe[data-pane='editor']");
  }

  scopeIframe() {
    return this.page.frameLocator("iframe[data-pane='scope']");
  }

  runButton() {
    return this.page.getByTestId("run-button");
  }

  stopButton() {
    return this.page.getByTestId("stop-button");
  }

  consoleOutput() {
    return this.page.getByTestId("run-console");
  }

  runStatus() {
    return this.page.getByTestId("run-status");
  }

  async startRun() {
    await this.runButton().click();
  }

  async stopRun() {
    await this.stopButton().click();
  }
}
