import type { Page } from "@playwright/test";

export class DriverStationPage {
  constructor(private page: Page) {}
  enableButton() {
    return this.page.getByTestId("ds-enable");
  }
  disableButton() {
    return this.page.getByTestId("ds-disable");
  }
  modeButton(mode: "auto" | "teleop" | "test") {
    return this.page.getByTestId(`ds-mode-${mode}`);
  }
  controllerSelect() {
    return this.page.getByTestId("ds-controller-select");
  }
  keyboardTile() {
    return this.page.getByTestId("ds-keyboard-tile");
  }
  statusIndicator() {
    return this.page.getByTestId("ds-status");
  }
}
