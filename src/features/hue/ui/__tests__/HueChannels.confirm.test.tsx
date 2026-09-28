// The bridge push and pull ask beside the "…" they were picked from, not in a dialog over the
// page: the question floats, and the page stays put. Escape, an outside press or Cancel says no, and
// nothing is written then.

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { HueAreaChannelInfo } from "@/features/hue/hueOnboardingApi";
import { HUE_AREA_CHANNELS_STATUS } from "@/shared/contracts/hue";
import { bridgeAction } from "./channelsMenu";
import { HueChannels } from "../HueChannels";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => (opts ? `${key} ${JSON.stringify(opts)}` : key),
  }),
}));

const invoke = vi.hoisted(() => vi.fn<typeof import("@tauri-apps/api/core").invoke>());
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
    <HueChannels
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

describe("HueChannels — bridge push confirm", () => {
  beforeEach(() => {
    invoke.mockReset();
  });

  it("asks beside the menu, not over the page, with Cancel quiet and the answer amber", async () => {
    const user = userEvent.setup();
    renderPanel();
    await user.click(bridgeAction("save"));

    const question = screen.getByTestId("hue-channel-map-confirm");
    const dialog = question.closest("[role='dialog']");
    expect(dialog).not.toBeNull();
    expect(dialog).not.toHaveAttribute("aria-modal", "true");
    expect(question).toHaveTextContent("hue:channelMap.saveConfirmTitle");
    expect(question).toHaveTextContent(/hue:channelMap\.saveConfirm .*192\.168\.1\.10/);

    const [cancel, confirm] = Array.from(question.querySelectorAll("button"));
    expect(cancel).toHaveTextContent("hue:page.cancel");
    expect(confirm).toHaveTextContent("hue:channelMap.saveToBridge");
    expect(confirm).toHaveFocus();
  });

  it("Escape cancels without writing to the bridge", async () => {
    const user = userEvent.setup();
    renderPanel();
    await user.click(bridgeAction("save"));
    await user.keyboard("{Escape}");

    await waitFor(() => expect(screen.queryByTestId("hue-channel-map-confirm")).toBeNull());
    expect(wroteToBridge()).toBe(false);
  });

  it("an outside press cancels, a press inside the question does not", async () => {
    const user = userEvent.setup();
    renderPanel();
    await user.click(bridgeAction("pull"));

    const question = screen.getByTestId("hue-channel-map-confirm");
    fireEvent.pointerDown(question);
    expect(screen.getByTestId("hue-channel-map-confirm")).toBeInTheDocument();

    fireEvent.pointerDown(document.body);
    await waitFor(() => expect(screen.queryByTestId("hue-channel-map-confirm")).toBeNull());
  });

  it("confirming writes once and closes", async () => {
    invoke.mockResolvedValue({ code: "HUE_CHANNEL_POSITIONS_UPDATED", message: "ok", details: null });
    const user = userEvent.setup();
    renderPanel();
    await user.click(bridgeAction("save"));
    await user.click(within(screen.getByTestId("hue-channel-map-confirm")).getAllByRole("button")[1]!);

    await waitFor(() => expect(screen.queryByTestId("hue-channel-map-confirm")).toBeNull());
    expect(invoke.mock.calls.filter(([command]) => command === "update_hue_channel_positions")).toHaveLength(1);
  });
});
