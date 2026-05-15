import { describe, test, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { EnableDisableRow } from "./EnableDisableRow";

describe("EnableDisableRow", () => {
  test("renders enable and disable buttons", () => {
    render(<EnableDisableRow enabled={false} canEnable={true} onSetEnabled={() => {}} />);
    expect(screen.getByTestId("ds-enable")).toBeInTheDocument();
    expect(screen.getByTestId("ds-disable")).toBeInTheDocument();
  });

  test("calls onSetEnabled(true) when enable clicked", () => {
    const onSetEnabled = vi.fn();
    render(<EnableDisableRow enabled={false} canEnable={true} onSetEnabled={onSetEnabled} />);
    fireEvent.click(screen.getByTestId("ds-enable"));
    expect(onSetEnabled).toHaveBeenCalledWith(true);
  });

  test("calls onSetEnabled(false) when disable clicked", () => {
    const onSetEnabled = vi.fn();
    render(<EnableDisableRow enabled={true} canEnable={true} onSetEnabled={onSetEnabled} />);
    fireEvent.click(screen.getByTestId("ds-disable"));
    expect(onSetEnabled).toHaveBeenCalledWith(false);
  });

  test("enable button disabled when canEnable is false", () => {
    render(<EnableDisableRow enabled={false} canEnable={false} onSetEnabled={() => {}} />);
    expect(screen.getByTestId("ds-enable")).toBeDisabled();
  });

  test("disable button disabled when not enabled", () => {
    render(<EnableDisableRow enabled={false} canEnable={true} onSetEnabled={() => {}} />);
    expect(screen.getByTestId("ds-disable")).toBeDisabled();
  });
});
