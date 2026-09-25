// Rows used to read "#0 · 1 light": nothing said which lamp a channel was.
// They now carry the Hue app's names, and an Identify button blinks the
// channel's lights — never while a stream owns them, and the page says why.

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { HueAreaChannelInfo } from "@/features/hue/hueOnboardingApi";
import { HUE_AREA_CHANNELS_STATUS, type HueIdentifyStatus } from "@/shared/contracts/hue";
import { HueChannelMapPanel } from "../HueChannelMapPanel";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => (opts ? `${key} ${JSON.stringify(opts)}` : key),
  }),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

function channel(index: number, channelId: number, lightIds: string[]): HueAreaChannelInfo {
  return {
    index,
    channelId,
    lightIds,
    positionX: 0,
    positionY: 0,
    positionZ: null,
    lightCount: lightIds.length,
    autoRegion: "center",
  };
}

const channels = [
  channel(0, 0, ["light-a"]),
  channel(1, 3, ["light-b", "light-c", "light-d"]),
  channel(2, 4, ["light-e"]),
];

const names = { "light-a": "Sofa lamp", "light-b": "Play left", "light-c": "Play right", "light-d": "Bar" };

const status = (code: HueIdentifyStatus["code"]): HueIdentifyStatus => ({ code, message: "", details: null });

function renderPanel(props: Partial<Parameters<typeof HueChannelMapPanel>[0]> = {}) {
  return render(
    <HueChannelMapPanel
      channels={channels}
      isLoading={false}
      channelsStatus={HUE_AREA_CHANNELS_STATUS.OK}
      placements={[]}
      bridgeIp="192.168.1.10"
      username=""
      areaId="area-1"
      isStreaming={false}
      lightNames={names}
      {...props}
    />,
  );
}

const row = (channelId: number) =>
  screen.getByRole("group", { name: `hue:channelMap.channelRowAriaLabel {"index":"#${channelId}"}` });

describe("HueChannelMapPanel — light names and Identify", () => {
  it("names each channel's lights, and falls back to the count for an unnamed one", () => {
    renderPanel();

    expect(row(0)).toHaveTextContent("Sofa lamp");
    expect(row(3)).toHaveTextContent('hue:channelMap.moreLights {"names":"Play left, Play right","count":1}');
    expect(row(4)).toHaveTextContent("hue:channelMap.oneLight");
    expect(row(4)).not.toHaveTextContent("light-e");
  });

  it("blinks the row's lights through onIdentify", async () => {
    const onIdentify = vi.fn(async () => status("HUE_IDENTIFY_OK"));
    const user = userEvent.setup();
    renderPanel({ onIdentify });

    await user.click(screen.getByTestId("hue-chmap-identify-3"));

    expect(onIdentify).toHaveBeenCalledWith(["light-b", "light-c", "light-d"]);
    await waitFor(() => expect(screen.getByTestId("hue-chmap-identify-3")).toBeEnabled());
    expect(screen.queryByText(/hue:channelMap\.identify(Failed|Partial|Blocked)/)).toBeNull();
  });

  it("is off while Hue streams, with the reason on the page", () => {
    renderPanel({ onIdentify: vi.fn(async () => status("HUE_IDENTIFY_OK")), isStreaming: true });

    const button = screen.getByTestId("hue-chmap-identify-0");
    expect(button).toBeDisabled();
    const note = screen.getByTestId("hue-chmap-streaming-note");
    expect(note).toHaveTextContent("hue:channelMap.streamingNote");
    expect(button).toHaveAttribute("aria-describedby", note.id);
  });

  it.each([
    ["HUE_IDENTIFY_BLOCKED_STREAMING", "hue:channelMap.identifyBlocked"],
    ["HUE_IDENTIFY_PARTIAL", "hue:channelMap.identifyPartial"],
    ["HUE_IDENTIFY_FAILED", "hue:channelMap.identifyFailed"],
  ] as const)("says so when the blink answers %s", async (code, copy) => {
    const user = userEvent.setup();
    renderPanel({ onIdentify: vi.fn(async () => status(code)) });

    await user.click(screen.getByTestId("hue-chmap-identify-0"));

    await waitFor(() => expect(screen.getByText(copy)).toBeInTheDocument());
  });

  it("offers the re-pair when the bridge refuses the key", async () => {
    const onRepair = vi.fn();
    const user = userEvent.setup();
    renderPanel({ onIdentify: vi.fn(async () => status("AUTH_INVALID_RE_PAIR_REQUIRED")), onRepair });

    await user.click(screen.getByTestId("hue-chmap-identify-0"));
    await user.click(await screen.findByRole("button", { name: "hue:runtime.actions.repair" }));

    expect(onRepair).toHaveBeenCalledTimes(1);
  });

  it("offers no Identify without a pairing to send it with", () => {
    renderPanel({ onIdentify: vi.fn(async () => status("HUE_IDENTIFY_OK")), username: undefined });

    expect(screen.queryByTestId("hue-chmap-identify-0")).toBeNull();
  });
});
