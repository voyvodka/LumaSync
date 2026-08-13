import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { WledCategory } from "../WledCategory";

const getWledSinkStatusMock = vi.fn();
const loadMock = vi.fn();
const saveMock = vi.fn();

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@/features/device/wledApi", () => ({
  discoverWledDevices: vi.fn(),
  connectWledSink: vi.fn(),
  testWledBridge: vi.fn(),
  getWledSinkStatus: () => getWledSinkStatusMock(),
}));

vi.mock("@/features/persistence/shellStore", () => ({
  shellStore: {
    load: () => loadMock(),
    save: (partial: unknown) => saveMock(partial),
  },
}));

const SAVED = {
  ip: "192.168.1.42",
  port: 4048,
  ledCount: 60,
  protocol: "ddp" as const,
};

beforeEach(() => {
  getWledSinkStatusMock.mockReset();
  loadMock.mockReset();
  saveMock.mockReset();
  getWledSinkStatusMock.mockResolvedValue({ connected: true, sink: SAVED });
  loadMock.mockResolvedValue({ lastWledSink: SAVED });
  saveMock.mockResolvedValue(undefined);
});

// Regression guard: `activeWledIp` and `onConnected` shipped declared but never
// passed, so a connected WLED device was invisible and never persisted.
describe("WledCategory → WledDevicePicker wiring", () => {
  it("passes the active sink IP down so the connected card is highlighted", async () => {
    render(<WledCategory isActive />);

    await waitFor(() => {
      expect(getWledSinkStatusMock).toHaveBeenCalled();
    });

    const input = await screen.findByLabelText<HTMLInputElement>(
      "device:page.wled.manualIp",
    );
    // The saved IP reaching the field proves `savedSink` was threaded through.
    await waitFor(() => {
      expect(input.value).toBe(SAVED.ip);
    });
  });

  it("persists the sink when the picker reports a successful connect", async () => {
    const { connectWledSink } = await import("@/features/device/wledApi");
    const { discoverWledDevices } = await import("@/features/device/wledApi");
    vi.mocked(discoverWledDevices).mockResolvedValue({
      status: { code: "WLED_DISCOVERY_OK", message: "ok", details: null },
      devices: [{ ip: SAVED.ip, ledCount: 60 }],
    });
    vi.mocked(connectWledSink).mockResolvedValue({
      status: { code: "WLED_CONNECT_OK", message: "ok", details: null },
    });

    const user = userEvent.setup();
    render(<WledCategory isActive />);

    const input = await screen.findByLabelText("device:page.wled.manualIp");
    await waitFor(() => {
      expect((input as HTMLInputElement).value).toBe(SAVED.ip);
    });

    await user.click(
      screen.getByRole("button", { name: "device:page.wled.discoverAction" }),
    );
    await user.click(
      await screen.findByRole("button", {
        name: "device:page.wled.reconnectAction",
      }),
    );

    await waitFor(() => {
      expect(saveMock).toHaveBeenCalledWith({
        lastWledSink: SAVED,
        lastSuccessfulPort: undefined,
      });
    });
  });
});
