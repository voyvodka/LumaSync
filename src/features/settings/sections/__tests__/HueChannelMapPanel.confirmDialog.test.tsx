// The bridge push and pull asked through their own copy of the app's yes/no
// dialog. They now use the shared ConfirmDialog; these pin what the copy did
// (Escape and backdrop cancel, nothing written on cancel) and the
// shared look (secondary Cancel, primary confirm).

import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { HueAreaChannelInfo } from "@/features/hue/hueOnboardingApi";
import { HUE_AREA_CHANNELS_STATUS } from "@/shared/contracts/hue";
import { HueChannelMapPanel } from "../HueChannelMapPanel";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => (opts ? `${key} ${JSON.stringify(opts)}` : key),
  }),
}));

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

const channels: HueAreaChannelInfo[] = [0, 2].map((channelId, index) => ({
  index,
  channelId,
  lightIds: [`light-${channelId}`],
  positionX: index,
  positionY: 0,
  positionZ: null,
  lightCount: 1,
  autoRegion: "center",
}));

function renderPanel() {
  return render(
    <HueChannelMapPanel
      channels={channels}
      isLoading={false}
      channelsStatus={HUE_AREA_CHANNELS_STATUS.OK}
      placements={channels.map((ch) => ({ channelIndex: ch.index, channelId: ch.channelId, x: ch.positionX, y: 0, z: 0 }))}
      bridgeIp="192.168.1.10"
      username="app-key"
      areaId="area-1"
      isStreaming={false}
    />,
  );
}

const wroteToBridge = () =>
  invoke.mock.calls.some(([command]) => command === "update_hue_channel_positions");

describe("HueChannelMapPanel — bridge push confirm", () => {
  beforeEach(() => {
    invoke.mockReset();
  });

  it("asks in the shared dialog, named by its title and described by its body", async () => {
    const user = userEvent.setup();
    renderPanel();
    await user.click(screen.getByRole("button", { name: /saveToBridge$/ }));

    const dialog = screen.getByTestId("hue-channel-map-confirm");
    expect(dialog).toHaveAttribute("role", "dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveAccessibleName("hue:channelMap.saveConfirmTitle");
    expect(dialog).toHaveAccessibleDescription(/hue:channelMap\.saveConfirm .*192\.168\.1\.10/);

    const [cancel, confirm] = Array.from(dialog.querySelectorAll("button"));
    expect(cancel).toHaveTextContent("hue:page.cancel");
    expect(cancel).toHaveClass("lm-btn");
    expect(confirm).toHaveClass("lm-btn", "is-primary");
  });

  it("Escape cancels without writing to the bridge", async () => {
    const user = userEvent.setup();
    renderPanel();
    await user.click(screen.getByRole("button", { name: /saveToBridge$/ }));
    await user.keyboard("{Escape}");

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(wroteToBridge()).toBe(false);
  });

  it("a backdrop click cancels, a click inside the card does not", async () => {
    const user = userEvent.setup();
    renderPanel();
    await user.click(screen.getByRole("button", { name: /pullFromBridge/ }));

    const dialog = screen.getByRole("dialog");
    fireEvent.click(dialog.firstElementChild as HTMLElement);
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    fireEvent.click(dialog);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("confirming writes once and closes", async () => {
    invoke.mockResolvedValue({ code: "HUE_CHANNEL_POSITIONS_UPDATED", message: "ok", details: null });
    const user = userEvent.setup();
    renderPanel();
    await user.click(screen.getByRole("button", { name: /saveToBridge$/ }));
    await user.click(within(screen.getByRole("dialog")).getAllByRole("button")[1]!);

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(invoke.mock.calls.filter(([command]) => command === "update_hue_channel_positions")).toHaveLength(1);
  });
});
