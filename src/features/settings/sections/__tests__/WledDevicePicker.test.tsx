import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi, beforeEach } from "vitest";

import { WLED_STATUS } from "@/shared/contracts/device";

import { WLED_STATUS_COPY, WledDevicePicker, wledStatusTone } from "../WledDevicePicker";
import type * as wledApiModule from "@/features/device/wledApi";

const discoverWledDevicesMock = vi.fn<typeof wledApiModule.discoverWledDevices>();
const connectWledSinkMock = vi.fn<typeof wledApiModule.connectWledSink>();
const testWledBridgeMock = vi.fn<typeof wledApiModule.testWledBridge>();

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock("@/features/device/wledApi", () => ({
  discoverWledDevices: (...args: Parameters<typeof discoverWledDevicesMock>) => discoverWledDevicesMock(...args),
  connectWledSink: (...args: Parameters<typeof connectWledSinkMock>) => connectWledSinkMock(...args),
  testWledBridge: (...args: Parameters<typeof testWledBridgeMock>) => testWledBridgeMock(...args),
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

describe("WledDevicePicker action results (H-10)", () => {
  const device = { ip: "192.168.1.42", name: "Desk", ledCount: 60, version: "0.14.0", mac: null };

  async function discoverOne() {
    discoverWledDevicesMock.mockResolvedValue({
      status: { code: "WLED_DISCOVERY_OK", message: "ok", details: null },
      devices: [device],
    });
    const user = userEvent.setup();
    render(<WledDevicePicker />);
    await user.type(screen.getByLabelText("device:page.wled.manualIp"), device.ip);
    await user.click(screen.getByRole("button", { name: "device:page.wled.discoverAction" }));
    return user;
  }

  it("reports a connect that worked as a success, in words", async () => {
    connectWledSinkMock.mockResolvedValue({
      status: { code: "WLED_CONNECT_OK", message: "Connected (English from Rust)", details: null },
    });
    const user = await discoverOne();
    await user.click(screen.getByRole("button", { name: "device:page.wled.connectAction" }));

    const note = await screen.findByText("device:page.wled.status.connectOk");
    expect(note.closest(".lm-callout")).toHaveClass("is-ok");
    expect(screen.queryByText("Connected (English from Rust)")).toBeNull();
  });

  it("reports an unconfirmed test as a caveat and a failed send as an error", async () => {
    testWledBridgeMock.mockResolvedValueOnce({
      status: { code: "WLED_TEST_SENT_UNCONFIRMED", message: "sent", details: null },
      sendLatencyMs: 3,
    });
    const user = await discoverOne();
    await user.click(screen.getByRole("button", { name: "device:page.wled.testAction" }));
    const caveat = await screen.findByText("device:page.wled.status.testSentUnconfirmed");
    expect(caveat.closest(".lm-callout")).toHaveClass("is-warning");

    testWledBridgeMock.mockResolvedValueOnce({
      status: { code: "WLED_TEST_SEND_FAILED", message: "send failed", details: null },
      sendLatencyMs: null,
    });
    await user.click(screen.getByRole("button", { name: "device:page.wled.testAction" }));
    const failure = await screen.findByText("device:page.wled.status.testSendFailed");
    expect(failure.closest(".lm-callout")).toHaveClass("is-error");
  });

  it("has words and a tone for every status code", () => {
    for (const code of Object.values(WLED_STATUS)) {
      expect(WLED_STATUS_COPY[code], code).toMatch(/^device:page\.wled\.status\./);
    }
    expect(wledStatusTone(WLED_STATUS.TEST_LIVE_CONFIRMED)).toBe("ok");
    expect(wledStatusTone(WLED_STATUS.PROTOCOL_MISMATCH)).toBe("error");
  });
});
