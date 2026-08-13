import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi, beforeEach } from "vitest";

import { WledDevicePicker } from "../WledDevicePicker";

const discoverWledDevicesMock = vi.fn();

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock("@/features/device/wledApi", () => ({
  discoverWledDevices: (...args: unknown[]) => discoverWledDevicesMock(...args),
  connectWledSink: vi.fn(),
  testWledBridge: vi.fn(),
}));

beforeEach(() => {
  discoverWledDevicesMock.mockReset();
  discoverWledDevicesMock.mockResolvedValue({
    status: { code: "WLED_DISCOVERY_OK", message: "ok", details: null },
    devices: [],
  });
});

// Regression guard: blank IP used to reach `invoke({})` and reject uncoded
// against the non-optional Rust `ip` field. Client must refuse it now.
describe("WledDevicePicker manual IP discovery", () => {
  it("disables Discover while the IP field is blank", () => {
    render(<WledDevicePicker />);

    expect(
      screen.getByRole("button", { name: "device:page.wled.discoverAction" }),
    ).toBeDisabled();
  });

  it("never calls discoverWledDevices for a blank IP", async () => {
    const user = userEvent.setup();
    render(<WledDevicePicker />);

    const button = screen.getByRole("button", {
      name: "device:page.wled.discoverAction",
    });
    await user.click(button);

    expect(discoverWledDevicesMock).not.toHaveBeenCalled();
  });

  it("enables Discover once a plausible IP is entered, and calls with the trimmed value", async () => {
    const user = userEvent.setup();
    render(<WledDevicePicker />);

    const input = screen.getByLabelText("device:page.wled.manualIp");
    await user.type(input, "  192.168.1.42  ");

    const button = screen.getByRole("button", {
      name: "device:page.wled.discoverAction",
    });
    expect(button).not.toBeDisabled();

    await user.click(button);

    expect(discoverWledDevicesMock).toHaveBeenCalledWith("192.168.1.42");
  });
});
